import { describe, expect, it } from 'vitest';
import {
  countByType,
  embedWidthPx,
  fitRect,
  floorPageLayout,
  markerPoint,
  paginate,
  truncate,
  wrapText,
} from '../src/lib/pdfLayout';

const mono = (s: string) => s.length * 5;

describe('PDF layout (R-57)', () => {
  it('uses an 11×17 landscape page with the title strip above the plan', () => {
    const L = floorPageLayout();
    expect(L.page).toEqual({ width: 1224, height: 792 });
    expect(L.titleStrip.y).toBeGreaterThan(L.planArea.y + L.planArea.h);
    expect(L.planArea.x + L.planArea.w).toBeLessThan(L.legend.x);
  });

  it('fits a sheet inside the plan area keeping aspect ratio', () => {
    const r = fitRect({ width: 5400, height: 3600 }, { x: 0, y: 0, w: 1000, h: 500 });
    expect(r.h).toBe(500);
    expect(r.w).toBeCloseTo(750);
    expect(r.x).toBeCloseTo(125);
  });

  it('caps embedded image resolution at 200 DPI at print size', () => {
    expect(embedWidthPx(720, 5400)).toBe(2000); // 10 in × 200
    expect(embedWidthPx(720, 1200)).toBe(1200); // never upscales
  });

  it('maps marker fractions with a bottom-left origin', () => {
    const r = { x: 10, y: 20, w: 100, h: 50 };
    expect(markerPoint(r, 0, 0)).toEqual({ x: 10, y: 70 });
    expect(markerPoint(r, 1, 1)).toEqual({ x: 110, y: 20 });
  });

  it('paginates rows and starts a new page when a row does not fit', () => {
    expect(paginate([10, 10, 10, 10, 10], 25, 30)).toEqual([
      [0, 1],
      [2, 3, 4],
    ]);
    expect(paginate([50], 25, 30)).toEqual([[0]]); // an oversized row still gets placed
  });

  it('wraps and truncates text', () => {
    expect(wrapText('one two three four', 40, mono)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('a b c d e f g h', 10, mono, 2)).toEqual(['a', 'b…']);
    expect(truncate('abcdefghij', 30, mono)).toBe('abcde…');
  });

  it('counts by type for the legend', () => {
    expect(Object.fromEntries(countByType([{ typeId: 'a' }, { typeId: 'b' }, { typeId: 'a' }]))).toEqual({
      a: 2,
      b: 1,
    });
  });
});
