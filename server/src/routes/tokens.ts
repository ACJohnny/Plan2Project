import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiToken, CreateTokenBody, Id } from '@sixpoint/shared';
import { apiTokens } from '../db/schema';
import { HttpError, randomToken, requireRole, sha256 } from '../lib/auth';

/** Admin-created read-only API tokens for scripts (e.g. reading markers back). */
export const tokenRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app.ctx;
  const admin = requireRole('admin');
  const dto = (t: typeof apiTokens.$inferSelect, token?: string) => ({
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    revokedAt: t.revokedAt?.toISOString() ?? null,
    ...(token ? { token } : {}),
  });

  app.get(
    '/api/tokens',
    { schema: { tags: ['tokens'], response: { 200: z.array(ApiToken) } }, preHandler: admin },
    async () => (await db.select().from(apiTokens).orderBy(desc(apiTokens.createdAt))).map((t) => dto(t)),
  );

  app.post(
    '/api/tokens',
    {
      schema: {
        tags: ['tokens'],
        body: CreateTokenBody,
        description:
          'Returns the token once. Send it as `Authorization: Bearer <token>`; it has Viewer access.',
        response: { 200: ApiToken },
      },
      preHandler: admin,
    },
    async (req) => {
      const raw = `spm_${randomToken(24)}`;
      const [t] = await db
        .insert(apiTokens)
        .values({ name: req.body.name, tokenHash: sha256(raw), createdBy: req.user!.id })
        .returning();
      return dto(t, raw);
    },
  );

  app.delete(
    '/api/tokens/:id',
    { schema: { tags: ['tokens'], params: z.object({ id: Id }) }, preHandler: admin },
    async (req) => {
      const [t] = await db
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(eq(apiTokens.id, req.params.id))
        .returning();
      if (!t) throw new HttpError(404, 'Token not found');
      return { ok: true };
    },
  );
};
