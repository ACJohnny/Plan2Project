import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { extractSheetTitle } from '@sixpoint/shared';
import type { Ctx } from '../app';
import type { DB, Tx } from '../db';
import { floors, uploads, type UploadPageRow } from '../db/schema';
import { floorDto, uploadDto } from '../lib/dto';
import { run } from '../lib/proc';
import type { SheetFiles } from '../lib/storage';
import { touchProject } from './projects';

export async function createFloor(
  db: DB | Tx,
  projectId: string,
  sheet: SheetFiles,
  name: string,
  sheetNumber: string,
  uploadId: string | null,
  page: number | null,
) {
  const r = await db.execute(
    sql`select coalesce(max(sort_order), -1) + 1 as n from floors where project_id = ${projectId} and deleted_at is null`,
  );
  const [f] = await db
    .insert(floors)
    .values({
      projectId,
      name,
      sheetNumber,
      sortOrder: Number((r.rows[0] as any).n),
      ...sheet,
      uploadId,
      uploadPage: page,
    })
    .returning();
  return f;
}

export async function pdfPageCount(file: string): Promise<number> {
  const { stdout } = await run('pdfinfo', [file], 30_000);
  const m = /^Pages:\s+(\d+)/m.exec(stdout);
  if (!m) throw new Error('Could not read the PDF page count');
  return Number(m[1]);
}

/** Render one PDF page to PNG with pdftoppm (R-18); returns the PNG path. */
export async function renderPdfPage(
  file: string,
  page: number,
  dpi: number,
  outDir: string,
): Promise<string> {
  const prefix = path.join(outDir, `page-${page}`);
  await run('pdftoppm', [
    '-r',
    String(dpi),
    '-png',
    '-f',
    String(page),
    '-l',
    String(page),
    '-singlefile',
    file,
    prefix,
  ]);
  return `${prefix}.png`;
}

export async function pageTitle(file: string, page: number): Promise<{ name: string; sheetNumber: string }> {
  try {
    const { stdout } = await run('pdftotext', ['-f', String(page), '-l', String(page), file, '-'], 30_000);
    const t = extractSheetTitle(stdout);
    if (t)
      return { name: t.title ? `${t.sheetNumber} ${t.title}` : t.sheetNumber, sheetNumber: t.sheetNumber };
  } catch {
    /* no text layer */
  }
  return { name: `Page ${page}`, sheetNumber: '' };
}

/** Background PDF conversion queue, one PDF at a time (R-18). */
export class PdfJobs {
  private queue: string[] = [];
  private running = false;

  constructor(
    private ctx: Ctx,
    private log: FastifyBaseLogger,
  ) {}

  enqueue(uploadId: string) {
    this.queue.push(uploadId);
    void this.pump();
  }

  /** Mark conversions interrupted by a restart as failed. */
  async recover() {
    await this.ctx.db
      .update(uploads)
      .set({ status: 'failed', error: 'Interrupted by a server restart — upload the file again' })
      .where(sql`${uploads.status} in ('queued', 'converting')`);
  }

  async idle() {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 50));
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        try {
          await this.convert(id);
        } catch (err: any) {
          this.log.error({ err, uploadId: id }, 'PDF conversion failed');
          const [u] = await this.ctx.db
            .update(uploads)
            .set({ status: 'failed', error: String(err?.message ?? err).slice(0, 500) })
            .where(eq(uploads.id, id))
            .returning();
          if (u)
            this.ctx.hub.publish(u.projectId, {
              type: 'upload.progress',
              origin: null,
              upload: uploadDto(u),
            });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async convert(id: string) {
    const { db, storage, hub, cfg } = this.ctx;
    const up = (await db.select().from(uploads).where(eq(uploads.id, id)))[0];
    if (!up) return;
    const src = storage.abs(up.originalPath);
    const workDir = path.dirname(src);
    const pageCount = await pdfPageCount(src);
    const publish = (u: typeof up) =>
      hub.publish(u.projectId, { type: 'upload.progress', origin: null, upload: uploadDto(u) });
    let [cur] = await db
      .update(uploads)
      .set({ status: 'converting', pageCount })
      .where(eq(uploads.id, id))
      .returning();
    publish(cur);
    const pages: UploadPageRow[] = [];
    for (let p = 1; p <= pageCount; p++) {
      const png = await renderPdfPage(src, p, cfg.PDF_RENDER_DPI, workDir);
      const sheet = await storage.storeSheet(png);
      await fs.rm(png, { force: true });
      const title = await pageTitle(src, p);
      // the project may have been deleted while converting
      const live = await db.execute(
        sql`select 1 from projects where id = ${up.projectId} and deleted_at is null`,
      );
      if (!live.rows.length) throw new Error('Project was deleted');
      const f = await createFloor(db, up.projectId, sheet, title.name, title.sheetNumber, id, p);
      await touchProject(db, up.projectId, up.uploadedBy);
      pages.push({
        page: p,
        floorId: f.id,
        name: title.name,
        sheetNumber: title.sheetNumber,
        thumbPath: sheet.thumbPath,
        widthPx: sheet.widthPx,
        heightPx: sheet.heightPx,
      });
      [cur] = await db.update(uploads).set({ pagesDone: p, pages }).where(eq(uploads.id, id)).returning();
      hub.publish(up.projectId, { type: 'floor.upsert', origin: null, floors: [floorDto(f)] });
      publish(cur);
    }
    [cur] = await db.update(uploads).set({ status: 'done' }).where(eq(uploads.id, id)).returning();
    publish(cur);
    this.log.info({ uploadId: id, pageCount }, 'PDF converted');
  }
}

export async function liveFloorsOfUpload(db: DB, uploadId: string) {
  return db
    .select()
    .from(floors)
    .where(and(eq(floors.uploadId, uploadId), isNull(floors.deletedAt)));
}
