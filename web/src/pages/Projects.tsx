import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Project } from '@sixpoint/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppHeader } from '../components/AppHeader';
import { Confirm, Menu, MenuItem, Modal, timeAgo } from '../components/ui';
import { toast } from '../toast';

type View = 'active' | 'archived' | 'trash';

/** Projects list (R-15). */
export function ProjectsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [view, setView] = useState<View>('active');
  const [q, setQ] = useState('');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [dup, setDup] = useState<Project | null>(null);
  const [del, setDel] = useState<Project | null>(null);

  const load = async (signal?: AbortSignal) => {
    try {
      const qs = new URLSearchParams({ view });
      if (q.trim()) qs.set('q', q.trim());
      setProjects(await api.get<Project[]>(`/api/projects?${qs}`, signal));
    } catch (e: any) {
      if (e.name !== 'AbortError') toast.error(`Couldn't load projects: ${e.message}`);
    }
  };

  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => load(ac.signal), q ? 200 : 0);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [view, q]);

  const sorted = useMemo(
    () => [...(projects ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects],
  );

  const patch = async (p: Project, body: object, msg: string) => {
    try {
      await api.patch(`/api/projects/${p.id}`, body);
      toast.success(msg);
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  return (
    <>
      <AppHeader />
      <main className="page">
        <div className="page-head">
          <div>
            <div className="eyebrow">Six Point Technology</div>
            <h1>Projects</h1>
          </div>
          <div className="grow" />
          {can('editor') && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              + New project
            </button>
          )}
        </div>
        <div className="list-tools">
          <label className="search">
            <span className="sr-only">Search projects</span>
            <input
              type="search"
              placeholder="Search name, client or address"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <div className="segmented" role="group" aria-label="Filter">
            {(['active', 'archived', ...(can('admin') ? ['trash'] : [])] as View[]).map((v) => (
              <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
                {v === 'active' ? 'Active' : v === 'archived' ? 'Archived' : 'Trash'}
              </button>
            ))}
          </div>
          <span className="muted small">Sorted by last edited</span>
        </div>

        {projects === null ? (
          <p className="muted">Loading…</p>
        ) : sorted.length === 0 ? (
          <div className="empty-card">
            {q ? (
              <p>No projects match “{q}”.</p>
            ) : view === 'active' ? (
              <>
                <p>No projects yet.</p>
                {can('editor') && (
                  <button className="btn btn-primary" onClick={() => setCreating(true)}>
                    Create the first project
                  </button>
                )}
              </>
            ) : (
              <p>Nothing here.</p>
            )}
          </div>
        ) : (
          <ul className="project-grid">
            {sorted.map((p) => (
              <li key={p.id} className="project-card">
                <Link
                  to={view === 'trash' ? '#' : `/p/${p.id}`}
                  className="project-link"
                  aria-label={`Open ${p.name}`}
                >
                  <div className="thumb">
                    {p.thumbUrl ? <img src={p.thumbUrl} alt="" loading="lazy" /> : <span>No sheets</span>}
                  </div>
                  <div className="project-meta">
                    <h2>{p.name}</h2>
                    <p className="muted">
                      {[p.client, p.jobNumber && `#${p.jobNumber}`].filter(Boolean).join(' · ') || '—'}
                    </p>
                    {p.address && <p className="muted small">{p.address}</p>}
                    <p className="counts">
                      <span className="mono">{p.floorCount}</span> floor{p.floorCount === 1 ? '' : 's'} ·{' '}
                      <span className="mono">{p.deviceCount}</span> device{p.deviceCount === 1 ? '' : 's'}
                    </p>
                    <p className="muted small">
                      Edited {timeAgo(p.updatedAt)}
                      {p.updatedByName ? ` by ${p.updatedByName}` : ''}
                    </p>
                  </div>
                </Link>
                {(can('editor') || view === 'trash') && (
                  <div className="card-menu">
                    <Menu label={`Actions for ${p.name}`} icon="⋯">
                      {view === 'trash' ? (
                        <MenuItem onClick={() => patch(p, { restore: true }, 'Project restored')}>
                          Restore
                        </MenuItem>
                      ) : (
                        <>
                          <MenuItem onClick={() => nav(`/p/${p.id}`)}>Open</MenuItem>
                          <MenuItem onClick={() => setDup(p)}>Duplicate…</MenuItem>
                          {view === 'archived' ? (
                            <MenuItem onClick={() => patch(p, { archived: false }, 'Project unarchived')}>
                              Unarchive
                            </MenuItem>
                          ) : (
                            <MenuItem onClick={() => patch(p, { archived: true }, 'Project archived')}>
                              Archive
                            </MenuItem>
                          )}
                          {can('admin') && (
                            <MenuItem danger onClick={() => setDel(p)}>
                              Delete…
                            </MenuItem>
                          )}
                        </>
                      )}
                    </Menu>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
      {creating && <ProjectDialog onClose={() => setCreating(false)} onSaved={(p) => nav(`/p/${p.id}`)} />}
      {dup && (
        <DuplicateDialog project={dup} onClose={() => setDup(null)} onDone={(p) => nav(`/p/${p.id}`)} />
      )}
      {del && (
        <Confirm
          title="Delete project"
          danger
          confirmLabel="Delete project"
          message={
            <>
              Move <strong>{del.name}</strong> to Trash? It can be restored from Trash for 30 days.
            </>
          }
          onClose={() => setDel(null)}
          onConfirm={async () => {
            await api.del(`/api/projects/${del.id}`);
            toast.success('Project moved to Trash');
            load();
          }}
        />
      )}
    </>
  );
}

/** R-16: project fields; used for create and for the settings panel. */
const MARKER_SIZES = [
  [0.6, 'Extra small (60%)'],
  [0.8, 'Small (80%)'],
  [1, 'Normal (100%)'],
  [1.25, 'Large (125%)'],
  [1.5, 'Extra large (150%)'],
  [2, 'Huge (200%)'],
] as const;

export function ProjectDialog({
  project,
  onClose,
  onSaved,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: (p: Project) => void;
}) {
  const [f, setF] = useState({
    name: project?.name ?? '',
    client: project?.client ?? '',
    address: project?.address ?? '',
    jobNumber: project?.jobNumber ?? '',
    notes: project?.notes ?? '',
    extraWireFt: String(project?.extraWireFt ?? 0),
    markerScale: String(project?.markerScale ?? 1),
  });
  const [snapToLines, setSnapToLines] = useState(project?.snapToLines ?? true);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { extraWireFt, markerScale: scale, ...fields } = f;
      const extra = Math.max(0, Number(extraWireFt) || 0);
      const markerScale = Number(scale) || 1;
      const p = project
        ? await api.patch<Project>(`/api/projects/${project.id}`, {
            ...fields,
            extraWireFt: extra,
            markerScale,
            snapToLines,
          })
        : await api.patch<Project>(`/api/projects/${(await api.post<Project>('/api/projects', fields)).id}`, {
            extraWireFt: extra,
            markerScale,
            snapToLines,
          });
      onSaved(p);
      onClose();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={project ? 'Project settings' : 'New project'} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <label className="field span-2">
          <span>Name *</span>
          <input required value={f.name} onChange={set('name')} maxLength={200} />
        </label>
        <label className="field">
          <span>Client</span>
          <input value={f.client} onChange={set('client')} maxLength={200} />
        </label>
        <label className="field">
          <span>Job number</span>
          <input value={f.jobNumber} onChange={set('jobNumber')} maxLength={80} />
        </label>
        <label className="field span-2">
          <span>Site address</span>
          <input value={f.address} onChange={set('address')} maxLength={400} />
        </label>
        <label className="field span-2">
          <span>Notes</span>
          <textarea rows={3} value={f.notes} onChange={set('notes')} />
        </label>
        <label className="field">
          <span>Extra wire length per run (ft)</span>
          <input
            type="number"
            min={0}
            max={1000}
            step={1}
            value={f.extraWireFt}
            onChange={set('extraWireFt')}
          />
        </label>
        <p className="muted small field-note">
          Added to every cable run for service loops, drops and termination.
        </p>
        <label className="field">
          <span>Marker size</span>
          <select value={f.markerScale} onChange={set('markerScale')}>
            {MARKER_SIZES.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            {!MARKER_SIZES.some(([v]) => v === Number(f.markerScale)) && (
              <option value={f.markerScale}>{Math.round(Number(f.markerScale) * 100)}%</option>
            )}
          </select>
        </label>
        <p className="muted small field-note">How large devices appear on this project's plans and PDF.</p>
        <label className="check-row span-2">
          <input type="checkbox" checked={snapToLines} onChange={(e) => setSnapToLines(e.target.checked)} />{' '}
          Snap zone outlines to lines on the drawing
        </label>
        <div className="form-actions span-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {project ? 'Save' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** R-23 */
export function DuplicateDialog({
  project,
  onClose,
  onDone,
}: {
  project: Project;
  onClose: () => void;
  onDone: (p: Project) => void;
}) {
  const [name, setName] = useState(`${project.name} (copy)`);
  const [withMarkers, setWithMarkers] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Duplicate project" onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const p = await api.post<Project>(`/api/projects/${project.id}/duplicate`, { name, withMarkers });
            toast.success('Project duplicated');
            onDone(p);
            onClose();
          } catch (err: any) {
            toast.error(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field span-2">
          <span>New project name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset className="span-2 radios">
          <legend>Copy</legend>
          <label>
            <input type="radio" checked={withMarkers} onChange={() => setWithMarkers(true)} /> Sheets and
            markers
          </label>
          <label>
            <input type="radio" checked={!withMarkers} onChange={() => setWithMarkers(false)} /> Sheets only
            (template)
          </label>
        </fieldset>
        <div className="form-actions span-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Duplicate
          </button>
        </div>
      </form>
    </Modal>
  );
}
