import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { findDuplicates, type Marker } from '@sixpoint/shared';
import { formatFeet } from '@sixpoint/shared';
import { changeType, deleteMarkers, editMarkers } from './ops';
import { ZoneEditor } from './ZoneDialogs';
import { ZoneList, useZoneNameOptions } from './ZonesPanel';
import { useClosets, useSummary } from './zones';
import { colorOf, getState, setState, tagOf, typeOf, useEditor } from './store';

/** Right panel: selected marker editor on top, current floor's schedule below (R-40..R-48). */
export function SidePanel() {
  return (
    <aside className="side" aria-label="Device details and schedule">
      <MarkerEditor />
      <Schedule />
    </aside>
  );
}

/* ---------- autosaving field (R-44) ---------- */

function useAutoField(value: string, commit: (v: string) => void, delay = 400) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<number | undefined>();
  const latest = useRef({ draft: value, value, commit });
  latest.current = { draft, value, commit };

  // remote / server updates never overwrite the field being typed in
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const flush = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const l = latest.current;
    if (l.draft !== l.value) l.commit(l.draft);
  };
  // flush when the editor unmounts (selection changes)
  useEffect(() => () => flush(), []);

  return {
    value: draft,
    onChange: (e: { target: { value: string } }) => {
      setDraft(e.target.value);
      latest.current.draft = e.target.value;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, delay);
    },
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      flush();
    },
  };
}

function MarkerEditor() {
  const selection = useEditor((s) => s.selection);
  const markers = useEditor((s) => s.markers);
  const selectedZone = useEditor((s) => (s.selectedZone ? s.zones[s.selectedZone] : null));
  const zoneEdit = useEditor((s) => s.zoneEdit);
  const sel = selection.map((id) => markers[id]).filter(Boolean);
  if (!sel.length && selectedZone && zoneEdit)
    return <ZoneEditor key={selectedZone.id + selectedZone.updatedAt} zone={selectedZone} />;
  if (!sel.length && zoneEdit) return <ZoneList />;
  if (!sel.length)
    return (
      <section className="editor-card empty">
        <div className="eyebrow">Device</div>
        <p className="muted">Select a device on the plan or in the schedule to edit it.</p>
      </section>
    );
  if (sel.length > 1) return <MultiEditor key={selection.join(',')} markers={sel} />;
  return <SingleEditor key={sel[0].id} m={sel[0]} />;
}

function rooms(all: Record<string, Marker>): string[] {
  const seen = new Map<string, string>();
  for (const m of Object.values(all))
    if (m.room && !seen.has(m.room.toLowerCase())) seen.set(m.room.toLowerCase(), m.room);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function RoomInput({
  field,
  all,
  id,
}: {
  field: ReturnType<typeof useAutoField>;
  all: Record<string, Marker>;
  id: string;
}) {
  const listId = useId();
  const zoneNames = useZoneNameOptions();
  const options = useMemo(() => {
    const q = field.value.trim().toLowerCase();
    const seen = new Set<string>();
    return [...rooms(all), ...zoneNames]
      .filter((r) => {
        const k = r.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return k.includes(q) && k !== q;
      })
      .slice(0, 12);
  }, [all, field.value, zoneNames]);
  return (
    <>
      <input id={id} {...field} list={listId} autoComplete="off" maxLength={200} />
      <datalist id={listId}>
        {options.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </>
  );
}

function SingleEditor({ m }: { m: Marker }) {
  const canEdit = useEditor((s) => s.canEdit);
  const all = useEditor((s) => s.markers);
  const floors = useEditor((s) => s.floors);
  const categories = useEditor((s) => s.categories);
  const types = useEditor((s) => s.types);
  const floor = floors.find((f) => f.id === m.floorId);
  const t = typeOf(m.typeId);
  const ids = useId();

  const room = useAutoField(m.room, (v) => editMarkers([m.id], { room: v }, 'room'));
  const mount = useAutoField(m.mountHeight, (v) => editMarkers([m.id], { mountHeight: v }, 'mount'));
  const notes = useAutoField(m.notes, (v) => editMarkers([m.id], { notes: v }, 'notes'));
  const number = useAutoField(String(m.number), (v) => {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 99999) editMarkers([m.id], { number: n }, 'number');
  });

  // R-42: inline duplicate warning
  const typed = parseInt(number.value, 10);
  const dups = Number.isFinite(typed) ? findDuplicates(Object.values(all), m.typeId, typed, m.id) : [];
  const dupFloor = dups[0] && floors.find((f) => f.id === dups[0].floorId)?.name;

  return (
    <section className="editor-card" aria-label={`Edit ${tagOf(m)}`}>
      <div className="editor-head">
        {t?.iconUrl && <img className="type-icon lg" src={t.iconUrl} alt="" />}
        <span className="tag tag-lg" style={{ background: colorOf(m.typeId) }}>
          {tagOf(m)}
        </span>
        <div>
          <div className="editor-type">{t?.name ?? 'Unknown type'}</div>
          <div className="muted small mono">
            {floor?.name} · x {m.x.toFixed(3)} · y {m.y.toFixed(3)}
          </div>
        </div>
      </div>
      <div className="editor-fields">
        <label className="field" htmlFor={`${ids}-type`}>
          <span>Type</span>
        </label>
        <select
          id={`${ids}-type`}
          value={m.typeId}
          disabled={!canEdit}
          onChange={(e) => changeType(m.id, e.target.value)}
        >
          {categories.map((c) => (
            <optgroup key={c.id} label={c.name}>
              {types
                .filter((x) => x.categoryId === c.id && (!x.retiredAt || x.id === m.typeId))
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} — {x.name}
                    {x.retiredAt ? ' (retired)' : ''}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <label className="field" htmlFor={`${ids}-num`}>
          <span>Number</span>
        </label>
        <div>
          <input
            id={`${ids}-num`}
            type="number"
            min={1}
            max={99999}
            inputMode="numeric"
            disabled={!canEdit}
            {...number}
            className="mono"
          />
          {dups.length > 0 && (
            <p className="warn small" role="status">
              {t?.code}
              {typed} is already used on {dupFloor ?? 'another floor'}
            </p>
          )}
        </div>
        <label className="field" htmlFor={`${ids}-room`}>
          <span>Room</span>
        </label>
        {canEdit ? (
          <RoomInput id={`${ids}-room`} field={room} all={all} />
        ) : (
          <input id={`${ids}-room`} value={m.room} disabled />
        )}
        <label className="field" htmlFor={`${ids}-mount`}>
          <span>Mount height</span>
        </label>
        <input
          id={`${ids}-mount`}
          disabled={!canEdit}
          {...mount}
          placeholder="e.g. 18 in AFF"
          maxLength={80}
        />
        <label className="field" htmlFor={`${ids}-notes`}>
          <span>Notes</span>
        </label>
        <textarea id={`${ids}-notes`} rows={3} disabled={!canEdit} {...notes} maxLength={5000} />
      </div>
      <Cabling m={m} />
      {t?.iconUrl && (
        <div className="cabling">
          <label className="check">
            <input
              type="checkbox"
              checked={m.iconLabel ?? t.iconLabel}
              disabled={!canEdit}
              onChange={(e) => editMarkers([m.id], { iconLabel: e.target.checked }, 'iconLabel')}
            />{' '}
            Print {tagOf(m)} below the icon
          </label>
        </div>
      )}
      <CoverageEditor key={m.id} m={m} />
      {canEdit && (
        <button className="btn btn-danger-ghost btn-block" onClick={() => deleteMarkers([m.id])}>
          Delete {tagOf(m)}
        </button>
      )}
    </section>
  );
}

/** Coverage area for devices whose type has one: on/off plus range, angle and direction. */
function CoverageEditor({ m }: { m: Marker }) {
  const canEdit = useEditor((s) => s.canEdit);
  const t = useEditor((s) => s.types.find((x) => x.id === m.typeId));
  const floor = useEditor((s) => s.floors.find((f) => f.id === m.floorId));
  const shown = useEditor((s) => s.showCoverage);
  if (!t?.coverage) return null;
  const o = m.coverage ?? {};
  const on = o.on ?? t.coverage.defaultOn;
  const range = o.rangeFt ?? t.coverage.rangeFt;
  const angle = o.angleDeg ?? t.coverage.angleDeg;
  const dir = o.dirDeg ?? 0;
  const set = (p: Partial<NonNullable<Marker['coverage']>>, field: string) =>
    editMarkers([m.id], { coverage: { ...o, ...p } }, `coverage.${field}`);
  const num = (v: string, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  return (
    <div className="cabling">
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          disabled={!canEdit}
          onChange={(e) => set({ on: e.target.checked }, 'on')}
        />{' '}
        Coverage area
      </label>
      {on && (
        <>
          <div className="coverage-edit">
            <label className="field">
              <span className="muted small">Range (ft)</span>
              <input
                type="number"
                min={1}
                max={1000}
                step={0.5}
                key={`r${range}`}
                defaultValue={range}
                disabled={!canEdit}
                onBlur={(e) => {
                  const n = num(e.target.value, 1, 1000);
                  if (n != null && n !== range) set({ rangeFt: n }, 'range');
                }}
              />
            </label>
            <label className="field">
              <span className="muted small">Angle (°)</span>
              <input
                type="number"
                min={5}
                max={360}
                key={`a${angle}`}
                defaultValue={angle}
                disabled={!canEdit}
                onBlur={(e) => {
                  const n = num(e.target.value, 5, 360);
                  if (n != null && n !== angle) set({ angleDeg: n }, 'angle');
                }}
              />
            </label>
            <label className="field">
              <span className="muted small">Facing (°)</span>
              <input
                type="number"
                min={0}
                max={359}
                key={`d${dir}`}
                defaultValue={Math.round(((dir % 360) + 360) % 360)}
                disabled={!canEdit || angle >= 360}
                onBlur={(e) => {
                  const n = num(e.target.value, -360, 720);
                  if (n != null && n !== dir) set({ dirDeg: n }, 'dir');
                }}
              />
            </label>
          </div>
          <p className="muted small">
            {!floor?.ftPerPx
              ? 'Set the floor scale to draw coverage on the plan.'
              : !shown
                ? 'Coverage is hidden; tick Coverage in the toolbar to see it.'
                : canEdit
                  ? 'Drag the handles on the plan to change range, angle and facing.'
                  : ''}
            {canEdit && m.coverage && (o.rangeFt != null || o.angleDeg != null || o.dirDeg != null) && (
              <>
                {' '}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() =>
                    editMarkers([m.id], { coverage: o.on == null ? null : { on: o.on } }, 'coverage')
                  }
                >
                  Reset to {t.code} defaults
                </button>
              </>
            )}
          </p>
        </>
      )}
    </div>
  );
}

/** Zone, equipment closet, wires and approximate run length for one device. */
function Cabling({ m }: { m: Marker }) {
  const canEdit = useEditor((s) => s.canEdit);
  const zones = useEditor((s) => s.zones);
  const wireTypes = useEditor((s) => s.wireTypes);
  const t = typeOf(m.typeId);
  const closets = useClosets();
  const summary = useSummary();
  const run = summary.runs.get(m.id);
  const zoneId = summary.zoneOf.get(m.id);
  const zone = zoneId ? zones[zoneId] : null;
  const wires = (t?.wires ?? []).map((w) => ({
    ...w,
    name: wireTypes.find((x) => x.id === w.wireTypeId)?.name ?? '?',
  }));
  const floors = useEditor((s) => s.floors);
  const floorName = (id: string) => floors.find((f) => f.id === id)?.name ?? '';
  return (
    <div className="cabling">
      <div className="cabling-row">
        <span className="muted small">Zone</span>
        <span>{zone ? zone.name : <span className="muted">Not in a zone</span>}</span>
      </div>
      <div className="cabling-row">
        <span className="muted small">Closet</span>
        {closets.length > 1 && canEdit ? (
          <select
            aria-label="Equipment closet"
            value={m.closetZoneId && closets.some((c) => c.id === m.closetZoneId) ? m.closetZoneId : ''}
            onChange={(e) => editMarkers([m.id], { closetZoneId: e.target.value || null }, 'closet')}
          >
            <option value="">Default · {closets[0].name}</option>
            {closets.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({floorName(c.floorId)})
              </option>
            ))}
          </select>
        ) : (
          <span>{closets[0] ? closets[0].name : <span className="muted">No equipment closet yet</span>}</span>
        )}
      </div>
      <div className="cabling-row">
        <span className="muted small">Wires</span>
        <span>
          {wires.length ? (
            wires.map((w) => `${w.count}× ${w.name}`).join(', ')
          ) : (
            <span className="muted">None</span>
          )}
        </span>
      </div>
      {wires.length > 0 && (
        <div className="cabling-row">
          <span className="muted small">Run</span>
          {run?.lengthFt != null ? (
            <span className="mono run-len">
              ≈ {formatFeet(run.lengthFt)}
              {wires.reduce((n, w) => n + w.count, 0) > 1 && <span className="muted small"> each</span>}
            </span>
          ) : (
            <span className="warn small">{run?.reason ?? 'Not computed'}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** R-45: set Room or Notes for several markers at once. */
function MultiEditor({ markers }: { markers: Marker[] }) {
  const canEdit = useEditor((s) => s.canEdit);
  const all = useEditor((s) => s.markers);
  const ids = markers.map((m) => m.id);
  const same = (k: 'room' | 'notes') => (markers.every((m) => m[k] === markers[0][k]) ? markers[0][k] : '');
  const room = useAutoField(same('room'), (v) => editMarkers(ids, { room: v }, 'room'));
  const notes = useAutoField(same('notes'), (v) => editMarkers(ids, { notes: v }, 'notes'));
  const uid = useId();
  return (
    <section className="editor-card" aria-label={`${markers.length} devices selected`}>
      <div className="editor-head">
        <span className="count-badge mono">{markers.length}</span>
        <div>
          <div className="editor-type">{markers.length} devices selected</div>
          <div className="muted small mono">
            {markers.map(tagOf).slice(0, 8).join(', ')}
            {markers.length > 8 ? '…' : ''}
          </div>
        </div>
      </div>
      {canEdit && (
        <>
          <div className="editor-fields">
            <label className="field" htmlFor={`${uid}-room`}>
              <span>Room (all)</span>
            </label>
            <RoomInput id={`${uid}-room`} field={room} all={all} />
            <label className="field" htmlFor={`${uid}-notes`}>
              <span>Notes (all)</span>
            </label>
            <textarea id={`${uid}-notes`} rows={2} {...notes} placeholder={same('notes') ? '' : 'Mixed'} />
          </div>
          <button className="btn btn-danger-ghost btn-block" onClick={() => deleteMarkers(ids)}>
            Delete {markers.length} devices
          </button>
        </>
      )}
    </section>
  );
}

/* ---------- schedule (R-46..R-48) ---------- */

function Schedule() {
  const floorId = useEditor((s) => s.floorId);
  const floors = useEditor((s) => s.floors);
  const markers = useEditor((s) => s.markers);
  const types = useEditor((s) => s.types);
  const selection = useEditor((s) => s.selection);
  const scope = useEditor((s) => s.scheduleScope);
  const canEdit = useEditor((s) => s.canEdit);
  const [filter, setFilter] = useState('');
  const fid = useId();

  const floorIds = new Set(floors.map((f) => f.id));
  const all = Object.values(markers).filter((m) => floorIds.has(m.floorId));
  const inScope = scope === 'floor' ? all.filter((m) => m.floorId === floorId) : all;
  const q = filter.trim().toLowerCase();
  const rows = q
    ? inScope.filter(
        (m) =>
          tagOf(m).toLowerCase().includes(q) ||
          m.room.toLowerCase().includes(q) ||
          m.notes.toLowerCase().includes(q),
      )
    : inScope;
  const floorOrder = new Map(floors.map((f, i) => [f.id, i]));
  const groups = types
    .map((t) => ({
      t,
      items: rows
        .filter((m) => m.typeId === t.id)
        .sort(
          (a, b) =>
            a.number - b.number || (floorOrder.get(a.floorId) ?? 0) - (floorOrder.get(b.floorId) ?? 0),
        ),
    }))
    .filter((g) => g.items.length);
  const floorName = (id: string) => floors.find((f) => f.id === id)?.name ?? '';

  const select = (m: Marker) => {
    const s = getState();
    setState({
      selectedZone: null,
      selection: [m.id],
      floorId: m.floorId,
      focus: { id: m.id, n: (s.focus?.n ?? 0) + 1 },
    });
  };

  return (
    <section className="schedule" aria-label="Device schedule">
      <div className="schedule-head">
        <h2>Schedule</h2>
        <div className="segmented segmented-sm" role="group" aria-label="Schedule scope">
          <button aria-pressed={scope === 'floor'} onClick={() => setState({ scheduleScope: 'floor' })}>
            This floor
          </button>
          <button aria-pressed={scope === 'all'} onClick={() => setState({ scheduleScope: 'all' })}>
            All floors
          </button>
        </div>
      </div>
      <label className="sr-only" htmlFor={fid}>
        Filter schedule
      </label>
      <input
        id={fid}
        type="search"
        className="schedule-filter"
        placeholder="Filter by tag, room or notes"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="schedule-body">
        {inScope.length === 0 ? (
          <p className="muted small schedule-empty">
            {floors.length === 0
              ? 'Upload a plan sheet to start.'
              : canEdit
                ? 'Pick a device type on the left and click the plan to place one'
                : 'No devices on this floor yet.'}
          </p>
        ) : groups.length === 0 ? (
          <p className="muted small schedule-empty">No devices match “{filter}”.</p>
        ) : (
          groups.map(({ t, items }) => (
            <div key={t.id} className="sched-group">
              <div className="sched-group-head">
                <span className="tag tag-sm" style={{ background: colorOf(t.id) }}>
                  {t.code}
                </span>
                <span>{t.name}</span>
                <span className="mono count">{items.length}</span>
              </div>
              <ul>
                {items.map((m) => (
                  <li key={m.id}>
                    <button
                      className={`sched-row ${selection.includes(m.id) ? 'selected' : ''}`}
                      onClick={() => select(m)}
                    >
                      <span className="mono sched-tag">{tagOf(m)}</span>
                      <span className={`sched-room ${m.room ? '' : 'muted'}`}>{m.room || 'No room'}</span>
                      {scope === 'all' && (
                        <span className="muted small sched-floor">{floorName(m.floorId)}</span>
                      )}
                      <span className="sched-notes muted">{m.notes.split('\n')[0]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
      <div className="schedule-foot">
        <span>
          {scope === 'floor' ? 'This floor' : 'All floors'}:{' '}
          <strong className="mono">{inScope.length}</strong>
        </span>
        <span>
          Project total: <strong className="mono">{all.length}</strong>
        </span>
      </div>
    </section>
  );
}
