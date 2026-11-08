import { AUDIO_FORMAT_LABEL, formatFeet } from '@sixpoint/shared';
import { Modal } from '../components/ui';
import { setState, tagOf, useEditor } from './store';
import { useClosets, useSummary } from './zones';

/** Project summary: audio zones by format, cable by wire type, and what's missing for run lengths. */
export function SummaryDialog({ onClose }: { onClose: () => void }) {
  const summary = useSummary();
  const floors = useEditor((s) => s.floors);
  const markers = useEditor((s) => s.markers);
  const extra = useEditor((s) => s.project?.extraWireFt ?? 0);
  const closets = useClosets();
  const floorName = (id: string) => floors.find((f) => f.id === id)?.name ?? '';

  const missing = new Map<string, string[]>();
  for (const [id, r] of summary.runs) {
    if (r.lengthFt !== null || !markers[id]) continue;
    const list = missing.get(r.reason ?? 'Unknown') ?? [];
    list.push(id);
    missing.set(r.reason ?? 'Unknown', list);
  }
  const goto = (id: string) => {
    const m = markers[id];
    if (!m) return;
    setState({ selection: [id], floorId: m.floorId, selectedZone: null, focus: { id, n: Date.now() } });
    onClose();
  };

  return (
    <Modal title="Project summary" onClose={onClose} wide>
      <section className="summary-section">
        <h3>Audio zones</h3>
        {summary.audioZones.length === 0 ? (
          <p className="muted small">
            No zones contain audio devices yet. Draw zones around rooms with speakers, then pick a format.
          </p>
        ) : (
          <div className="audio-groups">
            {summary.audioZones.map((g) => (
              <div key={g.format ?? 'none'} className="audio-group">
                <div className="audio-group-head">
                  <span className={`pill pill-strong ${g.format ? '' : 'pill-warn'}`}>
                    {g.format ? AUDIO_FORMAT_LABEL[g.format] : 'Format not set'}
                  </span>
                  <span className="muted small">
                    {g.zones.length} zone{g.zones.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ul>
                  {g.zones.map((z) => (
                    <li key={z.id}>
                      <button
                        className="link-btn"
                        onClick={() => (
                          setState({ selectedZone: z.id, selection: [], floorId: z.floorId }),
                          onClose()
                        )}
                      >
                        {z.name}
                      </button>{' '}
                      <span className="muted small">
                        {floorName(z.floorId)} · {z.devices} audio device{z.devices === 1 ? '' : 's'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="summary-section">
        <h3>Cable by wire type</h3>
        <p className="muted small">
          Approximate right-angle runs to{' '}
          {closets.length ? `the equipment closet${closets.length > 1 ? 's' : ''}` : 'an equipment closet'},
          through risers between floors, plus {extra} ft extra per run (Project settings).
        </p>
        {summary.wires.length === 0 ? (
          <p className="muted small">No wired devices yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Wire</th>
                  <th className="num">Runs</th>
                  <th className="num">Total</th>
                  <th className="num">Not computed</th>
                </tr>
              </thead>
              <tbody>
                {summary.wires.map((w) => (
                  <tr key={w.wireTypeId}>
                    <td>{w.name}</td>
                    <td className="num mono">{w.runs}</td>
                    <td className="num mono">
                      <strong>{formatFeet(w.totalFt)}</strong>
                    </td>
                    <td className={`num mono ${w.unresolved ? 'warn' : 'muted'}`}>{w.unresolved || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {missing.size > 0 && (
        <section className="summary-section">
          <h3>Runs that can't be measured yet</h3>
          {[...missing].map(([reason, ids]) => (
            <div key={reason} className="missing">
              <strong className="warn">{reason}</strong>{' '}
              <span className="muted small">
                ({ids.length} device{ids.length === 1 ? '' : 's'})
              </span>
              <div className="zone-devices">
                {ids.slice(0, 30).map((id) => (
                  <button key={id} className="tag tag-sm tag-btn tag-neutral" onClick={() => goto(id)}>
                    {tagOf(markers[id])}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </Modal>
  );
}
