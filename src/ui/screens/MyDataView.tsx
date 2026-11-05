import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { AccessGrant, ExportFormat } from '../../shared/contract/index.ts';
import { FormField } from '../components/FormField.tsx';
import { DescriptionList, Details } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { dataWindowText, validityShort, validityText } from '../components/products/grantText.ts';
import { ToolAccessBox } from '../components/products/ToolAccessBox.tsx';
import { EmptyState, QueryView, Skeleton } from '../components/QueryState.tsx';
import { ResultTable } from '../components/ResultTable.tsx';
import { SpecialCategoryBadge } from '../components/StatusBadge.tsx';
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

  const purposeField =
    grant.purposes.length === 1 ? (
      // Nur ein Zweck: als Text, bereits ausgewählt
      <div className="stack-sm">
        <p>
          <span className="muted">{t('myData.purposeLabel')}:</span> <strong>{purposeLabel(purpose)}</strong>
        </p>
        <p className="field-hint">{t('myData.purposeHint')}</p>
      </div>
    ) : (
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
    );

  return (
    <>
      <PageHeader
        title={grant.product.name}
        back={{ to: '/meine-daten', label: t('myData.backToList') }}
        description={grant.product.description || undefined}
        meta={
          <>
            <SpecialCategoryBadge show={grant.product.specialCategory} />
            <span className="muted small">{validityShort(i, grant)}</span>
          </>
        }
      />

      <Section title={t('myData.dataTitle')}>
        <div className="mydata-purpose">{purposeField}</div>
        {/* Zeilenzahl und Exporte direkt über der Tabelle */}
        <div className="row-between">
          <p aria-live="polite">
            {!purpose ? (
              <span className="muted">{t('myData.choosePurpose')}</span>
            ) : data.data ? (
              t('myData.statsReturned', { count: data.data.stats.returned })
            ) : null}
          </p>
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
        </div>
        {purpose && (
          <QueryView query={data}>
            {(result) => {
              // Empfänger erhalten nur die Zahl gelieferter Zeilen (keine Angaben über ausgeschlossene Zeilen)
              const shown = result.rows.slice(0, MAX_SHOWN);
              return (
                <div className="stack">
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

      <Details summary={t('myData.aboutRelease')}>
        <DescriptionList
          items={[
            [t('myData.recipient'), t(`recipientRoles.${grant.recipientRole}`)],
            [t('myData.category'), t(`categories.${grant.product.category}`)],
            [t('myData.validity'), validityText(i, grant)],
            [t('myData.dataWindow'), dataWindowText(i, grant)],
            [
              t('myData.consentLabel'),
              grant.requiresConsent ? t('myData.consentRequired') : t('myData.consentNotRequired'),
            ],
            [
              t('myData.columnsTitle'),
              grant.columns.map((c) => (c.unit ? `${c.label} (${c.unit})` : c.label)).join(', '),
            ],
          ]}
        />
      </Details>

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
