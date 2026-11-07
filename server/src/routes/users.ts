import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CreateUserBody, Id, UpdateUserBody, User } from '@sixpoint/shared';
import { sessions, users } from '../db/schema';
import { hashPassword, HttpError, requireRole } from '../lib/auth';
import { userDto } from '../lib/dto';

/** User admin (R-11). Admin only. */
export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app.ctx;
  const admin = requireRole('admin');

  app.get(
    '/api/users',
    { schema: { tags: ['users'], response: { 200: z.array(User) } }, preHandler: admin },
    async () => {
      const rows = await db.select().from(users).orderBy(asc(users.name));
      return rows.map(userDto);
    },
  );

  app.post(
    '/api/users',
    { schema: { tags: ['users'], body: CreateUserBody, response: { 200: User } }, preHandler: admin },
    async (req) => {
      const email = req.body.email.trim().toLowerCase();
      const dup = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`);
      if (dup.length) throw new HttpError(409, 'A user with that email already exists');
      const [u] = await db
        .insert(users)
        .values({
          email,
          name: req.body.name,
          role: req.body.role,
          passwordHash: await hashPassword(req.body.password),
        })
        .returning();
      return userDto(u);
    },
  );

  app.patch(
    '/api/users/:id',
    {
      schema: {
        tags: ['users'],
        params: z.object({ id: Id }),
        body: UpdateUserBody,
        response: { 200: User },
      },
      preHandler: admin,
    },
    async (req) => {
      const { id } = req.params;
      const current = (await db.select().from(users).where(eq(users.id, id)))[0];
      if (!current) throw new HttpError(404, 'User not found');
      const b = req.body;
      if (id === req.user!.id && ((b.role && b.role !== 'admin') || b.active === false))
        throw new HttpError(400, "You can't remove your own admin access");
      if (current.role === 'admin' && ((b.role && b.role !== 'admin') || b.active === false)) {
        const [{ n }] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(sql`${users.role} = 'admin' and ${users.active}`);
        if (n <= 1) throw new HttpError(400, 'At least one active admin is required');
      }
      const patch: Partial<typeof users.$inferInsert> = {};
      if (b.name) patch.name = b.name;
      if (b.role) patch.role = b.role;
      if (b.active !== undefined) patch.active = b.active;
      if (b.password) patch.passwordHash = await hashPassword(b.password);
      const [u] = await db.update(users).set(patch).where(eq(users.id, id)).returning();
      if (b.active === false || b.password) await db.delete(sessions).where(eq(sessions.userId, id));
      return userDto(u);
    },
  );
};
