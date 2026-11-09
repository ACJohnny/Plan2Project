import type { Floor, SheetLines } from '@sixpoint/shared';
import { api } from '../api';

const cache = new Map<string, Promise<SheetLines | null>>();

/** The lines found on a floor's sheet; null if they can't be had, and snapping just skips them. */
export function loadSheetLines(floor: Floor): Promise<SheetLines | null> {
  let job = cache.get(floor.imageUrl);
  if (!job) {
    job = api.get<SheetLines>(`/api/floors/${floor.id}/sheet-lines`).catch(() => {
      cache.delete(floor.imageUrl);
      return null;
    });
    cache.set(floor.imageUrl, job);
  }
  return job;
}
