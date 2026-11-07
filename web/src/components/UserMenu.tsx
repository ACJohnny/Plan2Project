import { useNavigate } from 'react-router-dom';
import type { Theme, User } from '@sixpoint/shared';
import { api } from '../api';
import { applyTheme, useAuth } from '../auth';
import { toast } from '../toast';
import { Avatar, Menu, MenuItem } from './ui';

export function UserMenu() {
  const { user, logout, setUser, can } = useAuth();
  const nav = useNavigate();
  if (!user) return null;
  const setTheme = async (theme: Theme) => {
    applyTheme(theme);
    try {
      const r = await api.patch<{ user: User }>('/api/me', { theme });
      setUser(r.user);
    } catch (e: any) {
      toast.error(`Couldn't save theme: ${e.message}`);
    }
  };
  return (
    <Menu label={`Account menu for ${user.name}`} icon={<Avatar name={user.name} />}>
      <div className="menu-head">
        <strong>{user.name}</strong>
        <span className="muted">
          {user.email} · {user.role}
        </span>
      </div>
      <MenuItem onClick={() => nav('/account')}>Account settings</MenuItem>
      {can('admin') && <MenuItem onClick={() => nav('/admin')}>Admin</MenuItem>}
      <div className="menu-sep" role="separator" />
      <div className="menu-label">Theme</div>
      {(['light', 'dark', 'system'] as Theme[]).map((t) => (
        <MenuItem key={t} onClick={() => setTheme(t)}>
          <span className="check" aria-hidden="true">
            {user.theme === t ? '✓' : ''}
          </span>
          {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
        </MenuItem>
      ))}
      <div className="menu-sep" role="separator" />
      <MenuItem
        onClick={async () => {
          await logout();
          nav('/login');
        }}
      >
        Sign out
      </MenuItem>
    </Menu>
  );
}
