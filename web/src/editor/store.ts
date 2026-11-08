import { create } from 'zustand';
import type {
  Category,
  DeviceType,
  Floor,
  Marker,
  PresenceUser,
  Project,
  Upload,
  View,
  WireType,
  Zone,
} from '@sixpoint/shared';

export type SaveStatus = 'saved' | 'saving' | 'offline' | 'failed';

export interface Change {
  id: string;
  before: Marker | null;
  after: Marker | null;
}
export interface HistoryEntry {
  label: string;
  changes: Change[];
  coalesceKey?: string;
  at: number;
}

export interface EditorState {
  projectId: string | null;
  project: Project | null;
  floors: Floor[];
  categories: Category[];
  types: DeviceType[];
  markers: Record<string, Marker>;
  zones: Record<string, Zone>;
  wireTypes: WireType[];
  /** extra plan tools beyond select/box/place */
  tool: 'zone' | 'riser' | 'calibrate' | null;
  selectedZone: string | null;
  /** Zone Edit mode: only then can zones be drawn, selected and reshaped */
  zoneEdit: boolean;
  /** admin-managed zone names for autocomplete */
  zoneNames: string[];
  /** the all-zones table dialog is open */
  zonesTable: boolean;
  floorId: string | null;
  selection: string[];
  armed: string | null;
  boxMode: boolean;
  views: Record<string, View>;
  saveStatus: SaveStatus;
  pending: number;
  presence: PresenceUser[];
  uploads: Record<string, Upload>;
  lastPlaced: { floorId: string; room: string; at: number } | null;
  clipboard: Marker[];
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  canEdit: boolean;
  scheduleScope: 'floor' | 'all';
  /** bump to ask the plan to center on a marker or zone */
  focus: { id: string; n: number } | null;
}

export const initialState = (): EditorState => ({
  projectId: null,
  project: null,
  floors: [],
  categories: [],
  types: [],
  markers: {},
  zones: {},
  wireTypes: [],
  tool: null,
  selectedZone: null,
  zoneEdit: false,
  zoneNames: [],
  zonesTable: false,
  floorId: null,
  selection: [],
  armed: null,
  boxMode: false,
  views: {},
  saveStatus: 'saved',
  pending: 0,
  presence: [],
  uploads: {},
  lastPlaced: null,
  clipboard: [],
  undo: [],
  redo: [],
  canEdit: false,
  scheduleScope: 'floor',
  focus: null,
});

export const useEditor = create<EditorState>(() => initialState());
export const getState = useEditor.getState;
export const setState = useEditor.setState;

/* ---------- derived helpers ---------- */

export function typeMap(s: Pick<EditorState, 'types'>) {
  return new Map(s.types.map((t) => [t.id, t]));
}
export function catMap(s: Pick<EditorState, 'categories'>) {
  return new Map(s.categories.map((c) => [c.id, c]));
}

let tagCache: {
  types: DeviceType[];
  map: Map<string, DeviceType>;
  cats: Category[];
  cmap: Map<string, Category>;
} | null = null;
function maps() {
  const s = getState();
  if (!tagCache || tagCache.types !== s.types || tagCache.cats !== s.categories)
    tagCache = { types: s.types, map: typeMap(s), cats: s.categories, cmap: catMap(s) };
  return tagCache;
}

export function typeOf(typeId: string): DeviceType | undefined {
  return maps().map.get(typeId);
}
export function colorOf(typeId: string): string {
  const t = maps().map.get(typeId);
  return (t && maps().cmap.get(t.categoryId)?.color) ?? '#6b7280';
}
export function tagOf(m: Pick<Marker, 'typeId' | 'number'>): string {
  return `${typeOf(m.typeId)?.code ?? '?'}${m.number}`;
}

export function currentFloor(s: EditorState = getState()): Floor | undefined {
  return s.floors.find((f) => f.id === s.floorId);
}

export function floorMarkers(s: EditorState, floorId: string | null): Marker[] {
  if (!floorId) return [];
  return Object.values(s.markers).filter((m) => m.floorId === floorId);
}
