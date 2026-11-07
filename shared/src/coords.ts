/** Coordinate and view math (R-31..R-34). Positions are 0–1 fractions of sheet width/height. */

export const MIN_ZOOM = 0.5; // × Fit
export const MAX_ZOOM = 12; // × Fit

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Round a fraction to 5 decimal places and clamp to the sheet. */
export function toFraction(v: number): number {
  return Math.round(clamp(v, 0, 1) * 1e5) / 1e5;
}

export interface View {
  /** screen px per sheet px */
  scale: number;
  /** screen offset of sheet origin, relative to viewport */
  tx: number;
  ty: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Scale that fits the whole sheet in the viewport with a margin. */
export function fitScale(sheet: Size, viewport: Size, margin = 16): number {
  const w = Math.max(1, viewport.width - margin * 2);
  const h = Math.max(1, viewport.height - margin * 2);
  return Math.min(w / sheet.width, h / sheet.height);
}

export function fitView(sheet: Size, viewport: Size, margin = 16): View {
  const scale = fitScale(sheet, viewport, margin);
  return {
    scale,
    tx: (viewport.width - sheet.width * scale) / 2,
    ty: (viewport.height - sheet.height * scale) / 2,
  };
}

/** Zoom so the sheet point under (px,py) stays under (px,py). Scale clamped to [MIN,MAX] × fit. */
export function zoomAt(view: View, factor: number, px: number, py: number, fit: number): View {
  const scale = clamp(view.scale * factor, fit * MIN_ZOOM, fit * MAX_ZOOM);
  const k = scale / view.scale;
  return { scale, tx: px - (px - view.tx) * k, ty: py - (py - view.ty) * k };
}

/** Screen point (relative to viewport) → sheet fractions. */
export function screenToFraction(view: View, sheet: Size, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.tx) / view.scale / sheet.width, y: (sy - view.ty) / view.scale / sheet.height };
}

export function fractionToScreen(view: View, sheet: Size, fx: number, fy: number): { x: number; y: number } {
  return { x: view.tx + fx * sheet.width * view.scale, y: view.ty + fy * sheet.height * view.scale };
}

export function inSheet(f: { x: number; y: number }): boolean {
  return f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1;
}

/** View centered on a fraction at a given scale. */
export function centerOn(sheet: Size, viewport: Size, fx: number, fy: number, scale: number): View {
  return {
    scale,
    tx: viewport.width / 2 - fx * sheet.width * scale,
    ty: viewport.height / 2 - fy * sheet.height * scale,
  };
}

/** Aspect ratio difference as a fraction (R-22). */
export function aspectDiff(a: Size, b: Size): number {
  const ra = a.width / a.height;
  const rb = b.width / b.height;
  return Math.abs(ra - rb) / ra;
}

/* ---------- color contrast (R-27) ---------- */

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  );
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function whiteTextContrast(hex: string): number {
  return contrastRatio('#ffffff', hex);
}
