import type { SheetLines } from '@sixpoint/shared';

/**
 * Room finding: every room label in the PDF's text layer seeds a flood fill through the open
 * floor, stopped by the walls. Labels sharing one open space split it between them.
 */

export type Box = [x0: number, y0: number, x1: number, y1: number];

export interface TextBlock {
  lines: string[];
  /** fractions of the page */
  box: Box;
  words: Box[];
}

export interface PageText {
  /** page size in points */
  width: number;
  height: number;
  blocks: TextBlock[];
}

export interface RoomLabel {
  name: string;
  /** fractions of the sheet */
  x: number;
  y: number;
}

export interface FoundRoom {
  label: number;
  /** fractions of the sheet */
  points: [number, number][];
  /** in working pixels */
  areaPx: number;
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

const boxOf = (attrs: string): Box | null => {
  const v = (k: string) => Number(new RegExp(`${k}="([-\\d.]+)"`).exec(attrs)?.[1]);
  const b: Box = [v('xMin'), v('yMin'), v('xMax'), v('yMax')];
  return b.every(Number.isFinite) ? b : null;
};

/** Parse `pdftotext -bbox-layout` output for one page. */
export function parseBboxLayout(xml: string): PageText | null {
  const page = /<page width="([\d.]+)" height="([\d.]+)"/.exec(xml);
  if (!page) return null;
  const width = Number(page[1]);
  const height = Number(page[2]);
  const frac = (b: Box): Box => [b[0] / width, b[1] / height, b[2] / width, b[3] / height];
  const blocks: TextBlock[] = [];
  for (const bm of xml.matchAll(/<block ([^>]*)>([\s\S]*?)<\/block>/g)) {
    const box = boxOf(bm[1]);
    if (!box) continue;
    const lines: string[] = [];
    const words: Box[] = [];
    for (const lm of bm[2].matchAll(/<line [^>]*>([\s\S]*?)<\/line>/g)) {
      const ws: string[] = [];
      for (const wm of lm[1].matchAll(/<word ([^>]*)>([^<]*)<\/word>/g)) {
        const wb = boxOf(wm[1]);
        if (wb) words.push(frac(wb));
        ws.push(unescape(wm[2]));
      }
      if (ws.length) lines.push(ws.join(' '));
    }
    if (lines.length) blocks.push({ lines, box: frac(box), words });
  }
  return { width, height, blocks };
}

/** Feet per paper inch from a "SCALE: 1/4" = 1'-0"" note, if the sheet has one. */
export function scaleFromText(text: PageText): number | null {
  for (const b of text.blocks) {
    const s = b.lines.join(' ');
    const m = /(\d+)(?:\s*\/\s*(\d+))?\s*"\s*=\s*(\d+)\s*'/.exec(s);
    if (m && /scale/i.test(s)) {
      const inches = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
      const ft = Number(m[3]);
      if (inches > 0 && ft > 0) return ft / inches;
    }
  }
  return null;
}

/** Text that is never a room's name: notes, tags, sheet furniture. */
const NOT_A_ROOM =
  /^(UP|DN|DOWN|FP|N|NORTH|F\.?F\.?|SCALE\b.*|.*\bPLAN|PROPOSED\b.*|EXISTING\b.*|NEW|DEMO\b.*|OPEN TO\b.*|.*\bBELOW|.*\bABOVE|SEE\b.*|NOTES?\b.*|TYP\.?|SIM\.?|BOOKSHELVES|SHELVES|SHELF|CABINETS?|BUILT-?INS?|COUNTER|ISLAND|SCHEMATIC\b.*|.*\bDESIGN|DESCRIPTION|REVISIONS?\b.*|REV\b.*|DATE\b.*|SHEET\b.*|NUMBER\b.*|DRAWN\b.*|CHECKED\b.*|PROJECT\b.*|ISSUED?\b.*|STAMP|SEAL|KEY\b.*|LEGEND)$/;
/** A dimension or a size printed under a room's name. */
const DIMENSION = /\d\s*['"]|\d\s*[x×]\s*\d|^\d+(\.\d+)?$/;
/** One line of a room name: up to four words, optionally ending in a number ("BEDROOM 2"). */
const NAME_LINE = /^[A-Za-z][A-Za-z.&'/-]*( [A-Za-z][A-Za-z.&'/-]*){0,3}( \d{1,2}[A-Za-z]?)?$/;

/** The text blocks that look like room names, with where they sit on the sheet. */
export function roomLabels(text: PageText): RoomLabel[] {
  const out: (RoomLabel & { caps: boolean; size: number })[] = [];
  for (const b of text.blocks) {
    if (b.lines.length > 4) continue;
    const name: string[] = [];
    let ok = true;
    for (const l of b.lines) {
      if (DIMENSION.test(l)) continue;
      if (!NAME_LINE.test(l)) {
        ok = false;
        break;
      }
      name.push(l);
    }
    if (!ok || !name.length || name.length > 3) continue;
    const n = name.join(' ');
    const letters = n.replace(/[^A-Za-z]/g, '');
    // spaced-out lettering ("P R O J E C T") and single letters (grid / section tags)
    if (letters.length < 3 || n.split(' ').filter((w) => w.length === 1).length > 1) continue;
    if (NOT_A_ROOM.test(n.toUpperCase())) continue;
    out.push({
      name: n,
      x: (b.box[0] + b.box[2]) / 2,
      y: (b.box[1] + b.box[3]) / 2,
      caps: n === n.toUpperCase(),
      // letter height, whichever way the text runs
      size: Math.max(
        0,
        ...b.words.map((w) => Math.min((w[2] - w[0]) * text.width, (w[3] - w[1]) * text.height)),
      ),
    });
  }
  // drawings label rooms in capitals; when most labels are, mixed-case text is notes
  const caps = out.filter((l) => l.caps);
  let keep = caps.length >= 0.7 * out.length ? caps : out;
  // much bigger lettering than the typical room name is a title
  const sizes = keep.map((l) => l.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  if (keep.length >= 4 && median > 0) keep = keep.filter((l) => l.size <= median * 1.6);
  return keep.map(({ name, x, y }) => ({ name, x, y }));
}

const ABBREVIATIONS: Record<string, string> = {
  CLO: 'Closet',
  CL: 'Closet',
  CLOS: 'Closet',
  CLST: 'Closet',
  'W.I.C.': 'Walk-in Closet',
  WIC: 'Walk-in Closet',
  PWDR: 'Powder',
  PDR: 'Powder',
  MSTR: 'Master',
  BDRM: 'Bedroom',
  BR: 'Bedroom',
  BTH: 'Bath',
  KIT: 'Kitchen',
  LNDRY: 'Laundry',
  LAUN: 'Laundry',
  MECH: 'Mechanical',
  ELEC: 'Electrical',
  STOR: 'Storage',
  STO: 'Storage',
  RM: 'Room',
  'RM.': 'Room',
  FAM: 'Family',
  LIV: 'Living',
  DIN: 'Dining',
  GAR: 'Garage',
  ENT: 'Entry',
  OFC: 'Office',
  UTIL: 'Utility',
  CONF: 'Conference',
};

/** "PRIMARY BEDROOM" → "Primary Bedroom", "CLO" → "Closet"; matches a known name's spelling. */
export function tidyName(raw: string, known: string[] = []): string {
  const words = raw.trim().split(/\s+/);
  const out = words.map((w) => {
    const ab = ABBREVIATIONS[w.toUpperCase()];
    if (ab) return ab;
    if (/^\d+[A-Za-z]?$/.test(w)) return w.toUpperCase();
    return w
      .toLowerCase()
      .replace(/^[a-z]/, (c) => c.toUpperCase())
      .replace(/([/&])([a-z])/g, (_, s, c) => s + c.toUpperCase());
  });
  const name = out.join(' ');
  return known.find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
}

/* ---------- raster work ---------- */

type P = [number, number];

const INF = 1e20;

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Squared distance from every pixel to the nearest pixel where `on` is 1. */
export function sqDistance(on: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = on[y * w + x] ? 0 : INF;
    dt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = out[row + x];
    dt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = d[x];
  }
  return out;
}

/** Morphological closing with a disc: fills gaps in the ink up to 2r wide without fattening it. */
export function close(ink: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const r2 = r * r;
  const toInk = sqDistance(ink, w, h);
  const outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) outside[i] = toInk[i] > r2 ? 1 : 0;
  // the sheet edge counts as open space, so closing never seals rooms against it
  const toOut = sqDistance(outside, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = toOut[i] > r2 ? 1 : 0;
  return out;
}

/**
 * Keep the ink that can be a wall: strokes that run straight (across, down or at 45°) for at least
 * `minRun` px, plus small bits touching them (wall end caps, jamb returns, corners). Everything else
 * goes: door swing arcs, dashed and dotted lines (overhead cabinets, beams, the property line), and
 * fixtures such as tubs and toilets.
 */
export function wallInk(
  ink: Uint8Array,
  w: number,
  h: number,
  minRun: number,
  maxBit: number,
  /** a door swing's size range, px */
  door: [number, number],
): Uint8Array {
  const N = w * h;
  const straight = new Uint8Array(N);
  // walk every line in one direction, marking ink runs (1 px breaks allowed) that are long enough
  const runs = (dx: number, dy: number) => {
    const need = dx && dy ? minRun / Math.SQRT2 : minRun;
    const starts: number[] = [];
    if (dy === 0) for (let y = 0; y < h; y++) starts.push(y * w);
    else if (dx === 0) for (let x = 0; x < w; x++) starts.push(x);
    else {
      // diagonals: start on the top row and on the entry side column
      const x0 = dx > 0 ? 0 : w - 1;
      for (let x = 0; x < w; x++) starts.push(x);
      for (let y = 1; y < h; y++) starts.push(y * w + x0);
    }
    const step = dy * w + dx;
    for (const s of starts) {
      let x = s % w;
      let y = (s - x) / w;
      let i = s;
      let start = -1;
      let startStep = 0;
      let lastStep = 0;
      let k = 0;
      const flush = () => {
        if (start >= 0 && lastStep - startStep + 1 >= need)
          for (let j = start, t = startStep; t <= lastStep; j += step, t++) if (ink[j]) straight[j] = 1;
        start = -1;
      };
      for (; x >= 0 && x < w && y < h; x += dx, y += dy, i += step, k++) {
        if (!ink[i]) continue;
        if (start < 0 || k - lastStep > 2) {
          flush();
          start = i;
          startStep = k;
        }
        lastStep = k;
      }
      flush();
    }
  };
  runs(1, 0);
  runs(0, 1);
  runs(1, 1);
  runs(-1, 1);

  const out = straight.slice();
  const seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  for (let s0 = 0; s0 < N; s0++) {
    if (!ink[s0] || straight[s0] || seen[s0]) continue;
    // one piece of leftover ink (8-connected): keep it if it's small and touches a straight stroke
    let n = 0;
    let top = 0;
    stack[top++] = s0;
    seen[s0] = 1;
    let x0 = w;
    let x1 = -1;
    let y0 = h;
    let y1 = -1;
    let touches = false;
    const members: number[] = [];
    while (top) {
      const i = stack[--top];
      members.push(i);
      n++;
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(h - 1, y + 1); ny++)
        for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++) {
          const j = ny * w + nx;
          if (!ink[j]) continue;
          if (straight[j]) touches = true;
          else if (!seen[j]) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (touches && bw <= maxBit && bh <= maxBit) {
      for (const i of members) out[i] = 1;
      continue;
    }
    // a door swing (a thin quarter circle centred on the hinge, or a pair of them for double
    // doors): close the doorway instead, along the box sides through the hinges
    const r = Math.min(bw, bh);
    const long = Math.max(bw, bh);
    if (r < door[0] || long > 2 * door[1] || n > 3 * (bw + bh)) continue;
    const corners: P[] = [
      [x0, y0],
      [x1 + 1, y0],
      [x1 + 1, y1 + 1],
      [x0, y1 + 1],
    ];
    // an arc passes through the corners beside its hinge and close to the one opposite (0.4 r)
    const far = corners.map(([cx, cy]) => {
      let near = Infinity;
      for (const i of members) {
        const x = i % w;
        near = Math.min(near, (x - cx) ** 2 + ((i - x) / w - cy) ** 2);
      }
      return near > (0.7 * r) ** 2;
    });
    const hinges = far.flatMap((f, c) => (f ? [c] : []));
    const side = (a: number, b: number) =>
      drawLine(out, w, h, corners[a][0], corners[a][1], corners[b][0], corners[b][1]);
    if (hinges.length === 1 && long <= door[1] && long <= 1.6 * r) {
      const c = hinges[0];
      side(c, (c + 1) % 4);
      side(c, (c + 3) % 4);
    } else if (hinges.length === 2 && (hinges[1] - hinges[0] === 1 || hinges[1] - hinges[0] === 3)) {
      // double doors: the hinges share the long side
      const [a, b] = hinges;
      const len = Math.hypot(corners[a][0] - corners[b][0], corners[a][1] - corners[b][1]);
      if (len >= 1.5 * r) side(a, b);
    }
  }
  return out;
}

function drawLine(ink: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n);
    const y = Math.round(y0 + ((y1 - y0) * i) / n);
    if (x >= 0 && y >= 0 && x < w && y < h) ink[y * w + x] = 1;
  }
}

/* ---------- outlines ---------- */

/** Outer boundary of the region `m` (1 = inside) along pixel edges, clockwise, corners only. */
export function traceOutline(m: Uint8Array, w: number, h: number): P[] {
  let start = -1;
  for (let i = 0; i < w * h && start < 0; i++) if (m[i]) start = i;
  if (start < 0) return [];
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  const sx = start % w;
  const sy = (start - sx) / w;
  // directions clockwise: E, S, W, N; the region stays on the right
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const ahead = (x: number, y: number, d: number): [boolean, boolean] => {
    switch (d) {
      case 0:
        return [at(x, y - 1), at(x, y)];
      case 1:
        return [at(x, y), at(x - 1, y)];
      case 2:
        return [at(x - 1, y), at(x - 1, y - 1)];
      default:
        return [at(x - 1, y - 1), at(x, y - 1)];
    }
  };
  const pts: P[] = [];
  let x = sx;
  let y = sy;
  let d = 0;
  const limit = 4 * (w + 1) * (h + 1);
  for (let step = 0; step < limit; step++) {
    const [l, r] = ahead(x, y, d);
    const nd = l ? (d + 3) % 4 : r ? d : (d + 1) % 4;
    if (nd !== d || step === 0) pts.push([x, y]);
    d = nd;
    x += DX[d];
    y += DY[d];
    if (x === sx && y === sy) break;
  }
  return pts;
}

const segDist = (p: P, a: P, b: P) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

function dpOpen(pts: P[], eps: number): P[] {
  if (pts.length < 3) return pts;
  let max = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return [...dpOpen(pts.slice(0, idx + 1), eps).slice(0, -1), ...dpOpen(pts.slice(idx), eps)];
}

/** Douglas–Peucker for a closed ring. */
export function simplifyRing(pts: P[], eps: number): P[] {
  if (pts.length < 4) return pts;
  let far = 0;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = dpOpen(pts.slice(0, far + 1), eps);
  const b = dpOpen([...pts.slice(far), pts[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Drop repeated and in-line corners. */
function clean(pts: P[], minEdge: number): P[] {
  let out = pts;
  for (let pass = 0; pass < 4; pass++) {
    const next: P[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = next.length ? next[next.length - 1] : out[out.length - 1];
      const p = out[i];
      const b = out[(i + 1) % out.length];
      if (Math.hypot(p[0] - a[0], p[1] - a[1]) < minEdge) continue;
      const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      if (Math.abs(cross) / len < 0.5) continue;
      next.push(p);
    }
    if (next.length === out.length || next.length < 3) return next.length >= 3 ? next : out;
    out = next;
  }
  return out;
}

/** Make edges within `deg` of horizontal or vertical exactly so, keeping the corners joined. */
export function squareUp(pts: P[], deg = 12): P[] {
  const n = pts.length;
  if (n < 3) return pts;
  const tol = Math.tan((deg * Math.PI) / 180);
  // 0 = horizontal, 1 = vertical, 2 = slanted, with the edge's level for straight ones
  const kind: number[] = [];
  const level: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dy <= dx * tol) {
      kind.push(0);
      level.push((a[1] + b[1]) / 2);
    } else if (dx <= dy * tol) {
      kind.push(1);
      level.push((a[0] + b[0]) / 2);
    } else {
      kind.push(2);
      level.push(0);
    }
  }
  // consecutive edges of the same straight kind become one, at their length-weighted level
  const out: P[] = [];
  for (let i = 0; i < n; i++) {
    const before = (i + n - 1) % n;
    const k0 = kind[before];
    const k1 = kind[i];
    const p = pts[i];
    if (k0 === 0 && k1 === 1) out.push([level[i], level[before]]);
    else if (k0 === 1 && k1 === 0) out.push([level[before], level[i]]);
    else if (k0 === 0 && k1 === 2) out.push([p[0], level[before]]);
    else if (k0 === 2 && k1 === 0) out.push([p[0], level[i]]);
    else if (k0 === 1 && k1 === 2) out.push([level[before], p[1]]);
    else if (k0 === 2 && k1 === 1) out.push([level[i], p[1]]);
    else if (k0 === 2 && k1 === 2) out.push(p);
    // same straight kind on both sides: a jog — keep it as a step at the midpoint
    else if (k0 === 0) out.push([p[0], level[before]], [p[0], level[i]]);
    else out.push([level[before], p[1]], [level[i], p[1]]);
  }
  return out;
}

/* ---------- the finder ---------- */

export interface FindOptions {
  /** greyscale pixels, one byte each */
  grey: Uint8Array;
  width: number;
  height: number;
  labels: RoomLabel[];
  /** text to rub out before looking for walls (fractions) */
  erase: Box[];
  /** detected straight lines; their joins across door openings help seal rooms */
  lines?: SheetLines;
  pxPerFt: number;
}

const INK = 160;
/** Gap sizes tried in turn, in feet: a room that leaks at one is tried again with the next. */
const GAPS_FT = [0.6, 1.2, 2, 3];
const MIN_ROOM_SQFT = 6;
/** Ink must run straight this far (ft) to count as a wall: longer than a dash, straighter than a door swing. */
const STRAIGHT_FT = 2;
/** Small bits of other ink (wall end caps, jamb returns) touching a wall are kept up to this size (ft). */
const BIT_FT = 1.5;
/** Notches narrower than this (ft) are filled: the pocket a door swing leaves, a nick from a fixture. */
const NOTCH_FT = 3;
/** Door swings this size (ft) are swapped for a line across the doorway. */
const DOOR_FT = [1.5, 4.5];
/** Outline corners closer to straight than this (ft) are dropped: shallow jogs, door reveals. */
const JOG_FT = 0.6;
/** Rooms whose simplified outline needs more corners than this are left out as unreliable. */
const MAX_CORNERS = 12;
/** How far (ft) a label's seed may move toward the middle of its room. */
const CLIMB_FT = 3;
/** How far either side of a meeting between rooms (ft) to look for walls to line a cut up with. */
const SPLIT_REACH_FT = 4;
/** Weight of the distance from the label against the room's width when splitting shared space. */
const TRAVEL_COST = 0.5;
/** A room filling this share of its bounding box becomes that rectangle. */
const RECT_FILL = 0.92;
/** Larger than this share of the sheet is the space around the building, not a room. */
const MAX_ROOM_SHARE = 0.4;
/** Open space spanning more than this share of the sheet's width and height is outside. */
const OUTSIDE_SPAN = 0.85;

/** Let other requests run between the heavy steps. */
const breathe = () => new Promise<void>((r) => setImmediate(r));

export async function findRooms(o: FindOptions): Promise<FoundRoom[]> {
  const { width: w, height: h, pxPerFt } = o;
  const N = w * h;
  let ink: Uint8Array = new Uint8Array(N);
  for (let i = 0; i < N; i++) ink[i] = o.grey[i] < INK ? 1 : 0;
  for (const [x0, y0, x1, y1] of o.erase) {
    const ax = Math.max(0, Math.floor(x0 * w) - 2);
    const bx = Math.min(w - 1, Math.ceil(x1 * w) + 2);
    const ay = Math.max(0, Math.floor(y0 * h) - 2);
    const by = Math.min(h - 1, Math.ceil(y1 * h) + 2);
    for (let y = ay; y <= by; y++) ink.fill(0, y * w + ax, y * w + bx + 1);
  }
  ink = wallInk(ink, w, h, Math.max(8, STRAIGHT_FT * pxPerFt), Math.max(4, BIT_FT * pxPerFt), [
    DOOR_FT[0] * pxPerFt,
    DOOR_FT[1] * pxPerFt,
  ]);
  await breathe();
  if (o.lines) {
    for (const [y, a, b] of o.lines.h) drawLine(ink, w, h, a * w, y * h, b * w, y * h);
    for (const [x, a, b] of o.lines.v) drawLine(ink, w, h, x * w, a * h, x * w, b * h);
  }

  const owner = new Int32Array(N); // accepted rooms: label index + 1
  const minPx = MIN_ROOM_SQFT * pxPerFt * pxPerFt;
  const maxPx = MAX_ROOM_SHARE * N;
  const L = o.labels.length;
  let pending = o.labels.map((_, i) => i);
  const cur = new Int32Array(N);
  const queue = new Int32Array(N);
  const walls = new Uint8Array(N);
  const size = new Int32Array(L + 1);
  const edge = new Uint8Array(L + 1);
  // bounding boxes of accepted rooms, in pixels
  const bx0 = new Int32Array(L + 1).fill(w);
  const by0 = new Int32Array(L + 1).fill(h);
  const bx1 = new Int32Array(L + 1).fill(-1);
  const by1 = new Int32Array(L + 1).fill(-1);
  const comp = new Int32Array(N);
  const toInk = sqDistance(ink, w, h);
  // whole pixels to the nearest ink, for the watershed
  const level = new Uint16Array(N);
  let maxLevel = 0;
  for (let i = 0; i < N; i++) {
    const l = Math.min(4095, Math.floor(Math.sqrt(toInk[i])));
    level[i] = l;
    if (l > maxLevel) maxLevel = l;
  }
  // priority = room for the room (distance to the walls) less a cost for the way travelled
  // (distance from the label): a watershed at narrow openings, an even split in open space
  const reach = new Float32Array(N);
  const SPAN = maxLevel + Math.ceil(TRAVEL_COST * (w + h)) + 2;
  const head = new Int32Array(SPAN);
  const tail = new Int32Array(SPAN);
  const nxt = new Int32Array(N);
  await breathe();
  const search = Math.max(4, Math.round(pxPerFt));
  const climb = Math.round(CLIMB_FT * pxPerFt);

  for (const gapFt of GAPS_FT) {
    if (!pending.length) break;
    const r = Math.max(1, Math.round((gapFt / 2) * pxPerFt));
    // closing: grow the ink by r, then shrink it back by r, sealing gaps up to 2r
    const r2 = r * r;
    const open = new Uint8Array(N);
    for (let i = 0; i < N; i++) open[i] = toInk[i] > r2 ? 1 : 0;
    await breathe();
    const toOpen = sqDistance(open, w, h);
    for (let i = 0; i < N; i++) walls[i] = toOpen[i] > r2 || owner[i] ? 1 : 0;

    // open-space areas; one that reaches the edge or spans most of the sheet is the
    // outside (a sheet border keeps it off the edge), not a room
    comp.fill(0);
    const outside: boolean[] = [false];
    for (let s0 = 0; s0 < N; s0++) {
      if (walls[s0] || comp[s0]) continue;
      const c = outside.length;
      let x0 = w;
      let x1 = -1;
      let y0 = h;
      let y1 = -1;
      let n = 0;
      queue[n++] = s0;
      comp[s0] = c;
      for (let k = 0; k < n; k++) {
        const i = queue[k];
        const x = i % w;
        const y = (i - x) / w;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        let j: number;
        if (x > 0 && !walls[(j = i - 1)] && !comp[j]) {
          comp[j] = c;
          queue[n++] = j;
        }
        if (x < w - 1 && !walls[(j = i + 1)] && !comp[j]) {
          comp[j] = c;
          queue[n++] = j;
        }
        if (i >= w && !walls[(j = i - w)] && !comp[j]) {
          comp[j] = c;
          queue[n++] = j;
        }
        if (i < N - w && !walls[(j = i + w)] && !comp[j]) {
          comp[j] = c;
          queue[n++] = j;
        }
      }
      outside.push(
        x0 === 0 ||
          y0 === 0 ||
          x1 === w - 1 ||
          y1 === h - 1 ||
          (x1 - x0 > OUTSIDE_SPAN * w && y1 - y0 > OUTSIDE_SPAN * h),
      );
    }
    await breathe();

    cur.fill(0);
    let qt = 0;
    const seedOf = new Int32Array(L + 1).fill(-1);
    for (const li of pending) {
      const lx = Math.round(o.labels[li].x * w);
      const ly = Math.round(o.labels[li].y * h);
      let best = -1;
      let bestD = Infinity;
      for (let y = Math.max(0, ly - search); y <= Math.min(h - 1, ly + search); y++)
        for (let x = Math.max(0, lx - search); x <= Math.min(w - 1, lx + search); x++) {
          const i = y * w + x;
          if (walls[i]) continue;
          const d = (x - lx) ** 2 + (y - ly) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      if (best < 0 || cur[best] || outside[comp[best]]) continue;
      // labels sit off-centre and on erased text: climb to the middle of the room (furthest from
      // its walls) so the room's own label floods it before a neighbour's can
      for (let step = 0; step < climb; step++) {
        const bx = best % w;
        const by = (best - bx) / w;
        let up = best;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = bx + dx;
            const y = by + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const j = y * w + x;
            if (!walls[j] && !cur[j] && toInk[j] > toInk[up]) up = j;
          }
        if (up === best) break;
        best = up;
      }
      cur[best] = li + 1;
      seedOf[li + 1] = best;
      queue[qt++] = best;
    }
    // every label floods at once, widest space first (a watershed on the distance to the walls),
    // so labels sharing a space split it at its narrowest: the opening between the rooms
    size.fill(0);
    edge.fill(0);
    head.fill(-1);
    let top = -1;
    const pushAt = (j: number) => {
      const l = Math.max(0, Math.round(level[j] - TRAVEL_COST * reach[j]) + SPAN - maxLevel - 2);
      nxt[j] = -1;
      if (head[l] < 0) head[l] = j;
      else nxt[tail[l]] = j;
      tail[l] = j;
      if (l > top) top = l;
    };
    for (let k = 0; k < qt; k++) {
      reach[queue[k]] = 0;
      pushAt(queue[k]);
    }
    qt = 0;
    for (;;) {
      while (top >= 0 && head[top] < 0) top--;
      if (top < 0) break;
      const i = head[top];
      head[top] = nxt[i];
      queue[qt++] = i;
      const v = cur[i];
      const push = (j: number) => {
        reach[j] = reach[i] + 1;
        pushAt(j);
      };
      size[v]++;
      const x = i % w;
      let j: number;
      if (x > 0) {
        if (!cur[(j = i - 1)] && !walls[j]) {
          cur[j] = v;
          push(j);
        }
      } else edge[v] = 1;
      if (x < w - 1) {
        if (!cur[(j = i + 1)] && !walls[j]) {
          cur[j] = v;
          push(j);
        }
      } else edge[v] = 1;
      if (i >= w) {
        if (!cur[(j = i - w)] && !walls[j]) {
          cur[j] = v;
          push(j);
        }
      } else edge[v] = 1;
      if (i < N - w) {
        if (!cur[(j = i + w)] && !walls[j]) {
          cur[j] = v;
          push(j);
        }
      } else edge[v] = 1;
    }
    const ok = new Uint8Array(L + 1);
    const next: number[] = [];
    for (const li of pending) {
      const v = li + 1;
      if (size[v] >= minPx && size[v] <= maxPx && !edge[v]) ok[v] = 1;
      else next.push(li);
    }
    for (let k = 0; k < qt; k++) {
      const i = queue[k];
      const v = cur[i];
      if (!ok[v]) continue;
      owner[i] = v;
      const x = i % w;
      const y = (i - x) / w;
      if (x < bx0[v]) bx0[v] = x;
      if (x > bx1[v]) bx1[v] = x;
      if (y < by0[v]) by0[v] = y;
      if (y > by1[v]) by1[v] = y;
    }
    pending = next;
    await breathe();
  }

  straightenSplits(owner, ink, w, h, Math.round(SPLIT_REACH_FT * pxPerFt), [bx0, by0, bx1, by1]);
  await breathe();

  const out: FoundRoom[] = [];
  const tidy = Math.max(2, Math.round((NOTCH_FT / 2) * pxPerFt));
  for (let li = 0; li < L; li++) {
    const v = li + 1;
    if (bx1[v] < 0) continue;
    const box: Box = [bx0[v], by0[v], bx1[v], by1[v]];
    const { poly, area } = outline(owner, v, box, w, h, tidy, pxPerFt);
    if (poly.length >= 3)
      out.push({
        label: li,
        points: poly.map(([x, y]) => [round(clamp01(x / w)), round(clamp01(y / h))]),
        areaPx: area,
      });
  }
  return out;
}

/**
 * Rooms sharing open space meet along whatever line the flood left, often a diagonal. Replace
 * each such meeting with one straight cut, across or down, on the line that best continues the
 * walls nearby (where a wall would close the opening).
 */
function straightenSplits(
  owner: Int32Array,
  ink: Uint8Array,
  w: number,
  h: number,
  reach: number,
  [bx0, by0, bx1, by1]: Int32Array[],
) {
  // where each pair of rooms touches
  const meets = new Map<
    number,
    { a: number; b: number; x0: number; y0: number; x1: number; y1: number; n: number }
  >();
  const touch = (a: number, b: number, x: number, y: number) => {
    const key = a < b ? a * 65536 + b : b * 65536 + a;
    let m = meets.get(key);
    if (!m) meets.set(key, (m = { a: Math.min(a, b), b: Math.max(a, b), x0: x, y0: y, x1: x, y1: y, n: 0 }));
    m.n++;
    if (x < m.x0) m.x0 = x;
    if (x > m.x1) m.x1 = x;
    if (y < m.y0) m.y0 = y;
    if (y > m.y1) m.y1 = y;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = owner[i];
      if (!a) continue;
      if (x < w - 1 && owner[i + 1] && owner[i + 1] !== a) touch(a, owner[i + 1], x, y);
      if (y < h - 1 && owner[i + w] && owner[i + w] !== a) touch(a, owner[i + w], x, y);
    }
  for (const m of meets.values()) {
    const { a, b } = m;
    const across = m.x1 - m.x0 >= m.y1 - m.y0; // the meeting runs across: cut along a row
    // already straight
    if ((across ? m.y1 - m.y0 : m.x1 - m.x0) <= 1) continue;
    // a's side: compare the rooms' middles
    const aMid = across ? by0[a] + by1[a] : bx0[a] + bx1[a];
    const bMid = across ? by0[b] + by1[b] : bx0[b] + bx1[b];
    const aFirst = aMid <= bMid;
    // the cut: the row (or column) through the meeting with the most wall on it nearby
    const lo = across ? m.y0 - 2 : m.x0 - 2;
    const hi = across ? m.y1 + 2 : m.x1 + 2;
    const s0 = Math.max(0, (across ? m.x0 : m.y0) - reach);
    const s1 = Math.min((across ? w : h) - 1, (across ? m.x1 : m.y1) + reach);
    const mid = (lo + hi) / 2;
    let cut = Math.round(mid);
    let best = -1;
    for (let c = Math.max(0, lo); c <= Math.min((across ? h : w) - 1, hi); c++) {
      let wall = 0;
      for (let t = s0; t <= s1; t++) wall += ink[across ? c * w + t : t * w + c];
      if (wall > best || (wall === best && Math.abs(c - mid) < Math.abs(cut - mid))) {
        best = wall;
        cut = c;
      }
    }
    // hand over the pixels around the meeting by side of the cut
    const rx0 = Math.max(0, across ? m.x0 : Math.min(m.x0, cut) - 1);
    const rx1 = Math.min(w - 1, across ? m.x1 + 1 : Math.max(m.x1, cut) + 1);
    const ry0 = Math.max(0, across ? Math.min(m.y0, cut) - 1 : m.y0);
    const ry1 = Math.min(h - 1, across ? Math.max(m.y1, cut) + 1 : m.y1 + 1);
    for (let y = ry0; y <= ry1; y++)
      for (let x = rx0; x <= rx1; x++) {
        const i = y * w + x;
        if (owner[i] !== a && owner[i] !== b) continue;
        const before = (across ? y : x) < cut;
        owner[i] = before === aFirst ? a : b;
      }
    for (const v of [a, b]) {
      bx0[v] = Math.min(bx0[v], rx0);
      by0[v] = Math.min(by0[v], ry0);
      bx1[v] = Math.max(bx1[v], rx1);
      by1[v] = Math.max(by1[v], ry1);
    }
  }
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** One room's pixels (where `owner` is `v`, within `box`) → a simple polygon in working pixels. */
function outline(
  owner: Int32Array,
  v: number,
  box: Box,
  w: number,
  h: number,
  tidy: number,
  pxPerFt: number,
) {
  const pad = tidy + 2;
  // the crop reaches past the room so filling notches can see the neighbours it mustn't cover
  const x0 = Math.max(0, box[0] - pad);
  const y0 = Math.max(0, box[1] - pad);
  const x1 = Math.min(w - 1, box[2] + pad);
  const y1 = Math.min(h - 1, box[3] + pad);
  // and a blank margin so closing never runs into the crop's edge
  const cw = x1 - x0 + 1 + 2 * pad;
  const ch = y1 - y0 + 1 + 2 * pad;
  let m: Uint8Array = new Uint8Array(cw * ch);
  const others = new Uint8Array(cw * ch);
  let area = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const o = owner[y * w + x];
      const k = (y - y0 + pad) * cw + (x - x0 + pad);
      if (o === v) {
        m[k] = 1;
        area++;
      } else if (o) others[k] = 1;
    }
  // fill the pockets door swings and fixtures leave, and holes (furniture, symbols),
  // but never over another room
  m = close(m, cw, ch, tidy);
  for (let i = 0; i < m.length; i++) if (others[i]) m[i] = 0;
  fillHoles(m, cw, ch);
  // keep the largest piece only (removing other rooms can leave slivers)
  m = largestPiece(m, cw, ch);
  const shift = ([x, y]: P): P => [x + x0 - pad, y + y0 - pad];

  // nearly fills its box: a plain rectangle
  let bx0 = cw;
  let by0 = ch;
  let bx1 = -1;
  let by1 = -1;
  let filled = 0;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      if (m[y * cw + x]) {
        filled++;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
  if (filled >= RECT_FILL * (bx1 - bx0 + 1) * (by1 - by0 + 1)) {
    const rect: P[] = [
      [bx0, by0],
      [bx1 + 1, by0],
      [bx1 + 1, by1 + 1],
      [bx0, by1 + 1],
    ];
    return { poly: rect.map(shift), area };
  }

  const ring = traceOutline(m, cw, ch).map(shift);
  const poly = clean(
    squareUp(simplifyRing(ring, Math.max(1.5, JOG_FT * pxPerFt))),
    Math.max(1, JOG_FT * pxPerFt),
  );
  // still a complicated shape: probably not a clean read of the room, so leave it out
  return { poly: poly.length <= MAX_CORNERS ? poly : [], area };
}

/** The largest 4-connected piece of a mask. */
function largestPiece(m: Uint8Array, w: number, h: number): Uint8Array {
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || label[s]) continue;
    const c = ++next;
    let n = 0;
    queue[n++] = s;
    label[s] = c;
    for (let k = 0; k < n; k++) {
      const i = queue[k];
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
        if (j >= 0 && j < w * h && m[j] && !label[j]) {
          label[j] = c;
          queue[n++] = j;
        }
    }
    if (n > bestSize) {
      bestSize = n;
      best = c;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = label[i] === best ? 1 : 0;
  return out;
}

function fillHoles(m: Uint8Array, w: number, h: number) {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!m[i] && !seen[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * h - w) push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!seen[i]) m[i] = 1;
}
