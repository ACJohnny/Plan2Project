/**
 * Zones and cable-run math (feature: zones, equipment closets, wires, run lengths).
 * All positions are 0–1 sheet fractions; lengths are in feet.
 */

export type Pt = [number, number];

export const AUDIO_FORMATS = ['stereo', '5.0', '5.1', '7.1'] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];
export const AUDIO_FORMAT_LABEL: Record<AudioFormat, string> = {
  stereo: 'Stereo',
  '5.0': '5.0',
  '5.1': '5.1',
  '7.1': '7.1',
};

/** Ray-casting point-in-polygon on sheet pixels (fractions scaled by w/h so aspect is respected). */
export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed-area centroid; falls back to the vertex average for degenerate shapes. */
export function centroid(poly: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function rectPolygon(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const [l, r] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [t, b] = [Math.min(y0, y1), Math.max(y0, y1)];
  return [
    [l, t],
    [r, t],
    [r, b],
    [l, b],
  ];
}

/* ---------- scale ---------- */

/** Common architectural / engineering scales: paper inches per real foot. */
export const DRAWING_SCALES: { label: string; feetPerPaperInch: number }[] = [
  { label: '1/16" = 1\'-0"', feetPerPaperInch: 16 },
  { label: '3/32" = 1\'-0"', feetPerPaperInch: 32 / 3 },
  { label: '1/8" = 1\'-0"', feetPerPaperInch: 8 },
  { label: '3/16" = 1\'-0"', feetPerPaperInch: 16 / 3 },
  { label: '1/4" = 1\'-0"', feetPerPaperInch: 4 },
  { label: '3/8" = 1\'-0"', feetPerPaperInch: 8 / 3 },
  { label: '1/2" = 1\'-0"', feetPerPaperInch: 2 },
  { label: '3/4" = 1\'-0"', feetPerPaperInch: 4 / 3 },
  { label: '1" = 1\'-0"', feetPerPaperInch: 1 },
  { label: '1" = 10\'', feetPerPaperInch: 10 },
  { label: '1" = 20\'', feetPerPaperInch: 20 },
  { label: '1" = 30\'', feetPerPaperInch: 30 },
];

/** Feet per sheet pixel from a drawing scale and the render DPI. */
export function ftPerPxFromScale(feetPerPaperInch: number, dpi: number): number {
  return feetPerPaperInch / dpi;
}

/** Feet per sheet pixel from two clicked points (fractions) and their real distance. */
export function ftPerPxFromCalibration(
  a: { x: number; y: number },
  b: { x: number; y: number },
  realFeet: number,
  sheet: { width: number; height: number },
): number {
  const px = Math.hypot((a.x - b.x) * sheet.width, (a.y - b.y) * sheet.height);
  return px > 0 ? realFeet / px : 0;
}

/** Parse "12' 6"", "12'6", "12.5", "12 ft 6 in", "150 in" → feet. */
export function parseFeet(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  let m = /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet)\s*-?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|in|inches)?)?$/.exec(t);
  if (m) return Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
  m = /^(\d+(?:\.\d+)?)\s*(?:"|in|inches)$/.exec(t);
  if (m) return Number(m[1]) / 12;
  m = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]);
  return null;
}

export function formatFeet(ft: number): string {
  return `${Math.round(ft)} ft`;
}

/* ---------- runs ---------- */

export interface RunFloor {
  id: string;
  name: string;
  widthPx: number;
  heightPx: number;
  ftPerPx: number | null;
  floorHeightFt: number;
  riser: { x: number; y: number } | null;
}
export interface RunZone {
  id: string;
  floorId: string;
  name: string;
  kind: 'room' | 'closet';
  points: Pt[];
}
export interface RunMarker {
  id: string;
  floorId: string;
  x: number;
  y: number;
  closetZoneId: string | null;
}
export interface RunResult {
  closetId: string | null;
  /** total feet including the project's extra length; null when it can't be computed */
  lengthFt: number | null;
  /** horizontal + vertical, before the extra */
  baseFt: number | null;
  reason: string | null;
}

/** Right-angle (Manhattan) horizontal distance on one floor, in feet. */
export function manhattanFt(f: RunFloor, a: { x: number; y: number }, b: { x: number; y: number }): number {
  return (Math.abs(a.x - b.x) * f.widthPx + Math.abs(a.y - b.y) * f.heightPx) * (f.ftPerPx ?? 0);
}

/** Floors are stacked in the given order; elevation = sum of floor-to-floor heights below. */
export function elevations(floors: RunFloor[]): Map<string, number> {
  const out = new Map<string, number>();
  let z = 0;
  for (const f of floors) {
    out.set(f.id, z);
    z += f.floorHeightFt;
  }
  return out;
}

/** Closets in project order (floor order, then zone order). The first is the default. */
export function orderedClosets(floors: RunFloor[], zones: RunZone[]): RunZone[] {
  const fi = new Map(floors.map((f, i) => [f.id, i]));
  return zones
    .map((z, i) => ({ z, i }))
    .filter(({ z }) => z.kind === 'closet' && fi.has(z.floorId))
    .sort((a, b) => fi.get(a.z.floorId)! - fi.get(b.z.floorId)! || a.i - b.i)
    .map(({ z }) => z);
}

/**
 * Approximate cable run from a device to its equipment closet:
 * right-angle path on each floor, via riser points between floors, plus floor-to-floor heights,
 * plus the project's extra length per run.
 */
export function computeRun(
  m: RunMarker,
  floors: RunFloor[],
  zones: RunZone[],
  extraFt: number,
  ctx?: { closets: RunZone[]; elev: Map<string, number>; floorById: Map<string, RunFloor> },
): RunResult {
  const closets = ctx?.closets ?? orderedClosets(floors, zones);
  const floorById = ctx?.floorById ?? new Map(floors.map((f) => [f.id, f]));
  const elev = ctx?.elev ?? elevations(floors);
  const closet = (m.closetZoneId && closets.find((c) => c.id === m.closetZoneId)) || closets[0];
  if (!closet) return { closetId: null, lengthFt: null, baseFt: null, reason: 'No equipment closet' };
  const df = floorById.get(m.floorId);
  const cf = floorById.get(closet.floorId);
  if (!df || !cf) return { closetId: closet.id, lengthFt: null, baseFt: null, reason: 'Floor not found' };
  const [cx, cy] = centroid(closet.points);
  const target = { x: cx, y: cy };
  if (!df.ftPerPx)
    return { closetId: closet.id, lengthFt: null, baseFt: null, reason: `Set the scale on ${df.name}` };
  let base: number;
  if (df.id === cf.id) {
    base = manhattanFt(df, m, target);
  } else {
    if (!cf.ftPerPx)
      return { closetId: closet.id, lengthFt: null, baseFt: null, reason: `Set the scale on ${cf.name}` };
    if (!df.riser)
      return { closetId: closet.id, lengthFt: null, baseFt: null, reason: `Set a riser on ${df.name}` };
    if (!cf.riser)
      return { closetId: closet.id, lengthFt: null, baseFt: null, reason: `Set a riser on ${cf.name}` };
    base =
      manhattanFt(df, m, df.riser) +
      Math.abs((elev.get(df.id) ?? 0) - (elev.get(cf.id) ?? 0)) +
      manhattanFt(cf, cf.riser, target);
  }
  return { closetId: closet.id, lengthFt: base + extraFt, baseFt: base, reason: null };
}

/** One floor's part of a run: a right-angle polyline in sheet fractions. */
export interface RunLeg {
  floorId: string;
  points: Pt[];
}

/** Right-angle polyline from a to b: horizontal first, then vertical. */
function elbow(a: { x: number; y: number }, b: { x: number; y: number }): Pt[] {
  return [
    [a.x, a.y],
    [b.x, a.y],
    [b.x, b.y],
  ];
}

/**
 * The drawn path of a run, for showing on the plan: device → closet on one floor, or
 * device → riser and riser → closet when the closet is on another floor. Empty when it can't be routed.
 */
export function runPath(
  m: RunMarker,
  floors: RunFloor[],
  zones: RunZone[],
  closets: RunZone[] = orderedClosets(floors, zones),
): RunLeg[] {
  const closet = (m.closetZoneId && closets.find((c) => c.id === m.closetZoneId)) || closets[0];
  if (!closet) return [];
  const [cx, cy] = centroid(closet.points);
  const target = { x: cx, y: cy };
  if (closet.floorId === m.floorId) return [{ floorId: m.floorId, points: elbow(m, target) }];
  const df = floors.find((f) => f.id === m.floorId);
  const cf = floors.find((f) => f.id === closet.floorId);
  if (!df?.riser || !cf?.riser) return [];
  return [
    { floorId: df.id, points: elbow(m, df.riser) },
    { floorId: cf.id, points: elbow(cf.riser, target) },
  ];
}

/** Zone containing a point on a floor (smallest area wins when zones overlap). */
export function zoneAt<Z extends RunZone>(zones: Z[], floorId: string, x: number, y: number): Z | null {
  let best: Z | null = null;
  let bestArea = Infinity;
  for (const z of zones) {
    if (z.floorId !== floorId || z.points.length < 3 || !pointInPolygon(x, y, z.points)) continue;
    const a = Math.abs(polygonArea(z.points));
    if (a < bestArea) {
      best = z;
      bestArea = a;
    }
  }
  return best;
}

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

/* ---------- default wiring (seed; admins edit it in the device library) ---------- */

export const SEED_WIRE_TYPES = [
  'Cat6',
  'RG6 coax',
  '16/2 speaker',
  '16/4 speaker',
  '14/2 speaker',
  '18/5 thermostat',
  '22/4 control',
  'Fiber',
];

export const SEED_TYPE_WIRES: Record<string, [wire: string, count: number][]> = {
  SPK: [['16/2 speaker', 1]],
  IWS: [['16/2 speaker', 1]],
  SUB: [['16/2 speaker', 1]],
  OSP: [['14/2 speaker', 1]],
  VOL: [['16/4 speaker', 1]],
  TV: [
    ['Cat6', 2],
    ['RG6 coax', 1],
  ],
  TVARC: [
    ['Cat6', 2],
    ['RG6 coax', 1],
  ],
  PRJ: [['Cat6', 2]],
  SBR: [['Cat6', 1]],
  KPD: [['Cat6', 1]],
  TS: [['Cat6', 1]],
  TSTAT: [['18/5 thermostat', 1]],
  SHD: [['22/4 control', 1]],
  SEN: [['22/4 control', 1]],
  DMRC: [['Fiber', 1]],
  WAP: [['Cat6', 1]],
  DATA: [['Cat6', 2]],
  CAM: [['Cat6', 1]],
  DBL: [['Cat6', 1]],
};

/* ---------- project summary ---------- */

export interface SummaryZone extends RunZone {
  audioFormat: AudioFormat | null;
}
export interface SummaryMarker extends RunMarker {
  typeId: string;
}
export interface WireTotal {
  wireTypeId: string;
  name: string;
  runs: number;
  totalFt: number;
  /** runs whose length couldn't be computed (not included in totalFt) */
  unresolved: number;
}
export interface AudioZoneGroup {
  format: AudioFormat | null;
  zones: { id: string; name: string; floorId: string; devices: number }[];
}
export interface ProjectSummary {
  runs: Map<string, RunResult>;
  wires: WireTotal[];
  audioZones: AudioZoneGroup[];
  zoneOf: Map<string, string | null>;
}

export function projectSummary(input: {
  floors: RunFloor[];
  zones: SummaryZone[];
  markers: SummaryMarker[];
  typeWires: Map<string, { wireTypeId: string; count: number }[]>;
  wireTypes: { id: string; name: string }[];
  audioTypeIds: Set<string>;
  extraFt: number;
}): ProjectSummary {
  const { floors, zones, markers } = input;
  const ctx = {
    closets: orderedClosets(floors, zones),
    elev: elevations(floors),
    floorById: new Map(floors.map((f) => [f.id, f])),
  };
  const runs = new Map<string, RunResult>();
  const zoneOf = new Map<string, string | null>();
  const totals = new Map<string, WireTotal>(
    input.wireTypes.map((w) => [
      w.id,
      { wireTypeId: w.id, name: w.name, runs: 0, totalFt: 0, unresolved: 0 },
    ]),
  );
  const audioCount = new Map<string, number>();
  for (const m of markers) {
    if (!ctx.floorById.has(m.floorId)) continue;
    const r = computeRun(m, floors, zones, input.extraFt, ctx);
    runs.set(m.id, r);
    const z = zoneAt(zones, m.floorId, m.x, m.y);
    zoneOf.set(m.id, z?.id ?? null);
    if (z && input.audioTypeIds.has(m.typeId)) audioCount.set(z.id, (audioCount.get(z.id) ?? 0) + 1);
    for (const w of input.typeWires.get(m.typeId) ?? []) {
      const t = totals.get(w.wireTypeId);
      if (!t) continue;
      t.runs += w.count;
      if (r.lengthFt === null) t.unresolved += w.count;
      else t.totalFt += r.lengthFt * w.count;
    }
  }
  const groups = new Map<AudioFormat | null, AudioZoneGroup>();
  const fi = new Map(floors.map((f, i) => [f.id, i]));
  for (const z of [...zones].sort(
    (a, b) => (fi.get(a.floorId) ?? 0) - (fi.get(b.floorId) ?? 0) || a.name.localeCompare(b.name),
  )) {
    const n = audioCount.get(z.id);
    if (!n) continue;
    const g = groups.get(z.audioFormat) ?? { format: z.audioFormat, zones: [] };
    g.zones.push({ id: z.id, name: z.name, floorId: z.floorId, devices: n });
    groups.set(z.audioFormat, g);
  }
  const order: (AudioFormat | null)[] = [...AUDIO_FORMATS, null];
  return {
    runs,
    zoneOf,
    wires: [...totals.values()].filter((t) => t.runs > 0),
    audioZones: order.filter((f) => groups.has(f)).map((f) => groups.get(f)!),
  };
}
