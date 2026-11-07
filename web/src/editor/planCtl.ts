import type { View } from '@sixpoint/shared';

/** Imperative bridge between the plan canvas and toolbar / keyboard / schedule. */
type Listener = (zoomPct: number) => void;

export const planCtl = {
  zoomBy: (_f: number) => {},
  fit: () => {},
  centerOn: (_id: string) => {},
  /** sheet fraction per one screen pixel, for nudging */
  pxToFraction: (): { fx: number; fy: number } => ({ fx: 0.001, fy: 0.001 }),
  getView: (): View | null => null,
  listeners: new Set<Listener>(),
  zoomPct: 100,
  emit(pct: number) {
    if (Math.round(pct) === Math.round(this.zoomPct)) return;
    this.zoomPct = pct;
    for (const l of this.listeners) l(pct);
  },
};
