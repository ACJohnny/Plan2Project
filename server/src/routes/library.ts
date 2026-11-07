import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  Category,
  CreateCategoryBody,
  CreateTypeBody,
  DeviceType,
  Id,
  Library,
  ReorderBody,
  SEED_LIBRARY,
  UpdateCategoryBody,
  UpdateTypeBody,
} from '@sixpoint/shared';
import type { DB } from '../db';
import { deviceCategories, deviceTypes } from '../db/schema';
import { HttpError, requireRole, requireUser } from '../lib/auth';

const P = z.object({ id: Id });

export async function seedLibrary(db: DB) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(deviceCategories);
  if (n > 0) return false;
  await db.transaction(async (tx) => {
    for (const [ci, c] of SEED_LIBRARY.entries()) {
      const [cat] = await tx
        .insert(deviceCategories)
        .values({ name: c.name, colorHex: c.color, sortOrder: ci })
        .returning();
      await tx
        .insert(deviceTypes)
        .values(c.types.map((t, ti) => ({ categoryId: cat.id, code: t.code, name: t.name, sortOrder: ti })));
    }
  });
  return true;
}

export async function loadLibrary(db: DB): Promise<Library> {
  const cats = await db
    .select()
    .from(deviceCategories)
    .orderBy(asc(deviceCategories.sortOrder), asc(deviceCategories.name));
  const usage = await db.execute(
    sql`select type_id, count(*)::int as n from markers where deleted_at is null group by type_id`,
  );
  const used = new Map((usage.rows as any[]).map((r) => [r.type_id, r.n]));
  const types = await db
    .select()
    .from(deviceTypes)
    .orderBy(asc(deviceTypes.sortOrder), asc(deviceTypes.code));
  const catOrder = new Map(cats.map((c, i) => [c.id, i]));
  types.sort(
    (a, b) =>
      (catOrder.get(a.categoryId) ?? 0) - (catOrder.get(b.categoryId) ?? 0) || a.sortOrder - b.sortOrder,
  );
  return {
    categories: cats.map((c) => ({ id: c.id, name: c.name, color: c.colorHex, sortOrder: c.sortOrder })),
    types: types.map((t) => ({
      id: t.id,
      categoryId: t.categoryId,
      code: t.code,
      name: t.name,
      defaultModel: t.defaultModel,
      defaultNotes: t.defaultNotes,
      sortOrder: t.sortOrder,
      retiredAt: t.retiredAt?.toISOString() ?? null,
      inUse: used.get(t.id) ?? 0,
    })),
  };
}

/** Device library (R-24..R-27). Reading is open to all signed-in users; changes are admin only. */
export const libraryRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, hub } = app.ctx;
  const admin = requireRole('admin');
  const changed = (req: { clientId: string | null }) =>
    hub.publishAll({ type: 'library.update', origin: req.clientId });

  app.get(
    '/api/device-library',
    { schema: { tags: ['library'], response: { 200: Library } }, preHandler: requireUser },
    async () => loadLibrary(db),
  );

  app.post(
    '/api/device-library/categories',
    {
      schema: { tags: ['library'], body: CreateCategoryBody, response: { 200: Category } },
      preHandler: admin,
    },
    async (req) => {
      const [{ n }] = await db
        .select({ n: sql<number>`coalesce(max(sort_order), -1)::int + 1` })
        .from(deviceCategories);
      const [c] = await db
        .insert(deviceCategories)
        .values({ name: req.body.name, colorHex: req.body.color.toLowerCase(), sortOrder: n })
        .returning();
      changed(req);
      return { id: c.id, name: c.name, color: c.colorHex, sortOrder: c.sortOrder };
    },
  );

  app.patch(
    '/api/device-library/categories/:id',
    {
      schema: { tags: ['library'], params: P, body: UpdateCategoryBody, response: { 200: Category } },
      preHandler: admin,
    },
    async (req) => {
      const patch: Partial<typeof deviceCategories.$inferInsert> = {};
      if (req.body.name) patch.name = req.body.name;
      if (req.body.color) patch.colorHex = req.body.color.toLowerCase();
      if (req.body.sortOrder !== undefined) patch.sortOrder = req.body.sortOrder;
      const [c] = await db
        .update(deviceCategories)
        .set(patch)
        .where(eq(deviceCategories.id, req.params.id))
        .returning();
      if (!c) throw new HttpError(404, 'Category not found');
      changed(req);
      return { id: c.id, name: c.name, color: c.colorHex, sortOrder: c.sortOrder };
    },
  );

  app.delete(
    '/api/device-library/categories/:id',
    { schema: { tags: ['library'], params: P }, preHandler: admin },
    async (req) => {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(deviceTypes)
        .where(eq(deviceTypes.categoryId, req.params.id));
      if (n > 0) throw new HttpError(409, 'Move or delete the types in this category first');
      await db.delete(deviceCategories).where(eq(deviceCategories.id, req.params.id));
      changed(req);
      return { ok: true };
    },
  );

  app.post(
    '/api/device-library/categories/reorder',
    { schema: { tags: ['library'], body: ReorderBody }, preHandler: admin },
    async (req) => {
      await db.transaction(async (tx) => {
        for (const [i, id] of req.body.ids.entries())
          await tx.update(deviceCategories).set({ sortOrder: i }).where(eq(deviceCategories.id, id));
      });
      changed(req);
      return { ok: true };
    },
  );

  async function codeTaken(code: string, exceptId?: string) {
    const rows = await db.select({ id: deviceTypes.id }).from(deviceTypes).where(eq(deviceTypes.code, code));
    return rows.some((r) => r.id !== exceptId);
  }

  app.post(
    '/api/device-library/types',
    { schema: { tags: ['library'], body: CreateTypeBody, response: { 200: DeviceType } }, preHandler: admin },
    async (req) => {
      if (await codeTaken(req.body.code)) throw new HttpError(409, `Code ${req.body.code} is already used`);
      const [{ n }] = await db
        .select({ n: sql<number>`coalesce(max(sort_order), -1)::int + 1` })
        .from(deviceTypes)
        .where(eq(deviceTypes.categoryId, req.body.categoryId));
      const [t] = await db
        .insert(deviceTypes)
        .values({ ...req.body, sortOrder: n })
        .returning();
      changed(req);
      return (await loadLibrary(db)).types.find((x) => x.id === t.id)!;
    },
  );

  app.patch(
    '/api/device-library/types/:id',
    {
      schema: { tags: ['library'], params: P, body: UpdateTypeBody, response: { 200: DeviceType } },
      preHandler: admin,
    },
    async (req) => {
      const { retired, ...rest } = req.body;
      if (rest.code && (await codeTaken(rest.code, req.params.id)))
        throw new HttpError(409, `Code ${rest.code} is already used`);
      const patch: Partial<typeof deviceTypes.$inferInsert> = { ...rest };
      if (retired !== undefined) patch.retiredAt = retired ? new Date() : null;
      const [t] = await db
        .update(deviceTypes)
        .set(patch)
        .where(eq(deviceTypes.id, req.params.id))
        .returning();
      if (!t) throw new HttpError(404, 'Device type not found');
      changed(req);
      return (await loadLibrary(db)).types.find((x) => x.id === t.id)!;
    },
  );

  // R-25: only unused types can be deleted; used ones must be retired.
  app.delete(
    '/api/device-library/types/:id',
    { schema: { tags: ['library'], params: P }, preHandler: admin },
    async (req) => {
      const r = await db.execute(
        sql`select count(*)::int as n from markers where type_id = ${req.params.id}`,
      );
      if ((r.rows[0] as any).n > 0)
        throw new HttpError(
          409,
          'This type is used by markers (including deleted ones kept for 30 days). Retire it instead.',
        );
      await db.delete(deviceTypes).where(eq(deviceTypes.id, req.params.id));
      changed(req);
      return { ok: true };
    },
  );

  app.post(
    '/api/device-library/types/reorder',
    {
      schema: { tags: ['library'], body: ReorderBody.extend({ categoryId: Id.optional() }) },
      preHandler: admin,
    },
    async (req) => {
      await db.transaction(async (tx) => {
        for (const [i, id] of req.body.ids.entries()) {
          const patch: Partial<typeof deviceTypes.$inferInsert> = { sortOrder: i };
          if (req.body.categoryId) patch.categoryId = req.body.categoryId;
          await tx.update(deviceTypes).set(patch).where(eq(deviceTypes.id, id));
        }
      });
      changed(req);
      return { ok: true };
    },
  );
};
