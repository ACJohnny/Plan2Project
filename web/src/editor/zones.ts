import { useMemo } from 'react';
import {
  projectSummary,
  zoneAt,
  type Floor,
  type Marker,
  type ProjectSummary,
  type RunFloor,
  type Zone,
} from '@sixpoint/shared';
import { api } from '../api';
import { toast } from '../toast';
import { uuid } from '../uuid';
import { getState, setState, useEditor } from './store';

/** Enter or leave Zone Edit mode. Outside it, zones can't be clicked, drawn or reshaped. */
export function setZoneEdit(on: boolean) {
  const s = getState();
  if (on && !s.canEdit) return;
  setState(
    on
      ? { zoneEdit: true, armed: null, boxMode: false, selection: [], tool: null }
      : {
          zoneEdit: false,
          selectedZone: null,
          roomDraft: null,
          tool: s.tool === 'zone' ? null : s.tool,
        },
  );
}

/* ---------- zone writes (optimistic, no undo) ---------- */

export async function saveZone(z: Zone) {
  const s = getState();
  const prev = s.zones[z.id] ?? null;
  setState({ zones: { ...s.zones, [z.id]: z } });
  try {
    const saved = await api.put<Zone>(`/api/zones/${z.id}`, {
      projectId: z.projectId,
      floorId: z.floorId,
      name: z.name,
      kind: z.kind,
      points: z.points,
      audioFormat: z.audioFormat,
      showName: z.showName,
    });
    setState({ zones: { ...getState().zones, [z.id]: saved } });
    return saved;
  } catch (e: any) {
    const cur = { ...getState().zones };
    if (prev) cur[z.id] = prev;
    else delete cur[z.id];
    setState({ zones: cur });
    toast.error(`Couldn't save zone ${z.name}: ${e.message}`);
    return null;
  }
}

export function newZone(floorId: string, points: [number, number][]): Zone {
  const s = getState();
  return {
    id: uuid(),
    projectId: s.projectId!,
    floorId,
    name: '',
    kind: 'room',
    points: points.map(([x, y]) => [round(x), round(y)]),
    audioFormat: null,
    showName: true,
    updatedAt: new Date().toISOString(),
  };
}

const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e5) / 1e5;

export async function deleteZone(id: string) {
  const s = getState();
  const prev = s.zones[id];
  if (!prev) return;
  const next = { ...s.zones };
  delete next[id];
  // devices sent to this closet fall back to the default
  const markers = { ...s.markers };
  for (const m of Object.values(markers))
    if (m.closetZoneId === id) markers[m.id] = { ...m, closetZoneId: null };
  setState({ zones: next, markers, selectedZone: s.selectedZone === id ? null : s.selectedZone });
  try {
    await api.del(`/api/zones/${id}`);
    toast.info(`Deleted ${prev.kind === 'closet' ? 'equipment closet' : 'zone'} ${prev.name}`);
  } catch (e: any) {
    setState({ zones: { ...getState().zones, [id]: prev } });
    toast.error(`Couldn't delete zone: ${e.message}`);
  }
}

/** Update a floor's scale / height / riser fields. */
export async function patchFloor(id: string, body: Partial<Floor>) {
  const s = getState();
  const prev = s.floors.find((f) => f.id === id);
  setState({ floors: s.floors.map((f) => (f.id === id ? { ...f, ...body } : f)) });
  try {
    const f = await api.patch<Floor>(`/api/floors/${id}`, body);
    setState({ floors: getState().floors.map((x) => (x.id === id ? f : x)) });
    return f;
  } catch (e: any) {
    if (prev) setState({ floors: getState().floors.map((x) => (x.id === id ? prev : x)) });
    toast.error(`Couldn't save floor: ${e.message}`);
    return null;
  }
}

export function zoneForPoint(floorId: string, x: number, y: number): Zone | null {
  return zoneAt(Object.values(getState().zones), floorId, x, y);
}

/* ---------- live summary: runs, wire totals, audio zones ---------- */

export function runFloorsOf(floors: Floor[]): RunFloor[] {
  return floors.map((f) => ({
    id: f.id,
    name: f.name,
    widthPx: f.widthPx,
    heightPx: f.heightPx,
    ftPerPx: f.ftPerPx,
    floorHeightFt: f.floorHeightFt,
    riser: f.riserX != null && f.riserY != null ? { x: f.riserX, y: f.riserY } : null,
  }));
}

export function computeSummary(
  floors: Floor[],
  zones: Record<string, Zone>,
  markers: Record<string, Marker>,
  s: ReturnType<typeof getState>,
): ProjectSummary {
  const audioCats = new Set(s.categories.filter((c) => c.name.toLowerCase() === 'audio').map((c) => c.id));
  // record insertion order = server creation order, which decides the default closet
  return projectSummary({
    floors: runFloorsOf(floors),
    zones: Object.values(zones),
    markers: Object.values(markers),
    typeWires: new Map(s.types.map((t) => [t.id, t.wires])),
    wireTypes: s.wireTypes,
    audioTypeIds: new Set(s.types.filter((t) => audioCats.has(t.categoryId)).map((t) => t.id)),
    extraFt: s.project?.extraWireFt ?? 0,
  });
}

export function useSummary(): ProjectSummary {
  const floors = useEditor((s) => s.floors);
  const zones = useEditor((s) => s.zones);
  const markers = useEditor((s) => s.markers);
  const types = useEditor((s) => s.types);
  const wireTypes = useEditor((s) => s.wireTypes);
  const extra = useEditor((s) => s.project?.extraWireFt ?? 0);
  return useMemo(
    () => computeSummary(floors, zones, markers, getState()),
    [floors, zones, markers, types, wireTypes, extra],
  );
}

/** Closets in project order (first = default). */
export function useClosets(): Zone[] {
  const floors = useEditor((s) => s.floors);
  const zones = useEditor((s) => s.zones);
  return useMemo(() => {
    const fi = new Map(floors.map((f, i) => [f.id, i]));
    return Object.values(zones)
      .filter((z) => z.kind === 'closet' && fi.has(z.floorId))
      .sort((a, b) => fi.get(a.floorId)! - fi.get(b.floorId)!);
  }, [floors, zones]);
}
