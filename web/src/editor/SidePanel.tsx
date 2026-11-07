import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { findDuplicates, type Marker } from '@sixpoint/shared';
import { changeType, deleteMarkers, editMarkers } from './ops';
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
  const sel = selection.map((id) => markers[id]).filter(Boolean);
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
  const options = useMemo(() => {
    const q = field.value.trim().toLowerCase();
    return rooms(all)
      .filter((r) => r.toLowerCase().includes(q) && r.toLowerCase() !== q)
      .slice(0, 12);
  }, [all, field.value]);
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
      {canEdit && (
        <button className="btn btn-danger-ghost btn-block" onClick={() => deleteMarkers([m.id])}>
          Delete {tagOf(m)}
        </button>
      )}
    </section>
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
