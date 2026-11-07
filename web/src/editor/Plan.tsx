import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  centerOn,
  clamp,
  fitScale,
  fitView,
  inSheet,
  MAX_ZOOM,
  MIN_ZOOM,
  screenToFraction,
  zoomAt,
  type Marker,
  type View,
} from '@sixpoint/shared';
import { commitMove, createMarkers, duplicateMarkers, placeMarker, setPositionsLocal } from './ops';
import { planCtl } from './planCtl';
import { colorOf, getState, setState, tagOf, typeOf, useEditor } from './store';
import { UploadDropZone } from './Uploads';

const DRAG_THRESHOLD = 5;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

type Gesture =
  | {
      kind: 'pending';
      id: number;
      sx: number;
      sy: number;
      markerId: string | null;
      shift: boolean;
      alt: boolean;
    }
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
    if (sheetRef.current)
      sheetRef.current.style.transform = `translate3d(${v.tx}px, ${v.ty}px, 0) scale(${v.scale})`;
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
      const m = getState().markers[id];
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
    if (focus && getState().markers[focus.id]?.floorId === floor?.id) {
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
    if (e.button === 1) {
      gesture.current = { kind: 'pan', id: e.pointerId, lx: p.x, ly: p.y };
      return;
    }
    gesture.current = {
      kind: 'pending',
      id: e.pointerId,
      sx: p.x,
      sy: p.y,
      markerId: mEl?.dataset.marker ?? null,
      shift: e.shiftKey,
      alt: e.altKey,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !sheet) return;
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
      if (g.markerId && s.canEdit) {
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
    } else if (cur.kind === 'marquee') {
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
      return;
    }
    if (g.kind === 'pending') {
      // a tap / click
      if (g.markerId) {
        const id = g.markerId;
        if (g.shift)
          setState({
            selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id],
          });
        else setState({ selection: [id] });
        return;
      }
      if (s.armed && s.canEdit) {
        const f = screenToFraction(viewRef.current!, sheet, g.sx, g.sy);
        if (inSheet(f)) placeMarker(s.armed, f.x, f.y); // clicks outside the sheet place nothing
        return;
      }
      if (!g.shift) setState({ selection: [] });
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

  if (!floor) return <UploadDropZone />;

  const armedType = armed ? typeOf(armed) : null;
  const nextTag = armedType ? `${armedType.code}${nextNum(markersAll, armed!)}` : '';
  void types;

  return (
    <div
      className={`plan ${armed ? 'is-placing' : ''} ${boxMode ? 'is-box' : ''}`}
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
      </div>
      {!loaded && <div className="plan-loading">Loading sheet…</div>}
      <div className="marker-layer" ref={layerRef}>
        {markers.map((m) => (
          <MarkerPin
            key={m.id}
            m={m}
            tag={tagOf(m)}
            color={colorOf(m.typeId)}
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
  w,
  h,
  selected,
}: {
  m: Marker;
  tag: string;
  color: string;
  w: number;
  h: number;
  selected: boolean;
}) {
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
