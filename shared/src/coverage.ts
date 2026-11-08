import type { MarkerCoverage, TypeCoverage } from './schemas';

export interface ResolvedCoverage {
  rangeFt: number;
  angleDeg: number;
  /** direction of the sector's center line, degrees clockwise from up (north on the sheet) */
  dirDeg: number;
}

/** Effective coverage for a device: type defaults merged with the device's overrides; null when off. */
export function resolveCoverage(
  type: { coverage: TypeCoverage | null } | undefined,
  m: { coverage: MarkerCoverage | null },
): ResolvedCoverage | null {
  const t = type?.coverage;
  if (!t) return null;
  const o = m.coverage ?? {};
  if (!(o.on ?? t.defaultOn)) return null;
  return {
    rangeFt: o.rangeFt ?? t.rangeFt,
    angleDeg: Math.min(360, Math.max(5, o.angleDeg ?? t.angleDeg)),
    dirDeg: o.dirDeg ?? 0,
  };
}

/** Unit vector for a bearing (clockwise from up), in screen coordinates (y down). */
export function bearing(deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

/** Bearing (clockwise from up) from a to b in screen coordinates. */
export function bearingOf(dx: number, dy: number): number {
  return normDeg((Math.atan2(dx, -dy) * 180) / Math.PI);
}

export function normDeg(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** SVG path for a sector (or full circle at 360°) centred at cx,cy with radius r, in the same units. */
export function sectorPath(cx: number, cy: number, r: number, angleDeg: number, dirDeg: number): string {
  if (angleDeg >= 359.9)
    return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  const [ax, ay] = bearing(dirDeg - angleDeg / 2);
  const [bx, by] = bearing(dirDeg + angleDeg / 2);
  const large = angleDeg > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${cx + ax * r} ${cy + ay * r} A ${r} ${r} 0 ${large} 1 ${cx + bx * r} ${cy + by * r} Z`;
}

/** Seeded coverage defaults by type code. */
export const SEED_TYPE_COVERAGE: Record<string, TypeCoverage> = {
  WAP: { defaultOn: true, rangeFt: 35, angleDeg: 360 },
  CAM: { defaultOn: true, rangeFt: 40, angleDeg: 90 },
  DBL: { defaultOn: true, rangeFt: 15, angleDeg: 150 },
  SEN: { defaultOn: false, rangeFt: 25, angleDeg: 90 },
};
