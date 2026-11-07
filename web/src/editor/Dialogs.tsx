import { useEffect, useRef, useState } from 'react';
import { deviceListText, type Activity, type ExportType, type Floor } from '@sixpoint/shared';
import { api, ApiError, download, CLIENT_ID } from '../api';
import { Confirm, Modal, timeAgo } from '../components/ui';
import { toast } from '../toast';
import { applyRenumber } from './ops';
import { colorOf, getState, setState, typeOf, useEditor } from './store';

void CLIENT_ID;

/* ---------- floor settings: rename, sheet number, replace, delete (R-21, R-22) ---------- */

export function FloorDialog({ floor, onClose }: { floor: Floor; onClose: () => void }) {
  const [name, setName] = useState(floor.name);
  const [sheet, setSheet] = useState(floor.sheetNumber);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [aspect, setAspect] = useState<{ stagedId: string; diff: number } | null>(null);
  const [revs, setRevs] = useState<
    { id: string; uploadedAt: string; widthPx: number; heightPx: number; imageUrl: string }[]
  >([]);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<typeof revs>(`/api/floors/${floor.id}/revisions`).then(setRevs, () => undefined);
  }, [floor.id, floor.updatedAt]);

  const save = async () => {
    try {
      const f = await api.patch<Floor>(`/api/floors/${floor.id}`, { name, sheetNumber: sheet });
      setState({ floors: getState().floors.map((x) => (x.id === f.id ? f : x)) });
      onClose();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const applyFloor = (f: Floor) =>
    setState({ floors: getState().floors.map((x) => (x.id === f.id ? f : x)) });

  const replace = async (fl: File) => {
    setReplacing(true);
    try {
      const fd = new FormData();
      fd.append('file', fl);
      const res = await fetch(`/api/floors/${floor.id}/sheet`, {
        method: 'POST',
        body: fd,
        headers: { 'X-Client-Id': CLIENT_ID },
      });
      const j = await res.json();
      if (!res.ok) throw new ApiError(res.status, j.error);
      if (j.applied) {
        applyFloor(j.floor);
        toast.success('Sheet replaced. Markers kept their positions.');
      } else setAspect({ stagedId: j.stagedId, diff: j.aspectDiff });
    } catch (e: any) {
      toast.error(`Couldn't replace the sheet: ${e.message}`);
    } finally {
      setReplacing(false);
    }
  };

  return (
    <Modal
      title="Floor settings"
      onClose={onClose}
      footer={
        <>
          <button
            className="btn btn-danger-ghost"
            onClick={async () =>
              setConfirmDel((await api.get<{ count: number }>(`/api/floors/${floor.id}/marker-count`)).count)
            }
          >
            Delete floor…
          </button>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field span-2">
          <span>Floor name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <label className="field span-2">
          <span>Sheet number</span>
          <input
            value={sheet}
            onChange={(e) => setSheet(e.target.value)}
            maxLength={40}
            className="mono"
            placeholder="e.g. A2.1"
          />
        </label>
        <div className="span-2 replace-box">
          <div>
            <strong>Replace sheet</strong>
            <p className="muted small">
              Upload a revised drawing. Markers keep their positions as fractions of the sheet. Current:{' '}
              {floor.widthPx}×{floor.heightPx} px.
            </p>
          </div>
          <button className="btn" disabled={replacing} onClick={() => file.current?.click()}>
            {replacing ? 'Processing…' : 'Upload revision…'}
          </button>
          <input
            ref={file}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg"
            hidden
            onChange={(e) => e.target.files?.[0] && replace(e.target.files[0])}
          />
        </div>
        {revs.length > 0 && (
          <div className="span-2">
            <strong className="small">Earlier revisions</strong>
            <ul className="rev-list">
              {revs.map((r) => (
                <li key={r.id}>
                  <a href={r.imageUrl} target="_blank" rel="noreferrer">
                    {new Date(r.uploadedAt).toLocaleString()}
                  </a>{' '}
                  <span className="muted small mono">
                    {r.widthPx}×{r.heightPx}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {aspect && (
        <Confirm
          title="Different proportions"
          confirmLabel="Replace anyway"
          message={`The new drawing's aspect ratio differs by ${(aspect.diff * 100).toFixed(1)}%. Markers keep their fractional positions, so some may land in the wrong spots.`}
          onClose={() => setAspect(null)}
          onConfirm={async () => {
            const r = await api.post<{ applied: boolean; floor: Floor }>(
              `/api/floors/${floor.id}/sheet?staged=${aspect.stagedId}&confirm=true`,
            );
            applyFloor(r.floor);
            toast.success('Sheet replaced');
          }}
        />
      )}
      {confirmDel !== null && (
        <Confirm
          title={`Delete ${floor.name}`}
          danger
          confirmLabel="Delete floor"
          message={
            confirmDel
              ? `This removes the floor and its ${confirmDel} marker${confirmDel === 1 ? '' : 's'}.`
              : 'This removes the floor. It has no markers.'
          }
          onClose={() => setConfirmDel(null)}
          onConfirm={async () => {
            await api.del(`/api/floors/${floor.id}`);
            const s = getState();
            const floors = s.floors.filter((f) => f.id !== floor.id);
            const markers = { ...s.markers };
            for (const m of Object.values(markers)) if (m.floorId === floor.id) delete markers[m.id];
            setState({ floors, markers, floorId: floors[0]?.id ?? null, selection: [] });
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

/* ---------- renumber (R-30) ---------- */

interface RenumberChange {
  id: string;
  typeId: string;
  floorId: string;
  oldTag: string;
  newTag: string;
  oldNumber: number;
  newNumber: number;
}

export function RenumberDialog({ onClose }: { onClose: () => void }) {
  const projectId = useEditor((s) => s.projectId)!;
  const types = useEditor((s) => s.types);
  const markers = useEditor((s) => s.markers);
  const floors = useEditor((s) => s.floors);
  const used = types.filter((t) => Object.values(markers).some((m) => m.typeId === t.id));
  const [typeId, setTypeId] = useState<string>('');
  const [preview, setPreview] = useState<RenumberChange[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    api
      .post<{ changes: RenumberChange[] }>(`/api/projects/${projectId}/renumber`, {
        typeId: typeId || null,
        apply: false,
      })
      .then(
        (r) => setPreview(r.changes),
        (e) => toast.error(e.message),
      );
  }, [typeId]);

  const floorName = (id: string) => floors.find((f) => f.id === id)?.name ?? '';
  return (
    <Modal
      title="Renumber devices"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !preview?.length}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<{ changes: RenumberChange[] }>(
                  `/api/projects/${projectId}/renumber`,
                  { typeId: typeId || null, apply: true },
                );
                applyRenumber(r.changes);
                toast.success(`Renumbered ${r.changes.length} device${r.changes.length === 1 ? '' : 's'}`);
                onClose();
              } catch (e: any) {
                toast.error(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Apply {preview?.length ? `${preview.length} changes` : ''}
          </button>
        </>
      }
    >
      <p className="muted small">Re-sequences by floor order, then top-to-bottom, left-to-right.</p>
      <label className="field">
        <span>Type</span>
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          <option value="">All types</option>
          {used.map((t) => (
            <option key={t.id} value={t.id}>
              {t.code} — {t.name}
            </option>
          ))}
        </select>
      </label>
      {preview === null ? (
        <p className="muted">Calculating…</p>
      ) : preview.length === 0 ? (
        <p className="muted">Already in order. Nothing to change.</p>
      ) : (
        <div className="table-wrap renumber-table">
          <table className="table">
            <thead>
              <tr>
                <th>Old</th>
                <th aria-hidden="true" />
                <th>New</th>
                <th>Floor</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className="tag tag-sm" style={{ background: colorOf(c.typeId) }}>
                      {c.oldTag}
                    </span>
                  </td>
                  <td aria-hidden="true">→</td>
                  <td>
                    <span className="tag tag-sm" style={{ background: colorOf(c.typeId) }}>
                      {c.newTag}
                    </span>
                  </td>
                  <td className="muted">{floorName(c.floorId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/* ---------- history (R-55) ---------- */

export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const projectId = useEditor((s) => s.projectId)!;
  const [rows, setRows] = useState<Activity[] | null>(null);
  useEffect(() => {
    api.get<Activity[]>(`/api/projects/${projectId}/activity`).then(setRows, (e) => toast.error(e.message));
  }, []);
  return (
    <Modal title="History" onClose={onClose}>
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No changes recorded yet.</p>
      ) : (
        <ol className="history">
          {rows.map((a) => (
            <li key={a.id}>
              <span>{a.summary}</span>
              <span className="muted small">
                {a.userName ?? 'Unknown'} ·{' '}
                <time dateTime={a.at} title={new Date(a.at).toLocaleString()}>
                  {timeAgo(a.at)}
                </time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

/* ---------- exports (R-56, R-57) ---------- */

export function ExportPdfDialog({ onClose }: { onClose: () => void }) {
  const projectId = useEditor((s) => s.projectId)!;
  const floors = useEditor((s) => s.floors);
  const [sel, setSel] = useState<Set<string>>(new Set(floors.map((f) => f.id)));
  return (
    <Modal
      title="Export print PDF"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!sel.size}
            onClick={() => {
              const ids = floors.filter((f) => sel.has(f.id)).map((f) => f.id);
              const qs = ids.length === floors.length ? '' : `?floors=${ids.join(',')}`;
              download(`/api/projects/${projectId}/export.pdf${qs}`);
              toast.info('Generating PDF…');
              onClose();
            }}
          >
            Download PDF
          </button>
        </>
      }
    >
      <p className="muted small">
        One 11×17 page per floor, then the device schedule and totals on letter pages.
      </p>
      <fieldset className="checks">
        <legend>Floors to include</legend>
        {floors.map((f) => (
          <label key={f.id}>
            <input
              type="checkbox"
              checked={sel.has(f.id)}
              onChange={() => {
                const s = new Set(sel);
                if (s.has(f.id)) s.delete(f.id);
                else s.add(f.id);
                setSel(s);
              }}
            />
            {f.name}
            {f.sheetNumber && !f.name.startsWith(f.sheetNumber) ? ` (${f.sheetNumber})` : ''}
          </label>
        ))}
      </fieldset>
    </Modal>
  );
}

export function buildDeviceList(): string {
  const s = getState();
  const types = new Map<string, ExportType>(
    s.types.map((t, i) => [
      t.id,
      {
        id: t.id,
        code: t.code,
        name: t.name,
        category: s.categories.find((c) => c.id === t.categoryId)?.name ?? '',
        color: colorOf(t.id),
        order: i,
      },
    ]),
  );
  return deviceListText(
    { name: s.project?.name ?? '' },
    s.floors.map((f) => ({ id: f.id, name: f.name, sheetNumber: f.sheetNumber || null })),
    types,
    Object.values(s.markers),
  );
}

/** R-56: copy to clipboard; fall back to a dialog with the text selected. */
export async function copyDeviceList(showFallback: (text: string) => void) {
  const text = buildDeviceList();
  try {
    if (!navigator.clipboard) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    toast.success('Device list copied');
  } catch {
    showFallback(text);
  }
}

export function CopyFallbackDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <Modal title="Copy device list" onClose={onClose} wide>
      <p className="muted small">
        Clipboard access isn't available. The text is selected; press Ctrl/⌘+C to copy it.
      </p>
      <textarea
        ref={ref}
        className="copy-text mono"
        readOnly
        value={text}
        rows={16}
        aria-label="Device list"
      />
    </Modal>
  );
}

void typeOf;
