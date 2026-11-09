/** One straight line on a sheet: position across it, then its start and end along it. */
export type SheetLine = [pos: number, a: number, b: number];
/** h: [y, xStart, xEnd], v: [x, yStart, yEnd]. */
export interface SheetLines {
  h: SheetLine[];
  v: SheetLine[];
}

export type SnapPoint = [number, number];
export type SnapSegment = [SnapPoint, SnapPoint];

/**
 * Screen pixels within which each target pulls a dragged corner, and the degrees from horizontal or
 * vertical within which an edge straightens. 0 turns any of them off.
 */
export const DEFAULT_SNAP = { cornerPx: 16, edgePx: 10, axisDeg: 3, linePx: 5 };

export interface SnapTargets {
  corners: SnapPoint[];
  edges: SnapSegment[];
  lines: SheetLines | null;
  /** the far ends of the edges that meet at this corner */
  neighbors?: SnapPoint[];
}
export interface SnapRadii {
  corner: number;
  edge: number;
  /** degrees, not pixels */
  axisDeg: number;
  line: number;
}
export type SnapGuide =
  { kind: 'corner'; at: SnapPoint } | { kind: 'edge' | 'line' | 'axis'; seg: SnapSegment };
export interface SnapResult {
  x: number;
  y: number;
  guides: SnapGuide[];
}

/** Closest point to `p` on segment a–b. */
export function nearestOnSegment(p: SnapPoint, a: SnapPoint, b: SnapPoint) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return { x, y, dist: Math.hypot(p[0] - x, p[1] - y) };
}

/**
 * Which way the edges from `p` to its adjacent corners would straighten: an edge within `maxDeg`
 * of vertical fixes x, one within `maxDeg` of horizontal fixes y. The closest to straight wins.
 */
function straighten(p: SnapPoint, ends: SnapPoint[], maxDeg: number) {
  const out: { x: SnapPoint | null; y: SnapPoint | null } = { x: null, y: null };
  if (maxDeg <= 0) return out;
  const limit = Math.tan((maxDeg * Math.PI) / 180);
  let bestX = Infinity;
  let bestY = Infinity;
  for (const e of ends) {
    const dx = Math.abs(p[0] - e[0]);
    const dy = Math.abs(p[1] - e[1]);
    if (dy > 0 && dx / dy <= limit && dx / dy < bestX) {
      out.x = e;
      bestX = dx / dy;
    }
    if (dx > 0 && dy / dx <= limit && dy / dx < bestY) {
      out.y = e;
      bestY = dy / dx;
    }
  }
  return out;
}

/** The spot on a segment at a given x (axis 0) or y (axis 1); none if the segment runs along that value. */
function segmentAt(seg: SnapSegment, axis: 0 | 1, value: number): SnapPoint | null {
  const [a, b] = seg;
  const span = b[axis] - a[axis];
  if (Math.abs(span) < 1e-9) return null;
  const t = (value - a[axis]) / span;
  if (t < 0 || t > 1) return null;
  const other = a[1 - axis] + t * (b[1 - axis] - a[1 - axis]);
  return axis === 0 ? [value, other] : [other, value];
}

/**
 * Where a dragged corner lands. All units match (sheet pixels here). First, any edge close to
 * horizontal or vertical comes out exactly straight, whatever else is nearby. Whatever that
 * leaves free then goes to another zone's corner, or else its edge, or else lines on the drawing.
 * Lines work on each axis alone, so a corner can settle where a horizontal and a vertical cross.
 */
export function snapPoint(p: SnapPoint, t: SnapTargets, r: SnapRadii): SnapResult {
  const ends = t.neighbors ?? [];
  const first = straighten(p, ends, r.axisDeg);
  const q: SnapPoint = [first.x ? first.x[0] : p[0], first.y ? first.y[1] : p[1]];
  const out: SnapResult = { x: q[0], y: q[1], guides: [] };
  const freeX = !first.x;
  const freeY = !first.y;

  let corner: SnapPoint | null = null;
  let bestD = Infinity;
  if ((freeX || freeY) && r.corner > 0)
    for (const c of t.corners) {
      const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
      if (d <= r.corner && d < bestD) {
        corner = c;
        bestD = d;
      }
    }

  let edge: { spot: SnapPoint; seg: SnapSegment } | null = null;
  bestD = Infinity;
  if (!corner && (freeX || freeY) && r.edge > 0)
    for (const seg of t.edges) {
      const spot: SnapPoint | null = !freeX
        ? segmentAt(seg, 0, q[0])
        : !freeY
          ? segmentAt(seg, 1, q[1])
          : (() => {
              const n = nearestOnSegment(q, seg[0], seg[1]);
              return [n.x, n.y] as SnapPoint;
            })();
      if (!spot) continue;
      const d = Math.hypot(q[0] - spot[0], q[1] - spot[1]);
      if (d <= r.edge && d < bestD) {
        edge = { spot, seg };
        bestD = d;
      }
    }

  if (corner) {
    if (freeX) out.x = corner[0];
    if (freeY) out.y = corner[1];
    out.guides.push({ kind: 'corner', at: corner });
  } else if (edge) {
    out.x = edge.spot[0];
    out.y = edge.spot[1];
    out.guides.push({ kind: 'edge', seg: edge.seg });
  } else if (r.line > 0 && t.lines) {
    // a line only pulls when the corner is alongside it, not somewhere past its end
    const pick = (lines: SheetLine[], across: number, along: number) => {
      let hit: SheetLine | null = null;
      let d = Infinity;
      for (const l of lines) {
        const dist = Math.abs(across - l[0]);
        if (dist <= r.line && dist < d && along >= l[1] - r.line && along <= l[2] + r.line) {
          hit = l;
          d = dist;
        }
      }
      return hit;
    };
    const h = freeY ? pick(t.lines.h, q[1], q[0]) : null;
    const v = freeX ? pick(t.lines.v, q[0], q[1]) : null;
    if (h) {
      out.y = h[0];
      out.guides.push({
        kind: 'line',
        seg: [
          [h[1], h[0]],
          [h[2], h[0]],
        ],
      });
    }
    if (v) {
      out.x = v[0];
      out.guides.push({
        kind: 'line',
        seg: [
          [v[0], v[1]],
          [v[0], v[2]],
        ],
      });
    }
  }

  // a snap can leave an edge nearly straight too, so check again where the corner ended up
  const after = straighten([out.x, out.y], ends, r.axisDeg);
  const endX = first.x ?? after.x;
  const endY = first.y ?? after.y;
  if (endX) out.x = endX[0];
  if (endY) out.y = endY[1];
  if (endX) out.guides.push({ kind: 'axis', seg: [endX, [out.x, out.y]] });
  if (endY) out.guides.push({ kind: 'axis', seg: [endY, [out.x, out.y]] });
  return out;
}

/** Corners and edges of the zones on one floor, in sheet pixels. */
export function zoneSnapTargets(
  zones: { id: string; floorId: string; points: [number, number][] }[],
  floorId: string,
  excludeId: string | null,
  width: number,
  height: number,
): Pick<SnapTargets, 'corners' | 'edges'> {
  const corners: SnapPoint[] = [];
  const edges: SnapSegment[] = [];
  for (const z of zones) {
    if (z.floorId !== floorId || z.id === excludeId) continue;
    const pts = z.points.map(([x, y]): SnapPoint => [x * width, y * height]);
    pts.forEach((q, i) => {
      corners.push(q);
      edges.push([q, pts[(i + 1) % pts.length]]);
    });
  }
  return { corners, edges };
}

/** The sheet's lines in sheet pixels. */
export function sheetLinesToPx(lines: SheetLines, width: number, height: number): SheetLines {
  return {
    h: lines.h.map(([p, a, b]) => [p * height, a * width, b * width]),
    v: lines.v.map(([p, a, b]) => [p * width, a * height, b * height]),
  };
}

/**
 * The closest spot on a closed outline. `after` is the corner the spot follows, so a new corner
 * goes in at index after + 1. Points and `p` share units.
 */
export function nearestOnOutline(points: SnapPoint[], p: SnapPoint) {
  let best = { after: 0, x: 0, y: 0, dist: Infinity };
  points.forEach((q, i) => {
    const n = nearestOnSegment(p, q, points[(i + 1) % points.length]);
    if (n.dist < best.dist) best = { after: i, x: n.x, y: n.y, dist: n.dist };
  });
  return best;
}
