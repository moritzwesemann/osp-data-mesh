import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { importCodeText, importParamTexts } from '../components/connectors/shared.ts';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { DateTime, DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { formatScalar } from '../components/ResultTable.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Pagination, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { codeText } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type RunDetail = ApiOutput<'imports.get'>;
type ErrorEntry = ApiOutput<'imports.errors'>['items'][number];
type SummaryEntry = RunDetail['errorSummary'][number];

const ERROR_PAGE_SIZE = 50;
const AFTER_CHANGE = [
  'imports.get',
  'imports.list',
  'imports.errors',
  'connectors.list',
  'connectors.get',
  'athletes.list',
  'datasets.list',
  'datasets.records',
] as const;

/** /importe/:id – Importlauf: Prüfergebnis, Vorschau, Fehlerprotokoll, Übernehmen/Verwerfen. */
export function ImportRunView() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const query = useApiQuery('imports.get', { params: { id } });
  return (
    <div className="page">
      <QueryView
        query={query}
        loading={
          <PageHeader
            title={t('connectors.runDocTitle')}
            back={{ to: '/quellen', label: t('connectors.backToList') }}
          />
        }
      >
        {(detail) => <RunView detail={detail} />}
      </QueryView>
    </div>
  );
}

function RunView({ detail }: { detail: RunDetail }) {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const session = useSession();
  const { run } = detail;
  const [confirm, setConfirm] = useState<'commit' | 'discard' | null>(null);

  const commit = useApiMutation('imports.commit', {
    invalidate: AFTER_CHANGE,
    onSuccess: (r) => {
      setConfirm(null);
      toast.success(t('connectors.committed', { inserted: r.insertedRows, updated: r.updatedRows }));
    },
  });
  const discard = useApiMutation('imports.discard', {
    invalidate: AFTER_CHANGE,
    onSuccess: () => {
      setConfirm(null);
      toast.success(t('connectors.discarded'));
    },
  });

  const previewed = run.status === 'previewed';
  const canCommit = previewed && session.can('imports.commit');
  const canDiscard = previewed && session.can('imports.discard');
  const busy = commit.isPending || discard.isPending;

  const summaryColumns: Column<SummaryEntry>[] = [
    { key: 'code', header: t('connectors.colCheck'), render: (s) => importCodeText(i, s.code) },
    {
      key: 'field',
      header: t('connectors.colField'),
      render: (s) => (s.field ? <span className="mono">{s.field}</span> : t('common.empty')),
    },
    { key: 'count', header: t('connectors.colCount'), className: 'num', render: (s) => fmt.number(s.count) },
  ];

  return (
    <>
      <PageHeader
        title={t('connectors.runPageTitle', { name: run.connectorName })}
        back={{ to: `/quellen/${run.connectorId}`, label: t('connectors.backToConnector') }}
        meta={<StatusBadge group="importStatus" value={run.status} />}
        actions={
          canCommit || canDiscard ? (
            <>
              {canDiscard && (
                <button
                  type="button"
                  className="btn btn-danger-outline"
                  disabled={busy}
                  onClick={() => {
                    discard.reset();
                    setConfirm('discard');
                  }}
                >
                  {t('connectors.discard')}
                </button>
              )}
              {canCommit && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || run.validRows === 0 /* validRows enthält Zeilen mit Warnung */}
                  onClick={() => {
                    commit.reset();
                    setConfirm('commit');
                  }}
                >
                  {t('connectors.commit')}
                </button>
              )}
            </>
          ) : undefined
        }
      />

      {previewed && (
        <div className="alert alert-info">
          <p>{t('connectors.previewPending')}</p>
        </div>
      )}
      {run.status === 'failed' && run.failureCode && (
        <div className="alert alert-error" role="alert">
          <p className="alert-title">{t('connectors.failure')}</p>
          <p>{codeText(i, run.failureCode)}</p>
        </div>
      )}

      <div className="stat-grid">
        <Stat label={t('connectors.statTotal')} value={fmt.number(run.totalRows)} />
        <Stat label={t('connectors.statValid')} value={fmt.number(run.validRows)} />
        <Stat label={t('connectors.statWarnings')} value={fmt.number(run.warningRows)} />
        <Stat label={t('connectors.statErrors')} value={fmt.number(run.errorRows)} />
        <Stat label={t('connectors.statInserted')} value={fmt.number(run.insertedRows)} />
        <Stat label={t('connectors.statUpdated')} value={fmt.number(run.updatedRows)} />
      </div>

      <div className="grid-2">
        <Section title={t('connectors.runInfo')}>
          <DescriptionList
            items={[
              [
                t('connectors.connector'),
                <Link key="k161" to={`/quellen/${run.connectorId}`}>
                  {run.connectorName}
                </Link>,
              ],
              [t('connectors.connectorVersion'), run.connectorVersion],
              [
                t('connectors.sourceName'),
                <span key="k164" className="break">
                  {run.sourceName}
                </span>,
              ],
              [t('connectors.sourceSize'), fmt.bytes(run.sourceSize)],
              [
                t('connectors.sha256'),
                <span key="k166" className="mono break small">
                  {run.sourceSha256}
                </span>,
              ],
              [t('connectors.started'), <DateTime key="k167" value={run.createdAt} />],
              [t('connectors.finished'), <DateTime key="k168" value={run.finishedAt} />],
            ]}
          />
        </Section>
        <Section title={t('connectors.errorSummaryTitle')}>
          <Table
            caption={t('connectors.errorSummaryTitle')}
            columns={summaryColumns}
            rows={detail.errorSummary}
            rowKey={(s) => `${s.code}|${s.field ?? ''}`}
            empty={t('connectors.errorSummaryEmpty')}
          />
        </Section>
      </div>

      <Section title={t('connectors.previewTitle')} description={t('connectors.previewIntro')}>
        <PreviewTable preview={detail.preview} />
      </Section>

      <ErrorLog runId={run.id} />

      <ConfirmDialog
        open={confirm === 'commit'}
        title={t('connectors.commitTitle')}
        message={t('connectors.commitConfirm', { valid: run.validRows, errors: run.errorRows })}
        confirmLabel={commit.isPending ? t('connectors.committing') : t('connectors.commit')}
        busy={commit.isPending}
        error={commit.error}
        onCancel={() => setConfirm(null)}
        onConfirm={() => commit.mutate({ params: { id: run.id } })}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        title={t('connectors.discardTitle')}
        message={t('connectors.discardConfirm')}
        confirmLabel={t('connectors.discard')}
        destructive
        busy={discard.isPending}
        error={discard.error}
        onCancel={() => setConfirm(null)}
        onConfirm={() => discard.mutate({ params: { id: run.id } })}
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

/** Vorschauzeilen: Rohwerte der Quelle und zugeordnete Werte nebeneinander. */
function PreviewTable({ preview }: { preview: RunDetail['preview'] }) {
  const i = useI18n();
  const { t } = i;
  if (preview.rows.length === 0) return <EmptyState message={t('connectors.previewEmpty')} />;
  const rawCols = preview.sourceColumns;
  const mappedCols: string[] = [];
  for (const row of preview.rows) {
    for (const k of Object.keys(row.mapped)) if (!mappedCols.includes(k)) mappedCols.push(k);
  }
  return (
    <div className="table-wrap">
      <table className="table table-data">
        <caption className="sr-only">{t('connectors.previewTitle')}</caption>
        <thead>
          <tr>
            <th scope="col" rowSpan={2} className="num">
              {t('connectors.colRow')}
            </th>
            <th scope="col" rowSpan={2}>
              {t('connectors.colRowStatus')}
            </th>
            {rawCols.length > 0 && (
              <th scope="colgroup" colSpan={rawCols.length}>
                {t('connectors.rawValues')}
              </th>
            )}
            {mappedCols.length > 0 && (
              <th scope="colgroup" colSpan={mappedCols.length}>
                {t('connectors.mappedValues')}
              </th>
            )}
          </tr>
          <tr>
            {rawCols.map((c) => (
              <th key={`raw:${c}`} scope="col" className="mono">
                {c}
              </th>
            ))}
            {mappedCols.map((c) => (
              <th key={`map:${c}`} scope="col" className="mono">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row) => (
            <tr key={row.rowNumber}>
              <td className="num muted">{row.rowNumber}</td>
              <td>
                <StatusBadge group="rowStatus" value={row.status} />
              </td>
              {rawCols.map((c) => {
                const v = row.raw[c];
                return (
                  <td key={`raw:${c}`}>
                    {v === null || v === undefined || v === '' ? (
                      <span className="muted">{t('common.empty')}</span>
                    ) : (
                      v
                    )}
                  </td>
                );
              })}
              {mappedCols.map((c) => (
                <td key={`map:${c}`}>{formatScalar(i, row.mapped[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Fehlerprotokoll (imports.errors), seitenweise. */
function ErrorLog({ runId }: { runId: string }) {
  const i = useI18n();
  const { t } = i;
  const [page, setPage] = useState(1);
  const errors = useApiQuery(
    'imports.errors',
    { params: { id: runId }, query: { page, pageSize: ERROR_PAGE_SIZE } },
    { keepPrevious: true },
  );
  const columns: Column<ErrorEntry>[] = [
    { key: 'row', header: t('connectors.colRow'), className: 'num', render: (e) => e.rowNumber },
    {
      key: 'field',
      header: t('connectors.colField'),
      render: (e) => (e.field ? <span className="mono">{e.field}</span> : t('common.empty')),
    },
    {
      key: 'code',
      header: t('connectors.colCheck'),
      render: (e) => {
        const params = importParamTexts(i, e.params);
        return (
          <span className="stack-sm">
            <span>{importCodeText(i, e.code, e.params)}</span>
            {params.length > 0 && <span className="small muted">{params.join(' · ')}</span>}
          </span>
        );
      },
    },
    {
      key: 'severity',
      header: t('connectors.colSeverity'),
      render: (e) => <StatusBadge group="severity" value={e.severity} />,
    },
    {
      key: 'raw',
      header: t('connectors.colRawValue'),
      render: (e) =>
        e.rawValue === null || e.rawValue === '' ? (
          <span className="muted">{t('common.empty')}</span>
        ) : (
          <span className="mono break">{e.rawValue}</span>
        ),
    },
  ];
  return (
    <Section title={t('connectors.errorLogTitle')}>
      <QueryView query={errors}>
        {(data) => (
          <>
            <Table
              caption={t('connectors.errorLogTitle')}
              columns={columns}
              rows={data.items}
              rowKey={(e) => `${e.rowNumber}|${e.field ?? ''}|${e.code}|${e.severity}`}
              empty={t('connectors.errorLogEmpty')}
            />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
          </>
        )}
      </QueryView>
    </Section>
  );
}
