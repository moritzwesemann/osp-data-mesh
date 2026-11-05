import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { RouteId } from '../../shared/contract/index.ts';
import { FingerprintBox } from '../components/federation/FingerprintBox.tsx';
import { DescriptionList, Details } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { QueryView, Skeleton } from '../components/QueryState.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

/** Höchstzahl der auf der Startseite gezeigten freigegebenen Datenprodukte */
const MY_DATA_SHOWN = 5;

/**
 * / – Startseite: offene Aufgaben (nur wenn es welche gibt), für mich freigegebene Daten, Kennzahlen.
 * Knotenkennung und Fingerprint aufklappbar am Ende (für alle Rollen), Rollen mit Beschreibung im Konto.
 */
export function Overview() {
  const { t } = useI18n();
  const s = useSession();
  const roles = s.roles.map((r) => t(`roles.${r}`)).join(', ');

  return (
    <div className="page">
      <PageHeader
        title={t('overview.welcome', { name: s.user.displayName })}
        docTitle={t('overview.title')}
        description={`${s.node.displayName} · ${roles}`}
      />
      <Todos />
      {s.can('access.list') && <MyDataSummary />}
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
  );
}

interface Todo {
  key: string;
  text: string;
  to: string;
  tone: 'warning' | 'danger';
}

/** Offene Aufgaben aus Importen, Partnern und Systemstatus; erscheint nur, wenn etwas zu tun ist. */
function Todos() {
  const { t, fmt } = useI18n();
  const s = useSession();
  const connectors = useApiQuery('connectors.list', {}, { enabled: s.can('connectors.list') });
  const peers = useApiQuery('peers.list', {}, { enabled: s.can('peers.list') });
  const system = useApiQuery('system.status', {}, { enabled: s.can('system.status') });

  const todos: Todo[] = [];
  for (const c of connectors.data?.items ?? []) {
    if (c.lastRun?.status === 'previewed') {
      todos.push({
        key: `run-${c.lastRun.id}`,
        text: t('overview.todoPreview', { name: c.name }),
        to: `/importe/${c.lastRun.id}`,
        tone: 'warning',
      });
    }
  }
  const pending = (peers.data?.items ?? []).filter((p) => p.status === 'pending').length;
  if (pending > 0) {
    todos.push({
      key: 'peers',
      text: t('overview.todoPeers', { count: pending }),
      to: '/partner',
      tone: 'warning',
    });
  }
  const st = system.data;
  if (st) {
    if (!st.db.ok) todos.push({ key: 'db', text: t('overview.dbFailed'), to: '/system', tone: 'danger' });
    if (!st.audit.ok) {
      todos.push({ key: 'audit', text: t('overview.auditBroken'), to: '/system', tone: 'danger' });
    }
    const last = st.backups.last;
    if (!last) {
      todos.push({ key: 'backup', text: t('overview.noBackup'), to: '/system', tone: 'warning' });
    } else if (last.status === 'failed') {
      todos.push({ key: 'backup', text: t('overview.backupFailed'), to: '/system', tone: 'danger' });
    } else if (
      st.backups.intervalHours > 0 &&
      Date.now() - Date.parse(last.startedAt) > 2 * st.backups.intervalHours * 3_600_000
    ) {
      todos.push({
        key: 'backup',
        text: t('overview.backupOld', { time: fmt.dateTime(last.startedAt) }),
        to: '/system',
        tone: 'warning',
      });
    }
    if (st.outbox.failed > 0) {
      todos.push({
        key: 'outbox',
        text: t('overview.todoOutbox', { count: st.outbox.failed }),
        to: '/partner',
        tone: 'warning',
      });
    }
    if (st.errors24h > 0) {
      todos.push({
        key: 'errors',
        text: t('overview.todoErrors', { count: st.errors24h }),
        to: '/system',
        tone: 'warning',
      });
    }
  }

  if (todos.length === 0) return null;
  return (
    <Section title={t('overview.todoTitle')}>
      <ul className="list-plain todo-list">
        {todos.map((x) => (
          <li key={x.key}>
            <span className={x.tone === 'danger' ? 'status-dot bad' : 'status-dot warn'} aria-hidden="true" />
            <Link to={x.to}>{x.text}</Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function MyDataSummary() {
  const { t } = useI18n();
  const s = useSession();
  const q = useApiQuery('access.list', {});
  return (
    <Section
      title={t('overview.myData')}
      actions={
        <Link to="/meine-daten" className="btn btn-sm">
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
            <ul className="list-plain list-divided">
              {data.items.slice(0, MY_DATA_SHOWN).map((g) => (
                <li key={g.releaseId} className="row-between">
                  <Link to={`/meine-daten/${g.releaseId}`}>{g.product.name}</Link>
                  {g.product.description && (
                    <span className="small muted clamp-1">{g.product.description}</span>
                  )}
                </li>
              ))}
              {data.items.length > MY_DATA_SHOWN && (
                <li>
                  <Link to="/meine-daten" className="small">
                    {t('overview.myDataMore', { count: data.items.length - MY_DATA_SHOWN })}
                  </Link>
                </li>
              )}
            </ul>
          )
        }
      </QueryView>
    </Section>
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
    <Section title={t('overview.atAGlance')}>
      <div className="stat-grid">{tiles}</div>
    </Section>
  );
}
