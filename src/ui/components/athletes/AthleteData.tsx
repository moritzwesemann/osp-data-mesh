import { useState } from 'react';
import { Link } from 'react-router';
import type { ColumnDef, Scalar } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import type { ApiOutput } from '../../lib/api.ts';
import { useApiQuery } from '../../lib/query.ts';
import { Section } from '../PageHeader.tsx';
import { QueryView, Skeleton } from '../QueryState.tsx';
import { ResultTable } from '../ResultTable.tsx';
import { SpecialCategoryBadge } from '../StatusBadge.tsx';
import { TrendChart, type TrendPoint } from '../TrendChart.tsx';

type Dataset = ApiOutput<'datasets.get'>;
type RecordItem = ApiOutput<'datasets.records'>['items'][number];

/** Höchstzahl geladener Einträge je Datensatz und Person (API-Maximum); mehr wird als Hinweis gezeigt */
const MAX_RECORDS = 500;

/**
 * Alle Daten einer Person aus einem Datensatz (z. B. alle Leistungsdiagnostiken): Verlauf einer Messgröße
 * und alle Einträge, neueste zuerst. Lädt nur Einträge dieser Person (datasets.records mit athleteId);
 * jeder Abruf wird protokolliert.
 */
export function AthleteDatasetSection({
  athleteId,
  datasetId,
  datasetName,
  count,
}: {
  athleteId: string;
  datasetId: string;
  datasetName: string;
  count: number;
}) {
  const { t } = useI18n();
  const dataset = useApiQuery('datasets.get', { params: { id: datasetId } });
  const records = useApiQuery('datasets.records', {
    params: { id: datasetId },
    query: { athleteId, page: 1, pageSize: MAX_RECORDS },
  });

  return (
    <Section
      id={`daten-${datasetId}`}
      title={
        <span className="row">
          <span>{datasetName}</span>
          <span className="muted small">{t('athletes.entries', { count })}</span>
          {dataset.data?.specialCategory && <SpecialCategoryBadge />}
        </span>
      }
      actions={
        <Link to={`/datensaetze/${datasetId}`} className="btn btn-sm">
          {t('athletes.openDataset')}
        </Link>
      }
    >
      {dataset.data?.specialCategory && <p className="small muted">{t('athletes.healthNote')}</p>}
      <QueryView query={dataset} loading={<Skeleton lines={3} />}>
        {(ds) => (
          <QueryView query={records} loading={<Skeleton lines={3} />}>
            {(page) => <DatasetBody dataset={ds} items={page.items} total={page.total} />}
          </QueryView>
        )}
      </QueryView>
    </Section>
  );
}

function DatasetBody({ dataset, items, total }: { dataset: Dataset; items: RecordItem[]; total: number }) {
  const { t } = useI18n();
  const columns: ColumnDef[] = dataset.fields.map((f) => ({
    key: f.name,
    label: f.label,
    type: f.type,
    ...(f.unit ? { unit: f.unit } : {}),
  }));
  return (
    <div className="stack">
      <Trend dataset={dataset} items={items} />
      <div className="stack-sm">
        <h3>{t('athletes.allEntries')}</h3>
        <ResultTable
          columns={columns}
          rows={items.map((r) => r.data)}
          caption={t('athletes.allEntriesOf', { name: dataset.name })}
        />
        {total > items.length && (
          <p className="small muted">{t('athletes.truncated', { shown: items.length, count: total })}</p>
        )}
      </div>
    </div>
  );
}

/** Verlauf: Messgröße wählbar (Zahlenfelder); bei Auswahlfeldern (z. B. Testart, Protokoll) nur Gleichartiges */
function Trend({ dataset, items }: { dataset: Dataset; items: RecordItem[] }) {
  const i = useI18n();
  const { t, fmt } = i;
  const numeric = dataset.fields.filter((f) => f.type === 'number' || f.type === 'integer');
  const dated = items.filter((r) => r.observedAt);
  // Gruppierfeld: erstes Auswahlfeld mit mehreren Werten bei dieser Person (Sprungarten, Testprotokolle)
  const group = dataset.fields.find(
    (f) => f.type === 'enum' && new Set(dated.map((r) => r.data[f.name]).filter((v) => v != null)).size > 1,
  );
  const groupValues = group ? valuesByFrequency(dated.map((r) => r.data[group.name])) : [];

  const [fieldName, setFieldName] = useState(numeric[0]?.name ?? '');
  const [groupValue, setGroupValue] = useState(groupValues[0] ?? '');
  const field = numeric.find((f) => f.name === fieldName) ?? numeric[0];
  // Ein einzelner Eintrag ergibt keinen Verlauf: dann nur die Tabelle
  if (!field || dated.length < 2) return null;
  const activeGroup = group && groupValues.includes(groupValue) ? groupValue : groupValues[0];

  const points: TrendPoint[] = dated
    .filter((r) => typeof r.data[field.name] === 'number')
    .filter((r) => !group || r.data[group.name] === activeGroup)
    .map((r) => ({ at: r.observedAt as string, value: r.data[field.name] as number }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const unit = field.unit ? ` ${field.unit}` : '';
  const formatValue = (n: number) => `${fmt.number(n, 1, field.type !== 'integer')}`;
  const first = points[0];
  const lastPoint = points[points.length - 1];

  return (
    <div className="stack-sm">
      <div className="row-between">
        <h3>{t('athletes.trendTitle')}</h3>
        <div className="row trend-controls">
          {numeric.length > 1 && (
            <label className="inline-select">
              <span className="small muted">{t('athletes.trendValue')}</span>
              <select
                className="input input-sm"
                value={field.name}
                onChange={(e) => setFieldName(e.target.value)}
              >
                {numeric.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.label}
                    {f.unit ? ` (${f.unit})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {group && (
            <label className="inline-select">
              <span className="small muted">{group.label}</span>
              <select
                className="input input-sm"
                value={activeGroup}
                onChange={(e) => setGroupValue(e.target.value)}
              >
                {groupValues.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      {points.length < 2 || !first || !lastPoint ? (
        <p className="small muted">{t('athletes.trendTooFew')}</p>
      ) : (
        <>
          <p className="small muted">
            {field.label}
            {unit ? ` (${field.unit})` : ''}
            {group ? ` · ${group.label}: ${activeGroup}` : ''} ·{' '}
            {t('athletes.trendRange', {
              count: points.length,
              from: fmt.date(first.at),
              until: fmt.date(lastPoint.at),
            })}
          </p>
          <TrendChart
            points={points}
            formatValue={formatValue}
            formatDate={(iso) => fmt.date(iso)}
            summary={t('athletes.trendSummary', {
              field: field.label,
              count: points.length,
              first: `${formatValue(first.value)}${unit}`,
              last: `${formatValue(lastPoint.value)}${unit}`,
              from: fmt.date(first.at),
              until: fmt.date(lastPoint.at),
            })}
          />
        </>
      )}
    </div>
  );
}

/** Werte nach Häufigkeit (häufigster zuerst), nur Texte */
function valuesByFrequency(values: readonly (Scalar | undefined)[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) if (typeof v === 'string') counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}
