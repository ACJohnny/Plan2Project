import { describe, expect, it } from 'vitest';
import { nearestOnOutline, sheetLinesToPx, snapPoint, zoneSnapTargets } from '../src/snap';
import type { SnapTargets } from '../src/snap';

const R = { corner: 16, edge: 10, line: 5 };
const none: SnapTargets = { corners: [], edges: [], lines: null };

describe('snapPoint', () => {
  it('leaves the point alone with nothing in reach', () => {
    expect(snapPoint([50, 50], none, R)).toEqual({ x: 50, y: 50, guides: [] });
  });

  it('prefers a corner over an edge over a line, even when the others are closer', () => {
    const t: SnapTargets = {
      corners: [[112, 100]],
      edges: [
        [
          [0, 104],
          [200, 104],
        ],
      ],
      lines: { h: [[101, 0, 200]], v: [] },
    };
    expect(snapPoint([100, 100], t, R)).toMatchObject({ x: 112, y: 100 });
    expect(snapPoint([100, 100], { ...t, corners: [] }, R)).toMatchObject({ x: 100, y: 104 });
    expect(snapPoint([100, 100], { ...t, corners: [], edges: [] }, R)).toMatchObject({ x: 100, y: 101 });
  });

  it('uses each radius, and 0 turns that snap off', () => {
    const t: SnapTargets = { ...none, corners: [[120, 100]] };
    expect(snapPoint([100, 100], t, R).x).toBe(100); // 20 away, reach is 16
    expect(snapPoint([100, 100], t, { ...R, corner: 25 }).x).toBe(120);
    expect(snapPoint([120, 100], t, { ...R, corner: 0 }).guides).toEqual([]);
    const lines: SnapTargets = { ...none, lines: { h: [[100, 0, 200]], v: [] } };
    expect(snapPoint([50, 102], lines, { ...R, line: 0 }).y).toBe(102);
  });

  it('snaps to the nearest of several corners', () => {
    const t: SnapTargets = {
      ...none,
      corners: [
        [110, 100],
        [104, 100],
      ],
    };
    expect(snapPoint([100, 100], t, R).x).toBe(104);
  });

  it('settles where a horizontal and a vertical line cross', () => {
    const t: SnapTargets = { ...none, lines: { h: [[100, 0, 200]], v: [[50, 0, 200]] } };
    const r = snapPoint([53, 97], t, R);
    expect(r).toMatchObject({ x: 50, y: 100 });
    expect(r.guides).toHaveLength(2);
  });

  it('ignores a line when the corner is past its end', () => {
    const t: SnapTargets = { ...none, lines: { h: [[100, 0, 50]], v: [] } };
    expect(snapPoint([53, 102], t, R).y).toBe(100); // within reach of the end
    expect(snapPoint([80, 102], t, R).y).toBe(102);
  });
});

describe('zones and sheets as targets', () => {
  const zones = [
    {
      id: 'a',
      floorId: 'f',
      points: [
        [0.1, 0.1],
        [0.2, 0.1],
        [0.2, 0.2],
      ] as [number, number][],
    },
    { id: 'b', floorId: 'g', points: [[0.5, 0.5]] as [number, number][] },
  ];
  it('uses the other zones on the same floor, in sheet pixels', () => {
    const t = zoneSnapTargets(zones, 'f', null, 1000, 500);
    expect(t.corners).toEqual([
      [100, 50],
      [200, 50],
      [200, 100],
    ]);
    expect(t.edges).toHaveLength(3);
    expect(t.edges[2]).toEqual([
      [200, 100],
      [100, 50],
    ]);
    expect(zoneSnapTargets(zones, 'f', 'a', 1000, 500).corners).toEqual([]);
  });
  it('scales lines by each direction of the sheet', () => {
    expect(sheetLinesToPx({ h: [[0.5, 0, 1]], v: [[0.5, 0, 1]] }, 1000, 500)).toEqual({
      h: [[250, 0, 1000]],
      v: [[500, 0, 500]],
    });
  });
});

describe('nearestOnOutline', () => {
  const square: [number, number][] = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  it('finds the spot and which corner it follows', () => {
    expect(nearestOnOutline(square, [50, 4])).toMatchObject({ after: 0, x: 50, y: 0, dist: 4 });
    expect(nearestOnOutline(square, [96, 50])).toMatchObject({ after: 1, x: 100, y: 50 });
  });
  it('includes the closing edge', () => {
    expect(nearestOnOutline(square, [3, 50])).toMatchObject({ after: 3, x: 0, y: 50 });
  });
});
