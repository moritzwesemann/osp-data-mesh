import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { FormField } from '../components/FormField.tsx';
import { AnchorSection } from '../components/federation/AnchorSection.tsx';
import { DateTime, DescriptionList, Details, Tabs } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { QueryView } from '../components/QueryState.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { Pagination, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import { type ApiOutput, downloadFile } from '../lib/api.ts';
import { codeText, describeError } from '../lib/errors.ts';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';
import { localInputToIso } from '../lib/util.ts';

type Tab = 'log' | 'exchange';
type Outcome = 'success' | 'denied' | 'error';
type AuditEntry = ApiOutput<'audit.list'>['items'][number];
type ExchangeEntry = ApiOutput<'exchange.log'>['items'][number];

const PAGE_SIZE = 50;
/** Objekttypen, die der Server ins Audit-Log schreibt (Filterauswahl) */
const OBJECT_TYPES = [
  'api_token',
  'athlete',
  'audit_log',
  'backup_run',
  'bi',
  'connector',
  'consent',
  'dataset',
  'discovery',
  'federation_message',
  'import_run',
  'master_key',
  'outbox',
  'outbox_message',
  'peer',
  'product',
  'received_product',
  'release',
  'remote_release',
  'route',
  'source',
  'user',
] as const;

/**
 * /audit – Audit-Log (kompakte Filter, weitere Filter aufklappbar, Integritätsprüfung, Export, Einzelheiten je
 * Eintrag aufklappbar) und Austauschprotokoll.
 */
export function Audit() {
  const { t } = useI18n();
  const s = useSession();
  const [params, setParams] = useSearchParams();
  const canLog = s.can('audit.list');
  const canExchange = s.can('exchange.log');
  const requested = params.get('ansicht') === 'austausch' ? 'exchange' : 'log';
  const tab: Tab = requested === 'exchange' && canExchange ? 'exchange' : canLog ? 'log' : 'exchange';

  const tabs = [
    ...(canLog ? [{ id: 'log' as const, label: t('audit.tabLog') }] : []),
    ...(canExchange ? [{ id: 'exchange' as const, label: t('audit.tabExchange') }] : []),
  ];

  return (
    <div className="page">
      <PageHeader title={t('audit.title')} description={t('audit.intro')} />
      {tabs.length > 1 && (
        <Tabs
          label={t('audit.tabsLabel')}
          tabs={tabs}
          active={tab}
          onChange={(id) => setParams(id === 'exchange' ? { ansicht: 'austausch' } : {})}
        />
      )}
      {tab === 'log' ? <AuditLog /> : <ExchangeLog />}
    </div>
  );
}

interface Filters {
  action: string;
  outcome: '' | Outcome;
  objectType: string;
  objectId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { action: '', outcome: '', objectType: '', objectId: '', from: '', to: '' };

function AuditLog() {
  const i = useI18n();
  const { t } = i;
  const s = useSession();
  const toast = useToast();
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const [verifyOn, setVerifyOn] = useState(false);
  const [exporting, setExporting] = useState(false);

  const from = localInputToIso(filters.from) ?? undefined;
  const to = localInputToIso(filters.to) ?? undefined;
  const list = useApiQuery(
    'audit.list',
    {
      query: {
        page,
        pageSize: PAGE_SIZE,
        action: filters.action.trim() || undefined,
        outcome: filters.outcome || undefined,
        objectType: filters.objectType.trim() || undefined,
        objectId: filters.objectId.trim() || undefined,
        from,
        to,
      },
    },
    { keepPrevious: true },
  );
  const verify = useApiQuery('audit.verify', {}, { enabled: verifyOn, staleTime: 0 });

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setFilters(draft);
    setPage(1);
  };

  const exportAs = async (format: 'csv' | 'json') => {
    setExporting(true);
    try {
      await downloadFile('audit.export', { query: { format, from, to } }, `audit-log.${format}`);
    } catch (err) {
      toast.error(`${t('audit.exportFailed')} ${describeError(i, err).message}`);
    } finally {
      setExporting(false);
    }
  };

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const reset = () => {
    setDraft(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(1);
  };

  return (
    <>
      <Section>
        <form className="stack" onSubmit={apply}>
          <div className="toolbar">
            <FormField label={t('audit.filterObjectType')}>
              {(a) => (
                <select
                  {...a}
                  className="input"
                  value={draft.objectType}
                  onChange={(e) => set('objectType', e.target.value)}
                >
                  <option value="">{t('audit.allObjectTypes')}</option>
                  {OBJECT_TYPES.map((o) => (
                    <option key={o} value={o}>
                      {t(`audit.objectTypes.${o}`)}
                    </option>
                  ))}
                  {draft.objectType && !(OBJECT_TYPES as readonly string[]).includes(draft.objectType) && (
                    <option value={draft.objectType}>{draft.objectType}</option>
                  )}
                </select>
              )}
            </FormField>
            <FormField label={t('audit.filterOutcome')}>
              {(a) => (
                <select
                  {...a}
                  className="input"
                  value={draft.outcome}
                  onChange={(e) => set('outcome', e.target.value as Filters['outcome'])}
                >
                  <option value="">{t('common.all')}</option>
                  {(['success', 'denied', 'error'] as const).map((o) => (
                    <option key={o} value={o}>
                      {t(`auditOutcome.${o}`)}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField label={t('audit.filterFrom')}>
              {(a) => (
                <input
                  {...a}
                  className="input"
                  type="datetime-local"
                  value={draft.from}
                  onChange={(e) => set('from', e.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('audit.filterTo')}>
              {(a) => (
                <input
                  {...a}
                  className="input"
                  type="datetime-local"
                  value={draft.to}
                  onChange={(e) => set('to', e.target.value)}
                />
              )}
            </FormField>
            <div className="row">
              <button type="submit" className="btn btn-primary">
                {t('audit.applyFilters')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={reset}>
                {t('common.resetFilters')}
              </button>
            </div>
          </div>
          <Details
            summary={t('audit.moreFilters')}
            defaultOpen={draft.action.trim() !== '' || draft.objectId.trim() !== ''}
          >
            <div className="toolbar">
              {/* Beispiel als Platzhalter: ein Hinweis unter dem Feld würde die Filterzeile verschieben */}
              <FormField label={t('audit.filterAction')}>
                {(a) => (
                  <input
                    {...a}
                    className="input"
                    placeholder={t('audit.filterActionHint')}
                    value={draft.action}
                    onChange={(e) => set('action', e.target.value)}
                  />
                )}
              </FormField>
              <FormField label={t('audit.filterObjectId')}>
                {(a) => (
                  <input
                    {...a}
                    className="input mono"
                    value={draft.objectId}
                    onChange={(e) => set('objectId', e.target.value)}
                  />
                )}
              </FormField>
            </div>
          </Details>
        </form>
      </Section>

      <div className="row-between">
        <button
          type="button"
          className="btn btn-sm"
          disabled={verify.isFetching}
          onClick={() => (verifyOn ? void verify.refetch() : setVerifyOn(true))}
        >
          {verify.isFetching ? t('audit.verifying') : t('audit.verify')}
        </button>
        {s.can('audit.export') && (
          <div className="row">
            <span className="small muted">{t('audit.exportHint')}</span>
            <button type="button" className="btn btn-sm" disabled={exporting} onClick={() => exportAs('csv')}>
              {t('audit.exportCsv')}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={exporting}
              onClick={() => exportAs('json')}
            >
              {t('audit.exportJson')}
            </button>
          </div>
        )}
      </div>
      {verify.isError && <ErrorMessage error={verify.error} onRetry={() => void verify.refetch()} />}
      {verify.data && !verify.isFetching && (
        <div className={verify.data.ok ? 'alert alert-success' : 'alert alert-error'} role="status">
          <p className="alert-title">
            {verify.data.ok
              ? t('audit.verifyOk', { checked: verify.data.checked })
              : t('audit.verifyBroken', {
                  seq: verify.data.firstBrokenSeq ?? '?',
                  checked: verify.data.checked,
                })}
          </p>
          {verify.data.ok && <p className="small">{t('audit.verifyLocalOnly')}</p>}
        </div>
      )}
      {s.can('anchors.status') && <AnchorSection />}

      <QueryView query={list}>
        {(data) => (
          <div className="stack">
            <AuditTable rows={data.items} open={open} onToggle={(id) => setOpen(open === id ? null : id)} />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
          </div>
        )}
      </QueryView>
    </>
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

function AuditTable({
  rows,
  open,
  onToggle,
}: {
  rows: readonly AuditEntry[];
  open: number | null;
  onToggle: (id: number) => void;
}) {
  const { t, tx } = useI18n();
  return (
    <Table
      caption={t('audit.tabLog')}
      rows={rows}
      rowKey={(r) => String(r.id)}
      empty={t('audit.empty')}
      expanded={(r) => (open === r.id ? <AuditDetails entry={r} /> : null)}
      columns={[
        { key: 'at', header: t('audit.at'), className: 'nowrap', render: (r) => <DateTime value={r.at} /> },
        {
          key: 'actor',
          header: t('audit.actor'),
          render: (r) => r.actorLabel ?? r.actorId ?? t('common.empty'),
        },
        {
          key: 'action',
          header: t('audit.action'),
          render: (r) => (
            <span className="row">
              <span className="mono">{r.action}</span>
              {r.outcome !== 'success' && <StatusBadge group="auditOutcome" value={r.outcome} />}
            </span>
          ),
        },
        {
          key: 'object',
          header: t('audit.object'),
          render: (r) =>
            r.objectType ? (tx(`audit.objectTypes.${r.objectType}`) ?? r.objectType) : t('common.empty'),
        },
        {
          key: 'more',
          header: <span className="sr-only">{t('audit.details')}</span>,
          render: (r) => <DetailsToggle open={open === r.id} onToggle={() => onToggle(r.id)} />,
        },
      ]}
    />
  );
}

function AuditDetails({ entry }: { entry: AuditEntry }) {
  const { t } = useI18n();
  const hasDetails = Object.keys(entry.details).length > 0;
  return (
    <div className="stack">
      <DescriptionList
        items={[
          [t('audit.outcome'), <StatusBadge key="outcome" group="auditOutcome" value={entry.outcome} />],
          [t('audit.actorType'), t(`actorType.${entry.actorType}`)],
          [
            t('audit.filterObjectId'),
            <span key="oid" className="mono break">
              {entry.objectId ?? t('common.empty')}
            </span>,
          ],
          [
            t('audit.seq'),
            <span key="seq" className="mono">
              {entry.seq}
            </span>,
          ],
          [t('audit.ip'), entry.ip ?? t('common.empty')],
          [
            t('audit.requestId'),
            <span key="rid" className="mono">
              {entry.requestId ?? t('common.empty')}
            </span>,
          ],
          [
            t('audit.hash'),
            <span key="hash" className="mono small break">
              {entry.hash}
            </span>,
          ],
        ]}
      />
      {hasDetails ? (
        <pre className="json">{JSON.stringify(entry.details, null, 2)}</pre>
      ) : (
        <p className="muted small">{t('audit.noDetails')}</p>
      )}
    </div>
  );
}

function ExchangeLog() {
  const i = useI18n();
  const { t } = i;
  const s = useSession();
  const purposeLabel = usePurposeLabel();
  const [direction, setDirection] = useState<'' | 'outgoing' | 'incoming'>('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const q = useApiQuery(
    'exchange.log',
    { query: { page, pageSize: PAGE_SIZE, direction: direction || undefined } },
    { keepPrevious: true },
  );

  const productLabel = (r: ExchangeEntry) => {
    if (!r.productRef) return t('common.empty');
    // Mitteilungen (Widerruf, Löschmitteilung) stehen als "notice:<art>" im Protokoll
    const notice = /^notice:(\w+)$/.exec(r.productRef)?.[1];
    const label = notice ? i.tx(`partners.messageTypes.${notice}`) : undefined;
    return label ?? <span className="mono small">{r.productRef}</span>;
  };

  const releaseRef = (r: ExchangeEntry) =>
    r.releaseId && s.can('releases.get') ? (
      <Link to={`/freigaben/${r.releaseId}`} className="mono small">
        {r.releaseId.slice(0, 8)}…
      </Link>
    ) : (
      <span className="mono small">
        {(r.releaseId ?? r.remoteReleaseId)?.slice(0, 8) ?? t('common.empty')}
      </span>
    );

  return (
    <>
      <Section>
        <div className="toolbar">
          <FormField label={t('audit.direction')}>
            {(a) => (
              <select
                {...a}
                className="input"
                value={direction}
                onChange={(e) => {
                  setDirection(e.target.value as typeof direction);
                  setPage(1);
                }}
              >
                <option value="">{t('audit.allDirections')}</option>
                <option value="outgoing">{t('exchangeDirection.outgoing')}</option>
                <option value="incoming">{t('exchangeDirection.incoming')}</option>
              </select>
            )}
          </FormField>
        </div>
      </Section>
      <QueryView query={q}>
        {(data) => (
          <div className="stack">
            <Table<ExchangeEntry>
              caption={t('audit.tabExchange')}
              rows={data.items}
              rowKey={(r) => r.id}
              empty={t('audit.exchangeEmpty')}
              expanded={(r) =>
                open === r.id ? (
                  <DescriptionList
                    items={[
                      [t('audit.release'), releaseRef(r)],
                      [t('audit.rows'), i.fmt.number(r.rowCount)],
                      [
                        t('audit.payload'),
                        <span key="sha" className="mono small break">
                          {r.payloadSha256 ?? t('common.empty')}
                        </span>,
                      ],
                    ]}
                  />
                ) : null
              }
              columns={[
                {
                  key: 'at',
                  header: t('audit.at'),
                  className: 'nowrap',
                  render: (r) => <DateTime value={r.at} />,
                },
                {
                  key: 'peer',
                  header: t('audit.peer'),
                  render: (r) => (
                    <span className="stack-sm">
                      <span className="mono">{r.peerNodeId}</span>
                      <span className="small muted">{t(`exchangeDirection.${r.direction}`)}</span>
                    </span>
                  ),
                },
                {
                  key: 'product',
                  header: t('audit.product'),
                  render: (r) => (
                    <span className="stack-sm">
                      <span>{productLabel(r)}</span>
                      {r.purpose && <span className="small muted">{purposeLabel(r.purpose)}</span>}
                    </span>
                  ),
                },
                {
                  key: 'outcome',
                  header: t('audit.outcome'),
                  render: (r) => (
                    <span className="stack-sm">
                      <span>
                        <StatusBadge group="exchangeOutcome" value={r.outcome} />
                      </span>
                      {r.denyReason && <span className="small">{codeText(i, r.denyReason)}</span>}
                      {r.outcome === 'delivered' && (
                        <span className="small muted">{t('common.rows', { count: r.rowCount })}</span>
                      )}
                    </span>
                  ),
                },
                {
                  key: 'more',
                  header: <span className="sr-only">{t('audit.details')}</span>,
                  render: (r) => (
                    <DetailsToggle
                      open={open === r.id}
                      onToggle={() => setOpen(open === r.id ? null : r.id)}
                    />
                  ),
                },
              ]}
            />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
          </div>
        )}
      </QueryView>
    </>
  );
}
