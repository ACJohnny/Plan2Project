import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Role, Theme, User } from '@sixpoint/shared';
import { api, ApiError } from './api';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: User) => void;
  can: (min: Role) => boolean;
}

const Ctx = createContext<AuthState>(null as any);
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** R-64: Light / Dark / System, saved per user. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('spm-theme', theme);
  } catch {
    /* storage blocked */
  }
}

try {
  const t = localStorage.getItem('spm-theme') as Theme | null;
  if (t) applyTheme(t);
} catch {
  /* storage blocked */
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const setUser = useCallback((u: User | null) => {
    setUserState(u);
    if (u) applyTheme(u.theme);
  }, []);

  useEffect(() => {
    api
      .get<{ user: User }>('/api/me')
      .then((r) => setUser(r.user))
      .catch((e) => {
        if (!(e instanceof ApiError) || e.status !== 401) console.warn(e);
        setUser(null);
      })
      .finally(() => setLoading(false));
    const onUnauth = () => setUserState(null);
    window.addEventListener('spm:unauthorized', onUnauth);
    return () => window.removeEventListener('spm:unauthorized', onUnauth);
  }, [setUser]);

  const value: AuthState = {
    user,
    loading,
    login: async (email, password) => {
      const r = await api.post<{ user: User }>('/api/auth/login', { email, password });
      setUser(r.user);
    },
    logout: async () => {
      await api.post('/api/auth/logout').catch(() => undefined);
      setUserState(null);
    },
    setUser,
    can: (min) => !!user && RANK[user.role] >= RANK[min],
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
