import { and, eq, isNull, sql } from 'drizzle-orm';
import type { MarkerPatch, PutMarkerBody } from '@sixpoint/shared';
import { toFraction } from '@sixpoint/shared';
import type { DB, Tx } from '../db';
import { activity, deviceTypes, floors, markers } from '../db/schema';
import { HttpError } from '../lib/auth';

type MarkerRow = typeof markers.$inferSelect;

/** Serialize numbering per project so two users placing at once never get the same tag (R-29). */
export async function lockProject(tx: Tx, projectId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'markers:' + projectId}))`);
}

export async function nextNumberDb(tx: Tx, projectId: string, typeId: string): Promise<number> {
  const r = await tx.execute(
    sql`select coalesce(max(number), 0) + 1 as n from markers
        where project_id = ${projectId} and type_id = ${typeId} and deleted_at is null`,
  );
  return Number((r.rows[0] as any).n);
}

async function checkFloor(tx: Tx, projectId: string, floorId: string) {
  const f = (await tx.select({ id: floors.id, projectId: floors.projectId, deletedAt: floors.deletedAt }).from(floors).where(eq(floors.id, floorId)))[0];
  if (!f || f.projectId !== projectId || f.deletedAt) throw new HttpError(400, 'Floor not found in this project');
}

async function checkType(tx: Tx, typeId: string) {
  const t = (await tx.select({ id: deviceTypes.id }).from(deviceTypes).where(eq(deviceTypes.id, typeId)))[0];
  if (!t) throw new HttpError(400, 'Unknown device type');
}

function snapshot(m: MarkerRow | undefined | null) {
  if (!m) return null;
  return {
    floorId: m.floorId,
    typeId: m.typeId,
    number: m.number,
    x: m.x,
    y: m.y,
    room: m.room,
    mountHeight: m.mountHeight,
    notes: m.notes,
  };
}

function classify(before: MarkerRow | undefined, after: MarkerRow): string {
  if (!before) return 'create';
  if (before.deletedAt) return 'restore';
  const moved = before.x !== after.x || before.y !== after.y || before.floorId !== after.floorId;
  const edited =
    before.typeId !== after.typeId ||
    before.number !== after.number ||
    before.room !== after.room ||
    before.mountHeight !== after.mountHeight ||
    before.notes !== after.notes;
  return moved && !edited ? 'move' : 'edit';
}

export async function logActivity(
  tx: DB | Tx,
  projectId: string,
  userId: string | null,
  markerId: string | null,
  action: string,
  before: unknown,
  after: unknown,
) {
  await tx.insert(activity).values({ projectId, userId, markerId, action, before: before ?? null, after: after ?? null });
}

export class Rejected extends Error {}

/** Create or update by client UUID (R-49, R-52). Must run inside a transaction holding lockProject. */
export async function upsertMarker(tx: Tx, userId: string, id: string, body: PutMarkerBody): Promise<MarkerRow> {
  const existing = (await tx.select().from(markers).where(eq(markers.id, id)))[0];
  if (existing && existing.projectId !== body.projectId) throw new HttpError(400, 'Marker belongs to another project');
  if (existing?.deletedAt && !body.restore) throw new Rejected('Marker was deleted');
  await checkFloor(tx, body.projectId, body.floorId);
  if (!existing || existing.typeId !== body.typeId) await checkType(tx, body.typeId);

  let number = body.number;
  const typeChanged = existing && existing.typeId !== body.typeId;
  if (body.autoNumber || number === undefined) {
    number = !existing || typeChanged ? await nextNumberDb(tx, body.projectId, body.typeId) : existing.number;
  }
  const values = {
    floorId: body.floorId,
    typeId: body.typeId,
    number: number!,
    x: toFraction(body.x),
    y: toFraction(body.y),
    room: body.room ?? '',
    mountHeight: body.mountHeight ?? '',
    notes: body.notes ?? '',
    updatedBy: userId,
    updatedAt: new Date(),
    deletedAt: null,
  };
  let row: MarkerRow;
  if (existing) {
    [row] = await tx.update(markers).set(values).where(eq(markers.id, id)).returning();
  } else {
    [row] = await tx
      .insert(markers)
      .values({ ...values, id, projectId: body.projectId, createdBy: userId })
      .returning();
  }
  const action = classify(existing, row);
  await logActivity(tx, body.projectId, userId, id, action, existing?.deletedAt ? null : snapshot(existing), snapshot(row));
  return row;
}

export async function patchMarker(tx: Tx, userId: string, projectId: string, p: MarkerPatch): Promise<MarkerRow> {
  const existing = (await tx.select().from(markers).where(eq(markers.id, p.id)))[0];
  if (!existing || existing.deletedAt || existing.projectId !== projectId) throw new Rejected('Marker not found');
  return upsertMarker(tx, userId, p.id, {
    projectId,
    floorId: p.floorId ?? existing.floorId,
    typeId: p.typeId ?? existing.typeId,
    number: p.autoNumber ? undefined : (p.number ?? (p.typeId && p.typeId !== existing.typeId ? undefined : existing.number)),
    autoNumber: p.autoNumber,
    x: p.x ?? existing.x,
    y: p.y ?? existing.y,
    room: p.room ?? existing.room,
    mountHeight: p.mountHeight ?? existing.mountHeight,
    notes: p.notes ?? existing.notes,
  });
}

export async function softDeleteMarker(tx: Tx, userId: string, id: string, projectId?: string): Promise<MarkerRow | null> {
  const existing = (await tx.select().from(markers).where(and(eq(markers.id, id), isNull(markers.deletedAt))))[0];
  if (!existing || (projectId && existing.projectId !== projectId)) return null;
  const [row] = await tx
    .update(markers)
    .set({ deletedAt: new Date(), updatedAt: new Date(), updatedBy: userId })
    .where(eq(markers.id, id))
    .returning();
  await logActivity(tx, existing.projectId, userId, id, 'delete', snapshot(existing), null);
  return row;
}
