import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import {
  whiteTextContrast,
  type Category,
  type DeviceType,
  type Library,
  type Role,
  type User,
} from '@sixpoint/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppHeader } from '../components/AppHeader';
import { Confirm, Modal } from '../components/ui';
import { toast } from '../toast';

type Tab = 'users' | 'library' | 'tokens';

export function AdminPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('users');
  if (!can('admin')) return <Navigate to="/" replace />;
  return (
    <>
      <AppHeader />
      <main className="page">
        <div className="page-head">
          <div>
            <div className="eyebrow">Admin</div>
            <h1>Administration</h1>
          </div>
        </div>
        <div className="segmented tabs" role="tablist">
          {(
            [
              ['users', 'Users'],
              ['library', 'Device library'],
              ['tokens', 'API tokens'],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              aria-pressed={tab === k}
              onClick={() => setTab(k)}
            >
              {l}
            </button>
          ))}
        </div>
        {tab === 'users' && <UsersAdmin />}
        {tab === 'library' && <LibraryAdmin />}
        {tab === 'tokens' && <TokensAdmin />}
      </main>
    </>
  );
}

/* ---------------- users (R-11) ---------------- */

function UsersAdmin() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const load = () => api.get<User[]>('/api/users').then(setUsers, (e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  const patch = async (u: User, body: object, msg: string) => {
    try {
      await api.patch(`/api/users/${u.id}`, body);
      toast.success(msg);
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>Users</h2>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + Add user
        </button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'inactive'}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <select
                    aria-label={`Role for ${u.name}`}
                    value={u.role}
                    disabled={u.id === me?.id}
                    onChange={(e) => patch(u, { role: e.target.value }, `${u.name} is now ${e.target.value}`)}
                  >
                    <option value="admin">Admin</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </td>
                <td>{u.active ? 'Active' : 'Deactivated'}</td>
                <td className="row-actions">
                  <button className="btn btn-sm" onClick={() => setResetting(u)}>
                    Reset password
                  </button>
                  {u.id !== me?.id && (
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        patch(
                          u,
                          { active: !u.active },
                          u.active ? `${u.name} deactivated` : `${u.name} reactivated`,
                        )
                      }
                    >
                      {u.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && <AddUser onClose={() => setAdding(false)} onDone={load} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
    </section>
  );
}

function AddUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'editor' as Role, password: '' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/users', f);
      toast.success(`Added ${f.name}`);
      onDone();
      onClose();
    } catch (err: any) {
      toast.error(err.message);
    }
  };
  return (
    <Modal title="Add user" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        <label className="field span-2">
          <span>Name</span>
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="field span-2">
          <span>Email</span>
          <input
            type="email"
            required
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            <option value="admin">Admin</option>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        </label>
        <label className="field">
          <span>Temporary password</span>
          <input
            required
            minLength={8}
            value={f.password}
            onChange={(e) => setF({ ...f, password: e.target.value })}
          />
        </label>
        <p className="muted small span-2">
          Share the temporary password with them; they can change it under Account settings.
        </p>
        <div className="form-actions span-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary">Add user</button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onClose }: { user: User; onClose: () => void }) {
  const [pw, setPw] = useState('');
  return (
    <Modal title={`Reset password for ${user.name}`} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.patch(`/api/users/${user.id}`, { password: pw });
            toast.success('Password reset. Their sessions were signed out.');
            onClose();
          } catch (err: any) {
            toast.error(err.message);
          }
        }}
      >
        <label className="field span-2">
          <span>New temporary password</span>
          <input required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        <div className="form-actions span-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary">Reset password</button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------- device library (R-24..R-27) ---------------- */

function ContrastNote({ color }: { color: string }) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
  const r = whiteTextContrast(color);
  return r < 4.5 ? (
    <span className="warn small" role="status">
      White labels are {r.toFixed(1)}:1 on this color. 4.5:1 is the minimum; pick a darker shade.
    </span>
  ) : (
    <span className="muted small">Contrast {r.toFixed(1)}:1 ✓</span>
  );
}

function LibraryAdmin() {
  const [lib, setLib] = useState<Library | null>(null);
  const [editType, setEditType] = useState<DeviceType | 'new' | null>(null);
  const [editCat, setEditCat] = useState<Category | 'new' | null>(null);
  const [delType, setDelType] = useState<DeviceType | null>(null);
  const load = () => api.get<Library>('/api/device-library').then(setLib, (e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!lib) return <p className="muted">Loading…</p>;

  const moveCat = async (i: number, d: number) => {
    const ids = lib.categories.map((c) => c.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.post('/api/device-library/categories/reorder', { ids });
    load();
  };
  const moveType = async (cat: Category, i: number, d: number) => {
    const ids = lib.types.filter((t) => t.categoryId === cat.id).map((t) => t.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.post('/api/device-library/types/reorder', { ids });
    load();
  };
  const retire = async (t: DeviceType, retired: boolean) => {
    try {
      await api.patch(`/api/device-library/types/${t.id}`, { retired });
      toast.success(retired ? `${t.code} retired` : `${t.code} restored to the palette`);
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Device library</h2>
        <div className="row-actions">
          <button className="btn" onClick={() => setEditCat('new')}>
            + Category
          </button>
          <button className="btn btn-primary" onClick={() => setEditType('new')}>
            + Device type
          </button>
        </div>
      </div>
      <p className="muted small">
        Retired types leave the palette but still show and export on existing markers. Only unused types can
        be deleted.
      </p>
      {lib.categories.map((c, ci) => {
        const types = lib.types.filter((t) => t.categoryId === c.id);
        return (
          <div key={c.id} className="lib-cat">
            <div className="lib-cat-head">
              <span className="swatch" style={{ background: c.color }} />
              <h3>{c.name}</h3>
              <span className="mono muted small">{c.color}</span>
              <div className="grow" />
              <button
                className="icon-btn"
                aria-label={`Move ${c.name} up`}
                onClick={() => moveCat(ci, -1)}
                disabled={ci === 0}
              >
                ↑
              </button>
              <button
                className="icon-btn"
                aria-label={`Move ${c.name} down`}
                onClick={() => moveCat(ci, 1)}
                disabled={ci === lib.categories.length - 1}
              >
                ↓
              </button>
              <button className="btn btn-sm" onClick={() => setEditCat(c)}>
                Edit
              </button>
            </div>
            <ul className="lib-types">
              {types.map((t, ti) => (
                <li key={t.id} className={t.retiredAt ? 'retired' : ''}>
                  <span className="tag" style={{ background: c.color }}>
                    {t.code}
                  </span>
                  <span className="lib-type-name">
                    {t.name}
                    {t.defaultModel && <span className="muted small"> · {t.defaultModel}</span>}
                    {t.wires.length > 0 && (
                      <span className="muted small wire-list">
                        {' '}
                        ·{' '}
                        {t.wires
                          .map(
                            (w) =>
                              `${w.count}× ${lib.wireTypes.find((x) => x.id === w.wireTypeId)?.name ?? '?'}`,
                          )
                          .join(', ')}
                      </span>
                    )}
                    {t.retiredAt && <span className="pill">Retired</span>}
                  </span>
                  <span className="muted small mono">{t.inUse} in use</span>
                  <div className="row-actions">
                    <button
                      className="icon-btn"
                      aria-label={`Move ${t.code} up`}
                      onClick={() => moveType(c, ti, -1)}
                      disabled={ti === 0}
                    >
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`Move ${t.code} down`}
                      onClick={() => moveType(c, ti, 1)}
                      disabled={ti === types.length - 1}
                    >
                      ↓
                    </button>
                    <button className="btn btn-sm" onClick={() => setEditType(t)}>
                      Edit
                    </button>
                    {t.retiredAt ? (
                      <button className="btn btn-sm" onClick={() => retire(t, false)}>
                        Unretire
                      </button>
                    ) : (
                      <button className="btn btn-sm" onClick={() => retire(t, true)}>
                        Retire
                      </button>
                    )}
                    {t.inUse === 0 && (
                      <button className="btn btn-sm btn-danger-ghost" onClick={() => setDelType(t)}>
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              ))}
              {!types.length && <li className="muted small">No types in this category.</li>}
            </ul>
          </div>
        );
      })}
      <WireTypesAdmin lib={lib} onChange={load} />
      {editType && (
        <TypeDialog
          lib={lib}
          type={editType === 'new' ? null : editType}
          onClose={() => setEditType(null)}
          onDone={load}
        />
      )}
      {editCat && (
        <CategoryDialog
          cat={editCat === 'new' ? null : editCat}
          onClose={() => setEditCat(null)}
          onDone={load}
        />
      )}
      {delType && (
        <Confirm
          title={`Delete ${delType.code}`}
          danger
          confirmLabel="Delete type"
          message={`Delete ${delType.code} ${delType.name}? No markers use it.`}
          onClose={() => setDelType(null)}
          onConfirm={async () => {
            try {
              await api.del(`/api/device-library/types/${delType.id}`);
              load();
            } catch (e: any) {
              toast.error(e.message);
            }
          }}
        />
      )}
    </section>
  );
}

function CategoryDialog({
  cat,
  onClose,
  onDone,
}: {
  cat: Category | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(cat?.name ?? '');
  const [color, setColor] = useState(cat?.color ?? '#6b7280');
  return (
    <Modal title={cat ? `Edit ${cat.name}` : 'New category'} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (cat) await api.patch(`/api/device-library/categories/${cat.id}`, { name, color });
            else await api.post('/api/device-library/categories', { name, color });
            onDone();
            onClose();
          } catch (err: any) {
            toast.error(err.message);
          }
        }}
      >
        <label className="field span-2">
          <span>Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <label className="field">
          <span>Color</span>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label className="field">
          <span>Hex</span>
          <input
            value={color}
            onChange={(e) => setColor(e.target.value)}
            pattern="#[0-9a-fA-F]{6}"
            className="mono"
          />
        </label>
        <div className="span-2 contrast-preview">
          <span className="tag" style={{ background: color }}>
            SPK12
          </span>
          <ContrastNote color={color} />
        </div>
        <div className="form-actions span-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function TypeDialog({
  lib,
  type,
  onClose,
  onDone,
}: {
  lib: Library;
  type: DeviceType | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [f, setF] = useState({
    categoryId: type?.categoryId ?? lib.categories[0]?.id ?? '',
    code: type?.code ?? '',
    name: type?.name ?? '',
    defaultModel: type?.defaultModel ?? '',
    defaultNotes: type?.defaultNotes ?? '',
  });
  const [wires, setWires] = useState(type?.wires ?? []);
  const codeOk = /^[A-Z]{1,6}$/.test(f.code);
  const dup = lib.types.find((t) => t.code === f.code && t.id !== type?.id);
  return (
    <Modal title={type ? `Edit ${type.code}` : 'New device type'} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const clean = wires.filter((w) => w.wireTypeId && w.count > 0);
            if (type) await api.patch(`/api/device-library/types/${type.id}`, { ...f, wires: clean });
            else {
              const t = await api.post<DeviceType>('/api/device-library/types', f);
              if (clean.length) await api.patch(`/api/device-library/types/${t.id}`, { wires: clean });
            }
            onDone();
            onClose();
          } catch (err: any) {
            toast.error(err.message);
          }
        }}
      >
        <label className="field">
          <span>Code</span>
          <input
            required
            className="mono"
            value={f.code}
            maxLength={6}
            onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })}
            aria-invalid={!codeOk || !!dup}
          />
          {dup ? (
            <span className="warn small">{f.code} is already used</span>
          ) : (
            <span className="muted small">1–6 uppercase letters</span>
          )}
        </label>
        <label className="field">
          <span>Category</span>
          <select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            {lib.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field span-2">
          <span>Name</span>
          <input
            required
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            maxLength={80}
          />
        </label>
        <label className="field span-2">
          <span>Default model / part number</span>
          <input value={f.defaultModel} onChange={(e) => setF({ ...f, defaultModel: e.target.value })} />
        </label>
        <label className="field span-2">
          <span>Default notes</span>
          <textarea
            rows={2}
            value={f.defaultNotes}
            onChange={(e) => setF({ ...f, defaultNotes: e.target.value })}
          />
          <span className="muted small">Both are copied into a new marker's notes when it's placed.</span>
        </label>
        <fieldset className="span-2 wires-edit">
          <legend>Wires to the equipment closet</legend>
          {wires.map((w, i) => (
            <div key={i} className="wire-row">
              <select
                aria-label="Wire type"
                value={w.wireTypeId}
                onChange={(e) =>
                  setWires(wires.map((x, j) => (j === i ? { ...x, wireTypeId: e.target.value } : x)))
                }
              >
                {lib.wireTypes.map((wt) => (
                  <option key={wt.id} value={wt.id}>
                    {wt.name}
                  </option>
                ))}
              </select>
              <input
                aria-label="Count"
                type="number"
                min={1}
                max={20}
                value={w.count}
                onChange={(e) =>
                  setWires(
                    wires.map((x, j) =>
                      j === i ? { ...x, count: Math.max(1, Number(e.target.value) || 1) } : x,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove wire"
                onClick={() => setWires(wires.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-sm"
            disabled={!lib.wireTypes.length}
            onClick={() => setWires([...wires, { wireTypeId: lib.wireTypes[0].id, count: 1 }])}
          >
            + Add wire
          </button>
        </fieldset>
        <div className="form-actions span-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!codeOk || !!dup}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------- API tokens ---------------- */

interface Token {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
  token?: string;
}

function TokensAdmin() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<Token | null>(null);
  const load = () => api.get<Token[]>('/api/tokens').then(setTokens, (e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  return (
    <section className="card">
      <div className="card-head">
        <h2>API tokens</h2>
      </div>
      <p className="muted small">
        Read-only tokens for scripts. Send <code>Authorization: Bearer &lt;token&gt;</code>. API reference:{' '}
        <a href="/api/docs">/api/docs</a>.
      </p>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setCreated(await api.post<Token>('/api/tokens', { name }));
            setName('');
            load();
          } catch (err: any) {
            toast.error(err.message);
          }
        }}
      >
        <label className="field grow">
          <span>Token name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Claude marker reader"
          />
        </label>
        <button className="btn btn-primary">Create token</button>
      </form>
      {created?.token && (
        <div className="callout" role="status">
          <strong>Copy this token now. It won't be shown again.</strong>
          <code className="token">{created.token}</code>
          <button className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(created.token!)}>
            Copy
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Created</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} className={t.revokedAt ? 'inactive' : ''}>
                <td>{t.name}</td>
                <td>{new Date(t.createdAt).toLocaleString()}</td>
                <td>{t.revokedAt ? 'Revoked' : 'Active'}</td>
                <td className="row-actions">
                  {!t.revokedAt && (
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        await api.del(`/api/tokens/${t.id}`);
                        load();
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WireTypesAdmin({ lib, onChange }: { lib: Library; onChange: () => void }) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  return (
    <div className="lib-cat">
      <div className="lib-cat-head">
        <h3>Wire types</h3>
        <span className="muted small">Assigned to device types above; used for cable-run totals.</span>
      </div>
      <ul className="lib-types">
        {lib.wireTypes.map((w) => (
          <li key={w.id}>
            {editing?.id === w.id ? (
              <form
                className="inline-form tight"
                onSubmit={(e) => {
                  e.preventDefault();
                  act(() => api.patch(`/api/device-library/wire-types/${w.id}`, { name: editing.name })).then(
                    () => setEditing(null),
                  );
                }}
              >
                <input
                  aria-label="Wire type name"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
                <button className="btn btn-sm btn-primary">Save</button>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span className="lib-type-name">{w.name}</span>
                <span className="muted small mono">
                  {w.inUse} type{w.inUse === 1 ? '' : 's'}
                </span>
                <div className="row-actions">
                  <button className="btn btn-sm" onClick={() => setEditing({ id: w.id, name: w.name })}>
                    Rename
                  </button>
                  <button
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() =>
                      (w.inUse === 0 ||
                        confirm(`${w.name} is assigned to ${w.inUse} device type(s). Delete it anyway?`)) &&
                      act(() => api.del(`/api/device-library/wire-types/${w.id}`))
                    }
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          act(() => api.post('/api/device-library/wire-types', { name })).then(() => setName(''));
        }}
      >
        <label className="field grow">
          <span>New wire type</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. HDMI, Cat6A, 18/2"
          />
        </label>
        <button className="btn">Add wire type</button>
      </form>
    </div>
  );
}
