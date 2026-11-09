import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { Id, PutZoneBody, Zone } from '@sixpoint/shared';
import { floors, markers, zones } from '../db/schema';
import { HttpError, requireRole, requireUser } from '../lib/auth';
import { markerDto, zoneDto } from '../lib/dto';
import { logActivity } from '../services/markers';
import { requireProject, touchProject } from '../services/projects';

const P = z.object({ id: Id });

/** Zones: rooms and equipment closets drawn on a floor. */
export const zoneRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, hub } = app.ctx;
  const editor = requireRole('editor');

  app.get(
    '/api/projects/:id/zones',
    { schema: { tags: ['zones'], params: P, response: { 200: z.array(Zone) } }, preHandler: requireUser },
    async (req) => {
      await requireProject(db, req.params.id);
      const rows = await db
        .select()
        .from(zones)
        .where(and(eq(zones.projectId, req.params.id), isNull(zones.deletedAt)));
      return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(zoneDto);
    },
  );

  // upsert by client UUID
  app.put(
    '/api/zones/:id',
    {
      schema: { tags: ['zones'], params: P, body: PutZoneBody, response: { 200: Zone } },
      preHandler: editor,
    },
    async (req) => {
      const b = req.body;
      await requireProject(db, b.projectId);
      const f = (await db.select().from(floors).where(eq(floors.id, b.floorId)))[0];
      if (!f || f.projectId !== b.projectId || f.deletedAt)
        throw new HttpError(400, 'Floor not found in this project');
      const existing = (await db.select().from(zones).where(eq(zones.id, req.params.id)))[0];
      if (existing && existing.projectId !== b.projectId)
        throw new HttpError(400, 'Zone belongs to another project');
      if (existing?.deletedAt) throw new HttpError(410, 'Zone was deleted');
      const values = {
        floorId: b.floorId,
        name: b.name,
        kind: b.kind,
        points: b.points,
        audioFormat: b.audioFormat ?? null,
        showName: b.showName ?? existing?.showName ?? true,
        updatedAt: new Date(),
      };
      const [row] = existing
        ? await db.update(zones).set(values).where(eq(zones.id, req.params.id)).returning()
        : await db
            .insert(zones)
            .values({ ...values, id: req.params.id, projectId: b.projectId, createdBy: req.user!.id })
            .returning();
      if (!existing || existing.name !== row.name || existing.kind !== row.kind)
        await logActivity(
          db,
          b.projectId,
          req.user!.id,
          null,
          existing ? 'zone.edit' : 'zone.create',
          existing ? { name: existing.name, kind: existing.kind } : null,
          {
            name: row.name,
            kind: row.kind,
          },
        );
      await touchProject(db, b.projectId, req.user!.id);
      const dto = zoneDto(row);
      hub.publish(b.projectId, { type: 'zone.upsert', origin: req.clientId, zones: [dto] });
      return dto;
    },
  );

  app.delete(
    '/api/zones/:id',
    { schema: { tags: ['zones'], params: P }, preHandler: editor },
    async (req) => {
      const zone = (
        await db
          .select()
          .from(zones)
          .where(and(eq(zones.id, req.params.id), isNull(zones.deletedAt)))
      )[0];
      if (!zone) return { ok: true, alreadyDeleted: true };
      const cleared = await db.transaction(async (tx) => {
        await tx.update(zones).set({ deletedAt: new Date() }).where(eq(zones.id, zone.id));
        // devices that were sent to this closet fall back to the default closet
        return tx
          .update(markers)
          .set({ closetZoneId: null, updatedAt: new Date() })
          .where(and(eq(markers.closetZoneId, zone.id), isNull(markers.deletedAt)))
          .returning();
      });
      await logActivity(
        db,
        zone.projectId,
        req.user!.id,
        null,
        'zone.delete',
        { name: zone.name, kind: zone.kind },
        null,
      );
      await touchProject(db, zone.projectId, req.user!.id);
      hub.publish(zone.projectId, { type: 'zone.delete', origin: req.clientId, ids: [zone.id] });
      if (cleared.length)
        hub.publish(zone.projectId, { type: 'marker.upsert', origin: null, markers: cleared.map(markerDto) });
      return { ok: true };
    },
  );
};
