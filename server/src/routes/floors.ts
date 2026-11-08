import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  aspectDiff,
  Floor,
  Id,
  PickPagesBody,
  ReorderFloorsBody,
  SheetRevision,
  UpdateFloorBody,
  Upload,
} from '@sixpoint/shared';
import { floors, markers, sheetRevisions, uploads, users, zones } from '../db/schema';
import { HttpError, requireRole, requireUser } from '../lib/auth';
import { floorDto, uploadDto } from '../lib/dto';
import { fileUrl } from '../lib/storage';
import { nameFromFilename, receiveFile } from '../lib/upload';
import { createFloor, pageTitle, renderPdfPage } from '../services/jobs';
import { requireProject, touchProject } from '../services/projects';

const P = z.object({ id: Id });

export const floorRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, hub, storage, cfg, jobs } = app.ctx;
  const editor = requireRole('editor');

  async function liveFloor(id: string) {
    const f = (
      await db
        .select()
        .from(floors)
        .where(and(eq(floors.id, id), isNull(floors.deletedAt)))
    )[0];
    if (!f) throw new HttpError(404, 'Floor not found');
    await requireProject(db, f.projectId);
    return f;
  }

  /* ---------- uploads (R-17..R-19) ---------- */

  async function handleUpload(req: any, projectId: string) {
    await requireProject(db, projectId);
    const file = await receiveFile(req, storage, cfg.UPLOAD_MAX_MB);
    const kind = file.magic === 'pdf' ? 'pdf' : 'image';
    const [up] = await db
      .insert(uploads)
      .values({
        id: file.id,
        projectId,
        originalPath: file.rel,
        filename: file.filename,
        kind,
        status: kind === 'pdf' ? 'queued' : 'converting',
        pageCount: kind === 'pdf' ? 0 : 1,
        uploadedBy: req.user!.id,
      })
      .returning();
    if (kind === 'pdf') {
      jobs.enqueue(up.id);
      return uploadDto(up);
    }
    const sheet = await storage.storeSheet(file.abs);
    const name = nameFromFilename(file.filename);
    const f = await createFloor(db, projectId, sheet, name, '', up.id, 1);
    await touchProject(db, projectId, req.user!.id);
    const [done] = await db
      .update(uploads)
      .set({
        status: 'done',
        pagesDone: 1,
        pages: [
          {
            page: 1,
            floorId: f.id,
            name,
            sheetNumber: '',
            thumbPath: sheet.thumbPath,
            widthPx: sheet.widthPx,
            heightPx: sheet.heightPx,
          },
        ],
      })
      .where(eq(uploads.id, up.id))
      .returning();
    hub.publish(projectId, { type: 'floor.upsert', origin: req.clientId, floors: [floorDto(f)] });
    return uploadDto(done);
  }

  app.post(
    '/api/projects/:id/uploads',
    {
      schema: {
        tags: ['floors'],
        params: P,
        consumes: ['multipart/form-data'],
        description:
          'Upload one PDF, PNG or JPG (field "file"). PDFs convert in the background; poll GET /api/uploads/:id.',
        response: { 200: Upload },
      },
      preHandler: editor,
    },
    async (req) => handleUpload(req, req.params.id),
  );

  app.get(
    '/api/uploads/:id',
    { schema: { tags: ['floors'], params: P, response: { 200: Upload } }, preHandler: requireUser },
    async (req) => {
      const u = (await db.select().from(uploads).where(eq(uploads.id, req.params.id)))[0];
      if (!u) throw new HttpError(404, 'Upload not found');
      return uploadDto(u);
    },
  );

  app.get(
    '/api/projects/:id/uploads',
    { schema: { tags: ['floors'], params: P, response: { 200: z.array(Upload) } }, preHandler: requireUser },
    async (req) => {
      const rows = await db
        .select()
        .from(uploads)
        .where(and(eq(uploads.projectId, req.params.id), isNull(uploads.targetFloorId)))
        .orderBy(desc(uploads.createdAt))
        .limit(20);
      return rows.map(uploadDto);
    },
  );

  // R-19: keep only the picked pages as floors
  app.post(
    '/api/uploads/:id/pages',
    {
      schema: { tags: ['floors'], params: P, body: PickPagesBody, response: { 200: Upload } },
      preHandler: editor,
    },
    async (req) => {
      const u = (await db.select().from(uploads).where(eq(uploads.id, req.params.id)))[0];
      if (!u) throw new HttpError(404, 'Upload not found');
      if (u.status !== 'done') throw new HttpError(409, 'Conversion is still running');
      const keep = new Set(req.body.keepPages);
      const drop = u.pages.filter((p) => p.floorId && !keep.has(p.page)).map((p) => p.floorId!);
      const removed: string[] = [];
      const removedMarkers: string[] = [];
      await db.transaction(async (tx) => {
        for (const fid of drop) {
          const now = new Date();
          const [f] = await tx
            .update(floors)
            .set({ deletedAt: now })
            .where(and(eq(floors.id, fid), isNull(floors.deletedAt)))
            .returning();
          if (!f) continue;
          removed.push(f.id);
          const ms = await tx
            .update(markers)
            .set({ deletedAt: now })
            .where(and(eq(markers.floorId, fid), isNull(markers.deletedAt)))
            .returning({ id: markers.id });
          removedMarkers.push(...ms.map((m) => m.id));
        }
      });
      const pages = u.pages.map((p) => (p.floorId && drop.includes(p.floorId) ? { ...p, floorId: null } : p));
      const [nu] = await db.update(uploads).set({ pages }).where(eq(uploads.id, u.id)).returning();
      if (removed.length)
        hub.publish(u.projectId, {
          type: 'floor.delete',
          origin: req.clientId,
          ids: removed,
          markerIds: removedMarkers,
        });
      await touchProject(db, u.projectId, req.user!.id);
      return uploadDto(nu);
    },
  );

  /* ---------- floors (R-21) ---------- */

  // Add one floor from an image or the first page of a PDF, synchronously.
  app.post(
    '/api/projects/:id/floors',
    {
      schema: { tags: ['floors'], params: P, consumes: ['multipart/form-data'], response: { 200: Upload } },
      preHandler: editor,
    },
    async (req) => handleUpload(req, req.params.id),
  );

  app.post(
    '/api/projects/:id/floors/reorder',
    {
      schema: { tags: ['floors'], params: P, body: ReorderFloorsBody, response: { 200: z.array(Floor) } },
      preHandler: editor,
    },
    async (req) => {
      const projectId = req.params.id;
      await requireProject(db, projectId);
      const rows = await db.transaction(async (tx) => {
        const fl = await tx
          .select()
          .from(floors)
          .where(and(eq(floors.projectId, projectId), isNull(floors.deletedAt)));
        const known = new Set(fl.map((f) => f.id));
        const order = req.body.floorIds.filter((id) => known.has(id));
        for (const f of fl) if (!order.includes(f.id)) order.push(f.id);
        for (let i = 0; i < order.length; i++)
          await tx.update(floors).set({ sortOrder: i }).where(eq(floors.id, order[i]));
        return tx
          .select()
          .from(floors)
          .where(and(eq(floors.projectId, projectId), isNull(floors.deletedAt)))
          .orderBy(asc(floors.sortOrder));
      });
      await touchProject(db, projectId, req.user!.id);
      hub.publish(projectId, { type: 'floor.order', origin: req.clientId, floorIds: rows.map((f) => f.id) });
      return rows.map(floorDto);
    },
  );

  app.patch(
    '/api/floors/:id',
    {
      schema: { tags: ['floors'], params: P, body: UpdateFloorBody, response: { 200: Floor } },
      preHandler: editor,
    },
    async (req) => {
      const f = await liveFloor(req.params.id);
      const [nf] = await db
        .update(floors)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(floors.id, f.id))
        .returning();
      await touchProject(db, f.projectId, req.user!.id);
      hub.publish(f.projectId, { type: 'floor.upsert', origin: req.clientId, floors: [floorDto(nf)] });
      return floorDto(nf);
    },
  );

  app.delete(
    '/api/floors/:id',
    { schema: { tags: ['floors'], params: P }, preHandler: editor },
    async (req) => {
      const f = await liveFloor(req.params.id);
      const now = new Date();
      const removed = await db.transaction(async (tx) => {
        await tx.update(floors).set({ deletedAt: now }).where(eq(floors.id, f.id));
        await tx
          .update(zones)
          .set({ deletedAt: now })
          .where(and(eq(zones.floorId, f.id), isNull(zones.deletedAt)));
        return tx
          .update(markers)
          .set({ deletedAt: now, updatedBy: req.user!.id })
          .where(and(eq(markers.floorId, f.id), isNull(markers.deletedAt)))
          .returning({ id: markers.id });
      });
      await touchProject(db, f.projectId, req.user!.id);
      hub.publish(f.projectId, {
        type: 'floor.delete',
        origin: req.clientId,
        ids: [f.id],
        markerIds: removed.map((m) => m.id),
      });
      return { ok: true, markersRemoved: removed.length };
    },
  );

  /* ---------- sheet replacement (R-22) ---------- */

  const ReplaceQuery = z.object({ confirm: z.coerce.boolean().optional(), staged: Id.optional() });
  const ReplaceResponse = z.object({
    applied: z.boolean(),
    stagedId: Id.optional(),
    aspectDiff: z.number(),
    widthPx: z.number(),
    heightPx: z.number(),
    floor: Floor.optional(),
  });

  app.post(
    '/api/floors/:id/sheet',
    {
      schema: {
        tags: ['floors'],
        params: P,
        querystring: ReplaceQuery,
        consumes: ['multipart/form-data'],
        description:
          'Upload a revised drawing (multipart "file"). If the aspect ratio differs by more than 2% the response has applied=false and a stagedId; repeat with ?staged=<id>&confirm=true to apply.',
        response: { 200: ReplaceResponse },
      },
      preHandler: editor,
    },
    async (req) => {
      const f = await liveFloor(req.params.id);
      let staged: typeof uploads.$inferSelect;
      if (req.query.staged) {
        const s = (await db.select().from(uploads).where(eq(uploads.id, req.query.staged)))[0];
        if (!s || s.targetFloorId !== f.id || !s.pages[0]?.imagePath)
          throw new HttpError(404, 'Staged sheet not found');
        staged = s;
      } else {
        const file = await receiveFile(req, storage, cfg.UPLOAD_MAX_MB);
        let src = file.abs;
        if (file.magic === 'pdf')
          src = await renderPdfPage(file.abs, 1, cfg.PDF_RENDER_DPI, path.dirname(file.abs));
        const sheet = await storage.storeSheet(src);
        if (src !== file.abs) await fs.rm(src, { force: true });
        const title = file.magic === 'pdf' ? await pageTitle(file.abs, 1) : { name: '', sheetNumber: '' };
        [staged] = await db
          .insert(uploads)
          .values({
            id: file.id,
            projectId: f.projectId,
            originalPath: file.rel,
            filename: file.filename,
            kind: file.magic === 'pdf' ? 'pdf' : 'image',
            status: 'done',
            pageCount: 1,
            pagesDone: 1,
            targetFloorId: f.id,
            uploadedBy: req.user!.id,
            pages: [
              {
                page: 1,
                floorId: f.id,
                name: title.name,
                sheetNumber: title.sheetNumber,
                thumbPath: sheet.thumbPath,
                widthPx: sheet.widthPx,
                heightPx: sheet.heightPx,
                imagePath: sheet.imagePath,
                previewPath: sheet.previewPath,
                previewWidthPx: sheet.previewWidthPx,
              },
            ],
          })
          .returning();
      }
      const pg = staged.pages[0];
      const diff = aspectDiff(
        { width: f.widthPx, height: f.heightPx },
        { width: pg.widthPx, height: pg.heightPx },
      );
      if (diff > 0.02 && !req.query.confirm) {
        return {
          applied: false,
          stagedId: staged.id,
          aspectDiff: diff,
          widthPx: pg.widthPx,
          heightPx: pg.heightPx,
        };
      }
      const nf = await db.transaction(async (tx) => {
        await tx.insert(sheetRevisions).values({
          floorId: f.id,
          imagePath: f.imagePath,
          previewPath: f.previewPath,
          thumbPath: f.thumbPath,
          widthPx: f.widthPx,
          heightPx: f.heightPx,
          uploadedBy: null,
          uploadedAt: f.updatedAt,
        });
        const [row] = await tx
          .update(floors)
          .set({
            imagePath: pg.imagePath!,
            previewPath: pg.previewPath!,
            thumbPath: pg.thumbPath!,
            widthPx: pg.widthPx,
            heightPx: pg.heightPx,
            previewWidthPx: pg.previewWidthPx!,
            // same drawing at another resolution: keep the real-world scale
            ftPerPx: f.ftPerPx ? (f.ftPerPx * f.widthPx) / pg.widthPx : null,
            renderDpi:
              staged.kind === 'pdf'
                ? cfg.PDF_RENDER_DPI
                : f.renderDpi && Math.round((f.renderDpi * pg.widthPx) / f.widthPx),
            updatedAt: new Date(),
          })
          .where(eq(floors.id, f.id))
          .returning();
        return row;
      });
      await touchProject(db, f.projectId, req.user!.id);
      hub.publish(f.projectId, { type: 'floor.upsert', origin: req.clientId, floors: [floorDto(nf)] });
      return {
        applied: true,
        aspectDiff: diff,
        widthPx: pg.widthPx,
        heightPx: pg.heightPx,
        floor: floorDto(nf),
      };
    },
  );

  app.get(
    '/api/floors/:id/revisions',
    {
      schema: { tags: ['floors'], params: P, response: { 200: z.array(SheetRevision) } },
      preHandler: requireUser,
    },
    async (req) => {
      const rows = await db
        .select({ r: sheetRevisions, by: users.name })
        .from(sheetRevisions)
        .leftJoin(users, eq(users.id, sheetRevisions.uploadedBy))
        .where(eq(sheetRevisions.floorId, req.params.id))
        .orderBy(desc(sheetRevisions.uploadedAt));
      return rows.map(({ r, by }) => ({
        id: r.id,
        floorId: r.floorId,
        imageUrl: fileUrl(r.previewPath),
        widthPx: r.widthPx,
        heightPx: r.heightPx,
        uploadedBy: by,
        uploadedAt: r.uploadedAt.toISOString(),
      }));
    },
  );

  // marker count for the delete confirmation (R-21)
  app.get(
    '/api/floors/:id/marker-count',
    {
      schema: { tags: ['floors'], params: P, response: { 200: z.object({ count: z.number() }) } },
      preHandler: requireUser,
    },
    async (req) => {
      const r = await db.execute(
        sql`select count(*)::int as n from markers where floor_id = ${req.params.id} and deleted_at is null`,
      );
      return { count: (r.rows[0] as any).n };
    },
  );
};
