/** Marker numbering rules (R-29, R-30, R-42). Pure functions shared by server and web. */

export interface NumberedMarker {
  id: string;
  typeId: string;
  number: number;
  floorId: string;
  x: number;
  y: number;
}

export function formatTag(code: string, number: number): string {
  return `${code}${number}`;
}

/** Next number = highest existing number for that type across the project + 1. */
export function nextNumber(
  markers: Iterable<Pick<NumberedMarker, 'typeId' | 'number'>>,
  typeId: string,
): number {
  let max = 0;
  for (const m of markers) if (m.typeId === typeId && m.number > max) max = m.number;
  return max + 1;
}

/** Markers of the same type already using `number`, excluding `selfId`. */
export function findDuplicates<T extends Pick<NumberedMarker, 'id' | 'typeId' | 'number'>>(
  markers: Iterable<T>,
  typeId: string,
  number: number,
  selfId?: string,
): T[] {
  const out: T[] = [];
  for (const m of markers) if (m.typeId === typeId && m.number === number && m.id !== selfId) out.push(m);
  return out;
}

export interface RenumberChange {
  id: string;
  typeId: string;
  oldNumber: number;
  newNumber: number;
}

/**
 * Re-sequence one type (or all, when typeId is null) by floor order, then top-to-bottom, left-to-right.
 * Rows are bucketed with a small y tolerance so markers on roughly the same line order left-to-right.
 */
export function planRenumber(
  markers: NumberedMarker[],
  floorOrder: string[],
  typeId: string | null,
  rowTolerance = 0.01,
): RenumberChange[] {
  const floorIndex = new Map(floorOrder.map((id, i) => [id, i]));
  const byType = new Map<string, NumberedMarker[]>();
  for (const m of markers) {
    if (typeId && m.typeId !== typeId) continue;
    if (!floorIndex.has(m.floorId)) continue;
    const list = byType.get(m.typeId) ?? [];
    list.push(m);
    byType.set(m.typeId, list);
  }
  const changes: RenumberChange[] = [];
  for (const [tid, list] of byType) {
    const sorted = sortReadingOrder(list, floorIndex, rowTolerance);
    sorted.forEach((m, i) => changes.push({ id: m.id, typeId: tid, oldNumber: m.number, newNumber: i + 1 }));
  }
  return changes;
}

export function sortReadingOrder<T extends Pick<NumberedMarker, 'floorId' | 'x' | 'y' | 'number'>>(
  list: T[],
  floorIndex: Map<string, number>,
  rowTolerance = 0.01,
): T[] {
  const row = (y: number) => Math.round(y / rowTolerance);
  return [...list].sort((a, b) => {
    const fa = floorIndex.get(a.floorId) ?? 0;
    const fb = floorIndex.get(b.floorId) ?? 0;
    if (fa !== fb) return fa - fb;
    const ra = row(a.y);
    const rb = row(b.y);
    if (ra !== rb) return ra - rb;
    if (a.x !== b.x) return a.x - b.x;
    return a.number - b.number;
  });
}

/** Parse "SPK12" into code + number. */
export function parseTag(tag: string): { code: string; number: number } | null {
  const m = /^([A-Z]{1,6})(\d+)$/.exec(tag.trim().toUpperCase());
  return m ? { code: m[1], number: Number(m[2]) } : null;
}
