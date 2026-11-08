import { useMemo } from 'react';
import {
  bearing,
  bearingOf,
  normDeg,
  orderedClosets,
  resolveCoverage,
  runPath,
  sectorPath,
  type Floor,
  type Marker,
  type ResolvedCoverage,
} from '@sixpoint/shared';
import { colorOf, getState, setState, typeOf, useEditor } from './store';
import { runFloorsOf } from './zones';

/* ---------- wire paths (SVG, sheet pixels) ---------- */

/** Right-angle paths from each device on this floor to its closet (or riser), plus riser → closet legs. */
export function WirePaths({ floor }: { floor: Floor }) {
  const show = useEditor((s) => s.showWires);
  const markers = useEditor((s) => s.markers);
  const zones = useEditor((s) => s.zones);
  const floors = useEditor((s) => s.floors);
  const selection = useEditor((s) => s.selection);
  const legs = useMemo(() => {
    if (!show) return [];
    const rf = runFloorsOf(floors);
    const zs = Object.values(zones);
    const closets = orderedClosets(rf, zs);
    const out: { key: string; markerId: string; points: [number, number][]; trunk: boolean }[] = [];
    const trunks = new Set<string>();
    for (const m of Object.values(markers)) {
      const path = runPath(m, rf, zs, closets);
      path.forEach((leg, i) => {
        if (leg.floorId !== floor.id) return;
        const trunk = i > 0; // riser → closet, shared by every device upstairs/downstairs
        const key = trunk ? `t:${leg.points.join(';')}` : `m:${m.id}`;
        if (trunk && trunks.has(key)) return;
        trunks.add(key);
        out.push({ key, markerId: m.id, points: leg.points, trunk });
      });
    }
    return out;
  }, [show, markers, zones, floors, floor.id]);
  if (!legs.length) return null;
  const sel = new Set(selection);
  const pts = (p: [number, number][]) =>
    p.map(([x, y]) => `${x * floor.widthPx},${y * floor.heightPx}`).join(' ');
  return (
    <g className="wire-paths">
      {legs.map((l) => (
        <polyline
          key={l.key}
          className={`wire-path ${l.trunk ? 'trunk' : ''} ${sel.has(l.markerId) && !l.trunk ? 'selected' : ''}`}
          style={l.trunk ? undefined : { stroke: colorOf(getState().markers[l.markerId]?.typeId ?? '') }}
          points={pts(l.points)}
        />
      ))}
    </g>
  );
}

/* ---------- coverage areas ---------- */

export function coverageOf(m: Marker): ResolvedCoverage | null {
  return resolveCoverage(typeOf(m.typeId), m);
}

/** Sectors / circles for every device on this floor whose coverage is on. */
export function CoverageShapes({ floor }: { floor: Floor }) {
  const show = useEditor((s) => s.showCoverage);
  const markers = useEditor((s) => s.markers);
  const types = useEditor((s) => s.types);
  const selection = useEditor((s) => s.selection);
  const shapes = useMemo(() => {
    if (!show || !floor.ftPerPx) return [];
    return Object.values(markers)
      .filter((m) => m.floorId === floor.id)
      .map((m) => ({ m, c: coverageOf(m) }))
      .filter((x): x is { m: Marker; c: ResolvedCoverage } => !!x.c);
  }, [show, markers, types, floor.id, floor.ftPerPx]);
  if (!shapes.length) return null;
  const sel = new Set(selection);
  return (
    <g className="coverage">
      {shapes.map(({ m, c }) => (
        <path
          key={m.id}
          className={`coverage-area ${sel.has(m.id) ? 'selected' : ''}`}
          style={{ '--c': colorOf(m.typeId) } as React.CSSProperties}
          d={sectorPath(
            m.x * floor.widthPx,
            m.y * floor.heightPx,
            c.rangeFt / floor.ftPerPx!,
            c.angleDeg,
            c.dirDeg,
          )}
        />
      ))}
    </g>
  );
}

export type CoverageHandle = 'a' | 'b' | 'dir';

/** Drag handles for the single selected device's coverage (constant screen size). */
export function CoverageHandles({ floor }: { floor: Floor }) {
  const show = useEditor((s) => s.showCoverage);
  const m = useEditor((s) => (s.selection.length === 1 ? s.markers[s.selection[0]] : null));
  const canEdit = useEditor((s) => s.canEdit);
  const zoneEdit = useEditor((s) => s.zoneEdit);
  useEditor((s) => s.types);
  if (!show || !m || !canEdit || zoneEdit || m.floorId !== floor.id || !floor.ftPerPx) return null;
  const c = coverageOf(m);
  if (!c) return null;
  const r = c.rangeFt / floor.ftPerPx;
  const cx = m.x * floor.widthPx;
  const cy = m.y * floor.heightPx;
  /** `rot` turns the bracket (corner up-right, arms left and down) so its arms run along the edges. */
  const at = (deg: number, extraScreenPx = 0, rot = 0) => {
    const [ux, uy] = bearing(deg);
    return {
      '--x': cx + ux * r,
      '--y': cy + uy * r,
      '--ox': ux * extraScreenPx,
      '--oy': uy * extraScreenPx,
      '--rot': `${rot}deg`,
    } as React.CSSProperties;
  };
  const full = c.angleDeg >= 359.9;
  return (
    <>
      {full ? (
        <div
          className="cov-handle edge"
          data-cov="a"
          title="Drag to change the range"
          style={at(c.dirDeg + 180, 0, c.dirDeg + 180 - 45)}
        />
      ) : (
        <>
          <div
            className="cov-handle edge"
            data-cov="a"
            title="Drag to change the angle and range"
            style={at(c.dirDeg - c.angleDeg / 2, 0, c.dirDeg - c.angleDeg / 2 - 90)}
          />
          <div
            className="cov-handle edge"
            data-cov="b"
            title="Drag to change the angle and range"
            style={at(c.dirDeg + c.angleDeg / 2, 0, c.dirDeg + c.angleDeg / 2)}
          />
        </>
      )}
      <div
        className="cov-handle dir"
        data-cov="dir"
        title="Drag around to turn it, in or out to change the range"
        style={at(c.dirDeg, 30)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M12 2l3 3h-2v6h6V9l3 3-3 3v-2h-6v6h2l-3 3-3-3h2v-6H5v2l-3-3 3-3v2h6V5H9z" />
        </svg>
      </div>
    </>
  );
}

/**
 * Apply a coverage handle drag: `f` is the pointer in sheet fractions, `grab` where the drag started.
 * Updates the store live.
 */
export function dragCoverage(
  before: Marker,
  handle: CoverageHandle,
  f: { x: number; y: number },
  floor: Floor,
  grab?: { x: number; y: number },
) {
  const c = coverageOf(before);
  if (!c || !floor.ftPerPx) return;
  const dx = (f.x - before.x) * floor.widthPx;
  const dy = (f.y - before.y) * floor.heightPx;
  const deg = bearingOf(dx, dy);
  const next = { ...(before.coverage ?? {}) };
  if (handle === 'dir') {
    next.dirDeg = Math.round(deg);
    // moving toward / away from the device changes the range by the same distance
    if (grab) {
      const g0 = Math.hypot((grab.x - before.x) * floor.widthPx, (grab.y - before.y) * floor.heightPx);
      const ft = c.rangeFt + (Math.hypot(dx, dy) - g0) * floor.ftPerPx;
      next.rangeFt = Math.max(1, Math.round(ft * 2) / 2);
    }
  } else {
    const rangeFt = Math.max(1, Math.round(Math.hypot(dx, dy) * floor.ftPerPx * 2) / 2);
    next.rangeFt = rangeFt;
    if (c.angleDeg < 359.9 || handle === 'a') {
      let diff = normDeg(deg - c.dirDeg);
      if (diff > 180) diff -= 360;
      const angle = Math.round(Math.min(360, Math.max(5, 2 * Math.abs(diff))));
      // a full circle stays full unless the handle is pulled well away from behind
      if (!(c.angleDeg >= 359.9 && angle > 340)) next.angleDeg = angle >= 355 ? 360 : angle;
    }
  }
  const s = getState();
  setState({ markers: { ...s.markers, [before.id]: { ...before, coverage: next } } });
}
