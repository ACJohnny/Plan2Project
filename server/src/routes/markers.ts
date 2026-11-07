import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { BatchMarkersBody, BatchMarkersResponse, Id, Marker, PutMarkerBody } from '@sixpoint/shared';
import { markers } from '../db/schema';
import { HttpError, requireRole, requireUser } from '../lib/auth';
import { markerDto } from '../lib/dto';
import { lockProject, patchMarker, Rejected, softDeleteMarker, upsertMarker } from '../services/markers';
import { requireProject, touchProject } from '../services/projects';

const P = z.object({ id: Id });

export const markerRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, hub } = app.ctx;
  const editor = requireRole('editor');

  app.get(
    '/api/projects/:id/markers',
    {
      schema: {
        tags: ['markers'],
        params: P,
        querystring: z.object({ floorId: Id.optional() }),
        response: { 200: z.array(Marker) },
      },
      preHandler: requireUser,
    },
    async (req) => {
      await requireProject(db, req.params.id);
      const conds = [eq(markers.projectId, req.params.id), isNull(markers.deletedAt)];
      if (req.query.floorId) conds.push(eq(markers.floorId, req.query.floorId));
      const rows = await db
        .select()
        .from(markers)
        .where(and(...conds));
      return rows.map(markerDto);
    },
  );

  // Upsert by client UUID (R-49). 410 when writing to a deleted marker (R-52) unless restore=true (undo, R-37).
  app.put(
    '/api/markers/:id',
    {
      schema: { tags: ['markers'], params: P, body: PutMarkerBody, response: { 200: Marker } },
      preHandler: editor,
    },
    async (req) => {
      await requireProject(db, req.body.projectId);
      let row;
      try {
        row = await db.transaction(async (tx) => {
          await lockProject(tx, req.body.projectId);
          const r = await upsertMarker(tx, req.user!.id, req.params.id, req.body);
          await touchProject(tx, req.body.projectId, req.user!.id);
          return r;
        });
      } catch (e) {
        if (e instanceof Rejected) throw new HttpError(410, e.message);
        throw e;
      }
      const dto = markerDto(row);
      hub.publish(req.body.projectId, { type: 'marker.upsert', origin: req.clientId, markers: [dto] });
      return dto;
    },
  );

  // Multi-marker moves, edits, pastes and deletes in one transaction (R-35, R-38, R-45)
  app.patch(
    '/api/markers/batch',
    {
      schema: { tags: ['markers'], body: BatchMarkersBody, response: { 200: BatchMarkersResponse } },
      preHandler: editor,
    },
    async (req) => {
      const { projectId, updates, creates, deletes } = req.body;
      await requireProject(db, projectId);
      const rejected: string[] = [];
      const result = await db.transaction(async (tx) => {
        await lockProject(tx, projectId);
        const out = [];
        const deleted: string[] = [];
        for (const c of creates) {
          try {
            out.push(await upsertMarker(tx, req.user!.id, c.id, { ...c, projectId }));
          } catch (e) {
            if (e instanceof Rejected) rejected.push(c.id);
            else throw e;
          }
        }
        for (const u of updates) {
          try {
            out.push(await patchMarker(tx, req.user!.id, projectId, u));
          } catch (e) {
            if (e instanceof Rejected) rejected.push(u.id);
            else throw e;
          }
        }
        for (const id of deletes) {
          const r = await softDeleteMarker(tx, req.user!.id, id, projectId);
          if (r) deleted.push(id);
        }
        await touchProject(tx, projectId, req.user!.id);
        return { out, deleted };
      });
      const dtos = result.out.map(markerDto);
      if (dtos.length) hub.publish(projectId, { type: 'marker.upsert', origin: req.clientId, markers: dtos });
      if (result.deleted.length)
        hub.publish(projectId, { type: 'marker.delete', origin: req.clientId, ids: result.deleted });
      return { markers: dtos, rejected, deleted: result.deleted };
    },
  );

  app.delete(
    '/api/markers/:id',
    { schema: { tags: ['markers'], params: P }, preHandler: editor },
    async (req) => {
      const row = await db.transaction(async (tx) => {
        const r = await softDeleteMarker(tx, req.user!.id, req.params.id);
        if (r) await touchProject(tx, r.projectId, req.user!.id);
        return r;
      });
      if (!row) return { ok: true, alreadyDeleted: true };
      hub.publish(row.projectId, { type: 'marker.delete', origin: req.clientId, ids: [row.id] });
      return { ok: true };
    },
  );
};
