import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  Activity,
  CreateProjectBody,
  DuplicateProjectBody,
  Floor,
  formatTag,
  Id,
  planRenumber,
  Project,
  RenumberBody,
  RenumberResponse,
  UpdateProjectBody,
} from '@sixpoint/shared';
import { activity, deviceTypes, floors, markers, projects, users, zones } from '../db/schema';
import { HttpError, requireRole, requireUser } from '../lib/auth';
import { floorDto, markerDto } from '../lib/dto';
import { getProjectDto, listProjects, requireProject, touchProject } from '../services/projects';
import { lockProject, logActivity } from '../services/markers';

const P = z.object({ id: Id });

export const projectRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, hub } = app.ctx;
  const editor = requireRole('editor');
  const admin = requireRole('admin');

  // R-15
  app.get(
    '/api/projects',
    {
      schema: {
        tags: ['projects'],
        querystring: z.object({
          q: z.string().optional(),
          view: z.enum(['active', 'archived', 'trash']).default('active'),
        }),
        response: { 200: z.array(Project) },
      },
      preHandler: requireUser,
    },
    async (req) => {
      if (req.query.view === 'trash' && req.user!.role !== 'admin')
        throw new HttpError(403, 'Requires admin role');
      return listProjects(db, { q: req.query.q, view: req.query.view });
    },
  );

  app.post(
    '/api/projects',
    {
      schema: { tags: ['projects'], body: CreateProjectBody, response: { 200: Project } },
      preHandler: editor,
    },
    async (req) => {
      const [p] = await db
        .insert(projects)
        .values({ ...req.body, createdBy: req.user!.id, updatedBy: req.user!.id })
        .returning();
      return getProjectDto(db, p.id);
    },
  );

  app.get(
    '/api/projects/:id',
    {
      schema: {
        tags: ['projects'],
        params: P,
        response: { 200: z.object({ project: Project, floors: z.array(Floor) }) },
      },
      preHandler: requireUser,
    },
    async (req) => {
      const project = await getProjectDto(db, req.params.id);
      const fl = await db
        .select()
        .from(floors)
        .where(and(eq(floors.projectId, req.params.id), isNull(floors.deletedAt)))
        .orderBy(asc(floors.sortOrder), asc(floors.id));
      return { project, floors: fl.map(floorDto) };
    },
  );

  // R-16, archive, restore from trash (R-54)
  app.patch(
    '/api/projects/:id',
    {
      schema: { tags: ['projects'], params: P, body: UpdateProjectBody, response: { 200: Project } },
      preHandler: editor,
    },
    async (req) => {
      const { archived, restore, ...fields } = req.body;
      const p = (await db.select().from(projects).where(eq(projects.id, req.params.id)))[0];
      if (!p) throw new HttpError(404, 'Project not found');
      const patch: Partial<typeof projects.$inferInsert> = {
        ...fields,
        updatedAt: new Date(),
        updatedBy: req.user!.id,
      };
      if (p.deletedAt) {
        if (!restore) throw new HttpError(404, 'Project not found');
        if (req.user!.role !== 'admin') throw new HttpError(403, 'Requires admin role');
        patch.deletedAt = null;
      }
      if (archived !== undefined) patch.archivedAt = archived ? new Date() : null;
      await db.update(projects).set(patch).where(eq(projects.id, p.id));
      const dto = await getProjectDto(db, p.id);
      hub.publish(p.id, { type: 'project.update', origin: req.clientId, project: dto });
      return dto;
    },
  );

  app.delete(
    '/api/projects/:id',
    { schema: { tags: ['projects'], params: P }, preHandler: admin },
    async (req) => {
      const p = await requireProject(db, req.params.id);
      await db
        .update(projects)
        .set({ deletedAt: new Date(), updatedBy: req.user!.id })
        .where(eq(projects.id, p.id));
      const dto = await getProjectDto(db, p.id, true);
      hub.publish(p.id, { type: 'project.update', origin: req.clientId, project: dto });
      return { ok: true };
    },
  );

  // R-23
  app.post(
    '/api/projects/:id/duplicate',
    {
      schema: { tags: ['projects'], params: P, body: DuplicateProjectBody, response: { 200: Project } },
      preHandler: editor,
    },
    async (req) => {
      const src = await requireProject(db, req.params.id);
      const newId = await db.transaction(async (tx) => {
        const [p] = await tx
          .insert(projects)
          .values({
            name: req.body.name,
            client: src.client,
            address: src.address,
            jobNumber: src.jobNumber,
            notes: src.notes,
            extraWireFt: src.extraWireFt,
            createdBy: req.user!.id,
            updatedBy: req.user!.id,
          })
          .returning();
        const fl = await tx
          .select()
          .from(floors)
          .where(and(eq(floors.projectId, src.id), isNull(floors.deletedAt)));
        const floorMap = new Map<string, string>();
        for (const f of fl) {
          const id = randomUUID();
          floorMap.set(f.id, id);
          await tx.insert(floors).values({
            ...f,
            id,
            projectId: p.id,
            uploadId: null,
            uploadPage: null,
            updatedAt: new Date(),
          });
        }
        // zones (rooms, closets) belong to the sheets, so they always come along
        const zoneMap = new Map<string, string>();
        const zs = await tx
          .select()
          .from(zones)
          .where(and(eq(zones.projectId, src.id), isNull(zones.deletedAt)));
        for (const z of zs) {
          if (!floorMap.has(z.floorId)) continue;
          const id = randomUUID();
          zoneMap.set(z.id, id);
          await tx.insert(zones).values({
            ...z,
            id,
            projectId: p.id,
            floorId: floorMap.get(z.floorId)!,
            createdBy: req.user!.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        if (req.body.withMarkers && fl.length) {
          const ms = await tx
            .select()
            .from(markers)
            .where(and(eq(markers.projectId, src.id), isNull(markers.deletedAt)));
          const rows = ms
            .filter((m) => floorMap.has(m.floorId))
            .map((m) => ({
              ...m,
              id: randomUUID(),
              projectId: p.id,
              floorId: floorMap.get(m.floorId)!,
              closetZoneId: m.closetZoneId ? (zoneMap.get(m.closetZoneId) ?? null) : null,
              createdBy: req.user!.id,
              updatedBy: req.user!.id,
              createdAt: new Date(),
              updatedAt: new Date(),
            }));
          for (let i = 0; i < rows.length; i += 500) await tx.insert(markers).values(rows.slice(i, i + 500));
        }
        return p.id;
      });
      return getProjectDto(db, newId);
    },
  );

  // R-55
  app.get(
    '/api/projects/:id/activity',
    {
      schema: { tags: ['projects'], params: P, response: { 200: z.array(Activity) } },
      preHandler: requireUser,
    },
    async (req) => {
      await requireProject(db, req.params.id);
      const rows = await db
        .select({ a: activity, userName: users.name })
        .from(activity)
        .leftJoin(users, eq(users.id, activity.userId))
        .where(eq(activity.projectId, req.params.id))
        .orderBy(desc(activity.at), desc(activity.id))
        .limit(50);
      const types = new Map((await db.select().from(deviceTypes)).map((t) => [t.id, t.code]));
      const tagOf = (s: any) => (s ? `${types.get(s.typeId) ?? '?'}${s.number}` : '');
      return rows.map(({ a, userName }) => ({
        id: a.id,
        userName,
        markerId: a.markerId,
        action: a.action,
        summary: summarize(a.action, a.before as any, a.after as any, tagOf),
        at: a.at.toISOString(),
      }));
    },
  );

  // R-30: preview (apply=false) or apply
  app.post(
    '/api/projects/:id/renumber',
    {
      schema: { tags: ['markers'], params: P, body: RenumberBody, response: { 200: RenumberResponse } },
      preHandler: editor,
    },
    async (req) => {
      const projectId = req.params.id;
      await requireProject(db, projectId);
      const result = await db.transaction(async (tx) => {
        await lockProject(tx, projectId);
        const fl = await tx
          .select({ id: floors.id })
          .from(floors)
          .where(and(eq(floors.projectId, projectId), isNull(floors.deletedAt)))
          .orderBy(asc(floors.sortOrder), asc(floors.id));
        const ms = await tx
          .select()
          .from(markers)
          .where(and(eq(markers.projectId, projectId), isNull(markers.deletedAt)));
        const types = new Map((await tx.select().from(deviceTypes)).map((t) => [t.id, t.code]));
        const plan = planRenumber(
          ms,
          fl.map((f) => f.id),
          req.body.typeId,
        );
        const byId = new Map(ms.map((m) => [m.id, m]));
        const changes = plan
          .filter((c) => c.oldNumber !== c.newNumber)
          .map((c) => ({
            ...c,
            floorId: byId.get(c.id)!.floorId,
            oldTag: formatTag(types.get(c.typeId) ?? '?', c.oldNumber),
            newTag: formatTag(types.get(c.typeId) ?? '?', c.newNumber),
          }));
        if (req.body.apply && changes.length) {
          const now = new Date();
          for (const c of changes) {
            await tx
              .update(markers)
              .set({ number: c.newNumber, updatedAt: now, updatedBy: req.user!.id })
              .where(eq(markers.id, c.id));
          }
          await logActivity(tx, projectId, req.user!.id, null, 'renumber', null, {
            count: changes.length,
            changes: changes.map((c) => [c.oldTag, c.newTag]),
          });
          await touchProject(tx, projectId, req.user!.id);
        }
        return changes;
      });
      if (req.body.apply && result.length) {
        const rows = await db
          .select()
          .from(markers)
          .where(
            inArray(
              markers.id,
              result.map((c) => c.id),
            ),
          );
        hub.publish(projectId, { type: 'marker.upsert', origin: req.clientId, markers: rows.map(markerDto) });
      }
      return { changes: result, applied: req.body.apply };
    },
  );

  // Room suggestions (R-43) are derived client-side; this helper serves scripts.
  app.get(
    '/api/projects/:id/rooms',
    {
      schema: { tags: ['projects'], params: P, response: { 200: z.array(z.string()) } },
      preHandler: requireUser,
    },
    async (req) => {
      const r = await db.execute(
        sql`select distinct on (lower(room)) room from markers where project_id = ${req.params.id}
            and deleted_at is null and room <> '' order by lower(room), room`,
      );
      return (r.rows as any[]).map((x) => x.room);
    },
  );
};

function summarize(action: string, before: any, after: any, tagOf: (s: any) => string): string {
  switch (action) {
    case 'create':
      return `Placed ${tagOf(after)}${after?.room ? ` in ${after.room}` : ''}`;
    case 'move':
      return `Moved ${tagOf(after)}`;
    case 'delete':
      return `Deleted ${tagOf(before)}`;
    case 'restore':
      return `Restored ${tagOf(after)}`;
    case 'zone.create':
      return `Added ${after?.kind === 'closet' ? 'equipment closet' : 'zone'} ${after?.name ?? ''}`;
    case 'zone.edit':
      return `Edited zone ${after?.name ?? ''}`;
    case 'zone.delete':
      return `Deleted zone ${before?.name ?? ''}`;
    case 'renumber':
      return `Renumbered ${after?.count ?? 0} devices`;
    case 'edit': {
      const fields: string[] = [];
      if (before && after) {
        if (before.typeId !== after.typeId || before.number !== after.number)
          fields.push(`tag ${tagOf(before)} → ${tagOf(after)}`);
        for (const k of ['room', 'mountHeight', 'notes'] as const)
          if (before[k] !== after[k]) fields.push(k === 'mountHeight' ? 'mount height' : k);
      }
      return `Edited ${tagOf(after)}${fields.length ? ` (${fields.join(', ')})` : ''}`;
    }
    default:
      return action;
  }
}
