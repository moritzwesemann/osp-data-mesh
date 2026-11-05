import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { RouteId } from '../../shared/contract/index.ts';
import { type MessageKey, useI18n } from '../i18n/index.tsx';
import { useSession, useSignOut } from '../lib/session.tsx';
import { cx } from '../lib/util.ts';
import { Icon, type IconName, initials } from './Icon.tsx';
import { Loading } from './QueryState.tsx';

interface NavItem {
  to: string;
  label: MessageKey;
  icon: IconName;
  /** sichtbar, wenn mindestens eine dieser Routen erlaubt ist (leer = immer) */
  routes: readonly RouteId[];
  end?: boolean;
}

interface NavGroup {
  label: MessageKey | null;
  items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [
  { label: null, items: [{ to: '/', label: 'nav.overview', icon: 'home', routes: [], end: true }] },
  {
    label: 'nav.groupUse',
    items: [
      { to: '/meine-daten', label: 'nav.myData', icon: 'inbox', routes: ['access.list'] },
      { to: '/katalog', label: 'nav.catalog', icon: 'search', routes: ['catalog.local'] },
    ],
  },
  {
    label: 'nav.groupData',
    items: [
      { to: '/athleten', label: 'nav.athletes', icon: 'users', routes: ['athletes.list'] },
      { to: '/quellen', label: 'nav.connectors', icon: 'upload', routes: ['connectors.list'] },
      { to: '/datensaetze', label: 'nav.datasets', icon: 'database', routes: ['datasets.list'] },
      { to: '/produkte', label: 'nav.products', icon: 'box', routes: ['products.list'] },
      { to: '/freigaben', label: 'nav.releases', icon: 'shield', routes: ['releases.list'] },
    ],
  },
  {
    label: 'nav.groupAdmin',
    items: [
      { to: '/partner', label: 'nav.partners', icon: 'share', routes: ['peers.list'] },
      { to: '/audit', label: 'nav.audit', icon: 'list', routes: ['audit.list', 'exchange.log'] },
      { to: '/benutzer', label: 'nav.users', icon: 'idCard', routes: ['users.list'] },
      { to: '/system', label: 'nav.system', icon: 'pulse', routes: ['system.status'] },
    ],
  },
];

/** ab dieser Breite: Symbolleiste links statt Klappmenü */
const DESKTOP = '(min-width: 720px)';
/** ab dieser Breite schiebt die aufgeklappte Leiste den Inhalt zur Seite, darunter liegt sie darüber */
const WIDE = '(min-width: 1100px)';
const RAIL_KEY = 'osp.rail';

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/** Aufgeklappte Leiste (breite Bildschirme) als Vorliebe dieses Browsers; Speicher kann fehlen. */
function readRailPref(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === 'open';
  } catch {
    return false;
  }
}
function writeRailPref(open: boolean) {
  try {
    localStorage.setItem(RAIL_KEY, open ? 'open' : 'closed');
  } catch {
    // ohne Speicher gilt die Wahl nur bis zum Neuladen
  }
}

interface Tip {
  label: string;
  top: number;
}

/**
 * Rahmen: graue Fläche mit Symbolleiste links (Name beim Überfahren, Klick auf das Logo klappt sie auf),
 * Inhalt auf einem hellen Blatt. Auf schmalen Bildschirmen Kopfzeile mit Klappmenü.
 */
export function AppShell() {
  const { t } = useI18n();
  const session = useSession();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const location = useLocation();
  const desktop = useMediaQuery(DESKTOP);
  const wide = useMediaQuery(WIDE);
  const [navOpen, setNavOpen] = useState(false);
  const [railPref, setRailPref] = useState(readRailPref);
  const [railOverlay, setRailOverlay] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const railToggle = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [lastPath, setLastPath] = useState(location.pathname);

  const railOpen = desktop && (wide ? railPref : railOverlay);
  const overlay = railOpen && !wide;

  // Nach Navigation: Klappmenü und darüberliegende Leiste schließen
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setNavOpen(false);
    setRailOverlay(false);
    setTip(null);
  }

  // Escape schließt Klappmenü bzw. darüberliegende Leiste und setzt den Fokus auf die auslösende Taste
  useEffect(() => {
    if (!navOpen && !overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (navOpen) {
        setNavOpen(false);
        menuButton.current?.focus();
      } else {
        setRailOverlay(false);
        railToggle.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen, overlay]);

  const toggleRail = () => {
    setTip(null);
    if (wide) {
      setRailPref((open) => {
        writeRailPref(!open);
        return !open;
      });
    } else {
      setRailOverlay((open) => !open);
    }
  };

  /** Name des Eintrags neben der zugeklappten Leiste (Maus oder Tastaturfokus) */
  const showTip = (target: EventTarget, viaFocus: boolean) => {
    if (railOpen || !desktop || !(target instanceof Element)) return;
    const el = target.closest<HTMLElement>('[data-tip]');
    if (!el) {
      setTip(null);
      return;
    }
    if (viaFocus && !el.matches(':focus-visible')) return;
    const r = el.getBoundingClientRect();
    setTip({ label: el.dataset.tip ?? '', top: Math.round(r.top + r.height / 2) });
  };

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((item) => item.routes.length === 0 || session.canAny(item.routes)),
  })).filter((g) => g.items.length > 0);

  const onSignOut = async () => {
    setBusy(true);
    await signOut();
    navigate('/anmelden', { replace: true });
  };

  const toggleLabel = railOpen ? t('shell.collapseNav') : t('shell.expandNav');

  return (
    <div className={cx('app', navOpen && 'nav-open', railOpen && 'rail-open')}>
      <a className="skip-link" href="#main">
        {t('shell.skipToContent')}
      </a>
      <header className="mobilebar">
        {/* Gleichbleibende Beschriftung (Zustand über aria-expanded); das Symbol wechselt zu × */}
        <button
          ref={menuButton}
          type="button"
          className="menu-button"
          aria-expanded={navOpen}
          aria-controls="app-nav"
          onClick={() => setNavOpen((o) => !o)}
        >
          <span className="menu-icon" aria-hidden="true" />
          <span>{t('shell.menu')}</span>
        </button>
        <Link to="/" className="brand">
          <img src="/icon.svg" alt="" width={26} height={26} />
          <span className="brand-name">{session.node.displayName}</span>
        </Link>
      </header>

      <nav
        id="app-nav"
        className="rail"
        aria-label={t('nav.mainNav')}
        onMouseOver={(e) => showTip(e.target, false)}
        onMouseLeave={() => setTip(null)}
        onFocus={(e) => showTip(e.target, true)}
        onBlur={() => setTip(null)}
        onScroll={() => setTip(null)}
      >
        <button
          ref={railToggle}
          type="button"
          className="rail-item rail-toggle"
          aria-expanded={railOpen}
          aria-label={toggleLabel}
          data-tip={toggleLabel}
          onClick={toggleRail}
        >
          <img className="rail-logo" src="/icon.svg" alt="" width={28} height={28} />
          <span className="rail-label rail-brand">
            <strong>{session.node.displayName}</strong>
            <small>{t('common.appName')}</small>
          </span>
        </button>
        {groups.map((g) => (
          <div className="rail-group" key={g.label ?? 'start'}>
            {g.label && (
              <p className="rail-group-label">
                <span className="rail-label">{t(g.label)}</span>
              </p>
            )}
            <ul>
              {g.items.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.end} className="rail-item" data-tip={t(item.label)}>
                    <Icon name={item.icon} />
                    <span className="rail-label">{t(item.label)}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <ul className="rail-foot">
          <li>
            <a href="/hilfe/" className="rail-item" target="_blank" rel="noopener" data-tip={t('shell.help')}>
              <Icon name="help" />
              <span className="rail-label">{t('shell.help')}</span>
            </a>
          </li>
          <li>
            <NavLink to="/konto" className="rail-item" data-tip={t('nav.account')}>
              <span className="rail-avatar" aria-hidden="true">
                {initials(session.user.displayName)}
              </span>
              <span className="rail-label rail-two-line">
                {t('nav.account')}
                <small>{session.user.displayName}</small>
              </span>
            </NavLink>
          </li>
          <li>
            <button
              type="button"
              className="rail-item"
              onClick={onSignOut}
              disabled={busy}
              data-tip={t('shell.signOut')}
            >
              <Icon name="signOut" />
              <span className="rail-label">{busy ? t('shell.signingOut') : t('shell.signOut')}</span>
            </button>
          </li>
        </ul>
      </nav>

      {overlay && (
        <button
          type="button"
          className="rail-scrim"
          tabIndex={-1}
          aria-label={t('shell.collapseNav')}
          onClick={() => setRailOverlay(false)}
        />
      )}
      {tip && <div className="rail-tip" aria-hidden="true" data-label={tip.label} style={{ top: tip.top }} />}

      <main id="main" className="sheet" tabIndex={-1}>
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
