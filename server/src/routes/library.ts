import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  Category,
  CreateCategoryBody,
  CreateTypeBody,
  DEFAULT_SNAP,
  DeviceType,
  Id,
  Library,
  ReorderBody,
  SEED_LIBRARY,
  SEED_TYPE_COVERAGE,
  SEED_TYPE_WIRES,
  SEED_WIRE_TYPES,
  SnapSettings,
  UpdateCategoryBody,
  UpdateTypeBody,
  WireType,
  WireTypeBody,
  ZoneName,
  ZoneNameBody,
} from '@sixpoint/shared';
import type { DB } from '../db';
import {
  appSettings,
  deviceCategories,
  deviceTypes,
  deviceTypeWires,
  wireTypes,
  zoneNames,
} from '../db/schema';
import { HttpError, requireRole, requireUser } from '../lib/auth';
import { DEFAULT_ICONS } from '../lib/defaultIcons';
import { fileUrl, ICON_MAX_MB, type Storage } from '../lib/storage';

const P = z.object({ id: Id });
const SNAP_KEY = 'snap';

export async function seedLibrary(db: DB) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(deviceCategories);
  if (n > 0) return false;
  await db.transaction(async (tx) => {
    for (const [ci, c] of SEED_LIBRARY.entries()) {
      const [cat] = await tx
        .insert(deviceCategories)
        .values({ name: c.name, colorHex: c.color, sortOrder: ci })
        .returning();
      await tx.insert(deviceTypes).values(
        c.types.map((t, ti) => ({
          categoryId: cat.id,
          code: t.code,
          name: t.name,
          sortOrder: ti,
          coverage: SEED_TYPE_COVERAGE[t.code] ?? null,
        })),
      );
    }
  });
  return true;
}

/** Seed wire types and default wiring once (also for installs created before wiring existed). */
/**
 * Give seeded device types their default icon, once per type: an icon an admin replaced is kept,
 * and one an admin removed stays removed across restarts.
 */
export async function seedDefaultIcons(db: DB, storage: Storage) {
  const types = await db.select().from(deviceTypes).where(eq(deviceTypes.iconSeeded, false));
  let added = 0;
  for (const t of types) {
    const def = t.iconPath ? null : DEFAULT_ICONS[t.code];
    const iconPath = def ? await storage.storeIcon(def) : t.iconPath;
    if (def) added++;
    await db.update(deviceTypes).set({ iconPath, iconSeeded: true }).where(eq(deviceTypes.id, t.id));
  }
  return added;
}

export async function seedWires(db: DB) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(wireTypes);
  if (n > 0) return false;
  await db.transaction(async (tx) => {
    const rows = await tx
      .insert(wireTypes)
      .values(SEED_WIRE_TYPES.map((name, i) => ({ name, sortOrder: i })))
      .returning();
    const byName = new Map(rows.map((r) => [r.name, r.id]));
    const types = await tx.select().from(deviceTypes);
    const links = types.flatMap((t) =>
      (SEED_TYPE_WIRES[t.code] ?? []).map(([w, count]) => ({
        typeId: t.id,
        wireTypeId: byName.get(w)!,
        count,
      })),
    );
    if (links.length) await tx.insert(deviceTypeWires).values(links).onConflictDoNothing();
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
  const wt = await db.select().from(wireTypes).orderBy(asc(wireTypes.sortOrder), asc(wireTypes.name));
  const links = await db.select().from(deviceTypeWires);
  const wireOrder = new Map(wt.map((w, i) => [w.id, i]));
  const wiresOf = new Map<string, { wireTypeId: string; count: number }[]>();
  for (const l of links.sort(
    (a, b) => (wireOrder.get(a.wireTypeId) ?? 0) - (wireOrder.get(b.wireTypeId) ?? 0),
  )) {
    const list = wiresOf.get(l.typeId) ?? [];
    list.push({ wireTypeId: l.wireTypeId, count: l.count });
    wiresOf.set(l.typeId, list);
  }
  const wireUse = new Map<string, number>();
  for (const l of links) wireUse.set(l.wireTypeId, (wireUse.get(l.wireTypeId) ?? 0) + 1);
  const zn = await db.select().from(zoneNames).orderBy(asc(zoneNames.sortOrder), asc(zoneNames.name));
  const snap = (await db.select().from(appSettings).where(eq(appSettings.key, SNAP_KEY)))[0]?.value;
  return {
    snap: { ...DEFAULT_SNAP, ...(snap as Partial<SnapSettings> | undefined) },
    zoneNames: zn.map((z) => ({ id: z.id, name: z.name, sortOrder: z.sortOrder })),
    wireTypes: wt.map((w) => ({
      id: w.id,
      name: w.name,
      sortOrder: w.sortOrder,
      inUse: wireUse.get(w.id) ?? 0,
    })),
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
      wires: wiresOf.get(t.id) ?? [],
      coverage: t.coverage ?? null,
      iconUrl: t.iconPath ? fileUrl(t.iconPath) : null,
      iconLabel: t.iconLabel,
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
        .values({ ...req.body, sortOrder: n, iconSeeded: true })
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
      const { retired, wires, ...rest } = req.body;
      if (rest.code && (await codeTaken(rest.code, req.params.id)))
        throw new HttpError(409, `Code ${rest.code} is already used`);
      const patch: Partial<typeof deviceTypes.$inferInsert> = { ...rest };
      if (retired !== undefined) patch.retiredAt = retired ? new Date() : null;
      if (wires) {
        await db.transaction(async (tx) => {
          await tx.delete(deviceTypeWires).where(eq(deviceTypeWires.typeId, req.params.id));
          const merged = new Map<string, number>();
          for (const w of wires) merged.set(w.wireTypeId, (merged.get(w.wireTypeId) ?? 0) + w.count);
          if (merged.size)
            await tx
              .insert(deviceTypeWires)
              .values(
                [...merged].map(([wireTypeId, count]) => ({ typeId: req.params.id, wireTypeId, count })),
              );
        });
      }
      const [t] = Object.keys(patch).length
        ? await db.update(deviceTypes).set(patch).where(eq(deviceTypes.id, req.params.id)).returning()
        : await db.select().from(deviceTypes).where(eq(deviceTypes.id, req.params.id));
      if (!t) throw new HttpError(404, 'Device type not found');
      changed(req);
      return (await loadLibrary(db)).types.find((x) => x.id === t.id)!;
    },
  );

  app.put(
    '/api/device-library/snap',
    {
      schema: {
        tags: ['library'],
        description: 'How strongly zone corners snap, as pull distances in screen pixels (0 = off).',
        body: SnapSettings,
        response: { 200: SnapSettings },
      },
      preHandler: admin,
    },
    async (req) => {
      await db
        .insert(appSettings)
        .values({ key: SNAP_KEY, value: req.body })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: req.body, updatedAt: new Date() },
        });
      changed(req);
      return req.body;
    },
  );

  app.post(
    '/api/device-library/types/:id/icon',
    {
      schema: {
        tags: ['library'],
        params: P,
        consumes: ['multipart/form-data'],
        description: 'Set the icon (multipart "file": PNG, JPG, WebP or SVG, up to 2 MB).',
        response: { 200: DeviceType },
      },
      preHandler: admin,
    },
    async (req) => {
      const file = await req.file({ limits: { fileSize: ICON_MAX_MB * 1024 * 1024, files: 1 } });
      if (!file) throw new HttpError(400, 'No file in the request');
      let buf: Buffer;
      try {
        buf = await file.toBuffer();
      } catch (e: any) {
        if (e.code === 'FST_REQ_FILE_TOO_LARGE')
          throw new HttpError(413, `Icons can be up to ${ICON_MAX_MB} MB`);
        throw e;
      }
      const iconPath = await app.ctx.storage.storeIcon(buf);
      const [t] = await db
        .update(deviceTypes)
        .set({ iconPath, iconSeeded: true })
        .where(eq(deviceTypes.id, req.params.id))
        .returning();
      if (!t) throw new HttpError(404, 'Device type not found');
      changed(req);
      return (await loadLibrary(db)).types.find((x) => x.id === t.id)!;
    },
  );

  app.delete(
    '/api/device-library/types/:id/icon',
    { schema: { tags: ['library'], params: P, response: { 200: DeviceType } }, preHandler: admin },
    async (req) => {
      const [t] = await db
        .update(deviceTypes)
        .set({ iconPath: null, iconSeeded: true })
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

  /* ---------- wire types ---------- */

  app.post(
    '/api/device-library/wire-types',
    { schema: { tags: ['library'], body: WireTypeBody, response: { 200: WireType } }, preHandler: admin },
    async (req) => {
      const [{ n }] = await db
        .select({ n: sql<number>`coalesce(max(sort_order), -1)::int + 1` })
        .from(wireTypes);
      const [w] = await db.insert(wireTypes).values({ name: req.body.name, sortOrder: n }).returning();
      changed(req);
      return { id: w.id, name: w.name, sortOrder: w.sortOrder, inUse: 0 };
    },
  );

  app.patch(
    '/api/device-library/wire-types/:id',
    {
      schema: { tags: ['library'], params: P, body: WireTypeBody, response: { 200: WireType } },
      preHandler: admin,
    },
    async (req) => {
      const [w] = await db
        .update(wireTypes)
        .set({ name: req.body.name })
        .where(eq(wireTypes.id, req.params.id))
        .returning();
      if (!w) throw new HttpError(404, 'Wire type not found');
      changed(req);
      return (await loadLibrary(db)).wireTypes.find((x) => x.id === w.id)!;
    },
  );

  app.delete(
    '/api/device-library/wire-types/:id',
    { schema: { tags: ['library'], params: P }, preHandler: admin },
    async (req) => {
      await db.delete(wireTypes).where(eq(wireTypes.id, req.params.id));
      changed(req);
      return { ok: true };
    },
  );

  app.post(
    '/api/device-library/wire-types/reorder',
    { schema: { tags: ['library'], body: ReorderBody }, preHandler: admin },
    async (req) => {
      await db.transaction(async (tx) => {
        for (const [i, id] of req.body.ids.entries())
          await tx.update(wireTypes).set({ sortOrder: i }).where(eq(wireTypes.id, id));
      });
      changed(req);
      return { ok: true };
    },
  );
  /* ---------- zone names (autocomplete list) ---------- */

  const uniqueName = async (name: string, except?: string) => {
    const hit = (
      await db
        .select()
        .from(zoneNames)
        .where(sql`lower(${zoneNames.name}) = lower(${name})`)
    )[0];
    if (hit && hit.id !== except) throw new HttpError(409, `${hit.name} is already in the list`);
  };

  app.post(
    '/api/device-library/zone-names',
    { schema: { tags: ['library'], body: ZoneNameBody, response: { 200: ZoneName } }, preHandler: admin },
    async (req) => {
      await uniqueName(req.body.name);
      const [{ n }] = await db
        .select({ n: sql<number>`coalesce(max(sort_order), -1)::int + 1` })
        .from(zoneNames);
      const [z] = await db.insert(zoneNames).values({ name: req.body.name, sortOrder: n }).returning();
      changed(req);
      return { id: z.id, name: z.name, sortOrder: z.sortOrder };
    },
  );

  app.patch(
    '/api/device-library/zone-names/:id',
    {
      schema: { tags: ['library'], params: P, body: ZoneNameBody, response: { 200: ZoneName } },
      preHandler: admin,
    },
    async (req) => {
      await uniqueName(req.body.name, req.params.id);
      const [z] = await db
        .update(zoneNames)
        .set({ name: req.body.name })
        .where(eq(zoneNames.id, req.params.id))
        .returning();
      if (!z) throw new HttpError(404, 'Zone name not found');
      changed(req);
      return { id: z.id, name: z.name, sortOrder: z.sortOrder };
    },
  );

  app.delete(
    '/api/device-library/zone-names/:id',
    { schema: { tags: ['library'], params: P }, preHandler: admin },
    async (req) => {
      await db.delete(zoneNames).where(eq(zoneNames.id, req.params.id));
      changed(req);
      return { ok: true };
    },
  );

  app.post(
    '/api/device-library/zone-names/reorder',
    { schema: { tags: ['library'], body: ReorderBody }, preHandler: admin },
    async (req) => {
      await db.transaction(async (tx) => {
        for (const [i, id] of req.body.ids.entries())
          await tx.update(zoneNames).set({ sortOrder: i }).where(eq(zoneNames.id, id));
      });
      changed(req);
      return { ok: true };
    },
  );
};
