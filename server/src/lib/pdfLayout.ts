/** Pure layout math for the print PDF (R-57). Units are PDF points (1/72 in). Unit tested. */

export const TABLOID_LANDSCAPE = { width: 17 * 72, height: 11 * 72 }; // 1224 × 792
export const LETTER_PORTRAIT = { width: 8.5 * 72, height: 11 * 72 }; // 612 × 792
export const LETTER_LANDSCAPE = { width: 11 * 72, height: 8.5 * 72 };
export const MAX_IMAGE_DPI = 200;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Largest rect with the image's aspect ratio that fits inside `area`, centered. */
export function fitRect(img: { width: number; height: number }, area: Rect): Rect {
  const s = Math.min(area.w / img.width, area.h / img.height);
  const w = img.width * s;
  const h = img.height * s;
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}

/** Pixel width to embed so the drawn image is at most MAX_IMAGE_DPI at print size. */
export function embedWidthPx(drawWidthPt: number, sourceWidthPx: number, dpi = MAX_IMAGE_DPI): number {
  return Math.min(sourceWidthPx, Math.round((drawWidthPt / 72) * dpi));
}

/** Marker fraction → PDF point (PDF origin is bottom-left). */
export function markerPoint(rect: Rect, fx: number, fy: number): { x: number; y: number } {
  return { x: rect.x + fx * rect.w, y: rect.y + (1 - fy) * rect.h };
}

export interface FloorPageLayout {
  page: { width: number; height: number };
  titleStrip: Rect;
  band: Rect;
  legend: Rect;
  planArea: Rect;
}

export function floorPageLayout(margin = 24, stripH = 58, legendW = 176, gap = 12): FloorPageLayout {
  const page = TABLOID_LANDSCAPE;
  const titleStrip = { x: margin, y: page.height - margin - stripH, w: page.width - margin * 2, h: stripH };
  const band = { x: margin, y: titleStrip.y - 3, w: titleStrip.w, h: 3 };
  const bodyTop = band.y - gap;
  const legend = { x: page.width - margin - legendW, y: margin, w: legendW, h: bodyTop - margin };
  const planArea = { x: margin, y: margin, w: legend.x - gap - margin, h: bodyTop - margin };
  return { page, titleStrip, band, legend, planArea };
}

/**
 * Split rows across pages. Each page has `firstPageSpace` (page 1) or `pageSpace` (later pages) points
 * available after the repeated header row. Returns arrays of row indexes per page.
 */
export function paginate(heights: number[], firstPageSpace: number, pageSpace: number): number[][] {
  const pages: number[][] = [[]];
  let left = firstPageSpace;
  heights.forEach((h, i) => {
    if (h > left && pages[pages.length - 1].length) {
      pages.push([]);
      left = pageSpace;
    }
    pages[pages.length - 1].push(i);
    left -= h;
  });
  return pages;
}

/** Greedy word wrap using a width function. */
export function wrapText(text: string, maxWidth: number, width: (s: string) => number, maxLines = 4): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (width(next) <= maxWidth || !line) {
        line = next;
        // hard-break very long words
        while (width(line) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && width(line.slice(0, cut)) > maxWidth) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && width(last + '…') > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = last + '…';
    return kept;
  }
  return out;
}

/** Truncate to one line with an ellipsis. */
export function truncate(text: string, maxWidth: number, width: (s: string) => number): string {
  if (width(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && width(t + '…') > maxWidth) t = t.slice(0, -1);
  return t + '…';
}

/** Count markers by type id. */
export function countByType(markers: { typeId: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of markers) m.set(x.typeId, (m.get(x.typeId) ?? 0) + 1);
  return m;
}
