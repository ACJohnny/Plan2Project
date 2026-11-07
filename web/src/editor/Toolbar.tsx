import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Floor } from '@sixpoint/shared';
import { api, download, CLIENT_ID } from '../api';
import { useAuth } from '../auth';
import { Avatar, Confirm, Logo, Menu, MenuItem, Spectrum } from '../components/ui';
import { UserMenu } from '../components/UserMenu';
import { DuplicateDialog, ProjectDialog } from '../pages/Projects';
import { toast } from '../toast';
import {
  copyDeviceList,
  CopyFallbackDialog,
  ExportPdfDialog,
  FloorDialog,
  HistoryDialog,
  RenumberDialog,
} from './Dialogs';
import { planCtl } from './planCtl';
import { getState, setState, useEditor } from './store';
import { useUploads } from './Uploads';

/** Top toolbar (R-60): logo, project, floor tabs, zoom, presence, save status, menu. */
export function Toolbar() {
  const project = useEditor((s) => s.project);
  const { can } = useAuth();
  const nav = useNavigate();
  const [dialog, setDialog] = useState<
    null | 'settings' | 'renumber' | 'history' | 'pdf' | 'dup' | 'delete' | 'floor'
  >(null);
  const [copyText, setCopyText] = useState<string | null>(null);
  const floor = useEditor((s) => s.floors.find((f) => f.id === s.floorId));
  if (!project) return null;

  return (
    <header className="toolbar">
      <div className="toolbar-row">
        <Link to="/" className="brand brand-sm" aria-label="Back to projects">
          <Logo size={28} />
        </Link>
        <div className="toolbar-project">
          <div className="eyebrow">{project.client || 'Project'}</div>
          <h1 className="project-name" title={project.name}>
            {project.name}
          </h1>
        </div>
        <FloorTabs onSettings={() => setDialog('floor')} />
        <ZoomControls />
        <Presence />
        <SaveStatus />
        <Menu label="Project menu" icon="⋯">
          {can('editor') && (
            <MenuItem onClick={() => useUploads.getState().set({ open: true })}>Upload sheets…</MenuItem>
          )}
          {can('editor') && floor && <MenuItem onClick={() => setDialog('floor')}>Floor settings…</MenuItem>}
          {can('editor') && <MenuItem onClick={() => setDialog('settings')}>Project settings…</MenuItem>}
          {can('editor') && <MenuItem onClick={() => setDialog('renumber')}>Renumber…</MenuItem>}
          <MenuItem onClick={() => setDialog('history')}>History</MenuItem>
          <div className="menu-sep" role="separator" />
          <MenuItem onClick={() => copyDeviceList(setCopyText)}>Copy device list</MenuItem>
          <MenuItem onClick={() => setDialog('pdf')}>Export PDF…</MenuItem>
          <MenuItem onClick={() => download(`/api/projects/${project.id}/export.csv`)}>Export CSV</MenuItem>
          {can('editor') && (
            <>
              <div className="menu-sep" role="separator" />
              <MenuItem onClick={() => setDialog('dup')}>Duplicate project…</MenuItem>
              <MenuItem
                onClick={async () => {
                  await api.patch(`/api/projects/${project.id}`, { archived: !project.archivedAt });
                  toast.success(project.archivedAt ? 'Project unarchived' : 'Project archived');
                  nav('/');
                }}
              >
                {project.archivedAt ? 'Unarchive project' : 'Archive project'}
              </MenuItem>
            </>
          )}
          {can('admin') && (
            <MenuItem danger onClick={() => setDialog('delete')}>
              Delete project…
            </MenuItem>
          )}
        </Menu>
        <UserMenu />
      </div>
      <Spectrum />
      {dialog === 'settings' && (
        <ProjectDialog
          project={project}
          onClose={() => setDialog(null)}
          onSaved={(p) => setState({ project: p })}
        />
      )}
      {dialog === 'renumber' && <RenumberDialog onClose={() => setDialog(null)} />}
      {dialog === 'history' && <HistoryDialog onClose={() => setDialog(null)} />}
      {dialog === 'pdf' && <ExportPdfDialog onClose={() => setDialog(null)} />}
      {dialog === 'floor' && floor && <FloorDialog floor={floor} onClose={() => setDialog(null)} />}
      {dialog === 'dup' && (
        <DuplicateDialog
          project={project}
          onClose={() => setDialog(null)}
          onDone={(p) => nav(`/p/${p.id}`)}
        />
      )}
      {dialog === 'delete' && (
        <Confirm
          title="Delete project"
          danger
          confirmLabel="Delete project"
          message={`Move ${project.name} to Trash? An admin can restore it for 30 days.`}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.del(`/api/projects/${project.id}`);
            nav('/');
          }}
        />
      )}
      {copyText !== null && <CopyFallbackDialog text={copyText} onClose={() => setCopyText(null)} />}
    </header>
  );
}

/** R-48: tabs with live counts; R-21: drag to reorder. */
function FloorTabs({ onSettings }: { onSettings: () => void }) {
  const floors = useEditor((s) => s.floors);
  const floorId = useEditor((s) => s.floorId);
  const markers = useEditor((s) => s.markers);
  const canEdit = useEditor((s) => s.canEdit);
  const [dragId, setDragId] = useState<string | null>(null);
  const counts = new Map<string, number>();
  for (const m of Object.values(markers)) counts.set(m.floorId, (counts.get(m.floorId) ?? 0) + 1);

  const reorder = async (ids: string[]) => {
    const s = getState();
    const byId = new Map(s.floors.map((f) => [f.id, f]));
    setState({ floors: ids.map((id, i) => ({ ...byId.get(id)!, sortOrder: i })) });
    try {
      await api.post<Floor[]>(`/api/projects/${s.projectId}/floors/reorder`, { floorIds: ids });
    } catch (e: any) {
      setState({ floors: s.floors });
      toast.error(`Couldn't reorder floors: ${e.message}`);
    }
  };
  const move = (id: string, d: number) => {
    const ids = floors.map((f) => f.id);
    const i = ids.indexOf(id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids);
  };

  if (!floors.length) return <div className="floor-tabs" />;
  return (
    <nav className="floor-tabs" aria-label="Floors">
      <div role="tablist" className="floor-tabs-inner">
        {floors.map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={f.id === floorId}
            className={`floor-tab ${dragId === f.id ? 'dragging' : ''}`}
            draggable={canEdit}
            onClick={() => setState({ floorId: f.id, selection: [] })}
            onDoubleClick={() => canEdit && onSettings()}
            onKeyDown={(e) => {
              if (canEdit && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                e.preventDefault();
                move(f.id, e.key === 'ArrowLeft' ? -1 : 1);
              }
            }}
            onDragStart={(e) => {
              setDragId(f.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => dragId && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!dragId || dragId === f.id) return;
              const ids = floors.map((x) => x.id).filter((x) => x !== dragId);
              ids.splice(
                ids.indexOf(f.id) +
                  (floors.findIndex((x) => x.id === dragId) < floors.findIndex((x) => x.id === f.id) ? 1 : 0),
                0,
                dragId,
              );
              reorder(ids);
            }}
            title={canEdit ? 'Double-click for floor settings · drag or Alt+←/→ to reorder' : f.name}
          >
            <span className="floor-tab-name">{f.name}</span>
            {f.sheetNumber && !f.name.startsWith(f.sheetNumber) && (
              <span className="floor-tab-sheet mono">{f.sheetNumber}</span>
            )}
            <span className="floor-tab-count mono" aria-label={`${counts.get(f.id) ?? 0} devices`}>
              {counts.get(f.id) ?? 0}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function ZoomControls() {
  const [pct, setPct] = useState(planCtl.zoomPct);
  const hasFloor = useEditor((s) => !!s.floorId);
  useEffect(() => {
    const l = (p: number) => setPct(p);
    planCtl.listeners.add(l);
    return () => void planCtl.listeners.delete(l);
  }, []);
  return (
    <div className="zoom" role="group" aria-label="Zoom">
      <button
        className="icon-btn"
        onClick={() => planCtl.zoomBy(1 / 1.4)}
        disabled={!hasFloor}
        aria-label="Zoom out"
        title="Zoom out (−)"
      >
        −
      </button>
      <span className="zoom-pct mono" aria-live="polite" title="Zoom as a percentage of Fit">
        {Math.round(pct)}%
      </span>
      <button
        className="icon-btn"
        onClick={() => planCtl.zoomBy(1.4)}
        disabled={!hasFloor}
        aria-label="Zoom in"
        title="Zoom in (+)"
      >
        +
      </button>
      <button className="btn btn-sm" onClick={() => planCtl.fit()} disabled={!hasFloor} title="Fit (0)">
        Fit
      </button>
    </div>
  );
}

/** R-53 */
function Presence() {
  const presence = useEditor((s) => s.presence);
  const { user } = useAuth();
  const seen = new Set<string>();
  const others = presence.filter((p) => {
    if (p.clientId === CLIENT_ID || (p.userId === user?.id && seen.has(p.userId))) return false;
    if (seen.has(p.userId)) return false;
    seen.add(p.userId);
    return true;
  });
  if (!others.length) return null;
  return (
    <div className="presence" aria-label={`Also viewing: ${others.map((o) => o.name).join(', ')}`}>
      {others.slice(0, 5).map((o) => (
        <Avatar key={o.userId} name={o.name} initials={o.initials} title={`${o.name} is viewing`} />
      ))}
      {others.length > 5 && <span className="avatar more">+{others.length - 5}</span>}
    </div>
  );
}

/** R-50 */
function SaveStatus() {
  const status = useEditor((s) => s.saveStatus);
  const pending = useEditor((s) => s.pending);
  const text =
    status === 'saved'
      ? 'Saved'
      : status === 'saving'
        ? 'Saving…'
        : status === 'offline'
          ? `Offline, ${pending} change${pending === 1 ? '' : 's'} queued`
          : 'Save failed';
  return (
    <div className={`save-status ${status}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      {text}
    </div>
  );
}
