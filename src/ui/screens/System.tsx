import { useState } from 'react';
import { CodeBlock, DateTime, DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { Pagination, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { codeText, describeError } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type Status = ApiOutput<'system.status'>;

/** /system – Status, Sicherungen, Fehler, BI-Schnittstelle, Dokumentation. */
export function System() {
  const { t } = useI18n();
  const s = useSession();
  const status = useApiQuery('system.status', {}, { refetchInterval: 60_000 });
  return (
    <div className="page">
      <PageHeader title={t('system.title')} description={t('system.intro')} />
      <QueryView query={status}>{(st) => <StatusCards st={st} />}</QueryView>
      <BackupsSection />
      {s.can('bi.views') && <BiSection />}
      <ErrorsSection />
      <Section title={t('system.linksTitle')}>
        <ul className="list-plain list-divided">
          <li>
            <a href="/hilfe/" target="_blank" rel="noopener">
              {t('system.helpLink')}
            </a>
          </li>
          <li>
            <a href="/api/v1/openapi.json" target="_blank" rel="noopener">
              {t('system.openApiLink')}
            </a>{' '}
            <span className="mono small muted">/api/v1/openapi.json</span>
          </li>
        </ul>
      </Section>
    </div>
  );
}

function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return (
    <span className={ok ? 'status-dot ok' : warn ? 'status-dot warn' : 'status-dot bad'} aria-hidden="true" />
  );
}

function StatusCards({ st }: { st: Status }) {
  const { t, fmt } = useI18n();
  const last = st.backups.last;
  return (
    <>
      <div className="stat-grid">
        <div className="stat">
          <span className="stat-label">{t('system.version')}</span>
          <span className="stat-value mono">{st.version}</span>
          <span className="stat-note">
            {t('system.uptime')}: {fmt.duration(st.uptimeSeconds)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('system.database')}</span>
          <span>
            <Dot ok={st.db.ok} />
            {st.db.ok ? t('system.dbOk') : t('system.dbFailed')}
          </span>
          <span className="stat-note">
            {t('system.migrations', { count: st.db.migrations, name: st.db.latestMigration ?? '–' })}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('system.auditChain')}</span>
          <span>
            <Dot ok={st.audit.ok} />
            {st.audit.ok
              ? t('system.auditOk', { checked: st.audit.checked })
              : t('system.auditBroken', { seq: st.audit.firstBrokenSeq ?? '?' })}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('system.lastBackup')}</span>
          {last ? (
            <>
              <span>
                <Dot ok={last.status === 'ok'} warn={last.status === 'running'} />
                <DateTime value={last.startedAt} />
              </span>
              <span className="stat-note">
                {t(`backupStatus.${last.status}`)} ·{' '}
                {st.backups.encrypted ? t('system.encrypted') : t('system.notEncrypted')}
              </span>
            </>
          ) : (
            <span>
              <Dot ok={false} warn />
              {t('system.noBackup')}
            </span>
          )}
          <span className="stat-note">{t('system.backupInterval', { hours: st.backups.intervalHours })}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('system.outbox')}</span>
          <span>
            <Dot ok={st.outbox.failed === 0} warn={st.outbox.pending > 0} />
            {t('system.outboxValue', { pending: st.outbox.pending, failed: st.outbox.failed })}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('system.bi')}</span>
          <span>
            <Dot ok={st.bi.errors === 0} />
            {t('system.biValue', { views: st.bi.views, errors: st.bi.errors })}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{t('system.errors24h')}</span>
          <span className="stat-value">{fmt.number(st.errors24h)}</span>
        </div>
      </div>
      <Section title={t('system.node')}>
        <DescriptionList
          items={[
            [t('common.name'), st.node.displayName],
            [
              t('overview.nodeId'),
              <span key="id" className="mono">
                {st.node.nodeId}
              </span>,
            ],
            [
              t('system.baseUrl'),
              <span key="url" className="mono break">
                {st.node.baseUrl}
              </span>,
            ],
            [
              t('common.fingerprint'),
              <span key="fp" className="mono break">
                {st.node.fingerprint}
              </span>,
            ],
            [t('system.serverTime'), <DateTime key="time" value={st.time} />],
          ]}
        />
      </Section>
    </>
  );
}

function BackupsSection() {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const backups = useApiQuery('system.backups', {});
  const backupNow = useApiMutation('system.backupNow', {
    invalidate: ['system.backups', 'system.status'],
    onSuccess: (run) =>
      run.status === 'failed'
        ? toast.error(codeText(i, run.errorCode ?? 'backup_failed'))
        : toast.success(t('system.backupDone')),
  });
  return (
    <Section
      title={t('system.backupsTitle')}
      description={t('system.backupsIntro')}
      actions={
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={backupNow.isPending}
          onClick={() => backupNow.mutate({})}
        >
          {backupNow.isPending ? t('system.backupRunning') : t('system.backupNow')}
        </button>
      }
    >
      {backupNow.error && (
        <div className="alert alert-error" role="alert">
          <p className="alert-title">{describeError(i, backupNow.error).message}</p>
        </div>
      )}
      <QueryView query={backups}>
        {(data) => (
          <Table
            caption={t('system.backupsTitle')}
            rows={data.items}
            rowKey={(b) => b.id}
            empty={t('system.backupsEmpty')}
            columns={[
              {
                key: 'started',
                header: t('system.started'),
                className: 'nowrap',
                render: (b) => <DateTime value={b.startedAt} />,
              },
              {
                key: 'status',
                header: t('common.status'),
                render: (b) => (
                  <span className="stack-sm">
                    <StatusBadge group="backupStatus" value={b.status} />
                    {b.errorCode && <span className="small">{codeText(i, b.errorCode)}</span>}
                  </span>
                ),
              },
              { key: 'trigger', header: t('system.trigger'), render: (b) => t(`backupTrigger.${b.trigger}`) },
              {
                key: 'file',
                header: t('system.fileName'),
                className: 'mono small',
                render: (b) => b.fileName ?? '–',
              },
              {
                key: 'size',
                header: t('system.size'),
                className: 'num nowrap',
                render: (b) => fmt.bytes(b.sizeBytes),
              },
              {
                key: 'sha',
                header: t('system.checksum'),
                className: 'mono small',
                render: (b) => (b.sha256 ? <span title={b.sha256}>{b.sha256.slice(0, 16)}…</span> : '–'),
              },
              {
                key: 'finished',
                header: t('system.finished'),
                className: 'nowrap',
                render: (b) => <DateTime value={b.finishedAt} />,
              },
            ]}
          />
        )}
      </QueryView>
    </Section>
  );
}

function ErrorsSection() {
  const i = useI18n();
  const { t } = i;
  const [page, setPage] = useState(1);
  const errors = useApiQuery('system.errors', { query: { page, pageSize: 25 } }, { keepPrevious: true });
  return (
    <Section title={t('system.errorsTitle')} description={t('system.errorsIntro')}>
      <QueryView query={errors}>
        {(data) => (
          <div className="stack">
            <Table
              caption={t('system.errorsTitle')}
              rows={data.items}
              rowKey={(e) => String(e.id)}
              empty={t('system.errorsEmpty')}
              columns={[
                {
                  key: 'at',
                  header: t('system.at'),
                  className: 'nowrap',
                  render: (e) => <DateTime value={e.at} />,
                },
                { key: 'status', header: t('system.httpStatus'), className: 'num', render: (e) => e.status },
                {
                  key: 'code',
                  header: t('system.code'),
                  render: (e) => (
                    <span className="stack-sm">
                      <span>{codeText(i, e.code)}</span>
                      <span className="mono small muted">{e.code}</span>
                    </span>
                  ),
                },
                {
                  key: 'request',
                  header: t('system.request'),
                  className: 'mono small break',
                  render: (e) => `${e.method ?? ''} ${e.path ?? ''}`.trim() || '–',
                },
                {
                  key: 'rid',
                  header: t('system.requestId'),
                  className: 'mono small',
                  render: (e) => e.requestId ?? '–',
                },
              ]}
            />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
          </div>
        )}
      </QueryView>
    </Section>
  );
}

function BiSection() {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const views = useApiQuery('bi.views', {});
  const refresh = useApiMutation('bi.refresh', {
    invalidate: ['bi.views', 'system.status'],
    onSuccess: (r) => toast.success(t('system.biRefreshed', { refreshed: r.refreshed, errors: r.errors })),
  });
  return (
    <Section
      title={t('system.biTitle')}
      description={t('system.biIntro')}
      actions={
        <button
          type="button"
          className="btn btn-sm"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate({})}
        >
          {refresh.isPending ? t('system.biRefreshing') : t('system.biRefresh')}
        </button>
      }
    >
      {refresh.error && (
        <div className="alert alert-error" role="alert">
          <p className="alert-title">{describeError(i, refresh.error).message}</p>
        </div>
      )}
      <QueryView query={views}>
        {(data) => {
          const c = data.connection;
          const host = c.host ?? t('system.notConfigured');
          const port = c.port ?? 5432;
          const db = c.database ?? t('system.notConfigured');
          const firstView = data.items[0]?.viewName ?? '<view>';
          const python = [
            'import pandas as pd',
            'from sqlalchemy import create_engine',
            '',
            `engine = create_engine("postgresql+psycopg://${c.role}:<PASSWORT>@${c.host ?? '<host>'}:${port}/${c.database ?? '<datenbank>'}")`,
            `df = pd.read_sql('SELECT * FROM ${c.schema}."${firstView}"', engine)`,
          ].join('\n');
          return (
            <div className="stack-lg">
              {data.items.length === 0 ? (
                <EmptyState message={t('system.biEmpty')} />
              ) : (
                <Table
                  caption={t('system.biTitle')}
                  rows={data.items}
                  rowKey={(v) => v.releaseId}
                  columns={[
                    { key: 'product', header: t('system.product'), render: (v) => v.productName },
                    {
                      key: 'view',
                      header: t('system.viewName'),
                      className: 'mono small',
                      render: (v) => `${c.schema}.${v.viewName}`,
                    },
                    {
                      key: 'status',
                      header: t('common.status'),
                      render: (v) => (
                        <span className="stack-sm">
                          <StatusBadge group="biViewStatus" value={v.status} />
                          {v.errorCode && <span className="small">{codeText(i, v.errorCode)}</span>}
                        </span>
                      ),
                    },
                    {
                      key: 'rows',
                      header: t('system.rowCount'),
                      className: 'num',
                      render: (v) => fmt.number(v.rowCount),
                    },
                    {
                      key: 'refreshed',
                      header: t('system.refreshedAt'),
                      className: 'nowrap',
                      render: (v) => <DateTime value={v.refreshedAt} />,
                    },
                  ]}
                />
              )}
              <div className="stack">
                <h3>{t('system.connectionTitle')}</h3>
                <DescriptionList
                  items={[
                    [
                      t('system.host'),
                      <span key="host" className="mono">
                        {host}
                      </span>,
                    ],
                    [
                      t('system.port'),
                      <span key="port" className="mono">
                        {port}
                      </span>,
                    ],
                    [
                      t('system.database'),
                      <span key="db" className="mono">
                        {db}
                      </span>,
                    ],
                    [
                      t('system.schema'),
                      <span key="schema" className="mono">
                        {c.schema}
                      </span>,
                    ],
                    [
                      t('system.role'),
                      <span key="role" className="mono">
                        {c.role}
                      </span>,
                    ],
                  ]}
                />
                <p className="field-hint">{t('system.passwordNote')}</p>
                <div className="grid-2">
                  <div className="stack-sm">
                    <h4>{t('system.toolExcel')}</h4>
                    <p className="small">{t('system.toolExcelText', { schema: c.schema })}</p>
                  </div>
                  <div className="stack-sm">
                    <h4>{t('system.toolTableau')}</h4>
                    <p className="small">{t('system.toolTableauText', { schema: c.schema })}</p>
                  </div>
                  <div className="stack-sm">
                    <h4>{t('system.toolSap')}</h4>
                    <p className="small">{t('system.toolSapText')}</p>
                  </div>
                  <div className="stack-sm">
                    <h4>{t('system.toolRest')}</h4>
                    <p className="small">{t('system.toolRestText')}</p>
                  </div>
                </div>
                <CodeBlock label={t('system.toolPython')} code={python} />
              </div>
            </div>
          );
        }}
      </QueryView>
    </Section>
  );
}
