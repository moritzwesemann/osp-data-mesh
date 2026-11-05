import { type ReactNode, useState } from 'react';
import { CodeBlock, DateTime, DescriptionList, Details } from '../components/Misc.tsx';
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
type Health = 'ok' | 'warn' | 'bad';

/**
 * /system – vorn eine Zustandsübersicht (Ampelpunkte), darunter Sicherungen; BI-Schnittstelle und Fehlerliste
 * zugeklappt (offen bei Fehlern), technische Angaben zum Knoten in Details.
 */
export function System() {
  const { t } = useI18n();
  const s = useSession();
  const status = useApiQuery('system.status', {}, { refetchInterval: 60_000 });
  return (
    <div className="page">
      <PageHeader title={t('system.title')} description={t('system.intro')} />
      <QueryView query={status}>{(st) => <HealthSummary st={st} />}</QueryView>
      <BackupsSection />
      {s.can('bi.views') && <BiSection />}
      <ErrorsSection defaultOpen={(status.data?.errors24h ?? 0) > 0} />
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

function Dot({ state }: { state: Health }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

function HealthItem({ label, state, children }: { label: string; state: Health; children: ReactNode }) {
  const { t } = useI18n();
  const stateText =
    state === 'ok' ? t('system.stateOk') : state === 'warn' ? t('system.stateWarn') : t('system.stateBad');
  return (
    <li className="health-item">
      <span className="health-label">{label}</span>
      <span>
        <Dot state={state} />
        {/* Zustand nicht nur als Farbe: für Screenreader als Text */}
        <span className="sr-only">{stateText}: </span>
        {children}
      </span>
    </li>
  );
}

/** Zustand auf einen Blick: Datenbank, Audit-Kette, letzte Sicherung, Ausgangspostfach, BI, Fehler (24 Std.). */
function HealthSummary({ st }: { st: Status }) {
  const { t, fmt } = useI18n();
  const last = st.backups.last;
  const items: { key: string; label: string; state: Health; value: ReactNode }[] = [
    {
      key: 'db',
      label: t('system.database'),
      state: st.db.ok ? 'ok' : 'bad',
      value: st.db.ok ? t('system.dbOk') : t('system.dbFailed'),
    },
    {
      key: 'audit',
      label: t('system.auditChain'),
      state: st.audit.ok ? 'ok' : 'bad',
      value: st.audit.ok
        ? t('system.auditOk', { checked: st.audit.checked })
        : t('system.auditBroken', { seq: st.audit.firstBrokenSeq ?? '?' }),
    },
    {
      key: 'backup',
      label: t('system.lastBackup'),
      state: !last ? 'warn' : last.status === 'ok' ? 'ok' : last.status === 'running' ? 'warn' : 'bad',
      value: last ? (
        <>
          <DateTime value={last.startedAt} />
          {last.status !== 'ok' && ` · ${t(`backupStatus.${last.status}`)}`}
          {!st.backups.encrypted && ` · ${t('system.notEncrypted')}`}
        </>
      ) : (
        t('system.noBackup')
      ),
    },
    {
      key: 'outbox',
      label: t('system.outbox'),
      state: st.outbox.failed === 0 ? 'ok' : st.outbox.pending > 0 ? 'warn' : 'bad',
      value:
        st.outbox.pending === 0 && st.outbox.failed === 0
          ? t('system.outboxAllDelivered')
          : t('system.outboxValue', { pending: st.outbox.pending, failed: st.outbox.failed }),
    },
    {
      key: 'bi',
      label: t('system.bi'),
      state: st.bi.errors === 0 ? 'ok' : 'bad',
      value: t('system.biValue', { views: st.bi.views, errors: st.bi.errors }),
    },
    {
      key: 'errors',
      label: t('system.errors24h'),
      state: st.errors24h === 0 ? 'ok' : 'warn',
      value: st.errors24h === 0 ? t('system.errorsNone') : fmt.number(st.errors24h),
    },
  ];
  const allOk = items.every((x) => x.state === 'ok');

  return (
    <Section title={t('system.statusTitle')}>
      <p className={allOk ? 'text-success' : undefined}>
        <strong>{allOk ? t('system.allOk') : t('system.needsAttention')}</strong>
      </p>
      <ul className="health-list">
        {items.map((x) => (
          <HealthItem key={x.key} label={x.label} state={x.state}>
            {x.value}
          </HealthItem>
        ))}
      </ul>
      <Details>
        <DescriptionList
          items={[
            [
              t('system.version'),
              <span key="v" className="mono">
                {st.version}
              </span>,
            ],
            [t('system.uptime'), fmt.duration(st.uptimeSeconds)],
            [t('system.serverTime'), <DateTime key="time" value={st.time} />],
            [
              t('system.dbSchema'),
              <span key="mig" className="break">
                {t('system.migrations', { count: st.db.migrations, name: st.db.latestMigration ?? '–' })}
              </span>,
            ],
            [
              t('system.backupsTitle'),
              `${t('system.backupInterval', { hours: st.backups.intervalHours })} · ${
                st.backups.encrypted ? t('system.encrypted') : t('system.notEncrypted')
              }`,
            ],
            [t('system.node'), st.node.displayName],
            [
              t('partners.nodeId'),
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
          ]}
        />
      </Details>
    </Section>
  );
}

/** Auf-/Zuklappen der Zeilendetails */
function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={onToggle}>
      {open ? t('common.hideDetails') : t('common.details')}
    </button>
  );
}

function BackupsSection() {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
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
            expanded={(b) =>
              open === b.id ? (
                <DescriptionList
                  items={[
                    [
                      t('system.fileName'),
                      <span key="file" className="mono small break">
                        {b.fileName ?? '–'}
                      </span>,
                    ],
                    [
                      t('system.checksum'),
                      <span key="sha" className="mono small break">
                        {b.sha256 ?? '–'}
                      </span>,
                    ],
                    [t('system.finished'), <DateTime key="fin" value={b.finishedAt} />],
                  ]}
                />
              ) : null
            }
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
                    <span>
                      <StatusBadge group="backupStatus" value={b.status} />
                    </span>
                    {b.errorCode && <span className="small">{codeText(i, b.errorCode)}</span>}
                  </span>
                ),
              },
              { key: 'trigger', header: t('system.trigger'), render: (b) => t(`backupTrigger.${b.trigger}`) },
              {
                key: 'size',
                header: t('system.size'),
                className: 'num nowrap',
                render: (b) => fmt.bytes(b.sizeBytes),
              },
              {
                key: 'more',
                header: <span className="sr-only">{t('common.details')}</span>,
                render: (b) => (
                  <DetailsToggle open={open === b.id} onToggle={() => setOpen(open === b.id ? null : b.id)} />
                ),
              },
            ]}
          />
        )}
      </QueryView>
    </Section>
  );
}

function ErrorsSection({ defaultOpen }: { defaultOpen: boolean }) {
  const i = useI18n();
  const { t } = i;
  const [page, setPage] = useState(1);
  const errors = useApiQuery('system.errors', { query: { page, pageSize: 25 } }, { keepPrevious: true });
  return (
    <Section
      title={t('system.errorsTitle')}
      description={t('system.errorsIntro')}
      collapsible
      defaultOpen={defaultOpen}
    >
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
                {
                  key: 'code',
                  header: t('system.errorColumn'),
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
                  render: (e) => (
                    <span className="stack-sm">
                      <span className="mono small break">
                        {`${e.method ?? ''} ${e.path ?? ''}`.trim() || '–'}
                      </span>
                      <span className="small muted">
                        {t('system.httpStatus')} {e.status}
                      </span>
                    </span>
                  ),
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
  const hasErrors = (views.data?.items ?? []).some((v) => v.status === 'error');
  return (
    <Section
      title={t('system.biTitle')}
      description={t('system.biIntro')}
      collapsible
      defaultOpen={hasErrors || refresh.isError}
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
            <div className="stack">
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
                          <span>
                            <StatusBadge group="biViewStatus" value={v.status} />
                          </span>
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
              <Details summary={t('system.connectionTitle')}>
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
              </Details>
            </div>
          );
        }}
      </QueryView>
    </Section>
  );
}
