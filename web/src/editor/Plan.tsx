import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  centerOn,
  clamp,
  fitScale,
  fitView,
  inSheet,
  MAX_ZOOM,
  MIN_ZOOM,
  centroid,
  rectPolygon,
  screenToFraction,
  zoneAt,
  zoomAt,
  type Marker,
  type View,
  type Zone,
} from '@sixpoint/shared';
import {
  commitMarkerEdit,
  commitMove,
  createMarkers,
  duplicateMarkers,
  placeMarker,
  setPositionsLocal,
} from './ops';
import { CoverageHandles, CoverageShapes, dragCoverage, WirePaths, type CoverageHandle } from './Overlays';
import { planCtl } from './planCtl';
import { colorOf, getState, setState, tagOf, typeOf, useEditor } from './store';
import { UploadDropZone } from './Uploads';
import { CalibrateDialog, ZoneDialog } from './ZoneDialogs';
import { patchFloor, saveZone, newZone, setZoneEdit } from './zones';
import { toast } from '../toast';

const DRAG_THRESHOLD = 5;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

type Gesture =
  | {
      kind: 'pending';
      id: number;
      sx: number;
      sy: number;
      markerId: string | null;
      vertex: { zoneId: string; index: number } | null;
      shift: boolean;
      alt: boolean;
    }
  | { kind: 'zoneRect'; id: number; sx: number; sy: number; x: number; y: number }
  | { kind: 'vertex'; id: number; zone: Zone; index: number }
  | { kind: 'coverage'; id: number; before: Marker; handle: CoverageHandle; grab: { x: number; y: number } }
  | { kind: 'pan'; id: number; lx: number; ly: number }
  | {
      kind: 'drag';
      id: number;
      sx: number;
      sy: number;
      before: Marker[];
      start: Map<string, { x: number; y: number }>;
      isCopy: boolean;
    }
  | { kind: 'marquee'; id: number; sx: number; sy: number; x: number; y: number; additive: boolean }
  | { kind: 'pinch'; d0: number; m0: { x: number; y: number }; v0: View };

/** The sheet with its marker overlay (R-28..R-39). */
export function Plan() {
  const floor = useEditor((s) => s.floors.find((f) => f.id === s.floorId));
  const markersAll = useEditor((s) => s.markers);
  const selection = useEditor((s) => s.selection);
  const armed = useEditor((s) => s.armed);
  const canEdit = useEditor((s) => s.canEdit);
  const boxMode = useEditor((s) => s.boxMode);
  const focus = useEditor((s) => s.focus);
  const types = useEditor((s) => s.types);
  const markerScale = useEditor((s) => s.project?.markerScale ?? 1);
  const zonesAll = useEditor((s) => s.zones);
  const tool = useEditor((s) => s.tool);
  const selectedZone = useEditor((s) => s.selectedZone);
  const zoneEdit = useEditor((s) => s.zoneEdit);

  const vpRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View | null>(null);
  const fitRef = useRef(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const anim = useRef<number | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  // zone drawing state (fractions)
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [pendingZone, setPendingZone] = useState<Zone | null>(null);
  const [calibA, setCalibA] = useState<{ x: number; y: number } | null>(null);
  const [calib, setCalib] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(
    null,
  );
  const zones = useMemo(
    () => (floor ? Object.values(zonesAll).filter((z) => z.floorId === floor.id) : []),
    [zonesAll, floor?.id],
  );

  useEffect(() => {
    setDraft([]);
    setHover(null);
    setCalibA(null);
  }, [tool, floor?.id]);

  const finishDraft = (pts: [number, number][]) => {
    if (pts.length < 3 || !floor) return;
    setDraft([]);
    setHover(null);
    setPendingZone(newZone(floor.id, pts));
  };

  // Enter closes the outline, Backspace removes the last corner (capture phase, before editor shortcuts)
  useEffect(() => {
    if (tool !== 'zone') return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, .modal')) return;
      if (e.key === 'Enter' && draft.length >= 3) {
        e.preventDefault();
        e.stopImmediatePropagation();
        finishDraft(draft);
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && draft.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setDraft(draft.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tool, draft]);

  const markers = useMemo(
    () => (floor ? Object.values(markersAll).filter((m) => m.floorId === floor.id) : []),
    [markersAll, floor?.id],
  );
  const selSet = useMemo(() => new Set(selection), [selection]);
  const sheet = floor ? { width: floor.widthPx, height: floor.heightPx } : null;

  /* ---------- view application (no React re-render per frame) ---------- */
  const apply = () => {
    const v = viewRef.current;
    if (!v) return;
    if (sheetRef.current) {
      sheetRef.current.style.transform = `translate3d(${v.tx}px, ${v.ty}px, 0) scale(${v.scale})`;
      // one screen pixel in sheet units, so SVG strokes keep a constant on-screen width
      sheetRef.current.style.setProperty('--px', String(1 / v.scale));
    }
    const l = layerRef.current;
    if (l) {
      l.style.setProperty('--tx', String(v.tx));
      l.style.setProperty('--ty', String(v.ty));
      l.style.setProperty('--s', String(v.scale));
    }
    planCtl.emit((v.scale / fitRef.current) * 100);
  };
  const setView = (v: View) => {
    viewRef.current = v;
    apply();
  };
  const vpSize = () => {
    const r = vpRef.current!.getBoundingClientRect();
    return { width: r.width, height: r.height };
  };
  const saveView = () => {
    const s = getState();
    if (floor && viewRef.current) setState({ views: { ...s.views, [floor.id]: viewRef.current } });
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = vpRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const animateTo = (target: View) => {
    if (anim.current) cancelAnimationFrame(anim.current);
    const from = viewRef.current!;
    if (reducedMotion()) {
      setView(target);
      saveView();
      return;
    }
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 320);
      const e = 1 - Math.pow(1 - k, 3);
      // interpolate in log-scale for a natural zoom
      const scale = Math.exp(Math.log(from.scale) + (Math.log(target.scale) - Math.log(from.scale)) * e);
      setView({ scale, tx: from.tx + (target.tx - from.tx) * e, ty: from.ty + (target.ty - from.ty) * e });
      if (k < 1) anim.current = requestAnimationFrame(step);
      else {
        anim.current = null;
        setView(target);
        saveView();
      }
    };
    anim.current = requestAnimationFrame(step);
  };

  /* ---------- floor change / resize: restore per-floor view (R-32) ---------- */
  useEffect(() => {
    if (!sheet || !vpRef.current) return;
    setLoaded(false);
    const vp = vpSize();
    fitRef.current = fitScale(sheet, vp);
    viewRef.current = getState().views[floor!.id] ?? fitView(sheet, vp);
    apply();
    const ro = new ResizeObserver(() => {
      const nvp = vpSize();
      if (!nvp.width || !nvp.height) return;
      const oldFit = fitRef.current;
      fitRef.current = fitScale(sheet, nvp);
      const v = viewRef.current!;
      if (Math.abs(v.scale - oldFit) < 1e-9 || !getState().views[floor!.id])
        viewRef.current = fitView(sheet, nvp);
      apply();
    });
    ro.observe(vpRef.current);
    return () => {
      saveView();
      ro.disconnect();
    };
  }, [floor?.id, floor?.widthPx, floor?.heightPx]);

  /* ---------- controller for toolbar / keyboard / schedule ---------- */
  useEffect(() => {
    planCtl.zoomBy = (f) => {
      if (!viewRef.current || !vpRef.current) return;
      const vp = vpSize();
      animateTo(zoomAt(viewRef.current, f, vp.width / 2, vp.height / 2, fitRef.current));
    };
    planCtl.fit = () => sheet && vpRef.current && animateTo(fitView(sheet, vpSize()));
    planCtl.centerOn = (id) => {
      const st = getState();
      const z = st.zones[id];
      const m = st.markers[id] ?? (z ? { x: centroid(z.points)[0], y: centroid(z.points)[1] } : null);
      if (!m || !sheet || !viewRef.current) return;
      const scale = clamp(
        Math.max(viewRef.current.scale, fitRef.current * 2.5),
        fitRef.current * MIN_ZOOM,
        fitRef.current * MAX_ZOOM,
      );
      animateTo(centerOn(sheet, vpSize(), m.x, m.y, scale));
    };
    planCtl.pxToFraction = () => {
      const v = viewRef.current;
      if (!v || !sheet) return { fx: 0.001, fy: 0.001 };
      return { fx: 1 / (v.scale * sheet.width), fy: 1 / (v.scale * sheet.height) };
    };
    planCtl.getView = () => viewRef.current;
  }, [floor?.id, sheet?.width, sheet?.height]);

  useEffect(() => {
    const st = getState();
    if (focus && (st.markers[focus.id] ?? st.zones[focus.id])?.floorId === floor?.id) {
      // wait a frame so a just-switched floor has its view
      requestAnimationFrame(() => planCtl.centerOn(focus.id));
    }
  }, [focus?.n, floor?.id]);

  /* ---------- wheel / trackpad zoom toward cursor ---------- */
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!viewRef.current) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const k = e.ctrlKey ? 0.01 : 0.0018; // ctrlKey = trackpad pinch
      const p = local(e);
      setView(zoomAt(viewRef.current, Math.exp(-e.deltaY * unit * k), p.x, p.y, fitRef.current));
      clearTimeout((onWheel as any).t);
      (onWheel as any).t = setTimeout(saveView, 200);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [floor?.id]);

  /* ---------- pointer gestures ---------- */
  const onPointerDown = (e: React.PointerEvent) => {
    if (!sheet || !viewRef.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    if (anim.current) cancelAnimationFrame(anim.current);
    try {
      vpRef.current!.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      // abandon a drag in progress (restore positions)
      const g = gesture.current;
      if (g?.kind === 'drag') setPositionsLocal(new Map(g.before.map((m) => [m.id, { x: m.x, y: m.y }])));
      gesture.current = {
        kind: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        v0: viewRef.current,
      };
      setMarquee(null);
      return;
    }
    if (pointers.current.size > 2) return;
    const mEl = (e.target as HTMLElement).closest<HTMLElement>('[data-marker]');
    const vEl = (e.target as HTMLElement).closest<HTMLElement>('[data-vertex]');
    if (e.button === 1) {
      gesture.current = { kind: 'pan', id: e.pointerId, lx: p.x, ly: p.y };
      return;
    }
    const cEl = (e.target as HTMLElement).closest<HTMLElement>('[data-cov]');
    const st = getState();
    if (cEl && st.selection.length === 1 && st.markers[st.selection[0]] && st.canEdit) {
      gesture.current = {
        kind: 'coverage',
        id: e.pointerId,
        before: st.markers[st.selection[0]],
        handle: cEl.dataset.cov as CoverageHandle,
        grab: screenToFraction(viewRef.current!, sheet!, p.x, p.y),
      };
      return;
    }
    gesture.current = {
      kind: 'pending',
      id: e.pointerId,
      sx: p.x,
      sy: p.y,
      markerId: getState().tool || getState().zoneEdit ? null : (mEl?.dataset.marker ?? null),
      vertex:
        vEl && getState().zoneEdit ? { zoneId: vEl.dataset.zone!, index: Number(vEl.dataset.vertex) } : null,
      shift: e.shiftKey,
      alt: e.altKey,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!sheet) return;
    if (!pointers.current.has(e.pointerId)) {
      // hover: rubber band for the zone outline / calibration line
      if ((tool === 'zone' && draft.length) || (tool === 'calibrate' && calibA)) setHover(local(e));
      return;
    }
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const panned = { ...g.v0, tx: g.v0.tx + (m.x - g.m0.x), ty: g.v0.ty + (m.y - g.m0.y) };
      setView(zoomAt(panned, d / g.d0, m.x, m.y, fitRef.current));
      return;
    }
    if (g.id !== e.pointerId) return;
    if (g.kind === 'pending') {
      if (Math.hypot(p.x - g.sx, p.y - g.sy) < DRAG_THRESHOLD) return;
      const s = getState();
      if (g.vertex && s.canEdit) {
        const z = s.zones[g.vertex.zoneId];
        if (z) {
          gesture.current = { kind: 'vertex', id: g.id, zone: z, index: g.vertex.index };
          return;
        }
      }
      if (s.tool === 'zone' && s.canEdit && !g.markerId) {
        gesture.current = { kind: 'zoneRect', id: g.id, sx: g.sx, sy: g.sy, x: p.x, y: p.y };
        setDraft([]);
      } else if (g.markerId && s.canEdit) {
        let ids = s.selection.includes(g.markerId) ? s.selection : [g.markerId];
        if (!s.selection.includes(g.markerId)) setState({ selection: ids });
        ids = ids.filter((id) => s.markers[id]?.floorId === floor!.id);
        let before = ids.map((id) => s.markers[id]);
        let isCopy = false;
        if (g.alt) {
          // R-38: Alt-drag duplicates in place; the copies are what moves
          const copies = duplicateMarkers(before, floor!.id, 0);
          const next = { ...s.markers };
          for (const c of copies) next[c.id] = c;
          setState({ markers: next, selection: copies.map((c) => c.id) });
          before = copies;
          isCopy = true;
        }
        gesture.current = {
          kind: 'drag',
          id: g.id,
          sx: g.sx,
          sy: g.sy,
          before,
          start: new Map(before.map((m) => [m.id, { x: m.x, y: m.y }])),
          isCopy,
        };
      } else if (s.tool) {
        gesture.current = { kind: 'pan', id: g.id, lx: g.sx, ly: g.sy };
      } else if (!g.markerId && (g.shift || getState().boxMode) && !getState().armed) {
        gesture.current = {
          kind: 'marquee',
          id: g.id,
          sx: g.sx,
          sy: g.sy,
          x: p.x,
          y: p.y,
          additive: g.shift,
        };
      } else {
        gesture.current = { kind: 'pan', id: g.id, lx: g.sx, ly: g.sy };
      }
    }
    const cur = gesture.current!;
    if (cur.kind === 'pan') {
      const v = viewRef.current!;
      setView({ ...v, tx: v.tx + (p.x - cur.lx), ty: v.ty + (p.y - cur.ly) });
      cur.lx = p.x;
      cur.ly = p.y;
    } else if (cur.kind === 'drag') {
      const v = viewRef.current!;
      const dx = (p.x - cur.sx) / (v.scale * sheet.width);
      const dy = (p.y - cur.sy) / (v.scale * sheet.height);
      const pos = new Map<string, { x: number; y: number }>();
      for (const [id, st] of cur.start) pos.set(id, { x: clamp(st.x + dx, 0, 1), y: clamp(st.y + dy, 0, 1) });
      setPositionsLocal(pos);
    } else if (cur.kind === 'coverage') {
      dragCoverage(
        cur.before,
        cur.handle,
        screenToFraction(viewRef.current!, sheet, p.x, p.y),
        floor!,
        cur.grab,
      );
    } else if (cur.kind === 'vertex') {
      const f = screenToFraction(viewRef.current!, sheet, p.x, p.y);
      const pts = cur.zone.points.map((q, i) =>
        i === cur.index ? ([clamp(f.x, 0, 1), clamp(f.y, 0, 1)] as [number, number]) : q,
      );
      setState({ zones: { ...getState().zones, [cur.zone.id]: { ...cur.zone, points: pts } } });
    } else if (cur.kind === 'marquee' || cur.kind === 'zoneRect') {
      cur.x = p.x;
      cur.y = p.y;
      setMarquee({
        x: Math.min(cur.sx, p.x),
        y: Math.min(cur.sy, p.y),
        w: Math.abs(p.x - cur.sx),
        h: Math.abs(p.y - cur.sy),
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g || !sheet) return;
    if (g.kind === 'pinch') {
      if (pointers.current.size === 0) {
        gesture.current = null;
        saveView();
      } else {
        // continue panning with the remaining finger
        const [id, p] = [...pointers.current.entries()][0];
        gesture.current = { kind: 'pan', id, lx: p.x, ly: p.y };
      }
      return;
    }
    if (g.id !== e.pointerId) return;
    gesture.current = null;
    const s = getState();
    if (e.type === 'pointercancel') {
      if (g.kind === 'drag') setPositionsLocal(new Map(g.before.map((m) => [m.id, { x: m.x, y: m.y }])));
      if (g.kind === 'vertex') setState({ zones: { ...getState().zones, [g.zone.id]: g.zone } });
      if (g.kind === 'coverage') setState({ markers: { ...getState().markers, [g.before.id]: g.before } });
      setMarquee(null);
      return;
    }
    if (g.kind === 'pending') {
      // a tap / click
      const f = screenToFraction(viewRef.current!, sheet, g.sx, g.sy);
      if (s.tool && s.canEdit) {
        if (!inSheet(f)) return;
        if (s.tool === 'zone') {
          const v = viewRef.current!;
          const near = (q: [number, number]) =>
            Math.hypot((q[0] - f.x) * sheet.width * v.scale, (q[1] - f.y) * sheet.height * v.scale) < 12;
          if (draft.length >= 3 && (near(draft[0]) || near(draft[draft.length - 1]))) finishDraft(draft);
          else setDraft([...draft, [f.x, f.y]]);
        } else if (s.tool === 'riser') {
          patchFloor(floor!.id, { riserX: Math.round(f.x * 1e5) / 1e5, riserY: Math.round(f.y * 1e5) / 1e5 });
          setState({ tool: null });
          toast.success(`Riser set on ${floor!.name}`);
        } else if (s.tool === 'calibrate') {
          if (!calibA) setCalibA(f);
          else {
            setCalib({ a: calibA, b: f });
            setCalibA(null);
            setHover(null);
          }
        }
        return;
      }
      if (g.markerId) {
        const id = g.markerId;
        if (g.shift)
          setState({
            selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id],
          });
        else setState({ selection: [id], selectedZone: null });
        return;
      }
      if (s.armed && s.canEdit) {
        const f = screenToFraction(viewRef.current!, sheet, g.sx, g.sy);
        if (inSheet(f)) placeMarker(s.armed, f.x, f.y); // clicks outside the sheet place nothing
        return;
      }
      if (s.zoneEdit) {
        // Zone Edit mode: select the zone under the click, if any
        const z = inSheet(f) ? zoneAt(zones, floor!.id, f.x, f.y) : null;
        setState({ selection: [], selectedZone: z?.id ?? null });
      } else if (!g.shift) setState({ selection: [] });
    } else if (g.kind === 'coverage') {
      commitMarkerEdit(g.before, 'Coverage of');
    } else if (g.kind === 'vertex') {
      const z = getState().zones[g.zone.id];
      if (z) saveZone(z);
    } else if (g.kind === 'zoneRect') {
      setMarquee(null);
      const v = viewRef.current!;
      const a = screenToFraction(v, sheet, g.sx, g.sy);
      const b = screenToFraction(v, sheet, g.x, g.y);
      if (Math.abs(g.x - g.sx) > 8 && Math.abs(g.y - g.sy) > 8)
        finishDraft(rectPolygon(clamp(a.x, 0, 1), clamp(a.y, 0, 1), clamp(b.x, 0, 1), clamp(b.y, 0, 1)));
    } else if (g.kind === 'drag') {
      if (g.isCopy) createMarkers(g.before.map((b) => getState().markers[b.id]).filter(Boolean), 'Duplicate');
      else commitMove(g.before);
    } else if (g.kind === 'marquee') {
      setMarquee(null);
      const v = viewRef.current!;
      const a = screenToFraction(v, sheet, Math.min(g.sx, g.x), Math.min(g.sy, g.y));
      const b = screenToFraction(v, sheet, Math.max(g.sx, g.x), Math.max(g.sy, g.y));
      const hit = markers
        .filter((m) => m.x >= a.x && m.x <= b.x && m.y >= a.y && m.y <= b.y)
        .map((m) => m.id);
      setState({ selection: g.additive ? [...new Set([...s.selection, ...hit])] : hit });
    } else if (g.kind === 'pan') {
      saveView();
    }
  };

  const hoverFrac = (h: { x: number; y: number }): [number, number] => {
    const f = screenToFraction(viewRef.current!, sheet!, h.x, h.y);
    return [clamp(f.x, 0, 1), clamp(f.y, 0, 1)];
  };

  if (!floor) return <UploadDropZone />;

  const armedType = armed ? typeOf(armed) : null;
  const nextTag = armedType ? `${armedType.code}${nextNum(markersAll, armed!)}` : '';
  void types;

  return (
    <>
      <div
        className={`plan ${armed || tool ? 'is-placing' : ''} ${boxMode ? 'is-box' : ''} ${zoneEdit ? 'is-zone-edit' : ''}`}
        ref={vpRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        role="application"
        aria-label={`Plan of ${floor.name}. ${markers.length} devices.`}
        aria-roledescription="plan canvas"
      >
        <div className="sheet" ref={sheetRef} style={{ width: floor.widthPx, height: floor.heightPx }}>
          <img
            src={floor.previewUrl}
            alt=""
            draggable={false}
            width={floor.widthPx}
            height={floor.heightPx}
            onLoad={() => setLoaded(true)}
            decoding="async"
          />
          <svg
            className="zones"
            viewBox={`0 0 ${floor.widthPx} ${floor.heightPx}`}
            width={floor.widthPx}
            height={floor.heightPx}
            aria-hidden="true"
          >
            {zones.map((z) => (
              <polygon
                key={z.id}
                className={`zone zone-${z.kind} ${z.id === selectedZone ? 'selected' : ''}`}
                points={z.points.map(([x, y]) => `${x * floor.widthPx},${y * floor.heightPx}`).join(' ')}
              />
            ))}
            <CoverageShapes floor={floor} />
            <WirePaths floor={floor} />
            {draft.length > 0 && (
              <polyline
                className="zone-draft"
                points={[...draft, ...(hover && viewRef.current ? [hoverFrac(hover)] : [])]
                  .map(([x, y]) => `${x * floor.widthPx},${y * floor.heightPx}`)
                  .join(' ')}
              />
            )}
            {calibA && (
              <line
                className="calib-line"
                x1={calibA.x * floor.widthPx}
                y1={calibA.y * floor.heightPx}
                x2={(hover ? hoverFrac(hover)[0] : calibA.x) * floor.widthPx}
                y2={(hover ? hoverFrac(hover)[1] : calibA.y) * floor.heightPx}
              />
            )}
          </svg>
        </div>
        {!loaded && <div className="plan-loading">Loading sheet…</div>}
        <div className="marker-layer" ref={layerRef} style={{ '--ms': markerScale } as React.CSSProperties}>
          {zones.map((z) => {
            const [cx, cy] = centroid(z.points);
            return (
              <div
                key={z.id}
                className={`zone-label ${z.kind === 'closet' ? 'closet' : ''} ${z.id === selectedZone ? 'selected' : ''}`}
                style={{ '--x': cx * floor.widthPx, '--y': cy * floor.heightPx } as React.CSSProperties}
              >
                {z.kind === 'closet' && <span className="eq-badge">EQ</span>}
                {z.name}
              </div>
            );
          })}
          {floor.riserX != null && floor.riserY != null && (
            <div
              className="riser-pin"
              title="Riser: where cables go between floors"
              style={
                {
                  '--x': floor.riserX * floor.widthPx,
                  '--y': floor.riserY * floor.heightPx,
                } as React.CSSProperties
              }
            >
              R
            </div>
          )}
          {[...draft, ...(calibA ? [[calibA.x, calibA.y] as [number, number]] : [])].map(([x, y], i) => (
            <div
              key={`d${i}`}
              className={`draft-pt ${i === 0 && draft.length >= 3 ? 'closable' : ''}`}
              style={{ '--x': x * floor.widthPx, '--y': y * floor.heightPx } as React.CSSProperties}
            />
          ))}
          {canEdit &&
            zoneEdit &&
            !tool &&
            selectedZone &&
            zonesAll[selectedZone]?.floorId === floor.id &&
            zonesAll[selectedZone].points.map(([x, y], i) => (
              <div
                key={`v${i}`}
                className="vertex"
                data-vertex={i}
                data-zone={selectedZone}
                title="Drag to reshape"
                style={{ '--x': x * floor.widthPx, '--y': y * floor.heightPx } as React.CSSProperties}
              />
            ))}
          <CoverageHandles floor={floor} />
          {markers.map((m) => (
            <MarkerPin
              key={m.id}
              m={m}
              tag={tagOf(m)}
              color={colorOf(m.typeId)}
              icon={typeOf(m.typeId)?.iconUrl ?? null}
              showLabel={m.iconLabel ?? typeOf(m.typeId)?.iconLabel ?? true}
              w={floor.widthPx}
              h={floor.heightPx}
              selected={selSet.has(m.id)}
            />
          ))}
        </div>
        {marquee && (
          <div
            className="marquee"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
        {tool && canEdit && (
          <div className="place-hint" role="status" onPointerDown={(e) => e.stopPropagation()}>
            <span>
              {tool === 'zone'
                ? draft.length >= 3
                  ? 'Click the first corner (or press Enter) to finish'
                  : draft.length
                    ? 'Click the next corner · Backspace undoes a corner'
                    : 'Click corners to outline a zone, or drag a rectangle'
                : tool === 'riser'
                  ? `Click where cables pass between floors on ${floor.name}`
                  : calibA
                    ? 'Click the second point'
                    : 'Click the first point of a known distance'}
            </span>
            <button className="btn btn-sm" onClick={() => setState({ tool: null })}>
              Cancel
            </button>
          </div>
        )}
        {zoneEdit && !tool && canEdit && (
          <div className="place-hint zone-edit-hint" role="status" onPointerDown={(e) => e.stopPropagation()}>
            <span>
              <strong>Zone Edit</strong> ·{' '}
              {selectedZone ? 'Drag the corner handles to reshape' : 'Click a zone to edit it'}
            </span>
            <button
              className="btn btn-sm"
              onClick={() => setState({ tool: 'zone', selectedZone: null, selection: [] })}
            >
              + New zone
            </button>
            <button className="btn btn-sm btn-primary" onClick={() => setZoneEdit(false)}>
              Done
            </button>
          </div>
        )}
        {armedType && canEdit && (
          <div className="place-hint" role="status" onPointerDown={(e) => e.stopPropagation()}>
            <span>
              Placing <strong>{armedType.name}</strong> · next <span className="mono">{nextTag}</span>
            </span>
            <button className="btn btn-sm btn-primary" onClick={() => setState({ armed: null })}>
              Done
            </button>
          </div>
        )}
      </div>
      {pendingZone && <ZoneDialog zone={pendingZone} isNew onClose={() => setPendingZone(null)} />}
      {calib && (
        <CalibrateDialog
          floor={floor}
          a={calib.a}
          b={calib.b}
          onClose={() => {
            setCalib(null);
            setState({ tool: null });
          }}
        />
      )}
    </>
  );
}

function nextNum(all: Record<string, Marker>, typeId: string) {
  let max = 0;
  for (const m of Object.values(all)) if (m.typeId === typeId && m.number > max) max = m.number;
  return max + 1;
}

/** R-33: constant screen size; position comes from CSS variables set on the layer. */
const MarkerPin = memo(function MarkerPin({
  m,
  tag,
  color,
  icon,
  showLabel,
  w,
  h,
  selected,
}: {
  m: Marker;
  tag: string;
  color: string;
  icon: string | null;
  showLabel: boolean;
  w: number;
  h: number;
  selected: boolean;
}) {
  if (icon)
    return (
      <div
        className={`marker has-icon ${selected ? 'selected' : ''}`}
        data-marker={m.id}
        style={{ '--x': m.x * w, '--y': m.y * h, '--c': color } as React.CSSProperties}
        title={`${tag}${m.room ? ` · ${m.room}` : ''}`}
        aria-label={tag}
      >
        <img src={icon} alt="" draggable={false} />
        {showLabel && (
          <span className="marker-label" style={{ background: color }}>
            {tag}
          </span>
        )}
      </div>
    );
  return (
    <div
      className={`marker ${selected ? 'selected' : ''}`}
      data-marker={m.id}
      style={{ '--x': m.x * w, '--y': m.y * h, background: color } as React.CSSProperties}
      title={`${tag}${m.room ? ` · ${m.room}` : ''}`}
    >
      {tag}
    </div>
  );
});
