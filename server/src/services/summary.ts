import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  projectSummary,
  type ExportType,
  type Library,
  type ProjectSummary,
  type RunFloor,
} from '@sixpoint/shared';
import type { DB } from '../db';
import { floors, markers, zones } from '../db/schema';
import { loadLibrary } from '../routes/library';
import { requireProject } from './projects';

/** Everything the exports need: project, ordered floors, zones, markers, library, cable summary. */
export async function loadProjectData(db: DB, projectId: string) {
  const project = await requireProject(db, projectId);
  const fl = await db
    .select()
    .from(floors)
    .where(and(eq(floors.projectId, projectId), isNull(floors.deletedAt)))
    .orderBy(asc(floors.sortOrder), asc(floors.id));
  const floorIds = new Set(fl.map((f) => f.id));
  const ms = (
    await db
      .select()
      .from(markers)
      .where(and(eq(markers.projectId, projectId), isNull(markers.deletedAt)))
  ).filter((m) => floorIds.has(m.floorId));
  const zs = (
    await db
      .select()
      .from(zones)
      .where(and(eq(zones.projectId, projectId), isNull(zones.deletedAt)))
  )
    .filter((z) => floorIds.has(z.floorId))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const lib = await loadLibrary(db);
  const summary = summarize(lib, fl, zs, ms, project.extraWireFt);
  const cats = new Map(lib.categories.map((c) => [c.id, c]));
  const types = new Map<string, ExportType>(
    lib.types.map((t, i) => [
      t.id,
      {
        id: t.id,
        code: t.code,
        name: t.name,
        category: cats.get(t.categoryId)?.name ?? '',
        color: cats.get(t.categoryId)?.color ?? '#6b7280',
        order: i,
      },
    ]),
  );
  return { project, floors: fl, zones: zs, markers: ms, lib, types, summary };
}

export function runFloors(fl: (typeof floors.$inferSelect)[]): RunFloor[] {
  return fl.map((f) => ({
    id: f.id,
    name: f.name,
    widthPx: f.widthPx,
    heightPx: f.heightPx,
    ftPerPx: f.ftPerPx,
    floorHeightFt: f.floorHeightFt,
    riser: f.riserX != null && f.riserY != null ? { x: f.riserX, y: f.riserY } : null,
  }));
}

export function summarize(
  lib: Library,
  fl: (typeof floors.$inferSelect)[],
  zs: (typeof zones.$inferSelect)[],
  ms: (typeof markers.$inferSelect)[],
  extraFt: number,
): ProjectSummary {
  const audioCats = new Set(lib.categories.filter((c) => c.name.toLowerCase() === 'audio').map((c) => c.id));
  return projectSummary({
    floors: runFloors(fl),
    zones: zs.map((z) => ({
      id: z.id,
      floorId: z.floorId,
      name: z.name,
      kind: z.kind,
      points: z.points,
      audioFormat: z.audioFormat,
    })),
    markers: ms.map((m) => ({
      id: m.id,
      floorId: m.floorId,
      x: m.x,
      y: m.y,
      closetZoneId: m.closetZoneId,
      typeId: m.typeId,
    })),
    typeWires: new Map(lib.types.map((t) => [t.id, t.wires])),
    wireTypes: lib.wireTypes,
    audioTypeIds: new Set(lib.types.filter((t) => audioCats.has(t.categoryId)).map((t) => t.id)),
    extraFt,
  });
}
