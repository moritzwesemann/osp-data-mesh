import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { RouteId } from '../../shared/contract/index.ts';
import { FingerprintBox } from '../components/federation/FingerprintBox.tsx';
import { Icon, type IconName, initials } from '../components/Icon.tsx';
import { DescriptionList, Details } from '../components/Misc.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { QueryView, Skeleton } from '../components/QueryState.tsx';
import { type MessageKey, useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import {
  confirmedGone,
  forgetVisits,
  RECENT_SOURCE,
  type RecentEntry,
  type RecentListState,
  readRecent,
} from '../lib/recent.ts';
import { useSession } from '../lib/session.tsx';
import { cx } from '../lib/util.ts';

/** Höchstzahl der Kacheln unter „Zuletzt geöffnet“ und „Für Sie freigegeben“ */
const TILES_SHOWN = 4;

function greetingKey(): MessageKey {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return 'overview.greetMorning';
  if (h >= 11 && h < 18) return 'overview.greetDay';
  return 'overview.greetEvening';
}

/**
 * / – Startseite: Gruß und Suche, offene Aufgaben wie ein Posteingang, zuletzt Geöffnetes und für mich
 * freigegebene Daten als Kacheln; Kennzahlen und Knotenangaben (aufklappbar) in einer schmalen Spalte
 * rechts bzw. auf schmalen Bildschirmen darunter.
 */
export function Overview() {
  const { t } = useI18n();
  const s = useSession();
  const roles = s.roles.map((r) => t(`roles.${r}`)).join(', ');

  return (
    <div className="page home">
      <PageHeader
        title={t(greetingKey(), { name: s.user.displayName })}
        docTitle={t('overview.title')}
        description={`${s.node.displayName} · ${roles}`}
        actions={s.can('catalog.local') ? <HomeSearch /> : undefined}
      />
      <div className="home-grid">
        <div className="home-main">
          <Todos />
          <Recent />
          {s.can('access.list') && <MyDataSummary />}
        </div>
        <div className="home-side">
          <AtAGlance />
          <Details summary={t('overview.thisNode')}>
            <DescriptionList
              items={[
                [t('common.name'), s.node.displayName],
                [
                  t('overview.nodeId'),
                  <span key="id" className="mono">
                    {s.node.nodeId}
                  </span>,
                ],
              ]}
            />
            <div className="stack-sm">
              <span className="field-label">{t('common.fingerprint')}</span>
              <FingerprintBox value={s.node.fingerprint} />
            </div>
          </Details>
        </div>
      </div>
    </div>
  );
}

/** Suche im Katalog (eigene Datenprodukte und Angebote der Partner) */
function HomeSearch() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  return (
    <search className="home-search">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const term = q.trim();
          navigate(term ? `/katalog?q=${encodeURIComponent(term)}` : '/katalog');
        }}
      >
        <Icon name="search" size={17} />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('overview.searchPlaceholder')}
          aria-label={t('overview.searchLabel')}
          enterKeyHint="search"
        />
      </form>
    </search>
  );
}

function HomeSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="home-section" aria-labelledby={id}>
      <div className="home-section-head">
        <h2 id={id}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

type Tone = 'teal' | 'violet' | 'blue' | 'amber' | 'rose';

function Tile({
  to,
  icon,
  tone,
  title,
  sub,
}: {
  to: string;
  icon: IconName | { initials: string };
  tone: Tone;
  title: string;
  sub: string;
}) {
  return (
    <li>
      <Link to={to} className="tile">
        <span className={cx('tile-icon', `tone-${tone}`)} aria-hidden="true">
          {typeof icon === 'string' ? <Icon name={icon} size={17} /> : icon.initials}
        </span>
        <span className="tile-text">
          <span className="tile-title">{title}</span>
          {sub && <span className="tile-sub">{sub}</span>}
        </span>
      </Link>
    </li>
  );
}

interface Todo {
  key: string;
  title: string;
  detail?: string;
  /** kurzer Hinweis neben dem Titel, z. B. „2 Fehler“ */
  tag?: string;
  to: string;
  action: string;
  tone: 'warning' | 'danger';
}

/** Offene Aufgaben aus Importen, Partnern und Systemstatus, wie ein Posteingang. */
function Todos() {
  const { t, fmt } = useI18n();
  const s = useSession();
  const connectors = useApiQuery('connectors.list', {}, { enabled: s.can('connectors.list') });
  const peers = useApiQuery('peers.list', {}, { enabled: s.can('peers.list') });
  const system = useApiQuery('system.status', {}, { enabled: s.can('system.status') });
  const sources = [
    s.can('connectors.list') && connectors,
    s.can('peers.list') && peers,
    s.can('system.status') && system,
  ].filter((q) => q !== false);
  if (sources.length === 0) return null;

  const review = t('overview.actionReview');
  const view = t('overview.actionView');
  const todos: Todo[] = [];
  for (const c of connectors.data?.items ?? []) {
    const run = c.lastRun;
    if (run?.status !== 'previewed') continue;
    todos.push({
      key: `run-${run.id}`,
      title: t('overview.todoImportTitle', { name: c.name }),
      detail:
        run.totalRows > 0
          ? t('overview.todoImportRows', { valid: run.validRows, total: run.totalRows })
          : undefined,
      tag: run.errorRows > 0 ? t('overview.todoImportErrors', { count: run.errorRows }) : undefined,
      to: `/importe/${run.id}`,
      action: review,
      tone: 'warning',
    });
  }
  for (const p of peers.data?.items ?? []) {
    if (p.status !== 'pending') continue;
    todos.push({
      key: `peer-${p.id}`,
      title: t('overview.todoPeerTitle', { name: p.displayName }),
      detail: t('overview.todoPeerDetail'),
      to: '/partner',
      action: view,
      tone: 'warning',
    });
  }
  const st = system.data;
  if (st) {
    const sys = (key: string, title: string, tone: Todo['tone'], detail?: string, to = '/system') =>
      todos.push({ key, title, detail, to, action: view, tone });
    if (!st.db.ok) sys('db', t('overview.dbFailed'), 'danger');
    if (!st.audit.ok) sys('audit', t('overview.auditBroken'), 'danger');
    const last = st.backups.last;
    if (!last) {
      sys('backup', t('overview.noBackup'), 'warning');
    } else if (last.status === 'failed') {
      sys('backup', t('overview.backupFailed'), 'danger');
    } else if (
      st.backups.intervalHours > 0 &&
      Date.now() - Date.parse(last.startedAt) > 2 * st.backups.intervalHours * 3_600_000
    ) {
      sys(
        'backup',
        t('overview.backupOldTitle'),
        'warning',
        t('overview.backupOldDetail', { time: fmt.dateTime(last.startedAt) }),
      );
    }
    if (st.outbox.failed > 0) {
      sys('outbox', t('overview.todoOutbox', { count: st.outbox.failed }), 'warning', undefined, '/partner');
    }
    if (st.errors24h > 0) sys('errors', t('overview.todoErrors', { count: st.errors24h }), 'warning');
  }

  const loaded = sources.every((q) => q.isSuccess);
  if (todos.length === 0 && !loaded) return null;
  return (
    <HomeSection
      title={t('overview.todoTitle')}
      aside={
        todos.length > 0 && (
          <span className="home-aside">{t('overview.openCount', { count: todos.length })}</span>
        )
      }
    >
      {todos.length === 0 ? (
        <p className="inbox-empty">
          <Icon name="check" size={18} />
          {t('overview.todoNone')}
        </p>
      ) : (
        <ul className="inbox">
          {todos.map((x) => (
            <li key={x.key} className="inbox-row">
              <span className={cx('inbox-ring', x.tone === 'danger' && 'is-danger')} aria-hidden="true" />
              <span className="inbox-text">
                <span className="inbox-title">{x.title}</span>
                {x.detail && <span className="inbox-detail">{x.detail}</span>}
              </span>
              {x.tag && <span className="inbox-tag">{x.tag}</span>}
              <Link to={x.to} className="btn btn-sm btn-primary">
                {x.action}
                <span className="sr-only">: {x.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </HomeSection>
  );
}

/**
 * Zuletzt geöffnet: Kennungen aus dem Browser, Bezeichnungen aus den Listen mit den Rechten der Person.
 * Nur die ersten Einträge werden geladen; was es nicht mehr gibt, wird aus der Liste entfernt.
 */
function Recent() {
  const { t } = useI18n();
  const s = useSession();
  const [since] = useState(() => Date.now());
  const [entries] = useState(() =>
    readRecent(s.node.nodeId, s.user.id)
      .filter((e) => s.can(RECENT_SOURCE[e.kind]))
      .slice(0, TILES_SHOWN),
  );
  const need = (kind: RecentEntry['kind']) => entries.some((e) => e.kind === kind);
  const athleteIds = entries.filter((e) => e.kind === 'athlete').map((e) => e.id);

  const athletes = useApiQuery(
    'athletes.list',
    { query: { ids: athleteIds.join(','), page: 1, pageSize: TILES_SHOWN } },
    { enabled: athleteIds.length > 0 },
  );
  const datasets = useApiQuery('datasets.list', {}, { enabled: need('dataset') });
  const products = useApiQuery('products.list', {}, { enabled: need('product') });
  const connectors = useApiQuery('connectors.list', {}, { enabled: need('connector') });
  const releases = useApiQuery('releases.list', { query: {} }, { enabled: need('release') });
  const received = useApiQuery('received.list', {}, { enabled: need('received') });
  const access = useApiQuery('access.list', {}, { enabled: need('myData') });

  const sources = {
    athlete: athletes,
    dataset: datasets,
    product: products,
    connector: connectors,
    release: releases,
    received,
    myData: access,
  } as const;
  const used = entries.map((e) => sources[e.kind]);
  const loaded = used.every((q) => q.isSuccess);
  const failed = used.some((q) => q.isError);

  const tile = (e: RecentEntry): ReactNode | null => {
    switch (e.kind) {
      case 'athlete': {
        const a = athletes.data?.items.find((x) => x.id === e.id);
        return (
          a && (
            <Tile
              key={`${e.kind}-${e.id}`}
              to={`/athleten/${a.id}`}
              icon={{ initials: initials(`${a.firstName} ${a.lastName}`) }}
              tone="violet"
              title={`${a.firstName} ${a.lastName}`}
              sub={`${a.sport} · ${t(`squad.${a.squadStatus}`)}`}
            />
          )
        );
      }
      case 'dataset': {
        const d = datasets.data?.items.find((x) => x.id === e.id);
        return (
          d && (
            <Tile
              key={`${e.kind}-${e.id}`}
              to={`/datensaetze/${d.id}`}
              icon="database"
              tone="teal"
              title={d.name}
              sub={t('common.entries', { count: d.recordCount })}
            />
          )
        );
      }
      case 'product': {
        const p = products.data?.items.find((x) => x.id === e.id);
        return (
          p && (
            <Tile
              key={`${e.kind}-${e.id}`}
              to={`/produkte/${p.id}`}
              icon="box"
              tone="blue"
              title={p.name}
              sub={t('overview.recentProduct')}
            />
          )
        );
      }
      case 'connector': {
        const c = connectors.data?.items.find((x) => x.id === e.id);
        return (
          c && (
            <Tile
              key={`${e.kind}-${e.id}`}
              to={`/quellen/${c.id}`}
              icon="upload"
              tone="amber"
              title={c.name}
              sub={t('overview.recentConnector')}
            />
          )
        );
      }
      case 'release': {
        const r = releases.data?.items.find((x) => x.id === e.id);
        if (!r) return null;
        const to =
          r.recipient.type === 'peer' ? r.recipient.peerName : t(`recipientRoles.${r.recipient.role}`);
        return (
          <Tile
            key={`${e.kind}-${e.id}`}
            to={`/freigaben/${r.id}`}
            icon="shield"
            tone="blue"
            title={r.productName}
            sub={t('overview.recentReleaseTo', { name: to })}
          />
        );
      }
      case 'received': {
        const r = received.data?.items.find((x) => x.id === e.id);
        return (
          r && (
            <Tile
              key={`${e.kind}-${e.id}`}
              to={`/empfangen/${r.id}`}
              icon="download"
              tone="rose"
              title={r.title}
              sub={t('overview.recentReceivedFrom', { name: r.peer.displayName })}
            />
          )
        );
      }
      case 'myData': {
        const g = access.data?.items.find((x) => x.releaseId === e.id);
        return (
          g && (
            <Tile
              key={`${e.kind}-${e.id}`}
              to={`/meine-daten/${g.releaseId}`}
              icon="inbox"
              tone="teal"
              title={g.product.name}
              sub={t('overview.recentMyData')}
            />
          )
        );
      }
    }
  };

  const resolved = loaded ? entries.map((e) => ({ e, node: tile(e) })) : [];
  // nicht mehr vorhandene Einträge vergessen (beim nächsten Besuch rücken andere nach) – nur, wenn eine nach
  // dem Öffnen der Startseite frisch geladene Liste das bestätigt, nie aufgrund zwischengespeicherter Daten
  const state = <T,>(
    q: { data?: T; isSuccess: boolean; isFetching: boolean; dataUpdatedAt: number },
    ids: (d: T) => string[],
  ): RecentListState | undefined =>
    q.isSuccess && q.data !== undefined
      ? { ids: new Set(ids(q.data)), fetchedAt: q.dataUpdatedAt, fetching: q.isFetching }
      : undefined;
  const byId = (d: { items: { id: string }[] }) => d.items.map((x) => x.id);
  const gone = loaded
    ? confirmedGone(
        entries,
        {
          athlete: state(athletes, byId),
          dataset: state(datasets, byId),
          product: state(products, byId),
          connector: state(connectors, byId),
          release: state(releases, byId),
          received: state(received, byId),
          myData: state(access, (d) => d.items.map((x) => x.releaseId)),
        },
        since,
      ).join(' ')
    : '';
  const nodeId = s.node.nodeId;
  const userId = s.user.id;
  useEffect(() => {
    if (gone) forgetVisits(nodeId, userId, gone.split(' '));
  }, [gone, nodeId, userId]);

  if (entries.length === 0 || failed) return null;
  const tiles = resolved.map((x) => x.node).filter(Boolean);
  if (loaded && tiles.length === 0) return null;
  return (
    <HomeSection title={t('overview.recentTitle')}>
      {loaded ? (
        <ul className="tiles">{tiles}</ul>
      ) : (
        <ul className="tiles" aria-busy="true">
          {entries.map((e) => (
            <li key={`${e.kind}-${e.id}`} className="tile tile-loading" />
          ))}
        </ul>
      )}
    </HomeSection>
  );
}

function MyDataSummary() {
  const { t } = useI18n();
  const s = useSession();
  const q = useApiQuery('access.list', {});
  return (
    <HomeSection
      title={t('overview.myData')}
      aside={
        <Link to="/meine-daten" className="home-aside">
          {t('overview.openMyData')}
        </Link>
      }
    >
      <QueryView query={q} loading={<Skeleton lines={2} />}>
        {(data) =>
          data.items.length === 0 ? (
            <p className="muted">
              {t('overview.myDataEmpty')}{' '}
              {s.can('catalog.local') && <Link to="/katalog">{t('overview.toCatalog')}</Link>}
            </p>
          ) : (
            <>
              <ul className="tiles">
                {data.items.slice(0, TILES_SHOWN).map((g) => (
                  <Tile
                    key={g.releaseId}
                    to={`/meine-daten/${g.releaseId}`}
                    icon="inbox"
                    tone="teal"
                    title={g.product.name}
                    sub={g.product.description || t(`categories.${g.product.category}`)}
                  />
                ))}
              </ul>
              {data.items.length > TILES_SHOWN && (
                <Link to="/meine-daten" className="small">
                  {t('overview.myDataMore', { count: data.items.length - TILES_SHOWN })}
                </Link>
              )}
            </>
          )
        }
      </QueryView>
    </HomeSection>
  );
}

/** Kennzahlen als Kacheln; jede führt zur passenden Seite. Nur, was die Rollen sehen dürfen. */
function AtAGlance() {
  const { t, fmt } = useI18n();
  const s = useSession();
  const can = (r: RouteId) => s.can(r);
  const athletes = useApiQuery(
    'athletes.list',
    { query: { page: 1, pageSize: 1 } },
    { enabled: can('athletes.list') },
  );
  const connectors = useApiQuery('connectors.list', {}, { enabled: can('connectors.list') });
  const releases = useApiQuery(
    'releases.list',
    { query: { status: 'active' } },
    { enabled: can('releases.list') },
  );
  const peers = useApiQuery('peers.list', {}, { enabled: can('peers.list') });
  const received = useApiQuery('received.list', {}, { enabled: can('received.list') });
  const system = useApiQuery('system.status', {}, { enabled: can('system.status') });

  const tiles: ReactNode[] = [];
  const tile = (key: string, label: string, value: ReactNode, to: string) =>
    tiles.push(
      <Link key={key} to={to} className="stat link-card">
        <span className="stat-label">{label}</span>
        <span className="stat-value">{value}</span>
      </Link>,
    );
  const n = (v: number | undefined) => (v === undefined ? '…' : fmt.number(v));

  if (can('athletes.list'))
    tile('athletes', t('overview.athletesCount'), n(athletes.data?.total), '/athleten');
  if (can('connectors.list')) {
    tile('connectors', t('overview.connectorsCount'), n(connectors.data?.items.length), '/quellen');
  }
  if (can('releases.list')) {
    tile(
      'releases',
      t('overview.activeReleases'),
      n(releases.data?.items.length),
      '/freigaben?status=active',
    );
  }
  if (can('received.list')) {
    const active = received.data?.items.filter((r) => r.status === 'active').length;
    tile('received', t('overview.receivedCount'), n(active), '/katalog?wo=empfangen');
  }
  if (can('peers.list')) {
    const trusted = peers.data?.items.filter((p) => p.status === 'trusted').length;
    tile('peers', t('overview.peersTrusted'), n(trusted), '/partner');
  }
  if (can('system.status')) {
    const last = system.data?.backups.last;
    tile(
      'backup',
      t('overview.lastBackup'),
      <span className="stat-text">
        {system.data ? (last ? fmt.dateTime(last.startedAt) : t('overview.noBackupShort')) : '…'}
      </span>,
      '/system',
    );
  }
  if (can('audit.list')) {
    tiles.push(
      <Link key="audit" to="/audit" className="stat link-card">
        <span className="stat-label">{t('overview.auditorTitle')}</span>
        <span className="stat-text">{t('overview.openAudit')}</span>
      </Link>,
    );
  }

  if (tiles.length === 0) return null;
  return (
    <HomeSection title={t('overview.atAGlance')}>
      <div className="stat-grid">{tiles}</div>
    </HomeSection>
  );
}
