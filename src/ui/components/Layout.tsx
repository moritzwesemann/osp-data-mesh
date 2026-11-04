import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { RouteId } from '../../shared/contract/index.ts';
import { type MessageKey, useI18n } from '../i18n/index.tsx';
import { useSession, useSignOut } from '../lib/session.tsx';
import { cx } from '../lib/util.ts';
import { Loading } from './QueryState.tsx';

interface NavItem {
  to: string;
  label: MessageKey;
  /** sichtbar, wenn mindestens eine dieser Routen erlaubt ist (leer = immer) */
  routes: readonly RouteId[];
  end?: boolean;
}

interface NavGroup {
  label: MessageKey | null;
  items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [
  { label: null, items: [{ to: '/', label: 'nav.overview', routes: [], end: true }] },
  {
    label: 'nav.groupData',
    items: [
      { to: '/athleten', label: 'nav.athletes', routes: ['athletes.list'] },
      { to: '/quellen', label: 'nav.connectors', routes: ['connectors.list'] },
      { to: '/datensaetze', label: 'nav.datasets', routes: ['datasets.list'] },
      { to: '/produkte', label: 'nav.products', routes: ['products.list'] },
      { to: '/freigaben', label: 'nav.releases', routes: ['releases.list'] },
    ],
  },
  {
    label: 'nav.groupUse',
    items: [
      { to: '/meine-daten', label: 'nav.myData', routes: ['access.list'] },
      { to: '/katalog', label: 'nav.catalog', routes: ['catalog.local'] },
      { to: '/empfangen', label: 'nav.received', routes: ['received.list'] },
    ],
  },
  {
    label: 'nav.groupNetwork',
    items: [{ to: '/partner', label: 'nav.partners', routes: ['peers.list'] }],
  },
  {
    label: 'nav.groupAdmin',
    items: [
      { to: '/audit', label: 'nav.audit', routes: ['audit.list', 'exchange.log'] },
      { to: '/benutzer', label: 'nav.users', routes: ['users.list'] },
      { to: '/system', label: 'nav.system', routes: ['system.status'] },
    ],
  },
];

/** Rahmen: Kopfzeile (Knoten, Person, Abmelden), Navigation (Seitenleiste bzw. Klappmenü), Inhalt. */
export function AppShell() {
  const { t } = useI18n();
  const session = useSession();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [lastPath, setLastPath] = useState(location.pathname);

  // Menü nach Navigation schließen
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setOpen(false);
  }

  // Escape schließt das aufgeklappte Menü und setzt den Fokus zurück auf die Menütaste
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      menuButton.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((item) => item.routes.length === 0 || session.canAny(item.routes)),
  })).filter((g) => g.items.length > 0);

  const onSignOut = async () => {
    setBusy(true);
    await signOut();
    navigate('/anmelden', { replace: true });
  };

  return (
    <div className={cx('app', open && 'nav-open')}>
      <a className="skip-link" href="#main">
        {t('shell.skipToContent')}
      </a>
      <header className="topbar">
        {/* Gleichbleibende Beschriftung (Zustand über aria-expanded), damit die Kopfzeile auf schmalen
            Bildschirmen nicht breiter wird; das Symbol wechselt zu × */}
        <button
          ref={menuButton}
          type="button"
          className="menu-button"
          aria-expanded={open}
          aria-controls="app-nav"
          onClick={() => setOpen((o) => !o)}
        >
          <span className="menu-icon" aria-hidden="true" />
          <span>{t('shell.menu')}</span>
        </button>
        <Link to="/" className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span className="brand-name">{t('common.appName')}</span>
        </Link>
        <span className="topbar-node">
          <span className="sr-only">{t('shell.node')}: </span>
          {session.node.displayName}
        </span>
        <div className="topbar-user">
          <Link to="/konto" className="topbar-user-name">
            <span className="sr-only">{t('shell.user')} </span>
            {session.user.displayName}
          </Link>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onSignOut} disabled={busy}>
            {busy ? t('shell.signingOut') : t('shell.signOut')}
          </button>
        </div>
      </header>
      <nav id="app-nav" className="sidenav" aria-label={t('nav.mainNav')}>
        {groups.map((g) => (
          <div className="nav-group" key={g.label ?? 'root'}>
            {g.label && <p className="nav-group-label">{t(g.label)}</p>}
            <ul>
              {g.items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className="nav-link">
                    {t(item.label)}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="nav-group nav-footer">
          <ul>
            <li>
              <NavLink to="/konto" className="nav-link">
                {t('nav.account')}
              </NavLink>
            </li>
            <li>
              <a href="/hilfe/" className="nav-link" target="_blank" rel="noopener">
                {t('shell.help')}
              </a>
            </li>
          </ul>
          <p className="nav-node-id mono">{session.node.nodeId}</p>
        </div>
      </nav>
      <main id="main" className="main" tabIndex={-1}>
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
