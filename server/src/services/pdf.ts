import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import sharp from 'sharp';
import { isoDate, sortForSchedule, SPECTRUM, type ExportMarker, type ExportType } from '@sixpoint/shared';
import type { Storage } from '../lib/storage';
import { woffToSfnt } from '../lib/woff';
import {
  countByType,
  embedWidthPx,
  fitRect,
  floorPageLayout,
  LETTER_LANDSCAPE,
  LETTER_PORTRAIT,
  markerPoint,
  paginate,
  truncate,
  wrapText,
  type Rect,
} from '../lib/pdfLayout';

const require = createRequire(import.meta.url);

function fontFile(pkg: string, file: string): string {
  return path.join(path.dirname(require.resolve(pkg)), 'files', file);
}

const FONT_FILES = {
  sans: ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff'],
  sansMed: ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-500-normal.woff'],
  sansBold: ['@fontsource/ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff'],
  head: ['@fontsource/barlow-semi-condensed', 'barlow-semi-condensed-latin-600-normal.woff'],
  headBold: ['@fontsource/barlow-semi-condensed', 'barlow-semi-condensed-latin-700-normal.woff'],
  mono: ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff'],
  monoBold: ['@fontsource/ibm-plex-mono', 'ibm-plex-mono-latin-600-normal.woff'],
} as const;
type FontKey = keyof typeof FONT_FILES;
const fontCache = new Map<string, Buffer>();

async function loadFont(k: FontKey): Promise<Buffer> {
  const [pkg, file] = FONT_FILES[k];
  const key = `${pkg}/${file}`;
  let b = fontCache.get(key);
  if (!b) fontCache.set(key, (b = woffToSfnt(await fs.readFile(fontFile(pkg, file)))));
  return b;
}

const hex = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const INK = hex('#1b1720');
const MUTED = hex('#6b6475');
const RULE = hex('#d9d4dd');
const PLUM = hex('#5b1762');
const WHITE = rgb(1, 1, 1);

/** pdf-lib fonts can't encode characters outside the subset files; replace them. */
function safe(s: string): string {
  return s.replace(/[^ -ɏ–—‘-”•…·→]/g, '?');
}

export interface PdfInput {
  project: { name: string; client: string; address: string };
  floors: {
    id: string;
    name: string;
    sheetNumber: string;
    imagePath: string;
    widthPx: number;
    heightPx: number;
  }[];
  types: Map<string, ExportType>;
  markers: ExportMarker[];
  logoPath: string | null;
  date?: Date;
}

export async function buildPdf(storage: Storage, input: PdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`${input.project.name} — device plan`);
  doc.setCreator('Six Point Markup');
  doc.setProducer('Six Point Markup');
  const F = {} as Record<FontKey, PDFFont>;
  for (const k of Object.keys(FONT_FILES) as FontKey[])
    F[k] = await doc.embedFont(await loadFont(k), { subset: true });
  const date = input.date ?? new Date();
  let logo: PDFImage | null = null;
  if (input.logoPath) {
    try {
      logo = await doc.embedPng(
        await sharp(input.logoPath).resize({ height: 120, withoutEnlargement: true }).png().toBuffer(),
      );
    } catch {
      logo = null;
    }
  }
  const text = (p: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color = INK) =>
    p.drawText(safe(s), { x, y, size, font, color });
  const w = (s: string, font: PDFFont, size: number) => font.widthOfTextAtSize(safe(s), size);

  /* ---------- one 11×17 page per floor ---------- */
  const L = floorPageLayout();
  for (const floor of input.floors) {
    const page = doc.addPage([L.page.width, L.page.height]);
    const ms = input.markers.filter((m) => m.floorId === floor.id);

    // title strip
    const ts = L.titleStrip;
    let tx = ts.x;
    if (logo) {
      const lh = 40;
      const lw = (logo.width / logo.height) * lh;
      page.drawImage(logo, { x: tx, y: ts.y + (ts.h - lh) / 2, width: lw, height: lh });
      tx += lw + 16;
    }
    text(page, 'DEVICE PLAN', tx, ts.y + ts.h - 14, 7.5, F.sansBold, PLUM);
    text(
      page,
      truncate(input.project.name, 420, (s) => w(s, F.headBold, 20)),
      tx,
      ts.y + 20,
      20,
      F.headBold,
    );
    const sub = [input.project.client, input.project.address].filter(Boolean).join(' · ');
    if (sub)
      text(
        page,
        truncate(sub, 420, (s) => w(s, F.sans, 9)),
        tx,
        ts.y + 6,
        9,
        F.sans,
        MUTED,
      );
    const right = ts.x + ts.w;
    const floorTitle =
      floor.sheetNumber && !floor.name.startsWith(floor.sheetNumber)
        ? `${floor.sheetNumber}  ${floor.name}`
        : floor.name;
    const ft = truncate(floorTitle, 420, (s) => w(s, F.head, 18));
    text(page, ft, right - w(ft, F.head, 18), ts.y + 22, 18, F.head);
    const meta = `${ms.length} device${ms.length === 1 ? '' : 's'}  ·  Exported ${isoDate(date)}`;
    text(page, meta, right - w(meta, F.mono, 8.5), ts.y + 7, 8.5, F.mono, MUTED);
    // spectrum band
    const seg = L.band.w / SPECTRUM.length;
    SPECTRUM.forEach((c, i) =>
      page.drawRectangle({
        x: L.band.x + i * seg,
        y: L.band.y,
        width: seg + 0.5,
        height: L.band.h,
        color: hex(c),
      }),
    );

    // plan image, JPEG at ≤200 DPI at print size
    const rect = fitRect({ width: floor.widthPx, height: floor.heightPx }, L.planArea);
    const pxW = embedWidthPx(rect.w, floor.widthPx);
    const jpg = await sharp(storage.abs(floor.imagePath), { limitInputPixels: false })
      .resize({ width: pxW })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 78, mozjpeg: true })
      .toBuffer();
    const img = await doc.embedJpg(jpg);
    page.drawImage(img, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      borderColor: RULE,
      borderWidth: 0.5,
    });

    // markers: white tag on category color, constant size
    for (const m of sortForSchedule(ms, input.types)) {
      const t = input.types.get(m.typeId);
      const tag = `${t?.code ?? '?'}${m.number}`;
      const size = 6.5;
      const tw = w(tag, F.monoBold, size);
      const bw = tw + 6;
      const bh = 10;
      const pt = markerPoint(rect, m.x, m.y);
      page.drawRectangle({
        x: pt.x - bw / 2,
        y: pt.y - bh / 2,
        width: bw,
        height: bh,
        color: hex(t?.color ?? '#6b7280'),
        borderColor: WHITE,
        borderWidth: 0.6,
      });
      text(page, tag, pt.x - tw / 2, pt.y - size * 0.36, size, F.monoBold, WHITE);
    }

    // legend: only the types used on this floor, with counts
    drawLegend(page, L.legend, ms, input.types, F, text, w);
  }

  /* ---------- letter portrait schedule ---------- */
  drawSchedule(doc, input, F, text, w, date);

  /* ---------- totals ---------- */
  drawTotals(doc, input, F, text, w);

  /* ---------- page numbers ---------- */
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const s = `${input.project.name} · Page ${i + 1} of ${pages.length}`;
    const { width } = p.getSize();
    text(p, s, width - 24 - w(s, F.sans, 7), 10, 7, F.sans, MUTED);
  });

  return doc.save();
}

type TextFn = (
  p: PDFPage,
  s: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  color?: ReturnType<typeof rgb>,
) => void;
type WidthFn = (s: string, font: PDFFont, size: number) => number;

function drawLegend(
  page: PDFPage,
  r: Rect,
  ms: ExportMarker[],
  types: Map<string, ExportType>,
  F: Record<FontKey, PDFFont>,
  text: TextFn,
  w: WidthFn,
) {
  page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, borderColor: RULE, borderWidth: 0.5 });
  let y = r.y + r.h - 18;
  text(page, 'LEGEND', r.x + 10, y, 8, F.sansBold, PLUM);
  y -= 16;
  const counts = countByType(ms);
  const used = [...counts.keys()]
    .map((id) => types.get(id)!)
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
  if (!used.length) text(page, 'No devices on this floor', r.x + 10, y, 8, F.sans, MUTED);
  for (const t of used) {
    if (y < r.y + 14) break;
    const cw = w(t.code, F.monoBold, 7) + 6;
    page.drawRectangle({ x: r.x + 10, y: y - 3, width: cw, height: 11, color: hex(t.color) });
    text(page, t.code, r.x + 13, y, 7, F.monoBold, WHITE);
    const n = String(counts.get(t.id));
    text(
      page,
      truncate(t.name, r.w - cw - 46, (s) => w(s, F.sans, 8)),
      r.x + 16 + cw,
      y,
      8,
      F.sans,
    );
    text(page, n, r.x + r.w - 10 - w(n, F.monoBold, 8), y, 8, F.monoBold);
    y -= 15;
  }
  const total = `${ms.length}`;
  page.drawLine({
    start: { x: r.x + 10, y: y + 6 },
    end: { x: r.x + r.w - 10, y: y + 6 },
    thickness: 0.5,
    color: RULE,
  });
  text(page, 'Total', r.x + 10, y - 6, 8, F.sansBold);
  text(page, total, r.x + r.w - 10 - w(total, F.monoBold, 8), y - 6, 8, F.monoBold);
}

function drawSchedule(
  doc: PDFDocument,
  input: PdfInput,
  F: Record<FontKey, PDFFont>,
  text: TextFn,
  w: WidthFn,
  date: Date,
) {
  const P = LETTER_PORTRAIT;
  const M = 36;
  const cols = [
    { key: 'tag', label: 'Tag', w: 52 },
    { key: 'type', label: 'Type', w: 104 },
    { key: 'floor', label: 'Floor', w: 84 },
    { key: 'room', label: 'Room', w: 96 },
    { key: 'mount', label: 'Mount ht', w: 52 },
    { key: 'notes', label: 'Notes', w: P.width - M * 2 - 388 },
  ];
  const size = 8;
  const lineH = 10.5;
  type Row = { kind: 'floor'; label: string } | { kind: 'item'; cells: string[][]; color: string };
  const rows: Row[] = [];
  for (const f of input.floors) {
    const ms = sortForSchedule(
      input.markers.filter((m) => m.floorId === f.id),
      input.types,
    );
    rows.push({
      kind: 'floor',
      label: `${f.name}${f.sheetNumber && !f.name.startsWith(f.sheetNumber) ? ` (${f.sheetNumber})` : ''} — ${ms.length} device${ms.length === 1 ? '' : 's'}`,
    });
    for (const m of ms) {
      const t = input.types.get(m.typeId);
      const raw = [`${t?.code ?? '?'}${m.number}`, t?.name ?? '', f.name, m.room, m.mountHeight, m.notes];
      const cells = raw.map((v, i) =>
        wrapText(v ?? '', cols[i].w - 6, (s) => w(s, i === 0 ? F.monoBold : F.sans, size), i === 5 ? 4 : 2),
      );
      rows.push({ kind: 'item', cells, color: t?.color ?? '#6b7280' });
    }
  }
  const heights = rows.map((r) =>
    r.kind === 'floor' ? 22 : Math.max(1, ...r.cells.map((c) => c.length)) * lineH + 5,
  );
  const top = P.height - M;
  const titleH = 40;
  const headH = 18;
  const bottom = M + 6;
  const pages = paginate(heights, top - titleH - headH - bottom, top - 14 - headH - bottom);

  pages.forEach((idxs, pi) => {
    const page = doc.addPage([P.width, P.height]);
    let y = top;
    if (pi === 0) {
      text(page, 'DEVICE SCHEDULE', M, y - 8, 7.5, F.sansBold, PLUM);
      text(page, input.project.name, M, y - 28, 16, F.headBold);
      const d = `Exported ${isoDate(date)}`;
      text(page, d, P.width - M - w(d, F.mono, 8), y - 28, 8, F.mono, MUTED);
      y -= titleH;
    } else {
      text(page, `${input.project.name} — device schedule (continued)`, M, y - 8, 8, F.sansMed, MUTED);
      y -= 14;
    }
    // repeated header row
    page.drawRectangle({ x: M, y: y - headH, width: P.width - M * 2, height: headH, color: hex('#f3eff5') });
    let x = M;
    for (const c of cols) {
      text(page, c.label.toUpperCase(), x + 3, y - 12, 7, F.sansBold, PLUM);
      x += c.w;
    }
    y -= headH;
    for (const i of idxs) {
      const r = rows[i];
      const h = heights[i];
      if (r.kind === 'floor') {
        text(page, r.label, M + 3, y - 15, 10, F.head);
        page.drawLine({
          start: { x: M, y: y - h + 1 },
          end: { x: P.width - M, y: y - h + 1 },
          thickness: 0.8,
          color: INK,
        });
      } else {
        x = M;
        r.cells.forEach((lines, ci) => {
          lines.forEach((ln, li) => {
            const yy = y - 10 - li * lineH;
            if (ci === 0) {
              const tw = w(ln, F.monoBold, size);
              page.drawRectangle({ x: x + 2, y: yy - 2.5, width: tw + 5, height: 10, color: hex(r.color) });
              text(page, ln, x + 4.5, yy, size, F.monoBold, WHITE);
            } else {
              text(page, ln, x + 3, yy, size, F.sans, ci === 3 && !ln ? MUTED : INK);
            }
          });
          if (ci === 3 && !lines.length) text(page, 'No room', x + 3, y - 10, size, F.sans, MUTED);
          x += cols[ci].w;
        });
        page.drawLine({
          start: { x: M, y: y - h },
          end: { x: P.width - M, y: y - h },
          thickness: 0.4,
          color: RULE,
        });
      }
      y -= h;
    }
  });
}

function drawTotals(
  doc: PDFDocument,
  input: PdfInput,
  F: Record<FontKey, PDFFont>,
  text: TextFn,
  w: WidthFn,
) {
  const counts = new Map<string, Map<string, number>>(); // typeId -> floorId -> n
  for (const m of input.markers) {
    let byFloor = counts.get(m.typeId);
    if (!byFloor) counts.set(m.typeId, (byFloor = new Map()));
    byFloor.set(m.floorId, (byFloor.get(m.floorId) ?? 0) + 1);
  }
  const types = [...counts.keys()]
    .map((id) => input.types.get(id)!)
    .filter(Boolean)
    .sort((a, b) => a.order - b.order);
  const P = input.floors.length > 6 ? LETTER_LANDSCAPE : LETTER_PORTRAIT;
  const M = 36;
  const typeW = 150;
  const totalW = 46;
  const colW = Math.max(28, (P.width - M * 2 - typeW - totalW) / Math.max(1, input.floors.length));
  const rowH = 16;
  const size = input.floors.length > 10 ? 6.5 : 8;
  const pages = paginate(
    types.map(() => rowH).concat([rowH + 4]),
    P.height - M * 2 - 70,
    P.height - M * 2 - 40,
  );

  const header = (page: PDFPage, y: number) => {
    page.drawRectangle({ x: M, y: y - 30, width: P.width - M * 2, height: 30, color: hex('#f3eff5') });
    text(page, 'TYPE', M + 4, y - 19, 7, F.sansBold, PLUM);
    input.floors.forEach((f, i) => {
      const label = f.sheetNumber || f.name;
      const lines = wrapText(label, colW - 4, (s) => w(s, F.sansBold, 6.5), 2);
      lines.forEach((ln, li) =>
        text(
          page,
          ln,
          M + typeW + i * colW + colW - 3 - w(ln, F.sansBold, 6.5),
          y - 12 - li * 8,
          6.5,
          F.sansBold,
          PLUM,
        ),
      );
    });
    text(page, 'TOTAL', P.width - M - 3 - w('TOTAL', F.sansBold, 7), y - 19, 7, F.sansBold, PLUM);
    return y - 30;
  };

  pages.forEach((idxs, pi) => {
    const page = doc.addPage([P.width, P.height]);
    let y = P.height - M;
    if (pi === 0) {
      text(page, 'TOTALS', M, y - 8, 7.5, F.sansBold, PLUM);
      text(page, `${input.project.name} — devices by floor`, M, y - 28, 16, F.headBold);
      y -= 40;
    }
    y = header(page, y);
    for (const i of idxs) {
      const isTotal = i === types.length;
      const t = types[i];
      const cells = input.floors.map((f) =>
        isTotal ? input.markers.filter((m) => m.floorId === f.id).length : (counts.get(t.id)?.get(f.id) ?? 0),
      );
      const total = cells.reduce((a, b) => a + b, 0);
      if (isTotal) {
        page.drawLine({ start: { x: M, y }, end: { x: P.width - M, y }, thickness: 0.8, color: INK });
        text(page, 'All devices', M + 4, y - 12, size + 1, F.sansBold);
      } else {
        const cw = w(t.code, F.monoBold, 7) + 5;
        page.drawRectangle({ x: M + 3, y: y - 13, width: cw, height: 10, color: hex(t.color) });
        text(page, t.code, M + 5.5, y - 10.5, 7, F.monoBold, WHITE);
        text(
          page,
          truncate(t.name, typeW - cw - 12, (s) => w(s, F.sans, size)),
          M + cw + 8,
          y - 11,
          size,
          F.sans,
        );
      }
      cells.forEach((n, ci) => {
        const s = n ? String(n) : '–';
        text(
          page,
          s,
          M + typeW + ci * colW + colW - 3 - w(s, F.mono, size),
          y - 11,
          size,
          isTotal ? F.monoBold : F.mono,
          n ? INK : MUTED,
        );
      });
      const ts = String(total);
      text(page, ts, P.width - M - 3 - w(ts, F.monoBold, size), y - 11, size, F.monoBold);
      page.drawLine({
        start: { x: M, y: y - rowH },
        end: { x: P.width - M, y: y - rowH },
        thickness: 0.4,
        color: RULE,
      });
      y -= isTotal ? rowH + 4 : rowH;
    }
  });
}
