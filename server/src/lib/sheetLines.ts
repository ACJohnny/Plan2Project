import type { SheetLine, SheetLines } from '@sixpoint/shared';

/** Darker than this (0–255) counts as ink; keeps faint grids and shading out. */
const INK = 150;
/** Runs this far apart along a row still count as one run (anti-aliasing, tiny breaks). */
const BRIDGE_PX = 2;
/** Solid at least this long, as a fraction of the sheet's longer side: longer than dashes and lettering. */
const MIN_RUN = 0.012;
/** Thicker than this is a filled shape, not a line. */
const MAX_THICK = 0.012;
/** At least this thick: snap to both faces of the wall rather than its centre. */
const WALL_PX = 6;
/** Parts of one line on either side of a gap up to this big (a door) join up. */
const JOIN_GAP = 0.03;
const MAX_LINES = 4000;

interface Blob {
  first: number;
  last: number;
  a: number;
  b: number;
}

/** Solid straight strokes in one direction; `at(line, i)` says whether a pixel is ink. */
function scan(lines: number, length: number, longSide: number, at: (line: number, i: number) => boolean) {
  const minRun = Math.max(12, Math.round(longSide * MIN_RUN));
  const maxThick = Math.max(WALL_PX, Math.round(longSide * MAX_THICK));
  const done: Blob[] = [];
  let open: Blob[] = [];
  for (let l = 0; l < lines; l++) {
    const next: Blob[] = [];
    let start = -1;
    let lastInk = -1;
    const flush = () => {
      if (start >= 0 && lastInk - start + 1 >= minRun) {
        const run = open.find((o) => o.a <= lastInk && o.b >= start);
        if (run) {
          run.last = l;
          run.a = Math.min(run.a, start);
          run.b = Math.max(run.b, lastInk);
          if (!next.includes(run)) next.push(run);
        } else next.push({ first: l, last: l, a: start, b: lastInk });
      }
      start = -1;
    };
    for (let i = 0; i < length; i++) {
      if (at(l, i)) {
        if (start < 0 || i - lastInk > BRIDGE_PX + 1) {
          flush();
          start = i;
        }
        lastInk = i;
      }
    }
    flush();
    for (const o of open) if (!next.includes(o)) done.push(o);
    open = next;
  }
  done.push(...open);

  const raw: SheetLine[] = [];
  for (const d of done) {
    const thick = d.last - d.first + 1;
    if (thick > maxThick) continue;
    if (thick >= WALL_PX) raw.push([d.first, d.a, d.b], [d.last + 1, d.a, d.b]);
    else raw.push([(d.first + d.last + 1) / 2, d.a, d.b]);
  }
  return join(raw, longSide * JOIN_GAP);
}

/** Merge parts of the same line split by small gaps such as doors. */
function join(lines: SheetLine[], gap: number): SheetLine[] {
  const sorted = [...lines].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out: SheetLine[] = [];
  for (const l of sorted) {
    let merged = false;
    for (let i = out.length - 1; i >= 0 && l[0] - out[i][0] <= 1.5; i--) {
      if (l[1] <= out[i][2] + gap && l[2] >= out[i][1] - gap) {
        out[i] = [out[i][0], Math.min(out[i][1], l[1]), Math.max(out[i][2], l[2])];
        merged = true;
        break;
      }
    }
    if (!merged) out.push(l);
  }
  return out;
}

const longest = (lines: SheetLine[]) =>
  lines.length <= MAX_LINES
    ? lines
    : [...lines].sort((p, q) => q[2] - q[1] - (p[2] - p[1])).slice(0, MAX_LINES);

/**
 * Horizontal and vertical lines in a greyscale image (one byte per pixel), as fractions of the sheet.
 * h: [y, xStart, xEnd], v: [x, yStart, yEnd].
 */
export function detectLines(px: Uint8Array | Buffer, width: number, height: number): SheetLines {
  const long = Math.max(width, height);
  const ink = (i: number) => px[i] < INK;
  const h = longest(scan(height, width, long, (y, x) => ink(y * width + x)));
  const v = longest(scan(width, height, long, (x, y) => ink(y * width + x)));
  const r = (n: number) => Math.round(n * 1e5) / 1e5;
  return {
    h: h.map(([p, a, b]) => [r(p / height), r(a / width), r((b + 1) / width)]),
    v: v.map(([p, a, b]) => [r(p / width), r(a / height), r((b + 1) / height)]),
  };
}
