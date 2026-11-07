import { useState, type FormEvent } from 'react';
import type { User } from '@sixpoint/shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AppHeader } from '../components/AppHeader';
import { toast } from '../toast';

/** R-12: own name and password. */
export function AccountPage() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.patch<{ user: User }>('/api/me', { name });
      setUser(r.user);
      toast.success('Name saved');
    } catch (e: any) {
      toast.error(e.message);
    }
  };
  const savePw = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (pw !== pw2) return setErr('New passwords do not match');
    if (pw.length < 8) return setErr('Use at least 8 characters');
    try {
      await api.patch('/api/me', { currentPassword: cur, newPassword: pw });
      setCur('');
      setPw('');
      setPw2('');
      toast.success('Password changed. Other sessions were signed out.');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <>
      <AppHeader />
      <main className="page narrow">
        <div className="eyebrow">Account</div>
        <h1>Your account</h1>
        <form className="card form-card" onSubmit={saveName}>
          <h2>Profile</h2>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </label>
          <label className="field">
            <span>Email</span>
            <input value={user?.email ?? ''} disabled />
          </label>
          <p className="muted small">Role: {user?.role}. Theme is in the account menu.</p>
          <button className="btn btn-primary">Save name</button>
        </form>
        <form className="card form-card" onSubmit={savePw}>
          <h2>Change password</h2>
          <label className="field">
            <span>Current password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={cur}
              onChange={(e) => setCur(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              required
              minLength={8}
            />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              required
            />
          </label>
          {err && (
            <p className="form-error" role="alert">
              {err}
            </p>
          )}
          <button className="btn btn-primary">Change password</button>
        </form>
      </main>
    </>
  );
}
