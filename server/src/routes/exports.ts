import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { deviceCsv, deviceListText, exportFilename, Id, type ExportType } from '@sixpoint/shared';
import { floors, markers } from '../db/schema';
import { requireUser } from '../lib/auth';
import { buildPdf } from '../services/pdf';
import { requireProject } from '../services/projects';
import { loadLibrary } from './library';

/** Outputs for every role (R-56..R-59). */
export const exportRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, storage, cfg } = app.ctx;
  const Q = z.object({ floors: z.string().optional().describe('Comma-separated floor ids to include (default all)') });
  const P = z.object({ id: Id });

  async function load(projectId: string, floorFilter?: string) {
    const project = await requireProject(db, projectId);
    let fl = await db
      .select()
      .from(floors)
      .where(and(eq(floors.projectId, projectId), isNull(floors.deletedAt)))
      .orderBy(asc(floors.sortOrder), asc(floors.id));
    if (floorFilter) {
      const want = new Set(floorFilter.split(',').map((s) => s.trim()));
      fl = fl.filter((f) => want.has(f.id));
    }
    const ms = await db
      .select()
      .from(markers)
      .where(and(eq(markers.projectId, projectId), isNull(markers.deletedAt)));
    const lib = await loadLibrary(db);
    const cats = new Map(lib.categories.map((c) => [c.id, c]));
    const types = new Map<string, ExportType>(
      lib.types.map((t, i) => [
        t.id,
        { id: t.id, code: t.code, name: t.name, category: cats.get(t.categoryId)?.name ?? '', color: cats.get(t.categoryId)?.color ?? '#6b7280', order: i },
      ]),
    );
    const floorIds = new Set(fl.map((f) => f.id));
    return { project, floors: fl, types, markers: ms.filter((m) => floorIds.has(m.floorId)) };
  }

  const disposition = (name: string) => `attachment; filename="${name}"`;

  app.get('/api/projects/:id/export.txt', { schema: { tags: ['exports'], params: P, querystring: Q }, preHandler: requireUser }, async (req, reply) => {
    const d = await load(req.params.id, req.query.floors);
    const txt = deviceListText(d.project, d.floors, d.types, d.markers);
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', disposition(exportFilename(d.project.name, 'txt')));
    return txt;
  });

  app.get('/api/projects/:id/export.csv', { schema: { tags: ['exports'], params: P, querystring: Q }, preHandler: requireUser }, async (req, reply) => {
    const d = await load(req.params.id, req.query.floors);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', disposition(exportFilename(d.project.name, 'csv')));
    return deviceCsv(d.floors, d.types, d.markers);
  });

  app.get('/api/projects/:id/export.pdf', { schema: { tags: ['exports'], params: P, querystring: Q }, preHandler: requireUser }, async (req, reply) => {
    const d = await load(req.params.id, req.query.floors);
    const logo = path.join(cfg.STATIC_DIR, 'logo.png');
    const bytes = await buildPdf(storage, {
      project: d.project,
      floors: d.floors,
      types: d.types,
      markers: d.markers,
      logoPath: fs.existsSync(logo) ? logo : null,
    });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', disposition(exportFilename(d.project.name, 'pdf')));
    return reply.send(Buffer.from(bytes));
  });
};
