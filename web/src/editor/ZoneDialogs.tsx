import { useMemo, useState, type FormEvent } from 'react';
import {
  AUDIO_FORMAT_LABEL,
  AUDIO_FORMATS,
  DRAWING_SCALES,
  formatFeet,
  ftPerPxFromCalibration,
  parseFeet,
  pointInPolygon,
  type AudioFormat,
  type Floor,
  type Zone,
} from '@sixpoint/shared';
import { Modal } from '../components/ui';
import { toast } from '../toast';
import { editMarkers } from './ops';
import { colorOf, getState, setState, tagOf, useEditor } from './store';
import { deleteZone, patchFloor, saveZone, setZoneEdit, useClosets } from './zones';
import { renameZone, ZoneNameInput } from './ZonesPanel';

function audioDevicesIn(z: Zone): number {
  const s = getState();
  const audio = new Set(s.categories.filter((c) => c.name.toLowerCase() === 'audio').map((c) => c.id));
  const audioTypes = new Set(s.types.filter((t) => audio.has(t.categoryId)).map((t) => t.id));
  return Object.values(s.markers).filter(
    (m) => m.floorId === z.floorId && audioTypes.has(m.typeId) && pointInPolygon(m.x, m.y, z.points),
  ).length;
}

const SHOW_NAME = 'Show name on the plan and PDF';

function ZoneFields({
  f,
  set,
  showAudio,
}: {
  f: { name: string; kind: 'room' | 'closet'; audioFormat: AudioFormat | null; showName: boolean };
  set: (
    p: Partial<{ name: string; kind: 'room' | 'closet'; audioFormat: AudioFormat | null; showName: boolean }>,
  ) => void;
  showAudio: boolean;
}) {
  return (
    <>
      <label className="field span-2">
        <span>Name</span>
        <ZoneNameInput
          required
          autoFocus
          value={f.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Living Room"
        />
      </label>
      <label className="check-row span-2">
        <input type="checkbox" checked={f.showName} onChange={(e) => set({ showName: e.target.checked })} />{' '}
        {SHOW_NAME}
      </label>
      <fieldset className="span-2 radios radios-row">
        <legend>Kind</legend>
        <label>
          <input type="radio" checked={f.kind === 'room'} onChange={() => set({ kind: 'room' })} /> Room
        </label>
        <label>
          <input type="radio" checked={f.kind === 'closet'} onChange={() => set({ kind: 'closet' })} />{' '}
          Equipment closet
        </label>
      </fieldset>
      {showAudio && (
        <label className="field span-2">
          <span>Audio format</span>
          <select
            value={f.audioFormat ?? ''}
            onChange={(e) => set({ audioFormat: (e.target.value || null) as AudioFormat | null })}
          >
            <option value="">Not set</option>
            {AUDIO_FORMATS.map((a) => (
              <option key={a} value={a}>
                {AUDIO_FORMAT_LABEL[a]}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

/** Name a newly drawn zone. */
export function ZoneDialog({ zone, onClose }: { zone: Zone; isNew?: boolean; onClose: () => void }) {
  const audio = useMemo(() => audioDevicesIn(zone), [zone]);
  const [f, setF] = useState({
    name: zone.name,
    kind: zone.kind,
    audioFormat: zone.audioFormat,
    showName: zone.showName,
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const saved = await saveZone({ ...zone, ...f, name: f.name.trim() });
    if (saved) {
      // devices inside with no room take the zone's name
      const inside = Object.values(getState().markers).filter(
        (m) => m.floorId === zone.floorId && !m.room && pointInPolygon(m.x, m.y, zone.points),
      );
      if (inside.length)
        editMarkers(
          inside.map((m) => m.id),
          { room: saved.name },
          `zone:${saved.id}`,
        );
      setState({ selectedZone: saved.id, selection: [], tool: null });
    }
    onClose();
  };
  return (
    <Modal title={zone.kind === 'closet' ? 'New equipment closet' : 'New zone'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <ZoneFields f={f} set={(p) => setF({ ...f, ...p })} showAudio={audio > 0 && f.kind === 'room'} />
        <div className="form-actions span-2">
          <button type="button" className="btn" onClick={onClose}>
            Discard
          </button>
          <button className="btn btn-primary">Save zone</button>
        </div>
      </form>
    </Modal>
  );
}

/** Side-panel editor for the selected zone. */
export function ZoneEditor({ zone }: { zone: Zone }) {
  const canEdit = useEditor((s) => s.canEdit);
  const markers = useEditor((s) => s.markers);
  const floors = useEditor((s) => s.floors);
  const closets = useClosets();
  const [name, setName] = useState(zone.name);
  const inside = Object.values(markers).filter(
    (m) => m.floorId === zone.floorId && pointInPolygon(m.x, m.y, zone.points),
  );
  const audio = audioDevicesIn(zone);
  const floor = floors.find((f) => f.id === zone.floorId);
  const isDefault = closets[0]?.id === zone.id;
  const served =
    zone.kind === 'closet'
      ? Object.values(markers).filter((m) => (m.closetZoneId ?? closets[0]?.id) === zone.id).length
      : 0;

  const update = (p: Partial<Zone>) => saveZone({ ...zone, ...p });

  return (
    <section className="editor-card" aria-label={`Zone ${zone.name}`}>
      <div className="editor-head">
        <span className={`zone-swatch ${zone.kind}`} aria-hidden="true" />
        <div>
          <div className="editor-type">{zone.kind === 'closet' ? 'Equipment closet' : 'Zone'}</div>
          <div className="muted small">
            {floor?.name} · {inside.length} device{inside.length === 1 ? '' : 's'} inside
            {zone.kind === 'closet' && ` · serves ${served}${isDefault ? ' (default closet)' : ''}`}
          </div>
        </div>
      </div>
      <div className="editor-fields">
        <label className="field" htmlFor="zone-name">
          <span>Name</span>
        </label>
        <ZoneNameInput
          id="zone-name"
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => renameZone(zone, name)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <label className="check-row zone-show-name">
          <input
            type="checkbox"
            checked={zone.showName}
            disabled={!canEdit}
            onChange={(e) => update({ showName: e.target.checked })}
          />{' '}
          {SHOW_NAME}
        </label>
        <label className="field" htmlFor="zone-kind">
          <span>Kind</span>
        </label>
        <select
          id="zone-kind"
          value={zone.kind}
          disabled={!canEdit}
          onChange={(e) => update({ kind: e.target.value as Zone['kind'] })}
        >
          <option value="room">Room</option>
          <option value="closet">Equipment closet</option>
        </select>
        {zone.kind === 'room' && (
          <>
            <label className="field" htmlFor="zone-audio">
              <span>Audio</span>
            </label>
            <div>
              <select
                id="zone-audio"
                value={zone.audioFormat ?? ''}
                disabled={!canEdit}
                onChange={(e) => update({ audioFormat: (e.target.value || null) as AudioFormat | null })}
              >
                <option value="">Not set</option>
                {AUDIO_FORMATS.map((a) => (
                  <option key={a} value={a}>
                    {AUDIO_FORMAT_LABEL[a]}
                  </option>
                ))}
              </select>
              <p className="muted small">
                {audio
                  ? `${audio} audio device${audio === 1 ? '' : 's'} in this zone`
                  : 'No audio devices in this zone yet'}
              </p>
            </div>
          </>
        )}
      </div>
      {inside.length > 0 && (
        <div className="zone-devices">
          {inside.slice(0, 40).map((m) => (
            <button
              key={m.id}
              className="tag tag-sm tag-btn"
              style={{ background: colorOf(m.typeId) }}
              onClick={() => {
                setZoneEdit(false);
                setState({ selection: [m.id] });
              }}
            >
              {tagOf(m)}
            </button>
          ))}
        </div>
      )}
      {canEdit && (
        <p className="muted small">
          Drag the corner handles on the plan to reshape. Double-click the outline to add a corner, or a
          corner to remove it. Hold Alt to drag without snapping.
        </p>
      )}
      <button className="btn btn-sm" onClick={() => setState({ selectedZone: null })}>
        ← Zones on this floor
      </button>
      {canEdit && (
        <button className="btn btn-danger-ghost btn-block" onClick={() => deleteZone(zone.id)}>
          Delete {zone.kind === 'closet' ? 'closet' : 'zone'}
        </button>
      )}
    </section>
  );
}

/** Two-point calibration: type the real distance between the clicked points. */
export function CalibrateDialog({
  floor,
  a,
  b,
  onClose,
}: {
  floor: Floor;
  a: { x: number; y: number };
  b: { x: number; y: number };
  onClose: () => void;
}) {
  const [dist, setDist] = useState('');
  const ft = parseFeet(dist);
  return (
    <Modal title="Calibrate scale" onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ft) return;
          const ftPerPx = ftPerPxFromCalibration(a, b, ft, { width: floor.widthPx, height: floor.heightPx });
          if (!(ftPerPx > 0)) return toast.error('The two points are too close together');
          const f = await patchFloor(floor.id, {
            ftPerPx,
            scaleLabel: `Calibrated (${formatFeet(ft)} span)`,
          });
          if (f)
            toast.success(`${floor.name} scale set: ${formatFeet(floor.widthPx * ftPerPx)} across the sheet`);
          onClose();
        }}
      >
        <label className="field span-2">
          <span>Real distance between the two points</span>
          <input
            autoFocus
            value={dist}
            onChange={(e) => setDist(e.target.value)}
            placeholder={`e.g. 24' 6" or 24.5`}
            required
          />
          <span className="muted small">{ft ? `${ft.toFixed(2)} ft` : 'Feet and inches, e.g. 12\' 6"'}</span>
        </label>
        <div className="form-actions span-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ft}>
            Set scale
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Scale, floor height and riser settings, shown in the floor dialog. */
export function FloorCablingSettings({ floor, onPickOnPlan }: { floor: Floor; onPickOnPlan: () => void }) {
  const [dpi, setDpi] = useState(String(floor.renderDpi ?? 150));
  const [height, setHeight] = useState(String(floor.floorHeightFt));
  const choose = async (label: string) => {
    const sc = DRAWING_SCALES.find((d) => d.label === label);
    const d = Number(dpi);
    if (!sc || !(d > 0)) return;
    await patchFloor(floor.id, { ftPerPx: sc.feetPerPaperInch / d, scaleLabel: sc.label, renderDpi: d });
  };
  const known = DRAWING_SCALES.some((d) => d.label === floor.scaleLabel);
  return (
    <div className="span-2 cabling-box">
      <strong>Scale and cabling</strong>
      <div className="form-grid">
        <label className="field">
          <span>Drawing scale</span>
          <select value={known ? floor.scaleLabel : ''} onChange={(e) => choose(e.target.value)}>
            <option value="">{floor.ftPerPx ? floor.scaleLabel || 'Custom' : 'Not set'}</option>
            {DRAWING_SCALES.map((d) => (
              <option key={d.label} value={d.label}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Sheet DPI</span>
          <input
            type="number"
            min={36}
            max={1200}
            value={dpi}
            onChange={(e) => setDpi(e.target.value)}
            onBlur={() => known && choose(floor.scaleLabel)}
          />
        </label>
        <p className="muted small span-2">
          {floor.ftPerPx
            ? `Sheet is about ${formatFeet(floor.widthPx * floor.ftPerPx)} × ${formatFeet(floor.heightPx * floor.ftPerPx)}.`
            : 'Set a scale so cable runs can be measured.'}{' '}
          PDF pages know their DPI; for scans, calibrating is more reliable.
        </p>
        <div className="span-2 row-actions start">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setState({ tool: 'calibrate' });
              onPickOnPlan();
            }}
          >
            Calibrate on plan…
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setState({ tool: 'riser' });
              onPickOnPlan();
            }}
          >
            {floor.riserX != null ? 'Move riser…' : 'Set riser…'}
          </button>
          {floor.riserX != null && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => patchFloor(floor.id, { riserX: null, riserY: null })}
            >
              Clear riser
            </button>
          )}
        </div>
        <label className="field">
          <span>Floor-to-floor height (ft)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            onBlur={() =>
              Number(height) >= 0 &&
              Number(height) !== floor.floorHeightFt &&
              patchFloor(floor.id, { floorHeightFt: Number(height) })
            }
          />
        </label>
        <p className="muted small">
          Height from this floor to the one above, added when a run changes floors.
        </p>
      </div>
    </div>
  );
}
