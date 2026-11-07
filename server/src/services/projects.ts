import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Project } from '@sixpoint/shared';
import type { DB, Tx } from '../db';
import { projects } from '../db/schema';
import { HttpError } from '../lib/auth';
import { fileUrl } from '../lib/storage';

type Q = DB | Tx;

export interface ListOpts {
  q?: string;
  view?: 'active' | 'archived' | 'trash' | 'live' | 'any';
  ids?: string[];
}

/** Projects with list columns: counts, thumbnail, last editor (R-15). */
export async function listProjects(db: Q, opts: ListOpts = {}): Promise<Project[]> {
  const view = opts.view ?? 'active';
  const where = [
    view === 'any' ? sql`true` : view === 'trash' ? sql`p.deleted_at is not null` : sql`p.deleted_at is null`,
    view === 'archived' ? sql`p.archived_at is not null` : view === 'active' ? sql`p.archived_at is null` : sql`true`,
  ];
  if (opts.q?.trim()) {
    const like = `%${opts.q.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push(sql`(p.name ilike ${like} or p.client ilike ${like} or p.address ilike ${like} or p.job_number ilike ${like})`);
  }
  if (opts.ids) {
    if (!opts.ids.length) return [];
    where.push(sql`p.id in (${sql.join(
      opts.ids.map((i) => sql`${i}::uuid`),
      sql`, `,
    )})`);
  }
  const res = await db.execute(sql`
    select p.id, p.name, p.client, p.address, p.job_number, p.notes, p.archived_at, p.deleted_at, p.created_by,
           p.updated_at, u.name as updated_by_name,
           (select count(*)::int from floors f where f.project_id = p.id and f.deleted_at is null) as floor_count,
           (select count(*)::int from markers m join floors f on f.id = m.floor_id
              where m.project_id = p.id and m.deleted_at is null and f.deleted_at is null) as device_count,
           (select f.thumb_path from floors f where f.project_id = p.id and f.deleted_at is null
              order by f.sort_order, f.id limit 1) as thumb_path
    from projects p left join users u on u.id = p.updated_by
    where ${sql.join(where, sql` and `)}
    order by p.updated_at desc
    limit 500`);
  return (res.rows as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    client: r.client,
    address: r.address,
    jobNumber: r.job_number,
    notes: r.notes,
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
    deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
    createdBy: r.created_by,
    updatedAt: new Date(r.updated_at).toISOString(),
    updatedByName: r.updated_by_name,
    floorCount: r.floor_count,
    deviceCount: r.device_count,
    thumbUrl: r.thumb_path ? fileUrl(r.thumb_path) : null,
  }));
}

export async function getProjectDto(db: Q, id: string, allowDeleted = false): Promise<Project> {
  const rows = await listProjects(db, { ids: [id], view: allowDeleted ? 'any' : 'live' });
  if (!rows[0]) throw new HttpError(404, 'Project not found');
  return rows[0];
}

/** Live (not deleted) project row or 404. */
export async function requireProject(db: Q, id: string) {
  const p = (await db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt))))[0];
  if (!p) throw new HttpError(404, 'Project not found');
  return p;
}

export async function touchProject(db: Q, id: string, userId: string | null) {
  await db.update(projects).set({ updatedAt: new Date(), updatedBy: userId }).where(eq(projects.id, id));
}
