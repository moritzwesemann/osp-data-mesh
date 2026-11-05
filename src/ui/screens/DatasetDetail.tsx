import { Link, useParams, useSearchParams } from 'react-router';
import type { Dataset, FieldDef } from '../../shared/contract/index.ts';
import { DateTime, DescriptionList, Details, YesNo } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { formatScalar } from '../components/ResultTable.tsx';
import { ShareabilityBadge, SpecialCategoryBadge } from '../components/StatusBadge.tsx';
import { type Column, Pagination, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { useApiQuery } from '../lib/query.ts';
import { useRememberVisit } from '../lib/recent.ts';
import { useSession } from '../lib/session.tsx';

type DatasetRecord = ApiOutput<'datasets.records'>['items'][number];
const PAGE_SIZE = 50;

/** /datensaetze/:id – Überblick, Felder und Einträge (Zugriff wird protokolliert); Kennungen und Prüfregeln aufklappbar. */
export function DatasetDetail() {
  const { id = '' } = useParams();
  const dataset = useApiQuery('datasets.get', { params: { id } });
  useRememberVisit('dataset', id, dataset.isSuccess);
  return (
    <div className="page">
      <QueryView query={dataset}>{(d) => <DatasetDetailBody dataset={d} />}</QueryView>
    </div>
  );
}

function DatasetDetailBody({ dataset: d }: { dataset: Dataset }) {
  const { t, fmt } = useI18n();
  const session = useSession();

  const range = (f: FieldDef) => {
    if (f.min === undefined && f.max === undefined) return t('common.empty');
    const lo = f.min === undefined ? '…' : fmt.number(f.min, 6);
    const hi = f.max === undefined ? '…' : fmt.number(f.max, 6);
    return `${lo} – ${hi}`;
  };

  // Auf einen Blick: Bezeichnung, Typ, Einheit, Pflicht; Feldnamen und Prüfregeln aufklappbar
  const fieldColumns: Column<FieldDef>[] = [
    { key: 'label', header: t('datasets.fields.label'), render: (f) => f.label },
    { key: 'type', header: t('datasets.fields.type'), render: (f) => t(`fieldTypes.${f.type}`) },
    { key: 'unit', header: t('datasets.fields.unit'), render: (f) => f.unit || t('common.empty') },
    { key: 'required', header: t('datasets.fields.required'), render: (f) => <YesNo value={f.required} /> },
  ];
  const ruleColumns: Column<FieldDef>[] = [
    { key: 'name', header: t('datasets.fields.name'), className: 'mono', render: (f) => f.name },
    { key: 'label', header: t('datasets.fields.label'), render: (f) => f.label },
    { key: 'range', header: t('datasets.fields.range'), className: 'nowrap', render: range },
    {
      key: 'enum',
      header: t('datasets.fields.enumValues'),
      className: 'break',
      render: (f) => (f.enumValues && f.enumValues.length > 0 ? f.enumValues.join(', ') : t('common.empty')),
    },
    {
      key: 'description',
      header: t('datasets.fields.description'),
      className: 'break',
      render: (f) => f.description || t('common.empty'),
    },
  ];

  const fieldLabel = (name: string) => d.fields.find((f) => f.name === name)?.label ?? name;
  const observedLabel = d.observedAtField ? fieldLabel(d.observedAtField) : t('datasets.observedAtNone');

  return (
    <>
      <PageHeader
        title={d.name}
        back={{ to: '/datensaetze', label: t('datasets.backToList') }}
        description={d.description || undefined}
        meta={
          d.specialCategory || d.shareability === 'internal' ? (
            <>
              <SpecialCategoryBadge show={d.specialCategory} />
              {d.shareability === 'internal' && <ShareabilityBadge value={d.shareability} />}
            </>
          ) : undefined
        }
        actions={
          session.can('datasets.update') ? (
            <Link to={`/datensaetze/${d.id}/bearbeiten`} className="btn">
              {t('datasets.edit')}
            </Link>
          ) : null
        }
      />

      <div className="grid-2">
        <Section title={t('datasets.summaryTitle')}>
          <DescriptionList
            items={[
              [t('datasets.category'), t(`categories.${d.category}`)],
              [t('datasets.recordCount'), fmt.number(d.recordCount)],
              [t('datasets.observedAtField'), observedLabel],
              [t('datasets.ownerContact'), d.ownerContact || t('common.empty')],
            ]}
          />
          <Details>
            <DescriptionList
              items={[
                [
                  t('datasets.slug'),
                  <span key="slug" className="mono">
                    {d.slug}
                  </span>,
                ],
                [t('datasets.specialCategory'), <YesNo key="special" value={d.specialCategory} />],
                [t('datasets.shareability'), t(`shareability.${d.shareability}`)],
                [t('datasets.version'), d.version],
                [
                  t('datasets.keyFields'),
                  d.keyFields.length > 0 ? (
                    <span key="keys">
                      {d.keyFields.map(fieldLabel).join(', ')}{' '}
                      <span className="small muted mono">({d.keyFields.join(', ')})</span>
                    </span>
                  ) : (
                    t('datasets.noKeyFields')
                  ),
                ],
                [t('datasets.createdAt'), <DateTime key="created" value={d.createdAt} />],
                [t('datasets.updatedAt'), <DateTime key="updated" value={d.updatedAt} />],
              ]}
            />
          </Details>
        </Section>

        <Section title={t('datasets.fields.title')}>
          <Table
            columns={fieldColumns}
            rows={d.fields}
            rowKey={(f) => f.name}
            caption={t('datasets.fields.caption')}
            empty={t('datasets.fields.empty')}
          />
          {d.fields.length > 0 && (
            <Details summary={t('datasets.fields.rulesTitle')}>
              <Table
                columns={ruleColumns}
                rows={d.fields}
                rowKey={(f) => f.name}
                caption={t('datasets.fields.rulesTitle')}
              />
            </Details>
          )}
        </Section>
      </div>

      <DatasetRecords dataset={d} />
    </>
  );
}

function DatasetRecords({ dataset: d }: { dataset: Dataset }) {
  const i = useI18n();
  const { t } = i;
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('seite')) || 1);
  const records = useApiQuery(
    'datasets.records',
    { params: { id: d.id }, query: { page, pageSize: PAGE_SIZE } },
    { keepPrevious: true },
  );

  const columns: Column<DatasetRecord>[] = [
    {
      key: 'athlete',
      header: t('datasets.athlete'),
      className: 'nowrap',
      render: (r) => <Link to={`/athleten/${r.athleteId}`}>{r.athleteName}</Link>,
    },
    {
      key: 'observed',
      header: t('datasets.observedAt'),
      className: 'nowrap',
      render: (r) => <DateTime value={r.observedAt} />,
    },
    ...d.fields.map(
      (f): Column<DatasetRecord> => ({
        key: `f:${f.name}`,
        header: (
          <>
            {f.label}
            {f.unit && <span className="col-unit"> ({f.unit})</span>}
          </>
        ),
        className: f.type === 'integer' || f.type === 'number' ? 'num nowrap' : 'nowrap',
        render: (r) => formatScalar(i, r.data[f.name], f.type),
      }),
    ),
    {
      key: 'import',
      header: t('datasets.importRun'),
      className: 'nowrap',
      render: (r) =>
        r.importRunId ? (
          <Link to={`/importe/${r.importRunId}`}>{t('datasets.importRunLink')}</Link>
        ) : (
          <span className="muted">{t('common.empty')}</span>
        ),
    },
    {
      key: 'updated',
      header: t('datasets.updatedAt'),
      className: 'nowrap',
      render: (r) => <DateTime value={r.updatedAt} />,
    },
  ];

  return (
    <Section title={t('datasets.records')} description={t('datasets.recordsAudit')}>
      <QueryView query={records}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState message={t('datasets.recordsEmpty')} />
          ) : (
            <div className="stack">
              <div className="table-scroll">
                <Table
                  columns={columns}
                  rows={data.items}
                  rowKey={(r) => r.id}
                  caption={t('datasets.recordsCaption')}
                />
              </div>
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={(p) => {
                  const next = new URLSearchParams(params);
                  if (p > 1) next.set('seite', String(p));
                  else next.delete('seite');
                  setParams(next, { replace: true });
                }}
              />
            </div>
          )
        }
      </QueryView>
    </Section>
  );
}
