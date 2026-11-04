import { Link } from 'react-router';
import type { RouteId } from '../../shared/contract/index.ts';
import { FingerprintBox } from '../components/federation/FingerprintBox.tsx';
import { DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView, Skeleton } from '../components/QueryState.tsx';
import { RoleBadge, StatusBadge } from '../components/StatusBadge.tsx';
import { Table } from '../components/Table.tsx';
import { type MessageKey, useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

interface Shortcut {
  to: string;
  label: MessageKey;
  route: RouteId;
}

const SHORTCUTS: readonly Shortcut[] = [
  { to: '/athleten', label: 'overview.shortcutAthletes', route: 'athletes.list' },
  { to: '/quellen', label: 'overview.shortcutImport', route: 'connectors.list' },
  { to: '/freigaben/neu', label: 'overview.shortcutRelease', route: 'releases.create' },
  { to: '/meine-daten', label: 'overview.openMyData', route: 'access.list' },
  { to: '/katalog', label: 'overview.shortcutCatalog', route: 'catalog.local' },
  { to: '/empfangen', label: 'overview.shortcutReceived', route: 'received.list' },
  { to: '/partner', label: 'overview.shortcutPartners', route: 'peers.list' },
  { to: '/benutzer', label: 'overview.shortcutUsers', route: 'users.list' },
  { to: '/audit', label: 'overview.openAudit', route: 'audit.list' },
];

/** / – Übersicht: Knoten, Rollen, Schnellzugriffe und rollenabhängige Kennzahlen. */
export function Overview() {
  const { t } = useI18n();
  const s = useSession();
  const shortcuts = SHORTCUTS.filter((x) => s.can(x.route));

  return (
    <div className="page">
      <PageHeader
        title={t('overview.welcome', { name: s.user.displayName })}
        docTitle={t('overview.title')}
        description={t('overview.intro')}
      />

      <div className="grid-2">
        <Section title={t('overview.thisNode')}>
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
            <p className="field-hint">{t('overview.fingerprintHint')}</p>
          </div>
        </Section>
        <Section title={t('overview.yourRoles')}>
          <ul className="list-plain list-divided">
            {s.roles.map((role) => (
              <li key={role} className="stack-sm">
                <span>
                  <RoleBadge role={role} />
                </span>
                <span className="small muted">{t(`roleDescriptions.${role}`)}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {shortcuts.length > 0 && (
        <Section title={t('overview.shortcuts')}>
          <div className="row">
            {shortcuts.map((x) => (
              <Link key={x.to} to={x.to} className="btn">
                {t(x.label)}
              </Link>
            ))}
          </div>
        </Section>
      )}

      {s.can('access.list') && <MyDataSummary />}
      {s.can('athletes.list') && <StewardSummary />}
      {s.can('system.status') && <SystemSummary />}
      {s.can('peers.list') && <PeersSummary />}
      {s.hasRole('auditor') && (
        <Section title={t('overview.auditorTitle')}>
          <p>{t('overview.auditorText')}</p>
          <div className="row">
            {s.can('audit.list') && (
              <Link to="/audit" className="btn btn-primary">
                {t('overview.openAudit')}
              </Link>
            )}
            {s.can('releases.list') && (
              <Link to="/freigaben" className="btn">
                {t('overview.openReleases')}
              </Link>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

function MyDataSummary() {
  const { t } = useI18n();
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
            <EmptyState message={t('overview.myDataEmpty')} />
          ) : (
            <div className="stack-sm">
              <p>{t('overview.myDataCount', { count: data.items.length })}</p>
              <ul className="list-plain list-divided">
                {data.items.slice(0, 5).map((g) => (
                  <li key={g.releaseId}>
                    <Link to={`/meine-daten/${g.releaseId}`}>{g.product.name}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )
        }
      </QueryView>
    </Section>
  );
}

function StewardSummary() {
  const { t, fmt } = useI18n();
  const s = useSession();
  const athletes = useApiQuery('athletes.list', { query: { page: 1, pageSize: 1 } });
  const connectors = useApiQuery('connectors.list', {}, { enabled: s.can('connectors.list') });
  const releases = useApiQuery(
    'releases.list',
    { query: { status: 'active' } },
    { enabled: s.can('releases.list') },
  );

  const runs = (connectors.data?.items ?? [])
    .flatMap((c) => (c.lastRun ? [{ connector: c, run: c.lastRun }] : []))
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt))
    .slice(0, 5);

  const stat = (label: string, value: number | undefined, to: string) => (
    <Link to={to} className="stat link-card">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value === undefined ? '…' : fmt.number(value)}</span>
    </Link>
  );

  return (
    <Section title={t('overview.stewardTitle')}>
      <div className="stat-grid">
        {stat(t('overview.athletesCount'), athletes.data?.total, '/athleten')}
        {s.can('connectors.list') &&
          stat(t('overview.connectorsCount'), connectors.data?.items.length, '/quellen')}
        {s.can('releases.list') &&
          stat(t('overview.activeReleases'), releases.data?.items.length, '/freigaben?status=active')}
      </div>
      {s.can('connectors.list') && (
        <div className="stack-sm">
          <h3>{t('overview.recentImports')}</h3>
          <QueryView query={connectors} loading={<Skeleton lines={2} />}>
            {() => (
              <Table
                caption={t('overview.recentImports')}
                rows={runs}
                rowKey={(r) => r.run.id}
                empty={t('overview.recentImportsEmpty')}
                columns={[
                  {
                    key: 'connector',
                    header: t('overview.connector'),
                    render: (r) => <Link to={`/quellen/${r.connector.id}`}>{r.connector.name}</Link>,
                  },
                  {
                    key: 'status',
                    header: t('common.status'),
                    render: (r) => <StatusBadge group="importStatus" value={r.run.status} />,
                  },
                  {
                    key: 'at',
                    header: t('overview.lastRun'),
                    className: 'nowrap',
                    render: (r) => <Link to={`/importe/${r.run.id}`}>{fmt.dateTime(r.run.createdAt)}</Link>,
                  },
                ]}
              />
            )}
          </QueryView>
        </div>
      )}
    </Section>
  );
}

function SystemSummary() {
  const { t, fmt } = useI18n();
  const q = useApiQuery('system.status', {});
  return (
    <Section
      title={t('overview.systemTitle')}
      actions={
        <Link to="/system" className="btn btn-sm">
          {t('overview.openSystem')}
        </Link>
      }
    >
      <QueryView query={q} loading={<Skeleton lines={3} />}>
        {(st) => (
          <div className="stat-grid">
            <div className="stat">
              <span className="stat-label">{t('system.database')}</span>
              <span>
                <span className={st.db.ok ? 'status-dot ok' : 'status-dot bad'} aria-hidden="true" />
                {st.db.ok ? t('overview.dbOk') : t('overview.dbFailed')}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('system.auditChain')}</span>
              <span>
                <span className={st.audit.ok ? 'status-dot ok' : 'status-dot bad'} aria-hidden="true" />
                {st.audit.ok ? t('overview.auditOk') : t('overview.auditBroken')}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('overview.lastBackup')}</span>
              {st.backups.last ? (
                <span className="stack-sm">
                  <span>{fmt.dateTime(st.backups.last.startedAt)}</span>
                  <StatusBadge group="backupStatus" value={st.backups.last.status} />
                </span>
              ) : (
                <span>
                  <span className="status-dot warn" aria-hidden="true" />
                  {t('overview.noBackup')}
                </span>
              )}
            </div>
            <div className="stat">
              <span className="stat-label">{t('overview.outboxPending')}</span>
              <span className="stat-value">{fmt.number(st.outbox.pending)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">{t('overview.errors24h')}</span>
              <span className="stat-value">{fmt.number(st.errors24h)}</span>
            </div>
          </div>
        )}
      </QueryView>
    </Section>
  );
}

function PeersSummary() {
  const { t } = useI18n();
  const q = useApiQuery('peers.list', {});
  return (
    <Section
      title={t('overview.peersTitle')}
      actions={
        <Link to="/partner" className="btn btn-sm">
          {t('overview.shortcutPartners')}
        </Link>
      }
    >
      <QueryView query={q} loading={<Skeleton lines={1} />}>
        {(data) => {
          const pending = data.items.filter((p) => p.status === 'pending').length;
          return (
            <p className="kv-inline">
              <strong>{t('overview.peersCount', { count: data.items.length })}</strong>
              {pending > 0 && <span>{t('overview.peersPending', { count: pending })}</span>}
            </p>
          );
        }}
      </QueryView>
    </Section>
  );
}
