import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { importCodeText, importParamTexts, targetLabel } from '../components/connectors/shared.ts';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { DateTime, DescriptionList, Details, MetaLine } from '../components/Misc.tsx';
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

/** /importe/:id – Importlauf: Prüfergebnis, Fehler und Warnungen, Vorschau, Übernehmen/Verwerfen; Laufangaben aufklappbar. */
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

  const [errorPage, setErrorPage] = useState(1);
  const errors = useApiQuery(
    'imports.errors',
    { params: { id: run.id }, query: { page: errorPage, pageSize: ERROR_PAGE_SIZE } },
    { keepPrevious: true },
  );
  // Quellspalte je Zielfeld aus den geladenen Einträgen (z. B. data.test_date → „Testdatum“)
  const columnByField = new Map<string, string>();
  for (const e of errors.data?.items ?? []) {
    if (e.field && typeof e.params.column === 'string') columnByField.set(e.field, e.params.column);
  }

  const previewed = run.status === 'previewed';
  const canCommit = previewed && session.can('imports.commit');
  const canDiscard = previewed && session.can('imports.discard');
  const busy = commit.isPending || discard.isPending;

  const committed = run.status === 'committed';

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
      <MetaLine
        items={[
          <span key="file" className="break">
            {run.sourceName}
          </span>,
          <DateTime key="started" value={run.createdAt} />,
        ]}
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
        {run.warningRows > 0 && (
          <Stat label={t('connectors.statWarnings')} value={fmt.number(run.warningRows)} />
        )}
        <Stat label={t('connectors.statErrors')} value={fmt.number(run.errorRows)} />
        {committed && <Stat label={t('connectors.statInserted')} value={fmt.number(run.insertedRows)} />}
        {committed && <Stat label={t('connectors.statUpdated')} value={fmt.number(run.updatedRows)} />}
      </div>

      <Section title={t('connectors.problemsTitle')}>
        {detail.errorSummary.length > 0 && (
          <ul className="list-plain stack-sm">
            {detail.errorSummary.map((s) => (
              <li key={`${s.code}|${s.field ?? ''}`}>
                <strong>{t('connectors.problemCount', { count: s.count })}</strong>{' '}
                {importCodeText(i, s.code)}
                {s.field && (
                  <span className="small muted">
                    {' · '}
                    <FieldText field={s.field} column={columnByField.get(s.field)} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <ErrorLog errors={errors} onPageChange={setErrorPage} />
      </Section>

      <Section title={t('connectors.previewTitle')} description={t('connectors.previewIntro')}>
        <PreviewTable preview={detail.preview} />
      </Section>

      <Details>
        <DescriptionList
          items={[
            [
              t('connectors.connector'),
              <Link key="connector" to={`/quellen/${run.connectorId}`}>
                {run.connectorName}
              </Link>,
            ],
            [t('connectors.connectorVersion'), run.connectorVersion],
            [
              t('connectors.sourceName'),
              <span key="file" className="break">
                {run.sourceName}
              </span>,
            ],
            [t('connectors.sourceSize'), fmt.bytes(run.sourceSize)],
            [
              t('connectors.sha256'),
              <span key="sha" className="mono break small">
                {run.sourceSha256}
              </span>,
            ],
            [t('connectors.started'), <DateTime key="started" value={run.createdAt} />],
            [t('connectors.finished'), <DateTime key="finished" value={run.finishedAt} />],
          ]}
        />
      </Details>

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
              <th key={`raw:${c}`} scope="col">
                {c}
              </th>
            ))}
            {mappedCols.map((c) => (
              <th key={`map:${c}`} scope="col" className={c.startsWith('athlete.') ? undefined : 'mono'}>
                {c.startsWith('athlete.') ? targetLabel(i, c, null) : c}
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

/** Feld eines Prüfeintrags lesbar: Quellspalte, sonst Bezeichnung des Athletenfelds, sonst Feldpfad. */
function FieldText({ field, column }: { field: string; column?: string }) {
  const i = useI18n();
  const { t } = i;
  if (column) return <>{`${t('importParams.column')}: ${column}`}</>;
  if (field.startsWith('athlete.'))
    return <>{`${t('connectors.colField')}: ${targetLabel(i, field, null)}`}</>;
  return (
    <>
      {t('connectors.colField')}: <span className="mono">{field}</span>
    </>
  );
}

/** Betroffene Zeilen (imports.errors), seitenweise: Zeile, Prüfung mit Angaben und Feld, Rohwert, Schwere. */
function ErrorLog({
  errors,
  onPageChange,
}: {
  errors: ReturnType<typeof useApiQuery<'imports.errors'>>;
  onPageChange: (page: number) => void;
}) {
  const i = useI18n();
  const { t } = i;
  const columns: Column<ErrorEntry>[] = [
    { key: 'row', header: t('connectors.colRow'), className: 'num', render: (e) => e.rowNumber },
    {
      key: 'code',
      header: t('connectors.colCheck'),
      render: (e) => {
        const params = importParamTexts(i, e.params);
        return (
          <span className="stack-sm">
            <span>{importCodeText(i, e.code, e.params)}</span>
            {(params.length > 0 || e.field) && (
              <span className="small muted">
                {params.join(' · ')}
                {e.field && (
                  <>
                    {params.length > 0 && ' · '}
                    {t('connectors.colField')}: <span className="mono">{e.field}</span>
                  </>
                )}
              </span>
            )}
          </span>
        );
      },
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
    {
      key: 'severity',
      header: t('connectors.colSeverity'),
      render: (e) => <StatusBadge group="severity" value={e.severity} />,
    },
  ];
  return (
    <QueryView query={errors}>
      {(data) => (
        <>
          <Table
            caption={t('connectors.errorLogTitle')}
            columns={columns}
            rows={data.items}
            rowKey={(e) => `${e.rowNumber}|${e.field ?? ''}|${e.code}|${e.severity}`}
            empty={t('connectors.errorSummaryEmpty')}
          />
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPageChange={onPageChange}
          />
        </>
      )}
    </QueryView>
  );
}
