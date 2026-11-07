import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { eq, sql } from 'drizzle-orm';
import { LoginBody, MeResponse, UpdateMeBody } from '@sixpoint/shared';
import { sessions, users } from '../db/schema';
import {
  createSession,
  hashPassword,
  HttpError,
  requireUser,
  SESSION_COOKIE,
  verifyPassword,
} from '../lib/auth';
import { userDto } from '../lib/dto';

// A real hash so unknown-email logins take the same time as wrong-password ones.
let dummyHash: Promise<string> | null = null;

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, cfg, limiter } = app.ctx;
  setInterval(() => limiter.sweep(), 60_000).unref();

  app.post('/api/auth/login', { schema: { tags: ['auth'], body: LoginBody, response: { 200: MeResponse } } }, async (req, reply) => {
    const email = req.body.email.trim().toLowerCase();
    const wait = limiter.lockedFor(email, req.ip);
    if (wait > 0) throw new HttpError(429, `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60000)} minutes.`);
    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    const u = rows[0];
    dummyHash ??= hashPassword('dummy-password-for-timing');
    const ok = u ? await verifyPassword(u.passwordHash, req.body.password) : (await verifyPassword(await dummyHash, 'x'), false);
    if (!u || !ok || !u.active) {
      limiter.fail(email, req.ip);
      throw new HttpError(401, u && ok && !u.active ? 'This account is deactivated' : 'Email or password is incorrect');
    }
    limiter.succeed(email);
    const s = await createSession(db, u.id);
    reply.setCookie(SESSION_COOKIE, s.raw, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.secureCookies,
      signed: true,
      maxAge: 30 * 24 * 3600,
    });
    return { user: userDto(u), csrf: s.csrf };
  });

  app.post('/api/auth/logout', { schema: { tags: ['auth'] } }, async (req, reply) => {
    if (req.sessionId) await db.delete(sessions).where(eq(sessions.id, req.sessionId));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { schema: { tags: ['auth'], response: { 200: MeResponse } }, preHandler: requireUser }, async (req) => {
    const u = (await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1))[0];
    if (!u) {
      // API tokens whose creator was removed
      return {
        user: {
          id: req.user!.id,
          email: '',
          name: req.user!.name,
          role: req.user!.role,
          active: true,
          theme: 'system' as const,
          createdAt: new Date(0).toISOString(),
        },
      };
    }
    return { user: { ...userDto(u), role: req.user!.role }, csrf: req.user!.csrf };
  });

  // R-12: own name, password and theme (R-64)
  app.patch('/api/me', { schema: { tags: ['auth'], body: UpdateMeBody, response: { 200: MeResponse } }, preHandler: requireUser }, async (req) => {
    if (req.user!.via !== 'session') throw new HttpError(403, 'Sign in to change your account');
    const u = (await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1))[0];
    if (!u) throw new HttpError(404, 'User not found');
    const patch: Partial<typeof users.$inferInsert> = {};
    if (req.body.name) patch.name = req.body.name;
    if (req.body.theme) patch.theme = req.body.theme;
    if (req.body.newPassword) {
      if (!(await verifyPassword(u.passwordHash, req.body.currentPassword ?? '')))
        throw new HttpError(400, 'Current password is incorrect');
      patch.passwordHash = await hashPassword(req.body.newPassword);
    }
    const [nu] = Object.keys(patch).length
      ? await db.update(users).set(patch).where(eq(users.id, u.id)).returning()
      : [u];
    if (req.body.newPassword) {
      // sign out other sessions
      await db.delete(sessions).where(sql`${sessions.userId} = ${u.id} and ${sessions.id} <> ${req.sessionId}`);
    }
    return { user: userDto(nu), csrf: req.user!.csrf };
  });
};
