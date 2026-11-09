/** One straight line on a sheet: position across it, then its start and end along it. */
export type SheetLine = [pos: number, a: number, b: number];
/** h: [y, xStart, xEnd], v: [x, yStart, yEnd]. */
export interface SheetLines {
  h: SheetLine[];
  v: SheetLine[];
}

export type SnapPoint = [number, number];
export type SnapSegment = [SnapPoint, SnapPoint];

/** Screen pixels within which each target pulls a dragged corner; 0 turns it off. */
export const DEFAULT_SNAP = { cornerPx: 16, edgePx: 10, linePx: 5 };

export interface SnapTargets {
  corners: SnapPoint[];
  edges: SnapSegment[];
  lines: SheetLines | null;
}
export interface SnapRadii {
  corner: number;
  edge: number;
  line: number;
}
export type SnapGuide = { kind: 'corner'; at: SnapPoint } | { kind: 'edge' | 'line'; seg: SnapSegment };
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
 * Where a dragged corner lands. All units match (sheet pixels here): another zone's corner beats
 * its edge, which beats lines on the drawing. Lines snap each axis on its own, so a corner can
 * settle where a horizontal and a vertical line cross.
 */
export function snapPoint(p: SnapPoint, t: SnapTargets, r: SnapRadii): SnapResult {
  let best: SnapPoint | null = null;
  let bestD = Infinity;
  if (r.corner > 0)
    for (const c of t.corners) {
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (d <= r.corner && d < bestD) {
        best = c;
        bestD = d;
      }
    }
  if (best) return { x: best[0], y: best[1], guides: [{ kind: 'corner', at: best }] };

  let edge: { x: number; y: number; seg: SnapSegment } | null = null;
  bestD = Infinity;
  if (r.edge > 0)
    for (const seg of t.edges) {
      const n = nearestOnSegment(p, seg[0], seg[1]);
      if (n.dist <= r.edge && n.dist < bestD) {
        edge = { x: n.x, y: n.y, seg };
        bestD = n.dist;
      }
    }
  if (edge) return { x: edge.x, y: edge.y, guides: [{ kind: 'edge', seg: edge.seg }] };

  const out: SnapResult = { x: p[0], y: p[1], guides: [] };
  if (r.line > 0 && t.lines) {
    // a line only pulls when the corner is alongside it, not somewhere past its end
    const pick = (lines: typeof t.lines.h, across: number, along: number) => {
      let hit: (typeof lines)[number] | null = null;
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
    const h = pick(t.lines.h, p[1], p[0]);
    const v = pick(t.lines.v, p[0], p[1]);
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
