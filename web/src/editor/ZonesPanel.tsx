import { useId, useMemo, useState, type InputHTMLAttributes } from 'react';
import { AUDIO_FORMAT_LABEL, AUDIO_FORMATS, zoneAt, type AudioFormat, type Zone } from '@sixpoint/shared';
import { Modal } from '../components/ui';
import { editMarkers } from './ops';
import { getState, setState, useEditor } from './store';
import { deleteZone, saveZone, setZoneEdit, useClosets, useSummary } from './zones';

/* ---------- name autocomplete ---------- */

/** Admin zone names first, then names already used in this project. */
export function useZoneNameOptions(): string[] {
  const names = useEditor((s) => s.zoneNames);
  const zones = useEditor((s) => s.zones);
  return useMemo(() => {
    const seen = new Map<string, string>();
    for (const n of [...names, ...Object.values(zones).map((z) => z.name)])
      if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
    return [...seen.values()];
  }, [names, zones]);
}

/** A text input that suggests zone names from the admin list. */
export function ZoneNameInput(props: InputHTMLAttributes<HTMLInputElement> & { value: string }) {
  const listId = useId();
  const options = useZoneNameOptions();
  const q = props.value.trim().toLowerCase();
  const shown = options.filter((o) => o.toLowerCase() !== q && o.toLowerCase().includes(q)).slice(0, 15);
  return (
    <>
      <input maxLength={120} autoComplete="off" {...props} list={listId} />
      <datalist id={listId}>
        {shown.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

/* ---------- actions ---------- */

/** Rename a zone; devices whose Room came from the old name follow it. */
export async function renameZone(zone: Zone, name: string) {
  const next = name.trim();
  if (!next || next === zone.name) return;
  const saved = await saveZone({ ...zone, name: next });
  if (!saved || !zone.name) return;
  const s = getState();
  const ids = Object.values(s.markers)
    .filter(
      (m) => m.room === zone.name && zoneAt(Object.values(s.zones), m.floorId, m.x, m.y)?.id === zone.id,
    )
    .map((m) => m.id);
  if (ids.length) editMarkers(ids, { room: next }, `zone:${zone.id}`);
}

/** Jump to a zone on the plan and select it (in Zone Edit mode for editors). */
export function showZone(id: string) {
  const s = getState();
  const z = s.zones[id];
  if (!z) return;
  if (s.canEdit) setZoneEdit(true);
  setState({
    floorId: z.floorId,
    selectedZone: id,
    selection: [],
    zonesTable: false,
    focus: { id, n: (s.focus?.n ?? 0) + 1 },
  });
}

function useZoneStats() {
  const summary = useSummary();
  const closets = useClosets();
  return useMemo(() => {
    const devices = new Map<string, number>();
    for (const [, zid] of summary.zoneOf) if (zid) devices.set(zid, (devices.get(zid) ?? 0) + 1);
    const served = new Map<string, number>();
    for (const [, r] of summary.runs)
      if (r.closetId) served.set(r.closetId, (served.get(r.closetId) ?? 0) + 1);
    return { devices, served, defaultCloset: closets[0]?.id ?? null };
  }, [summary, closets]);
}

/* ---------- side panel list (Zone Edit mode, nothing selected) ---------- */

export function ZoneList() {
  const floorId = useEditor((s) => s.floorId);
  const floor = useEditor((s) => s.floors.find((f) => f.id === s.floorId));
  const zonesAll = useEditor((s) => s.zones);
  const stats = useZoneStats();
  const zones = Object.values(zonesAll)
    .filter((z) => z.floorId === floorId)
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="editor-card" aria-label="Zones on this floor">
      <div className="editor-head">
        <span className="zone-swatch" aria-hidden="true" />
        <div>
          <div className="editor-type">Zone Edit</div>
          <div className="muted small">
            {zones.length} zone{zones.length === 1 ? '' : 's'} on {floor?.name ?? 'this floor'}
          </div>
        </div>
      </div>
      <p className="muted small">
        Click a zone on the plan or below to edit it. <strong>+ New zone</strong> draws one: click corners, or
        drag a rectangle.
      </p>
      <ul className="zone-list">
        {zones.map((z) => (
          <li key={z.id}>
            <button className="zone-list-btn" onClick={() => showZone(z.id)}>
              <span className={`zone-swatch sm ${z.kind}`} aria-hidden="true" />
              <span className="grow">{z.name || <em className="muted">Unnamed</em>}</span>
              {z.kind === 'closet' && <span className="eq-badge">EQ</span>}
              {z.audioFormat && <span className="pill">{AUDIO_FORMAT_LABEL[z.audioFormat]}</span>}
              <span className="muted small mono">{stats.devices.get(z.id) ?? 0}</span>
            </button>
          </li>
        ))}
        {!zones.length && <li className="muted small">No zones on this floor yet.</li>}
      </ul>
      <div className="row-actions start">
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setState({ tool: 'zone', selectedZone: null, selection: [] })}
        >
          + New zone
        </button>
        <button className="btn btn-sm" onClick={() => setState({ zonesTable: true })}>
          All zones…
        </button>
      </div>
    </section>
  );
}

/* ---------- all-zones table ---------- */

function NameCell({ zone, disabled }: { zone: Zone; disabled: boolean }) {
  const [v, setV] = useState(zone.name);
  return (
    <ZoneNameInput
      aria-label={`Name of ${zone.name || 'zone'}`}
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => (v.trim() ? renameZone(zone, v) : setV(zone.name))}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function ZonesTableDialog() {
  const open = useEditor((s) => s.zonesTable);
  if (!open) return null;
  return <ZonesTable onClose={() => setState({ zonesTable: false })} />;
}

function ZonesTable({ onClose }: { onClose: () => void }) {
  const canEdit = useEditor((s) => s.canEdit);
  const floors = useEditor((s) => s.floors);
  const zonesAll = useEditor((s) => s.zones);
  const stats = useZoneStats();
  const [floorFilter, setFloorFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const order = new Map(floors.map((f, i) => [f.id, i]));
  const rows = Object.values(zonesAll)
    .filter((z) => order.has(z.floorId))
    .filter((z) => floorFilter === 'all' || z.floorId === floorFilter)
    .filter((z) => !q || z.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => order.get(a.floorId)! - order.get(b.floorId)! || a.name.localeCompare(b.name));
  const floorName = (id: string) => floors.find((f) => f.id === id)?.name ?? '';

  return (
    <Modal title="Zones" onClose={onClose} wide>
      <div className="zones-table-filters">
        <label className="field">
          <span>Floor</span>
          <select value={floorFilter} onChange={(e) => setFloorFilter(e.target.value)}>
            <option value="all">All floors</option>
            {floors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Search</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zone name" />
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="muted">
          {Object.keys(zonesAll).length
            ? 'No zones match.'
            : 'No zones yet. Turn on Zone Edit in the palette and draw one.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table zones-table">
            <thead>
              <tr>
                <th>Floor</th>
                <th>Name</th>
                <th>Kind</th>
                <th>Audio</th>
                <th className="num">Devices</th>
                <th className="num">Runs</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((z) => (
                <tr key={z.id}>
                  <td className="nowrap">{floorName(z.floorId)}</td>
                  <td>
                    <NameCell key={z.updatedAt} zone={z} disabled={!canEdit} />
                  </td>
                  <td>
                    <select
                      aria-label={`Kind of ${z.name}`}
                      value={z.kind}
                      disabled={!canEdit}
                      onChange={(e) =>
                        saveZone({
                          ...z,
                          kind: e.target.value as Zone['kind'],
                          audioFormat: e.target.value === 'closet' ? null : z.audioFormat,
                        })
                      }
                    >
                      <option value="room">Room</option>
                      <option value="closet">Equipment closet</option>
                    </select>
                  </td>
                  <td>
                    {z.kind === 'room' ? (
                      <select
                        aria-label={`Audio format of ${z.name}`}
                        value={z.audioFormat ?? ''}
                        disabled={!canEdit}
                        onChange={(e) =>
                          saveZone({ ...z, audioFormat: (e.target.value || null) as AudioFormat | null })
                        }
                      >
                        <option value="">None</option>
                        {AUDIO_FORMATS.map((a) => (
                          <option key={a} value={a}>
                            {AUDIO_FORMAT_LABEL[a]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted small">
                        {stats.defaultCloset === z.id ? 'Default closet' : '–'}
                      </span>
                    )}
                  </td>
                  <td className="num mono">{stats.devices.get(z.id) ?? 0}</td>
                  <td className="num mono">{z.kind === 'closet' ? (stats.served.get(z.id) ?? 0) : '–'}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-sm" onClick={() => showZone(z.id)}>
                        Show
                      </button>
                      {canEdit && (
                        <button
                          className="btn btn-sm btn-danger-ghost"
                          aria-label={`Delete ${z.name}`}
                          onClick={() => confirm(`Delete zone ${z.name}?`) && deleteZone(z.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Devices counts devices inside each zone. Runs counts devices wired to each equipment closet. Names
        suggest from the admin's zone list.
      </p>
    </Modal>
  );
}
