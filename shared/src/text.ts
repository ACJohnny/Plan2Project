/** Text outputs shared by server exports and the web client (R-56, R-58, R-59). */

export function slugify(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'project'
  );
}

export function isoDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function exportFilename(projectName: string, ext: 'pdf' | 'csv' | 'txt', d = new Date()): string {
  return `${slugify(projectName)}-device-plan-${isoDate(d)}.${ext}`;
}

export interface ExportFloor {
  id: string;
  name: string;
  sheetNumber: string | null;
}
export interface ExportType {
  id: string;
  code: string;
  name: string;
  category: string;
  color: string;
  order: number;
}
export interface ExportMarker {
  id: string;
  floorId: string;
  typeId: string;
  number: number;
  x: number;
  y: number;
  room: string;
  mountHeight: string;
  notes: string;
}

/** Markers sorted for schedules: library type order, then number. */
export function sortForSchedule<M extends ExportMarker>(markers: M[], types: Map<string, ExportType>): M[] {
  return [...markers].sort((a, b) => {
    const ta = types.get(a.typeId)?.order ?? 0;
    const tb = types.get(b.typeId)?.order ?? 0;
    return ta - tb || a.number - b.number;
  });
}

export function deviceListText(
  project: { name: string },
  floors: ExportFloor[],
  types: Map<string, ExportType>,
  markers: ExportMarker[],
  date = new Date(),
): string {
  const lines: string[] = [`${project.name} — device list`, `Exported ${isoDate(date)}`, ''];
  let total = 0;
  for (const f of floors) {
    const ms = sortForSchedule(
      markers.filter((m) => m.floorId === f.id),
      types,
    );
    total += ms.length;
    const head = f.sheetNumber ? `${f.name} (${f.sheetNumber})` : f.name;
    lines.push(`${head} — ${ms.length} device${ms.length === 1 ? '' : 's'}`);
    for (const m of ms) {
      const t = types.get(m.typeId);
      const parts = [
        `${t?.code ?? '?'}${m.number}`,
        t?.name ?? 'Unknown',
        m.room || 'No room',
        `x ${m.x.toFixed(3)}, y ${m.y.toFixed(3)}`,
      ];
      if (m.notes) parts.push(m.notes.replace(/\s*\n\s*/g, ' / '));
      lines.push('  ' + parts.join(' · '));
    }
    lines.push('');
  }
  lines.push(`Total: ${total} device${total === 1 ? '' : 's'}`);
  return lines.join('\n');
}

function csvCell(v: string | number): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  'floor',
  'sheet',
  'tag',
  'code',
  'type',
  'category',
  'number',
  'room',
  'mount_height',
  'notes',
  'x',
  'y',
] as const;

export function deviceCsv(floors: ExportFloor[], types: Map<string, ExportType>, markers: ExportMarker[]): string {
  const rows: string[] = [CSV_COLUMNS.join(',')];
  for (const f of floors) {
    for (const m of sortForSchedule(
      markers.filter((mm) => mm.floorId === f.id),
      types,
    )) {
      const t = types.get(m.typeId);
      rows.push(
        [
          f.name,
          f.sheetNumber ?? '',
          `${t?.code ?? ''}${m.number}`,
          t?.code ?? '',
          t?.name ?? '',
          t?.category ?? '',
          m.number,
          m.room,
          m.mountHeight,
          m.notes,
          m.x.toFixed(5),
          m.y.toFixed(5),
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}

/** Pull "A2.1 1st Floor Plan" style sheet titles from pdftotext output (R-19). */
export function extractSheetTitle(text: string): { sheetNumber: string; title: string } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const num = /\b([A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?)\b/;
  const titleWords = /(PLAN|FLOOR|LEVEL|BASEMENT|ELEVATION|SECTION|DETAIL|ROOF|SITE|SCHEDULE|LAYOUT|CEILING|ATTIC|GARAGE)/i;
  // 1) a line that is "<num> <title>"
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^([A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?)\s+(.{3,60})$/.exec(lines[i]);
    if (m && titleWords.test(m[2])) return { sheetNumber: m[1], title: tidyTitle(m[2]) };
  }
  // 2) a sheet-number-only line, with the title after a "SHEET TITLE" label or nearby
  const isNum = (l: string) => /^(?:SHEET\s*(?:NO\.?|NUMBER)?:?\s*)?([A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?)$/i.exec(l);
  const isLabel = (l: string) => /^(SHEET( TITLE| NO\.?| NUMBER)?|TITLE|DRAWING( TITLE)?|SCALE.*|N)$/i.test(l);
  let numIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (isNum(lines[i]) && /\d/.test(lines[i])) {
    numIdx = i;
    break;
  }
  if (numIdx < 0) return null;
  const sheetNumber = isNum(lines[numIdx])![1].toUpperCase();
  const labelIdx = lines.findIndex((l) => /^(SHEET |DRAWING )?TITLE:?$/i.test(l));
  if (labelIdx >= 0) {
    const after = lines.slice(labelIdx + 1, labelIdx + 6).filter((l) => !isLabel(l) && !isNum(l));
    const t = after.find((l) => titleWords.test(l)) ?? after[0];
    if (t && t.length <= 60 && !isNum(t)) return { sheetNumber, title: tidyTitle(t) };
  }
  for (let d = 1; d <= 6; d++) {
    for (const j of [numIdx - d, numIdx + d]) {
      const l = lines[j];
      if (l && titleWords.test(l) && l.length <= 60 && !num.test(l) && !isLabel(l)) return { sheetNumber, title: tidyTitle(l) };
    }
  }
  return { sheetNumber, title: '' };
}

function tidyTitle(t: string): string {
  const s = t.trim().replace(/^(SHEET\s*TITLE:?\s*)/i, '');
  if (s === s.toUpperCase()) {
    return s
      .toLowerCase()
      .replace(/\b([a-z])/g, (c) => c.toUpperCase())
      .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (_m, n, suf) => n + suf.toLowerCase());
  }
  return s;
}
