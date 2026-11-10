import { useState } from 'react';
import {
  centroid,
  pointInPolygon,
  polygonArea,
  zoneAt,
  type DetectRoomsResult,
  type Floor,
} from '@sixpoint/shared';
import { api } from '../api';
import { toast } from '../toast';
import { getState, setState, useEditor, type RoomDraft } from './store';
import { newZone, saveZone } from './zones';
import { ZoneNameInput } from './ZonesPanel';

/** Ask the server for the rooms on a floor's drawing and open them for review. */
export async function detectRooms(floorId: string) {
  const res = await api.post<DetectRoomsResult>(`/api/floors/${floorId}/detect-rooms`);
  const zones = Object.values(getState().zones);
  const draft: RoomDraft = {
    floorId,
    note: res.note,
    rooms: res.rooms.map((r, i) => {
      // a room that already has a zone starts unticked
      const existing =
        zoneAt(zones, floorId, r.at[0], r.at[1]) ?? zoneAt(zones, floorId, ...centroid(r.points));
      return {
        key: i,
        name: r.name,
        points: r.points,
        areaSqFt: r.areaSqFt,
        on: !existing,
        existing: existing?.name ?? null,
      };
    }),
  };
  setState({ roomDraft: draft, selectedZone: null, selection: [], tool: null });
}

/** The suggested room under a point, smallest first (so a closet inside a bedroom wins). */
export function draftRoomAt(draft: RoomDraft, x: number, y: number) {
  let best: RoomDraft['rooms'][number] | null = null;
  let bestArea = Infinity;
  for (const r of draft.rooms) {
    if (!pointInPolygon(x, y, r.points)) continue;
    const a = Math.abs(polygonArea(r.points));
    if (a < bestArea) {
      bestArea = a;
      best = r;
    }
  }
  return best;
}

export function toggleDraftRoom(key: number, on?: boolean) {
  const d = getState().roomDraft;
  if (!d) return;
  setState({
    roomDraft: { ...d, rooms: d.rooms.map((r) => (r.key === key ? { ...r, on: on ?? !r.on } : r)) },
  });
}

/** Dashed outlines of the suggested rooms (inside the plan's SVG, sheet pixels). */
export function RoomDraftShapes({ floor }: { floor: Floor }) {
  const draft = useEditor((s) => (s.roomDraft?.floorId === floor.id ? s.roomDraft : null));
  if (!draft) return null;
  return (
    <g className="room-drafts">
      {draft.rooms.map((r) => (
        <polygon
          key={r.key}
          className={`room-draft ${r.on ? 'on' : 'off'}`}
          points={r.points.map(([x, y]) => `${x * floor.widthPx},${y * floor.heightPx}`).join(' ')}
        />
      ))}
    </g>
  );
}

/** Names of the suggested rooms (in the plan's marker layer). */
export function RoomDraftLabels({ floor }: { floor: Floor }) {
  const draft = useEditor((s) => (s.roomDraft?.floorId === floor.id ? s.roomDraft : null));
  if (!draft) return null;
  return (
    <>
      {draft.rooms.map((r) => {
        const [cx, cy] = centroid(r.points);
        return (
          <div
            key={r.key}
            className={`zone-label room-draft-label ${r.on ? 'on' : 'off'}`}
            style={{ '--x': cx * floor.widthPx, '--y': cy * floor.heightPx } as React.CSSProperties}
          >
            {r.on ? '✓ ' : ''}
            {r.name || 'Unnamed'}
          </div>
        );
      })}
    </>
  );
}

/** Side panel: tick the rooms to keep, fix their names, then add them as zones. */
export function RoomReview() {
  const draft = useEditor((s) => s.roomDraft)!;
  const floor = useEditor((s) => s.floors.find((f) => f.id === s.roomDraft?.floorId));
  const [busy, setBusy] = useState(false);
  // the drawing already prints these names, so by default the zones don't print them again
  const [showNames, setShowNames] = useState(false);
  const chosen = draft.rooms.filter((r) => r.on);
  const close = () => setState({ roomDraft: null });
  const setAll = (on: boolean) =>
    setState({ roomDraft: { ...draft, rooms: draft.rooms.map((r) => ({ ...r, on })) } });
  const rename = (key: number, name: string) =>
    setState({
      roomDraft: { ...draft, rooms: draft.rooms.map((r) => (r.key === key ? { ...r, name } : r)) },
    });

  const add = async () => {
    const rooms = chosen.filter((r) => r.name.trim());
    setBusy(true);
    const saved = await Promise.all(
      rooms.map((r) =>
        saveZone({ ...newZone(draft.floorId, r.points), name: r.name.trim(), showName: showNames }),
      ),
    );
    setBusy(false);
    const n = saved.filter(Boolean).length;
    if (n) toast.success(`Added ${n} zone${n === 1 ? '' : 's'}`);
    // keep any that failed to save on screen, so they can be tried again
    const failed = new Set(rooms.filter((_, i) => !saved[i]).map((r) => r.key));
    if (failed.size)
      setState({ roomDraft: { ...draft, rooms: draft.rooms.filter((r) => failed.has(r.key)) } });
    else close();
  };

  return (
    <section className="editor-card" aria-label="Rooms found on the drawing">
      <div className="editor-head">
        <span className="zone-swatch" aria-hidden="true" />
        <div>
          <div className="editor-type">Rooms found</div>
          <div className="muted small">
            {draft.rooms.length} on {floor?.name ?? 'this floor'}
          </div>
        </div>
      </div>
      {draft.note && <p className="muted small">{draft.note}</p>}
      {draft.rooms.length > 0 && (
        <>
          <p className="muted small">
            Tick the rooms to add as zones, and fix any names. Click a room on the plan to tick or untick it.
            Rooms that already have a zone start unticked.
          </p>
          <div className="row-actions start">
            <button className="btn btn-sm" onClick={() => setAll(true)}>
              All
            </button>
            <button className="btn btn-sm" onClick={() => setAll(false)}>
              None
            </button>
          </div>
          <ul className="room-review">
            {draft.rooms.map((r) => (
              <li key={r.key} className={r.on ? '' : 'off'}>
                <input
                  type="checkbox"
                  checked={r.on}
                  aria-label={`Add ${r.name || 'this room'}`}
                  onChange={(e) => toggleDraftRoom(r.key, e.target.checked)}
                />
                <ZoneNameInput
                  aria-label={`Name for room ${r.key + 1}`}
                  value={r.name}
                  onChange={(e) => rename(r.key, e.target.value)}
                />
                <span
                  className="muted small mono"
                  title={r.existing ? `Overlaps zone ${r.existing}` : undefined}
                >
                  {r.existing ? 'exists' : r.areaSqFt != null ? `${r.areaSqFt} ft²` : ''}
                </span>
              </li>
            ))}
          </ul>
          <label className="check">
            <input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} />
            <span>Show names on the plan (the drawing already shows them)</span>
          </label>
        </>
      )}
      <div className="row-actions start">
        {draft.rooms.length > 0 && (
          <button className="btn btn-sm btn-primary" disabled={busy || !chosen.length} onClick={add}>
            {busy ? 'Adding…' : `Add ${chosen.length} zone${chosen.length === 1 ? '' : 's'}`}
          </button>
        )}
        <button className="btn btn-sm" onClick={close} disabled={busy}>
          {draft.rooms.length ? 'Cancel' : 'Close'}
        </button>
      </div>
    </section>
  );
}

/** "Detect rooms" button for the Zone Edit panel. */
export function DetectRoomsButton() {
  const floorId = useEditor((s) => s.floorId);
  const [busy, setBusy] = useState(false);
  if (!floorId) return null;
  return (
    <button
      className="btn btn-sm"
      disabled={busy}
      title="Find the rooms on the drawing from its room names and walls, to add as zones"
      onClick={async () => {
        setBusy(true);
        try {
          await detectRooms(floorId);
        } catch (e: any) {
          toast.error(`Couldn't detect rooms: ${e.message}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Finding rooms…' : 'Detect rooms'}
    </button>
  );
}
