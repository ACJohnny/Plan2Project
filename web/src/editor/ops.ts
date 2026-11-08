import { uuid } from '../uuid';
import {
  nextNumber,
  toFraction,
  type BatchMarkersBody,
  type Marker,
  type PutMarkerBody,
} from '@sixpoint/shared';
import { api, ApiError } from '../api';
import { toast } from '../toast';
import { getState, setState, tagOf, typeOf, type Change, type HistoryEntry } from './store';
import { zoneForPoint } from './zones';

/* =====================================================================
 * Write queue (R-49, R-50, R-52): optimistic local apply, ordered sends,
 * retry once, roll back with a toast, queue while offline.
 * ===================================================================== */

type Op =
  | {
      kind: 'put';
      id: string;
      body: PutMarkerBody;
      rollback: Map<string, Marker | null>;
      label: string;
      tries: number;
    }
  | { kind: 'delete'; id: string; rollback: Map<string, Marker | null>; label: string; tries: number }
  | {
      kind: 'batch';
      body: BatchMarkersBody;
      rollback: Map<string, Marker | null>;
      label: string;
      tries: number;
    };

const queue: Op[] = [];
let running = false;
let lastFailed = false;

/** marker ids with unsent local changes; remote updates for them are ignored until sent */
export function pendingIds(): Set<string> {
  const s = new Set<string>();
  for (const op of queue) for (const id of op.rollback.keys()) s.add(id);
  return s;
}

function updateStatus(status?: 'offline') {
  setState({
    pending: queue.length,
    saveStatus: status ?? (queue.length ? 'saving' : lastFailed ? 'failed' : 'saved'),
  });
}

function enqueue(op: Op) {
  // Coalesce consecutive edits of the same marker that haven't been sent yet (autosave while typing).
  const last = queue[queue.length - 1];
  const lastIsSending = running && queue.length === 1;
  if (op.kind === 'put' && last?.kind === 'put' && last.id === op.id && !lastIsSending && !op.body.restore) {
    last.body = { ...op.body, autoNumber: last.body.autoNumber || op.body.autoNumber };
    last.label = op.label;
    updateStatus();
    return;
  }
  queue.push(op);
  updateStatus();
  void pump();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitOnline() {
  updateStatus('offline');
  for (;;) {
    await Promise.race([
      sleep(3000),
      new Promise((r) => window.addEventListener('online', r, { once: true })),
    ]);
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      if (r.ok) return;
    } catch {
      /* still offline */
    }
  }
}

async function send(op: Op): Promise<Marker[]> {
  if (op.kind === 'put') return [await api.put<Marker>(`/api/markers/${op.id}`, op.body)];
  if (op.kind === 'delete') {
    await api.del(`/api/markers/${op.id}`);
    return [];
  }
  const r = await api.patch<{ markers: Marker[]; rejected: string[] }>('/api/markers/batch', op.body);
  if (r.rejected.length) dropLocal(r.rejected);
  return r.markers;
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const op = queue[0];
      try {
        const markers = await send(op);
        queue.shift();
        lastFailed = false;
        acceptServer(markers);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(500, String(e));
        if (err.network) {
          await waitOnline();
          continue;
        }
        if (err.status === 410) {
          // written against a marker someone deleted: drop quietly (R-52)
          queue.shift();
          if (op.kind === 'put') dropLocal([op.id]);
          continue;
        }
        if (op.tries < 1 && err.status !== 401 && err.status !== 403) {
          op.tries++;
          await sleep(600);
          continue;
        }
        queue.shift();
        lastFailed = true;
        rollback(op);
        toast.error(`Couldn't save ${op.label}: ${err.message}. The change was undone.`);
      }
      updateStatus();
    }
  } finally {
    running = false;
    updateStatus();
  }
}

/** Server copies win unless there are newer local changes still queued. */
function acceptServer(markers: Marker[]) {
  if (!markers.length) return;
  const pend = pendingIds();
  const s = getState();
  const next = { ...s.markers };
  let changed = false;
  for (const m of markers) {
    if (pend.has(m.id)) continue;
    const local = next[m.id];
    if (!local) continue; // deleted locally since
    if (local.number !== m.number) fixHistoryNumber(m.id, m.number);
    next[m.id] = m;
    changed = true;
  }
  if (changed) setState({ markers: next });
}

function fixHistoryNumber(id: string, number: number) {
  const fix = (h: HistoryEntry[]) =>
    h.map((e) => ({
      ...e,
      changes: e.changes.map((c) => (c.id === id && c.after ? { ...c, after: { ...c.after, number } } : c)),
    }));
  const s = getState();
  setState({ undo: fix(s.undo), redo: fix(s.redo) });
}

function dropLocal(ids: string[]) {
  const s = getState();
  const next = { ...s.markers };
  for (const id of ids) delete next[id];
  setState({ markers: next, selection: s.selection.filter((x) => !ids.includes(x)) });
}

function rollback(op: Op) {
  const s = getState();
  const next = { ...s.markers };
  for (const [id, prev] of op.rollback) {
    if (prev) next[id] = prev;
    else delete next[id];
  }
  setState({ markers: next, selection: s.selection.filter((id) => next[id]) });
}

export function hasPendingWrites() {
  return queue.length > 0;
}

/* =====================================================================
 * Local apply + history (R-37)
 * ===================================================================== */

const HISTORY_MAX = 50;

function bodyOf(m: Marker, extra: Partial<PutMarkerBody> = {}): PutMarkerBody {
  return {
    projectId: m.projectId,
    floorId: m.floorId,
    typeId: m.typeId,
    number: m.number,
    x: m.x,
    y: m.y,
    room: m.room,
    mountHeight: m.mountHeight,
    notes: m.notes,
    closetZoneId: m.closetZoneId,
    ...extra,
  };
}

/** Apply a set of changes locally and queue the matching server writes. */
function commit(
  changes: Change[],
  label: string,
  opts: { autoNumber?: Set<string>; restore?: boolean } = {},
) {
  if (!changes.length) return;
  const s = getState();
  const next = { ...s.markers };
  const rollbackMap = new Map<string, Marker | null>();
  for (const c of changes) {
    rollbackMap.set(c.id, s.markers[c.id] ?? null);
    if (c.after) next[c.id] = c.after;
    else delete next[c.id];
  }
  setState({ markers: next, selection: s.selection.filter((id) => next[id]) });

  const projectId = s.projectId!;
  if (changes.length === 1) {
    const c = changes[0];
    if (!c.after) enqueue({ kind: 'delete', id: c.id, rollback: rollbackMap, label, tries: 0 });
    else
      enqueue({
        kind: 'put',
        id: c.id,
        body: bodyOf(c.after, {
          ...(opts.autoNumber?.has(c.id) ? { autoNumber: true, number: undefined } : {}),
          ...(opts.restore && !c.before ? {} : {}),
          ...(opts.restore && !s.markers[c.id] ? { restore: true } : {}),
        }),
        rollback: rollbackMap,
        label,
        tries: 0,
      });
    return;
  }
  const body: BatchMarkersBody = { projectId, updates: [], creates: [], deletes: [] };
  for (const c of changes) {
    if (!c.after) body.deletes.push(c.id);
    else if (!s.markers[c.id])
      body.creates.push({
        ...bodyOf(c.after, opts.autoNumber?.has(c.id) ? { autoNumber: true, number: undefined } : {}),
        id: c.id,
        restore: opts.restore,
      });
    else {
      const a = c.after;
      body.updates.push({
        id: c.id,
        floorId: a.floorId,
        typeId: a.typeId,
        x: a.x,
        y: a.y,
        room: a.room,
        mountHeight: a.mountHeight,
        notes: a.notes,
        closetZoneId: a.closetZoneId,
        ...(opts.autoNumber?.has(c.id) ? { autoNumber: true } : { number: a.number }),
      });
    }
  }
  enqueue({ kind: 'batch', body, rollback: rollbackMap, label, tries: 0 });
}

function pushHistory(entry: HistoryEntry) {
  const s = getState();
  const top = s.undo[s.undo.length - 1];
  if (entry.coalesceKey && top?.coalesceKey === entry.coalesceKey && entry.at - top.at < 5000) {
    // merge: keep the original befores, take the latest afters
    const merged: HistoryEntry = {
      ...top,
      at: entry.at,
      changes: top.changes.map((c) => ({
        ...c,
        after: entry.changes.find((e) => e.id === c.id)?.after ?? c.after,
      })),
    };
    setState({ undo: [...s.undo.slice(0, -1), merged], redo: [] });
    return;
  }
  setState({ undo: [...s.undo, entry].slice(-HISTORY_MAX), redo: [] });
}

function describe(changes: Change[], verb: string) {
  const m = changes[0]?.after ?? changes[0]?.before;
  if (changes.length === 1 && m) return `${verb} ${tagOf(m)}`;
  return `${verb} ${changes.length} devices`;
}

/* =====================================================================
 * Actions
 * ===================================================================== */

export function newMarker(typeId: string, floorId: string, x: number, y: number, number?: number): Marker {
  const s = getState();
  const t = typeOf(typeId);
  const now = Date.now();
  const lp = s.lastPlaced;
  // a device placed inside a zone takes the zone's name; otherwise R-43 prefill
  const zone = zoneForPoint(floorId, x, y);
  const room = zone ? zone.name : lp && lp.floorId === floorId && now - lp.at < 2 * 60_000 ? lp.room : '';
  const notes = [t?.defaultModel, t?.defaultNotes].filter(Boolean).join('\n'); // R-26
  return {
    id: uuid(),
    projectId: s.projectId!,
    floorId,
    typeId,
    number: number ?? nextNumber(Object.values(s.markers), typeId),
    x: toFraction(x),
    y: toFraction(y),
    room,
    mountHeight: '',
    notes,
    closetZoneId: null,
    createdBy: null,
    updatedBy: null,
    updatedAt: new Date().toISOString(),
  };
}

/** R-28 */
export function placeMarker(typeId: string, x: number, y: number) {
  const s = getState();
  if (!s.floorId) return;
  const m = newMarker(typeId, s.floorId, x, y);
  const changes = [{ id: m.id, before: null, after: m }];
  commit(changes, tagOf(m), { autoNumber: new Set([m.id]) });
  pushHistory({ label: `Place ${tagOf(m)}`, changes, at: Date.now() });
  setState({
    selection: [m.id],
    selectedZone: null,
    lastPlaced: { floorId: m.floorId, room: m.room, at: Date.now() },
  });
  return m;
}

/** R-31, R-35: positions are already applied locally during the drag; this records them. */
export function commitMove(before: Marker[]) {
  const s = getState();
  const changes: Change[] = [];
  for (const b of before) {
    const a = s.markers[b.id];
    if (a && (a.x !== b.x || a.y !== b.y)) {
      const after = { ...a, x: toFraction(a.x), y: toFraction(a.y) };
      // moving into another zone updates a room that was blank or came from the old zone
      const from = zoneForPoint(b.floorId, b.x, b.y);
      const to = zoneForPoint(after.floorId, after.x, after.y);
      if (to && to.id !== from?.id && (!b.room || b.room === from?.name)) after.room = to.name;
      changes.push({ id: b.id, before: b, after });
    }
  }
  if (!changes.length) return;
  // restore the "before" locally so commit() records a correct rollback, then apply
  const tmp = { ...s.markers };
  for (const b of before) if (tmp[b.id]) tmp[b.id] = b;
  setState({ markers: tmp });
  commit(changes, describe(changes, 'move'));
  pushHistory({ label: describe(changes, 'Move'), changes, at: Date.now() });
}

/** Local-only position update while dragging (not saved, not in history). */
export function setPositionsLocal(pos: Map<string, { x: number; y: number }>) {
  const s = getState();
  const next = { ...s.markers };
  for (const [id, p] of pos) if (next[id]) next[id] = { ...next[id], x: p.x, y: p.y };
  setState({ markers: next });
}

export function nudge(ids: string[], dx: number, dy: number) {
  const s = getState();
  const before = ids.map((id) => s.markers[id]).filter(Boolean);
  if (!before.length) return;
  const changes = before.map((b) => ({
    id: b.id,
    before: b,
    after: { ...b, x: toFraction(b.x + dx), y: toFraction(b.y + dy) },
  }));
  commit(changes, describe(changes, 'move'));
  pushHistory({
    label: describe(changes, 'Move'),
    changes,
    coalesceKey: `nudge:${ids.join(',')}`,
    at: Date.now(),
  });
}

/** R-40, R-45: field edits on one or more markers. */
export function editMarkers(
  ids: string[],
  patch: Partial<Pick<Marker, 'room' | 'mountHeight' | 'notes' | 'number' | 'closetZoneId'>>,
  field: string,
) {
  const s = getState();
  const changes: Change[] = [];
  for (const id of ids) {
    const b = s.markers[id];
    if (!b) continue;
    const a = { ...b, ...patch };
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ id, before: b, after: a });
  }
  if (!changes.length) return;
  commit(changes, describe(changes, 'edit to'));
  pushHistory({
    label: describe(changes, 'Edit'),
    changes,
    coalesceKey: `edit:${field}:${ids.join(',')}`,
    at: Date.now(),
  });
  if (patch.room !== undefined && s.lastPlaced && ids.length === 1)
    setState({ lastPlaced: { ...s.lastPlaced, room: patch.room } });
}

/** R-41: changing type assigns the next number for the new type. */
export function changeType(id: string, typeId: string) {
  const s = getState();
  const b = s.markers[id];
  if (!b || b.typeId === typeId) return;
  const a = { ...b, typeId, number: nextNumber(Object.values(s.markers), typeId) };
  const changes = [{ id, before: b, after: a }];
  commit(changes, tagOf(a), { autoNumber: new Set([id]) });
  pushHistory({ label: `Change ${tagOf(b)} to ${tagOf(a)}`, changes, at: Date.now() });
}

/** R-36, R-37 */
export function deleteMarkers(ids: string[]) {
  const s = getState();
  const changes = ids
    .map((id) => s.markers[id])
    .filter(Boolean)
    .map((b) => ({ id: b.id, before: b, after: null }));
  if (!changes.length) return;
  commit(changes, describe(changes, 'delete of'));
  const entry: HistoryEntry = { label: describe(changes, 'Delete'), changes, at: Date.now() };
  pushHistory(entry);
  setState({ selection: [] });
  toast.info(describe(changes, 'Deleted'), { label: 'Undo', run: () => undoEntry(entry) }, 7000);
}

function applyEntry(entry: HistoryEntry, dir: 'undo' | 'redo') {
  const s = getState();
  const changes: Change[] = entry.changes.map((c) => {
    const target = dir === 'undo' ? c.before : c.after;
    return { id: c.id, before: s.markers[c.id] ?? null, after: target ? { ...target } : null };
  });
  commit(
    changes.filter((c) => c.before || c.after),
    entry.label.toLowerCase(),
    { restore: true },
  );
  const live = changes.filter((c) => c.after).map((c) => c.id);
  setState({ selection: live });
  const target = changes.find((c) => c.after)?.after;
  if (target && target.floorId !== s.floorId) setState({ floorId: target.floorId });
}

export function undo() {
  const s = getState();
  const e = s.undo[s.undo.length - 1];
  if (!e) return;
  setState({ undo: s.undo.slice(0, -1), redo: [...s.redo, e] });
  applyEntry(e, 'undo');
}

export function redo() {
  const s = getState();
  const e = s.redo[s.redo.length - 1];
  if (!e) return;
  setState({ redo: s.redo.slice(0, -1), undo: [...s.undo, e] });
  applyEntry(e, 'redo');
}

/** Undo a specific entry (toast Undo button), wherever it is in the stack. */
export function undoEntry(entry: HistoryEntry) {
  const s = getState();
  setState({ undo: s.undo.filter((e) => e !== entry), redo: [...s.redo, entry] });
  applyEntry(entry, 'undo');
}

/** R-38: copy / paste with new numbers. */
export function copySelection() {
  const s = getState();
  const ms = s.selection.map((id) => s.markers[id]).filter(Boolean);
  if (ms.length) {
    setState({ clipboard: ms });
    toast.info(`Copied ${ms.length === 1 ? tagOf(ms[0]) : `${ms.length} devices`}`);
  }
}

export function duplicateMarkers(src: Marker[], floorId: string, offset: number): Marker[] {
  const s = getState();
  const all = Object.values(s.markers);
  const out: Marker[] = [];
  for (const m of src) {
    if (!typeOf(m.typeId) || typeOf(m.typeId)?.retiredAt) continue;
    const n = nextNumber([...all, ...out], m.typeId);
    const copy: Marker = {
      ...m,
      id: uuid(),
      floorId,
      number: n,
      x: toFraction(m.x + offset),
      y: toFraction(m.y + offset),
      updatedAt: new Date().toISOString(),
    };
    out.push(copy);
  }
  return out;
}

export function paste() {
  const s = getState();
  if (!s.clipboard.length || !s.floorId) return;
  const sameFloor = s.clipboard.every((m) => m.floorId === s.floorId);
  const copies = duplicateMarkers(s.clipboard, s.floorId, sameFloor ? 0.01 : 0);
  if (!copies.length) return;
  createMarkers(copies, 'Paste');
}

/** Create already-built markers (paste, alt-drag duplicate). */
export function createMarkers(copies: Marker[], verb: string) {
  const s = getState();
  // the markers may already be in local state (alt-drag); record them as new
  const tmp = { ...s.markers };
  for (const c of copies) delete tmp[c.id];
  setState({ markers: tmp });
  const changes = copies.map((c) => ({ id: c.id, before: null, after: c }));
  commit(changes, describe(changes, `${verb.toLowerCase()} of`), {
    autoNumber: new Set(copies.map((c) => c.id)),
  });
  pushHistory({ label: describe(changes, verb), changes, at: Date.now() });
  setState({ selection: copies.map((c) => c.id) });
}

/** R-30: after the server renumbers, apply locally and make it undoable. */
export function applyRenumber(changes: { id: string; newNumber: number }[]) {
  const s = getState();
  const list: Change[] = [];
  const next = { ...s.markers };
  for (const c of changes) {
    const b = s.markers[c.id];
    if (!b) continue;
    const a = { ...b, number: c.newNumber };
    next[c.id] = a;
    list.push({ id: c.id, before: b, after: a });
  }
  setState({ markers: next });
  if (list.length) pushHistory({ label: `Renumber ${list.length} devices`, changes: list, at: Date.now() });
}

/* =====================================================================
 * Remote changes (R-51)
 * ===================================================================== */

export function applyRemoteUpserts(markers: Marker[]) {
  const pend = pendingIds();
  const s = getState();
  const next = { ...s.markers };
  for (const m of markers) {
    if (pend.has(m.id)) continue;
    const cur = next[m.id];
    if (cur && cur.updatedAt > m.updatedAt) continue;
    next[m.id] = m;
  }
  setState({ markers: next });
}

export function applyRemoteDeletes(ids: string[]) {
  const pend = pendingIds();
  const s = getState();
  const next = { ...s.markers };
  for (const id of ids) if (!pend.has(id)) delete next[id];
  setState({ markers: next, selection: s.selection.filter((id) => next[id]) });
}

/** Replace all markers after a (re)load, keeping unsent local edits. */
export function replaceAllMarkers(markers: Marker[]) {
  const pend = pendingIds();
  const s = getState();
  const next: Record<string, Marker> = {};
  for (const m of markers) next[m.id] = m;
  for (const id of pend) {
    if (s.markers[id]) next[id] = s.markers[id];
    else delete next[id];
  }
  setState({ markers: next, selection: s.selection.filter((id) => next[id]) });
}

export function resetQueue() {
  queue.length = 0;
  lastFailed = false;
}
