import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth';
import { Logo, Spectrum } from './ui';
import { UserMenu } from './UserMenu';

export function AppHeader({ children }: { children?: ReactNode }) {
  const { can } = useAuth();
  return (
    <header className="app-header">
      <div className="app-header-row">
        <Link to="/" className="brand" aria-label="Six Point Markup — projects">
          <Logo size={30} />
          <span className="brand-text">
            <span className="eyebrow">Six Point</span>
            <span className="brand-name">Markup</span>
          </span>
        </Link>
        <nav className="app-nav" aria-label="Main">
          <NavLink to="/" end>
            Projects
          </NavLink>
          {can('admin') && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="grow" />
        {children}
        <UserMenu />
      </div>
      <Spectrum />
    </header>
  );
}
