import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import {
  clip,
  endPath,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import sharp from 'sharp';
import {
  AUDIO_FORMAT_LABEL,
  centroid,
  sectorPath,
  type ResolvedCoverage,
  isoDate,
  sortForSchedule,
  SPECTRUM,
  type ExportMarker,
  type ExportType,
  type ProjectSummary,
} from '@sixpoint/shared';
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
const ACCENT = hex('#c4105c');

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
    riserX?: number | null;
    riserY?: number | null;
    ftPerPx?: number | null;
  }[];
  /** effective coverage per marker id (only devices whose coverage is on) */
  coverage?: Map<string, ResolvedCoverage>;
  /** stored icon path per device type id (types without one draw the code tag) */
  typeIcons?: Map<string, string>;
  /** marker ids whose code + number is not printed below their icon */
  hiddenLabels?: Set<string>;
  types: Map<string, ExportType>;
  markers: ExportMarker[];
  zones?: {
    id: string;
    floorId: string;
    name: string;
    kind: 'room' | 'closet';
    points: [number, number][];
    showName?: boolean;
  }[];
  summary?: ProjectSummary;
  extraWireFt?: number;
  /** size of device markers; 1 = normal */
  markerScale?: number;
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

  // device icons in use, embedded once each; a missing file falls back to the code tag
  const icons = new Map<string, PDFImage>();
  const usedTypes = new Set(input.markers.map((m) => m.typeId));
  const byPath = new Map<string, PDFImage>();
  for (const [typeId, rel] of input.typeIcons ?? []) {
    if (!usedTypes.has(typeId)) continue;
    try {
      let img = byPath.get(rel);
      if (!img) byPath.set(rel, (img = await doc.embedPng(await fs.readFile(storage.abs(rel)))));
      icons.set(typeId, img);
    } catch {
      /* draw the tag instead */
    }
  }

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

    // zones (rooms and equipment closets) under the markers
    for (const z of (input.zones ?? []).filter((zz) => zz.floorId === floor.id && zz.points.length >= 3)) {
      const closet = z.kind === 'closet';
      const d =
        z.points
          .map(([px, py], i) => `${i ? 'L' : 'M'}${(px * rect.w).toFixed(2)},${(py * rect.h).toFixed(2)}`)
          .join(' ') + ' Z';
      page.drawSvgPath(d, {
        x: rect.x,
        y: rect.y + rect.h,
        color: closet ? ACCENT : PLUM,
        opacity: closet ? 0.1 : 0.05,
        borderColor: closet ? ACCENT : PLUM,
        borderWidth: closet ? 1.2 : 0.7,
        borderOpacity: 0.7,
      });
      if (z.showName === false) continue;
      const [cx, cy] = centroid(z.points);
      const pt = markerPoint(rect, cx, cy);
      const label = closet ? `EQ · ${z.name}` : z.name;
      const lw = w(label, F.head, 7.5);
      text(page, label, pt.x - lw / 2, pt.y + 7, 7.5, F.head, closet ? ACCENT : PLUM);
    }
    // coverage areas (camera field of view, WAP range…) under the markers
    if (floor.ftPerPx && input.coverage?.size) {
      const ptPerSheetPx = rect.w / floor.widthPx;
      // keep the areas inside the sheet
      page.pushOperators(pushGraphicsState(), rectangle(rect.x, rect.y, rect.w, rect.h), clip(), endPath());
      for (const m of ms) {
        const c = input.coverage.get(m.id);
        if (!c) continue;
        const color = hex(input.types.get(m.typeId)?.color ?? '#6b7280');
        page.drawSvgPath(
          sectorPath(
            m.x * rect.w,
            m.y * rect.h,
            (c.rangeFt / floor.ftPerPx) * ptPerSheetPx,
            c.angleDeg,
            c.dirDeg,
          ),
          {
            x: rect.x,
            y: rect.y + rect.h,
            color,
            opacity: 0.18,
            borderColor: color,
            borderWidth: 0.8,
            borderOpacity: 0.8,
          },
        );
      }
      page.pushOperators(popGraphicsState());
    }
    if (floor.riserX != null && floor.riserY != null) {
      const rp = markerPoint(rect, floor.riserX, floor.riserY);
      page.drawRectangle({
        x: rp.x - 5,
        y: rp.y - 5,
        width: 10,
        height: 10,
        color: INK,
        borderColor: WHITE,
        borderWidth: 0.6,
      });
      text(page, 'R', rp.x - w('R', F.monoBold, 6.5) / 2, rp.y - 2.3, 6.5, F.monoBold, WHITE);
    }

    // markers: white tag on category color, constant size
    const k = input.markerScale ?? 1;
    for (const m of sortForSchedule(ms, input.types)) {
      const t = input.types.get(m.typeId);
      const tag = `${t?.code ?? '?'}${m.number}`;
      const size = 6.5 * k;
      const tw = w(tag, F.monoBold, size);
      const bw = tw + 6 * k;
      const bh = 10 * k;
      const pt = markerPoint(rect, m.x, m.y);
      const icon = icons.get(m.typeId);
      if (icon) {
        const box = 16 * k;
        const color = hex(t?.color ?? '#6b7280');
        page.drawRectangle({
          x: pt.x - box / 2,
          y: pt.y - box / 2,
          width: box,
          height: box,
          color: WHITE,
          borderColor: color,
          borderWidth: 0.8,
        });
        const inset = 1 * k;
        page.drawImage(icon, {
          x: pt.x - box / 2 + inset,
          y: pt.y - box / 2 + inset,
          width: box - 2 * inset,
          height: box - 2 * inset,
        });
        if (!input.hiddenLabels?.has(m.id)) {
          const ls = 5.5 * k;
          const lw = w(tag, F.monoBold, ls);
          const top = pt.y - box / 2 - k;
          page.drawRectangle({
            x: pt.x - lw / 2 - 2 * k,
            y: top - 8 * k,
            width: lw + 4 * k,
            height: 8 * k,
            color,
            borderColor: WHITE,
            borderWidth: 0.4,
          });
          text(page, tag, pt.x - lw / 2, top - 6 * k, ls, F.monoBold, WHITE);
        }
        continue;
      }
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
    drawLegend(page, L.legend, ms, input.types, F, text, w, icons);
  }

  /* ---------- letter portrait schedule ---------- */
  drawSchedule(doc, input, F, text, w, date);

  /* ---------- totals ---------- */
  drawTotals(doc, input, F, text, w);

  /* ---------- cable + audio summary ---------- */
  if (input.summary && (input.summary.wires.length || input.summary.audioZones.length))
    drawSummary(doc, input, input.summary, F, text, w);

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
  icons: Map<string, PDFImage>,
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
    const icon = icons.get(t.id);
    if (icon) page.drawImage(icon, { x: r.x + 10, y: y - 3, width: 11, height: 11 });
    const inset = used.some((u) => icons.has(u.id)) ? 14 : 0;
    const cw = w(t.code, F.monoBold, 7) + 6 + inset;
    page.drawRectangle({
      x: r.x + 10 + inset,
      y: y - 3,
      width: cw - inset,
      height: 11,
      color: hex(t.color),
    });
    text(page, t.code, r.x + 13 + inset, y, 7, F.monoBold, WHITE);
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

function drawSummary(
  doc: PDFDocument,
  input: PdfInput,
  sum: ProjectSummary,
  F: Record<FontKey, PDFFont>,
  text: TextFn,
  w: WidthFn,
) {
  const P = LETTER_PORTRAIT;
  const M = 36;
  let page = doc.addPage([P.width, P.height]);
  let y = P.height - M;
  const need = (h: number) => {
    if (y - h < M + 14) {
      page = doc.addPage([P.width, P.height]);
      y = P.height - M;
    }
  };
  text(page, 'SUMMARY', M, y - 8, 7.5, F.sansBold, PLUM);
  text(page, `${input.project.name} — cable and audio summary`, M, y - 28, 16, F.headBold);
  y -= 48;

  if (sum.wires.length) {
    text(page, 'Cable by wire type', M, y - 12, 12, F.head);
    const extra = input.extraWireFt ?? 0;
    const note = `Approximate: right-angle runs to the equipment closet, risers between floors, plus ${extra} ft extra per run.`;
    text(page, note, M, y - 26, 7.5, F.sans, MUTED);
    y -= 34;
    const cols = [M + 4, M + 240, M + 330, M + 440];
    page.drawRectangle({ x: M, y: y - 18, width: P.width - M * 2, height: 18, color: hex('#f3eff5') });
    ['WIRE', 'RUNS', 'TOTAL', 'NOT COMPUTED'].forEach((h, i) =>
      text(page, h, cols[i], y - 12, 7, F.sansBold, PLUM),
    );
    y -= 18;
    for (const t of sum.wires) {
      need(16);
      text(page, t.name, cols[0], y - 11, 9, F.sans);
      text(page, String(t.runs), cols[1], y - 11, 9, F.mono);
      text(page, `${Math.round(t.totalFt).toLocaleString('en-US')} ft`, cols[2], y - 11, 9, F.monoBold);
      text(
        page,
        t.unresolved ? String(t.unresolved) : '–',
        cols[3],
        y - 11,
        9,
        F.mono,
        t.unresolved ? INK : MUTED,
      );
      page.drawLine({
        start: { x: M, y: y - 16 },
        end: { x: P.width - M, y: y - 16 },
        thickness: 0.4,
        color: RULE,
      });
      y -= 16;
    }
    y -= 20;
  }

  if (sum.audioZones.length) {
    need(40);
    text(page, 'Audio zones', M, y - 12, 12, F.head);
    y -= 24;
    const floorName = new Map(input.floors.map((f) => [f.id, f.name]));
    for (const g of sum.audioZones) {
      need(34);
      const label = g.format ? AUDIO_FORMAT_LABEL[g.format] : 'Format not set';
      text(
        page,
        `${label} — ${g.zones.length} zone${g.zones.length === 1 ? '' : 's'}`,
        M,
        y - 12,
        10,
        F.sansBold,
      );
      y -= 18;
      for (const z of g.zones) {
        need(14);
        text(page, z.name, M + 12, y - 10, 9, F.sans);
        const meta = `${floorName.get(z.floorId) ?? ''} · ${z.devices} audio device${z.devices === 1 ? '' : 's'}`;
        text(page, meta, M + 220, y - 10, 8, F.sans, MUTED);
        y -= 14;
      }
      y -= 8;
    }
  }
  void w;
}
