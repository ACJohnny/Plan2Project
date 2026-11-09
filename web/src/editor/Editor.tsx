import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Floor, Library, Marker, Project, ProjectEvent, Zone } from '@sixpoint/shared';
import { api, CLIENT_ID } from '../api';
import { useAuth } from '../auth';
import { toast } from '../toast';
import {
  applyRemoteDeletes,
  applyRemoteUpserts,
  copySelection,
  deleteMarkers,
  hasPendingWrites,
  nudge,
  paste,
  redo,
  replaceAllMarkers,
  resetQueue,
  undo,
} from './ops';
import { Palette } from './Palette';
import { Plan } from './Plan';
import { planCtl } from './planCtl';
import { SidePanel } from './SidePanel';
import { getState, initialState, setState, useEditor } from './store';
import { Toolbar } from './Toolbar';
import { deleteZone, setZoneEdit } from './zones';
import { ZonesTableDialog } from './ZonesPanel';
import { onUploadProgress, UploadDialog } from './Uploads';

const sortFloors = (fl: Floor[]) =>
  [...fl].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const loaded = useEditor((s) => s.projectId === id && !!s.project);
  const canEdit = useEditor((s) => s.canEdit);

  /* ---------- load ---------- */
  useEffect(() => {
    if (!id) return;
    resetQueue();
    setState({ ...initialState(), projectId: id, canEdit: can('editor') });
    let cancelled = false;
    (async () => {
      try {
        const [p, lib, ms, zs] = await Promise.all([
          api.get<{ project: Project; floors: Floor[] }>(`/api/projects/${id}`),
          api.get<Library>('/api/device-library'),
          api.get<Marker[]>(`/api/projects/${id}/markers`),
          api.get<Zone[]>(`/api/projects/${id}/zones`),
        ]);
        if (cancelled) return;
        const floors = sortFloors(p.floors);
        setState({
          project: p.project,
          floors,
          floorId: floors[0]?.id ?? null,
          categories: lib.categories,
          types: lib.types,
          wireTypes: lib.wireTypes,
          zoneNames: lib.zoneNames.map((z) => z.name),
          markers: Object.fromEntries(ms.map((m) => [m.id, m])),
          zones: Object.fromEntries(zs.map((z) => [z.id, z])),
        });
        document.title = `${p.project.name} · Six Point Markup`;
      } catch (e: any) {
        setError(e.status === 404 ? 'This project was not found or was deleted.' : e.message);
      }
    })();
    return () => {
      cancelled = true;
      document.title = 'Six Point Markup';
    };
  }, [id]);

  /* ---------- live updates (R-51) ---------- */
  useEffect(() => {
    if (!id || !loaded) return;
    const es = new EventSource(`/api/projects/${id}/events?clientId=${encodeURIComponent(CLIENT_ID)}`);
    let hadError = false;
    const on = (type: ProjectEvent['type'], fn: (e: any) => void) =>
      es.addEventListener(type, (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as ProjectEvent;
        if (data.origin && data.origin === CLIENT_ID) return; // our own echo
        fn(data);
      });
    on('marker.upsert', (e) => applyRemoteUpserts(e.markers));
    on('marker.delete', (e) => applyRemoteDeletes(e.ids));
    on('floor.upsert', (e) => {
      const s = getState();
      const byId = new Map(s.floors.map((f) => [f.id, f]));
      for (const f of e.floors as Floor[]) byId.set(f.id, f);
      const floors = sortFloors([...byId.values()]);
      setState({ floors, floorId: s.floorId ?? floors[0]?.id ?? null });
    });
    on('floor.delete', (e) => {
      const s = getState();
      const floors = s.floors.filter((f) => !e.ids.includes(f.id));
      const markers = { ...s.markers };
      for (const mid of e.markerIds) delete markers[mid];
      setState({
        floors,
        markers,
        floorId: floors.some((f) => f.id === s.floorId) ? s.floorId : (floors[0]?.id ?? null),
      });
    });
    on('floor.order', (e) => {
      const s = getState();
      const byId = new Map(s.floors.map((f) => [f.id, f]));
      setState({
        floors: (e.floorIds as string[])
          .map((fid, i) => byId.get(fid) && { ...byId.get(fid)!, sortOrder: i })
          .filter(Boolean) as Floor[],
      });
    });
    on('project.update', (e) => {
      if (e.project.deletedAt) {
        toast.error('This project was deleted.');
        nav('/');
        return;
      }
      setState({ project: e.project });
    });
    on('zone.upsert', (e) =>
      setState({
        zones: { ...getState().zones, ...Object.fromEntries((e.zones as Zone[]).map((z) => [z.id, z])) },
      }),
    );
    on('zone.delete', (e) => {
      const s = getState();
      const zones = { ...s.zones };
      for (const zid of e.ids) delete zones[zid];
      setState({ zones, selectedZone: s.selectedZone && zones[s.selectedZone] ? s.selectedZone : null });
    });
    on('upload.progress', (e) => onUploadProgress(e.upload));
    on('library.update', async () => {
      const lib = await api.get<Library>('/api/device-library');
      setState({
        categories: lib.categories,
        types: lib.types,
        wireTypes: lib.wireTypes,
        zoneNames: lib.zoneNames.map((z) => z.name),
      });
    });
    es.addEventListener('presence', (ev) =>
      setState({ presence: JSON.parse((ev as MessageEvent).data).users }),
    );
    es.onerror = () => {
      hadError = true;
    };
    es.onopen = async () => {
      if (!hadError) return;
      hadError = false;
      // resync anything missed while disconnected
      try {
        const [p, ms] = await Promise.all([
          api.get<{ project: Project; floors: Floor[] }>(`/api/projects/${id}`),
          api.get<Marker[]>(`/api/projects/${id}/markers`),
        ]);
        setState({ project: p.project, floors: sortFloors(p.floors) });
        replaceAllMarkers(ms);
        const zs = await api.get<Zone[]>(`/api/projects/${id}/zones`);
        setState({ zones: Object.fromEntries(zs.map((z) => [z.id, z])) });
      } catch {
        /* next reconnect will retry */
      }
    };
    return () => es.close();
  }, [id, loaded]);

  /* ---------- keyboard (R-36) ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input:not([type=checkbox]), textarea, select, [contenteditable=true], .modal')) return;
      const s = getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key;
      if (mod && k.toLowerCase() === 'z') {
        e.preventDefault();
        if (!s.canEdit) return;
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k.toLowerCase() === 'y') {
        e.preventDefault();
        if (s.canEdit) redo();
        return;
      }
      if (mod && k.toLowerCase() === 'c') {
        if (s.selection.length) {
          e.preventDefault();
          copySelection();
        }
        return;
      }
      if (mod && k.toLowerCase() === 'v') {
        if (s.canEdit && s.clipboard.length) {
          e.preventDefault();
          paste();
        }
        return;
      }
      if (mod) return;
      if ((k === 'Delete' || k === 'Backspace') && s.selection.length && s.canEdit) {
        e.preventDefault();
        deleteMarkers(s.selection);
      } else if ((k === 'Delete' || k === 'Backspace') && s.zoneEdit && s.selectedZone && s.canEdit) {
        if (s.tool === 'zone') return; // Backspace removes a corner while drawing
        e.preventDefault();
        deleteZone(s.selectedZone);
      } else if (k === 'Escape') {
        if (s.tool) setState({ tool: null });
        else if (s.selectedZone || s.selection.length) setState({ selectedZone: null, selection: [] });
        else if (s.armed || s.boxMode) setState({ armed: null, boxMode: false });
        else if (s.zoneEdit) setZoneEdit(false);
      } else if (k.startsWith('Arrow') && s.selection.length && s.canEdit) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const { fx, fy } = planCtl.pxToFraction();
        const dx = k === 'ArrowLeft' ? -step * fx : k === 'ArrowRight' ? step * fx : 0;
        const dy = k === 'ArrowUp' ? -step * fy : k === 'ArrowDown' ? step * fy : 0;
        nudge(s.selection, dx, dy);
      } else if (k === '+' || k === '=') {
        e.preventDefault();
        planCtl.zoomBy(1.4);
      } else if (k === '-' || k === '_') {
        e.preventDefault();
        planCtl.zoomBy(1 / 1.4);
      } else if (k === '0') {
        e.preventDefault();
        planCtl.fit();
      }
    };
    window.addEventListener('keydown', onKey);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (hasPendingWrites()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  if (error)
    return (
      <main className="page narrow">
        <h1>Can't open project</h1>
        <p>{error}</p>
        <Link to="/" className="btn">
          Back to projects
        </Link>
      </main>
    );
  if (!loaded) return <div className="page-loading">Loading project…</div>;

  return (
    <div className={`editor ${canEdit ? '' : 'read-only'}`}>
      <Toolbar />
      <div className="editor-body">
        {canEdit && <Palette />}
        <main className="plan-wrap" aria-label="Plan">
          <Plan />
        </main>
        <SidePanel />
      </div>
      <UploadDialog />
      <ZonesTableDialog />
    </div>
  );
}
