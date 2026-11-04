import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { AccessGrant, ExportFormat } from '../../shared/contract/index.ts';
import { FormField } from '../components/FormField.tsx';
import { DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { dataWindowText, validityText } from '../components/products/grantText.ts';
import { ToolAccessBox } from '../components/products/ToolAccessBox.tsx';
import { EmptyState, QueryView, Skeleton } from '../components/QueryState.tsx';
import { ResultTable } from '../components/ResultTable.tsx';
import { Badge, CategoryBadge, SpecialCategoryBadge } from '../components/StatusBadge.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import { absoluteUrl, downloadFile } from '../lib/api.ts';
import { describeError } from '../lib/errors.ts';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiQuery } from '../lib/query.ts';

/** Höchstzahl angezeigter Zeilen in der Tabelle; Exporte enthalten alle Zeilen. */
const MAX_SHOWN = 500;
const FORMATS: readonly ExportFormat[] = ['csv', 'json', 'xml'];

/** /meine-daten/:id – Daten einer Freigabe abrufen (access.data), exportieren, Werkzeugzugriff. */
export function MyDataView() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const q = useApiQuery('access.list', {});
  const back = { to: '/meine-daten', label: t('myData.backToList') };

  return (
    <div className="page">
      <QueryView
        query={q}
        loading={
          <>
            <PageHeader title={t('myData.title')} back={back} />
            <Skeleton />
          </>
        }
      >
        {(data) => {
          const grant = data.items.find((g) => g.releaseId === id);
          if (!grant) {
            return (
              <>
                <PageHeader title={t('myData.title')} back={back} />
                <EmptyState
                  message={t('myData.notFound')}
                  action={
                    <Link to="/meine-daten" className="btn">
                      {t('myData.backToList')}
                    </Link>
                  }
                />
              </>
            );
          }
          return <GrantView grant={grant} />;
        }}
      </QueryView>
    </div>
  );
}

function GrantView({ grant }: { grant: AccessGrant }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const purposeLabel = usePurposeLabel();
  const [purpose, setPurpose] = useState(grant.purposes.length === 1 ? (grant.purposes[0] ?? '') : '');
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const id = grant.releaseId;

  const data = useApiQuery(
    'access.data',
    { params: { id }, query: { purpose, format: 'json' } },
    { enabled: purpose !== '' },
  );

  const exportAs = async (format: ExportFormat) => {
    setExporting(format);
    try {
      await downloadFile(
        'access.data',
        { params: { id }, query: { purpose, format } },
        `${grant.product.slug}.${format}`,
      );
      toast.success(t('myData.exportDone'));
    } catch (err) {
      toast.error(describeError(i, err).message);
    } finally {
      setExporting(null);
    }
  };

  const exportLabel = (f: ExportFormat) =>
    f === 'csv' ? t('myData.exportCsv') : f === 'json' ? t('myData.exportJson') : t('myData.exportXml');

  const toolPurpose = purpose || grant.purposes[0] || '';

  return (
    <>
      <PageHeader
        title={grant.product.name}
        back={{ to: '/meine-daten', label: t('myData.backToList') }}
        description={grant.product.description || undefined}
        meta={
          <>
            <CategoryBadge category={grant.product.category} />
            <SpecialCategoryBadge show={grant.product.specialCategory} />
            <Badge tone="accent">{t(`recipientRoles.${grant.recipientRole}`)}</Badge>
          </>
        }
      />

      <Section>
        <div className="form-grid">
          <FormField label={t('myData.purposeLabel')} required hint={t('myData.purposeHint')}>
            {(a) => (
              <select {...a} className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                <option value="">{t('common.select')}</option>
                {grant.purposes.map((p) => (
                  <option key={p} value={p}>
                    {purposeLabel(p)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <DescriptionList
            items={[
              [t('myData.validity'), validityText(i, grant)],
              [t('myData.dataWindow'), dataWindowText(i, grant)],
              ...(grant.requiresConsent
                ? ([[t('myData.consentLabel'), t('myData.consentRequired')]] as [string, string][])
                : []),
            ]}
          />
        </div>
      </Section>

      <Section
        title={t('myData.dataTitle')}
        actions={
          <div className="row">
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                className="btn btn-sm"
                disabled={!purpose || exporting !== null}
                aria-busy={exporting === f || undefined}
                onClick={() => void exportAs(f)}
              >
                {exporting === f ? t('myData.exporting') : exportLabel(f)}
              </button>
            ))}
          </div>
        }
      >
        {!purpose ? (
          <p className="muted">{t('myData.choosePurpose')}</p>
        ) : (
          <QueryView query={data}>
            {(result) => {
              const s = result.stats;
              const parts = [t('myData.statsReturned', { count: s.returned })];
              if (grant.requiresConsent || grant.product.specialCategory || s.excludedByConsent > 0)
                parts.push(t('myData.statsConsent', { count: s.excludedByConsent }));
              if (s.excludedByFilter > 0) parts.push(t('myData.statsFilter', { count: s.excludedByFilter }));
              if (s.excludedByTime > 0) parts.push(t('myData.statsTime', { count: s.excludedByTime }));
              const shown = result.rows.slice(0, MAX_SHOWN);
              return (
                <div className="stack">
                  <p aria-live="polite">{parts.join('; ')}</p>
                  <ResultTable columns={result.columns} rows={shown} caption={grant.product.name} numbered />
                  {result.rows.length > MAX_SHOWN && (
                    <p className="small muted">
                      {t('myData.truncated', { shown: MAX_SHOWN, count: result.rows.length })}
                    </p>
                  )}
                </div>
              );
            }}
          </QueryView>
        )}
      </Section>

      <Section title={t('myData.columnsTitle')}>
        <ul className="badges list-plain">
          {grant.columns.map((c) => (
            <li key={c.key}>
              <Badge>
                {c.label}
                {c.unit ? ` (${c.unit})` : ''}
              </Badge>
            </li>
          ))}
        </ul>
      </Section>

      {toolPurpose && (
        <ToolAccessBox
          url={absoluteUrl('access.data', { params: { id }, query: { purpose: toolPurpose, format: 'csv' } })}
          fileBase={grant.product.slug}
          purposeLabel={purposeLabel(toolPurpose)}
        />
      )}
    </>
  );
}
