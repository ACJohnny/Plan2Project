import { useEditor, setState } from './store';

/** Device palette (R-28, R-60, R-61, R-65). Hidden for viewers (R-13). */
export function Palette() {
  const categories = useEditor((s) => s.categories);
  const types = useEditor((s) => s.types);
  const armed = useEditor((s) => s.armed);
  const boxMode = useEditor((s) => s.boxMode);
  const hasFloor = useEditor((s) => !!s.floorId);
  const tool = useEditor((s) => s.tool);

  const arm = (id: string) => setState({ armed: armed === id ? null : id, boxMode: false, tool: null });

  return (
    <aside className="palette" aria-label="Device palette">
      <div className="palette-tools" role="group" aria-label="Tools">
        <button
          className="tool-btn"
          aria-pressed={!armed && !boxMode && !tool}
          onClick={() => setState({ armed: null, boxMode: false, tool: null })}
          title="Select (Esc)"
        >
          <span aria-hidden="true">↖</span> Select
        </button>
        <button
          className="tool-btn"
          aria-pressed={boxMode}
          onClick={() => setState({ armed: null, boxMode: !boxMode, tool: null })}
          title="Box select (or Shift-drag)"
        >
          <span aria-hidden="true">⬚</span> Box
        </button>
      </div>
      <section className="palette-cat palette-zones" aria-label="Zones and cabling">
        <h3 className="eyebrow">Zones</h3>
        <div className="palette-list">
          <button
            className="palette-btn"
            aria-pressed={tool === 'zone'}
            disabled={!hasFloor}
            onClick={() =>
              setState({ tool: tool === 'zone' ? null : 'zone', armed: null, boxMode: false, selection: [] })
            }
            title="Outline a room or equipment closet"
          >
            <span className="tag tag-zone">ZONE</span>
            <span className="palette-name">Draw zone</span>
          </button>
          <button
            className="palette-btn"
            aria-pressed={tool === 'riser'}
            disabled={!hasFloor}
            onClick={() => setState({ tool: tool === 'riser' ? null : 'riser', armed: null, boxMode: false })}
            title="Mark where cables pass between floors"
          >
            <span className="tag tag-riser">R</span>
            <span className="palette-name">Set riser</span>
          </button>
          <button
            className="palette-btn"
            aria-pressed={tool === 'calibrate'}
            disabled={!hasFloor}
            onClick={() =>
              setState({ tool: tool === 'calibrate' ? null : 'calibrate', armed: null, boxMode: false })
            }
            title="Click two points of a known distance to set the scale"
          >
            <span className="tag tag-riser">↔</span>
            <span className="palette-name">Calibrate scale</span>
          </button>
        </div>
      </section>
      {categories.map((c) => {
        const list = types.filter((t) => t.categoryId === c.id && !t.retiredAt);
        if (!list.length) return null;
        return (
          <section key={c.id} className="palette-cat">
            <h3 className="eyebrow">{c.name}</h3>
            <div className="palette-list">
              {list.map((t) => (
                <button
                  key={t.id}
                  className="palette-btn"
                  aria-pressed={armed === t.id}
                  disabled={!hasFloor}
                  onClick={() => arm(t.id)}
                  title={`${t.name} (${t.code})`}
                  aria-label={`${t.name}, code ${t.code}`}
                >
                  <span className="tag" style={{ background: c.color }}>
                    {t.code}
                  </span>
                  <span className="palette-name">{t.name}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </aside>
  );
}
