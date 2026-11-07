import { uuid } from '../uuid';
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Upload } from '@sixpoint/shared';
import { api, uploadFile } from '../api';
import { Modal } from '../components/ui';
import { toast } from '../toast';
import { getState, setState, useEditor } from './store';

/** Upload jobs for the current project, shown in the upload dialog (R-17..R-19). */
interface FileJob {
  key: string;
  name: string;
  size: number;
  progress: number;
  uploadId?: string;
  error?: string;
  state: 'uploading' | 'processing' | 'done' | 'failed';
}

interface UploadUi {
  open: boolean;
  jobs: FileJob[];
  picker: string | null;
  set: (p: Partial<UploadUi>) => void;
  update: (key: string, p: Partial<FileJob>) => void;
}

export const useUploads = create<UploadUi>((set, get) => ({
  open: false,
  jobs: [],
  picker: null,
  set: (p) => set(p),
  update: (key, p) => set({ jobs: get().jobs.map((j) => (j.key === key ? { ...j, ...p } : j)) }),
}));

const ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

export function startUploads(files: FileList | File[]) {
  const s = getState();
  if (!s.projectId) return;
  const ui = useUploads.getState();
  ui.set({ open: true });
  for (const file of Array.from(files)) {
    const key = uuid();
    const job: FileJob = { key, name: file.name, size: file.size, progress: 0, state: 'uploading' };
    useUploads.setState({ jobs: [...useUploads.getState().jobs, job] });
    const { promise } = uploadFile<Upload>(`/api/projects/${s.projectId}/uploads`, file, (p) =>
      useUploads.getState().update(key, { progress: p }),
    );
    promise.then(
      (up) => {
        setState({ uploads: { ...getState().uploads, [up.id]: up } });
        useUploads
          .getState()
          .update(key, { uploadId: up.id, progress: 1, state: up.status === 'done' ? 'done' : 'processing' });
        if (up.status !== 'done') poll(up.id);
      },
      (e) => useUploads.getState().update(key, { state: 'failed', error: e.message }),
    );
  }
}

/** Fallback polling alongside SSE upload.progress events. */
function poll(id: string) {
  const tick = async () => {
    try {
      const up = await api.get<Upload>(`/api/uploads/${id}`);
      onUploadProgress(up);
      if (up.status === 'done' || up.status === 'failed') return;
    } catch {
      /* retry */
    }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1500);
}

export function onUploadProgress(up: Upload) {
  setState({ uploads: { ...getState().uploads, [up.id]: up } });
  const ui = useUploads.getState();
  const job = ui.jobs.find((j) => j.uploadId === up.id);
  if (!job || job.state === 'done' || job.state === 'failed') return;
  if (up.status === 'failed') ui.update(job.key, { state: 'failed', error: up.error ?? 'Conversion failed' });
  else if (up.status === 'done') {
    ui.update(job.key, { state: 'done' });
    if (up.pageCount > 1) ui.set({ open: true, picker: up.id });
  }
}

/** Empty state in the plan area (R-66). */
export function UploadDropZone() {
  const canEdit = useEditor((s) => s.canEdit);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  if (!canEdit)
    return (
      <div className="dropzone dropzone-empty">
        <p>No plan sheets yet.</p>
        <p className="muted small">An editor needs to upload the plans for this project.</p>
      </div>
    );
  return (
    <div
      className={`dropzone dropzone-empty ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) startUploads(e.dataTransfer.files);
      }}
    >
      <div className="dropzone-icon" aria-hidden="true">
        ⇪
      </div>
      <p>
        <strong>Drop plan sheets here</strong>
      </p>
      <p className="muted small">PDF, PNG or JPG. Multi-page PDFs become one floor per page you pick.</p>
      <button className="btn btn-primary" onClick={() => input.current?.click()}>
        Choose files
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => e.target.files && startUploads(e.target.files)}
      />
    </div>
  );
}

export function UploadDialog() {
  const { open, jobs, picker, set } = useUploads();
  const uploads = useEditor((s) => s.uploads);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  if (!open) return null;
  if (picker && uploads[picker])
    return <PagePicker upload={uploads[picker]} onClose={() => set({ picker: null })} />;
  const close = () =>
    set({ open: false, jobs: jobs.filter((j) => j.state === 'uploading' || j.state === 'processing') });
  return (
    <Modal title="Upload plan sheets" onClose={close} wide>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          startUploads(e.dataTransfer.files);
        }}
      >
        <p>
          <strong>Drag files here</strong> or{' '}
          <button className="link-btn" onClick={() => input.current?.click()}>
            choose files
          </button>
        </p>
        <p className="muted small">PDF, PNG or JPG. Several at once is fine.</p>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => e.target.files && startUploads(e.target.files)}
        />
      </div>
      {jobs.length > 0 && (
        <ul className="upload-list">
          {jobs.map((j) => {
            const up = j.uploadId ? uploads[j.uploadId] : undefined;
            let status = '';
            if (j.state === 'uploading') status = `Uploading ${Math.round(j.progress * 100)}%`;
            else if (j.state === 'failed') status = j.error ?? 'Failed';
            else if (up?.kind === 'pdf' && up.status !== 'done')
              status = up.pageCount
                ? `Converting page ${Math.min(up.pagesDone + 1, up.pageCount)} of ${up.pageCount}`
                : 'Reading PDF…';
            else
              status =
                up?.kind === 'pdf'
                  ? `${up.pageCount} page${up.pageCount === 1 ? '' : 's'} converted`
                  : 'Added as a floor';
            const pct =
              j.state === 'uploading'
                ? j.progress
                : up?.pageCount
                  ? up.pagesDone / up.pageCount
                  : j.state === 'done'
                    ? 1
                    : 0.05;
            return (
              <li key={j.key} className={`upload-item ${j.state}`}>
                <div className="upload-name">
                  <span>{j.name}</span>
                  <span className="muted small mono">{(j.size / 1024 / 1024).toFixed(1)} MB</span>
                </div>
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuenow={Math.round(pct * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${j.name} progress`}
                >
                  <span style={{ width: `${Math.round(pct * 100)}%` }} />
                </div>
                <div className={`small ${j.state === 'failed' ? 'warn' : 'muted'}`}>{status}</div>
                {up && up.status === 'done' && up.pageCount > 1 && (
                  <button className="btn btn-sm" onClick={() => set({ picker: up.id })}>
                    Pick pages…
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/** R-19: choose which pages of a multi-page PDF stay as floors. */
function PagePicker({ upload, onClose }: { upload: Upload; onClose: () => void }) {
  const [keep, setKeep] = useState<Set<number>>(
    () => new Set(upload.pages.filter((p) => p.floorId).map((p) => p.page)),
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setKeep(new Set(upload.pages.filter((p) => p.floorId).map((p) => p.page)));
  }, [upload.id]);
  const toggle = (n: number) => {
    const s = new Set(keep);
    if (s.has(n)) s.delete(n);
    else s.add(n);
    setKeep(s);
  };
  return (
    <Modal
      title={`Pick pages from ${upload.filename}`}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted small grow">
            {keep.size} of {upload.pageCount} pages become floors
          </span>
          <button className="btn" onClick={onClose}>
            Keep all
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || keep.size === 0}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.post<Upload>(`/api/uploads/${upload.id}/pages`, { keepPages: [...keep] });
                setState({ uploads: { ...getState().uploads, [r.id]: r } });
                const removed = upload.pages
                  .filter((p) => p.floorId && !keep.has(p.page))
                  .map((p) => p.floorId);
                if (removed.length) {
                  const s = getState();
                  const floors = s.floors.filter((f) => !removed.includes(f.id));
                  setState({
                    floors,
                    floorId: floors.some((f) => f.id === s.floorId) ? s.floorId : (floors[0]?.id ?? null),
                  });
                }
                toast.success(`${keep.size} floor${keep.size === 1 ? '' : 's'} kept`);
                onClose();
              } catch (e: any) {
                toast.error(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Keep selected pages
          </button>
        </>
      }
    >
      <p className="muted small">
        A full set often includes elevations and details. Uncheck pages that shouldn't be floors.
      </p>
      <ul className="page-grid">
        {upload.pages.map((p) => (
          <li key={p.page}>
            <label className={`page-card ${keep.has(p.page) ? 'checked' : ''}`}>
              <input
                type="checkbox"
                checked={keep.has(p.page)}
                onChange={() => toggle(p.page)}
                disabled={!p.floorId && !keep.has(p.page)}
              />
              {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : <div className="thumb-ph" />}
              <span className="page-name">{p.name}</span>
              <span className="muted small mono">
                Page {p.page} · {p.widthPx}×{p.heightPx}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
