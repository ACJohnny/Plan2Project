import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { polygonArea, type DetectRoomsResult, type DetectedRoom } from '@sixpoint/shared';
import type { DB } from '../db';
import { floors, uploads, zoneNames } from '../db/schema';
import { run } from '../lib/proc';
import { findRooms, parseBboxLayout, roomLabels, scaleFromText, tidyName, type PageText } from '../lib/rooms';
import { exists, type Storage } from '../lib/storage';

/** Working width for room finding: about an inch per pixel on a 1/4" scale sheet. */
const WORK_WIDTH = 2000;
/** Assumed when neither the floor nor the sheet says: 1/4" = 1'-0". */
const DEFAULT_FT_PER_INCH = 4;

/** The PDF page's words with their positions, or null when it has none. */
export async function pdfPageText(file: string, page: number): Promise<PageText | null> {
  try {
    const { stdout } = await run(
      'pdftotext',
      ['-f', String(page), '-l', String(page), '-bbox-layout', file, '-'],
      60_000,
    );
    const t = parseBboxLayout(stdout);
    return t && t.blocks.length ? t : null;
  } catch {
    return null;
  }
}

type FloorRow = typeof floors.$inferSelect;

/** Rooms on a floor's sheet, named from the room labels in its PDF. */
export async function detectRooms(db: DB, storage: Storage, f: FloorRow): Promise<DetectRoomsResult> {
  const none = (note: string): DetectRoomsResult => ({ rooms: [], note });
  const up = f.uploadId ? (await db.select().from(uploads).where(eq(uploads.id, f.uploadId)))[0] : undefined;
  if (!up || up.kind !== 'pdf' || !(await exists(storage.abs(up.originalPath))))
    return none(
      "Rooms are found from the room names in a PDF's text, and this sheet wasn't uploaded as a PDF. Draw zones by hand, or replace the sheet with the PDF.",
    );
  const text = await pdfPageText(storage.abs(up.originalPath), f.uploadPage ?? 1);
  if (!text)
    return none(
      'This PDF page has no text layer (it may be a scan), so there are no room names to go by. Draw zones by hand.',
    );
  if (Math.abs(text.width / text.height / (f.widthPx / f.heightPx) - 1) > 0.02)
    return none("The PDF page and the sheet image don't line up, so room names can't be placed.");
  const labels = roomLabels(text);
  if (!labels.length) return none('No room names were found in the PDF text on this sheet.');

  const { data, info } = await sharp(storage.abs(f.imagePath), { limitInputPixels: false })
    .resize({ width: WORK_WIDTH, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ftPerInch = scaleFromText(text) ?? DEFAULT_FT_PER_INCH;
  const pxPerFt = f.ftPerPx
    ? info.width / (f.widthPx * f.ftPerPx)
    : info.width / ((text.width / 72) * ftPerInch);
  const lines = await storage.sheetLines(f.imagePath).catch(() => undefined);
  const found = await findRooms({
    grey: data,
    width: info.width,
    height: info.height,
    labels,
    erase: text.blocks.flatMap((b) => b.words),
    lines,
    pxPerFt,
  });

  const known = (await db.select({ name: zoneNames.name }).from(zoneNames)).map((z) => z.name);
  const rooms: DetectedRoom[] = found.map((r) => {
    const l = labels[r.label];
    const sqPx = Math.abs(polygonArea(r.points)) * f.widthPx * f.heightPx;
    return {
      name: tidyName(l.name, known),
      at: [l.x, l.y],
      points: r.points,
      areaSqFt: f.ftPerPx ? Math.round(sqPx * f.ftPerPx * f.ftPerPx) : null,
    };
  });
  // the same name twice ("Closet", "Closet") gets numbered, in reading order
  const count = new Map<string, number>();
  for (const r of rooms) count.set(r.name.toLowerCase(), (count.get(r.name.toLowerCase()) ?? 0) + 1);
  const seen = new Map<string, number>();
  const ordered = [...rooms].sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]);
  for (const r of ordered) {
    const k = r.name.toLowerCase();
    if ((count.get(k) ?? 0) < 2 || /\d$/.test(r.name)) continue;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > 1) r.name = `${r.name} ${n}`;
  }
  const missed = labels.length - rooms.length;
  return {
    rooms: ordered,
    note: rooms.length
      ? null
      : `Found ${labels.length} room name${labels.length === 1 ? '' : 's'}, but no closed walls around ${missed === 1 ? 'it' : 'them'}.`,
  };
}
