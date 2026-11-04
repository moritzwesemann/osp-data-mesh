import { useI18n } from '../../i18n/index.tsx';
import type { ApiOutput } from '../../lib/api.ts';
import { codeText } from '../../lib/errors.ts';
import { ResultTable } from '../ResultTable.tsx';

type PreviewResult = ApiOutput<'releases.preview'>;

/** Ergebnis von releases.preview: Entscheidung, Zählwerte, Beispielzeilen. */
export function ReleasePreviewResult({ result, stale }: { result: PreviewResult; stale: boolean }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { decision, stats } = result;
  const reason = decision.reason
    ? (i.tx(`denyReasons.${decision.reason}`) ?? codeText(i, decision.reason))
    : undefined;

  const statItems: [string, number][] = [
    [t('releases.statTotal'), stats.total],
    [t('releases.statReturned'), stats.returned],
    [t('releases.statFilter'), stats.excludedByFilter],
    [t('releases.statTime'), stats.excludedByTime],
    [t('releases.statConsent'), stats.excludedByConsent],
  ];

  return (
    <div className="stack" aria-live="polite">
      {stale && (
        <div className="alert alert-warning">
          <p>{t('releases.previewStale')}</p>
        </div>
      )}
      {decision.allowed ? (
        <div className="alert alert-success">
          <p className="alert-title">{t('releases.previewAllowed')}</p>
        </div>
      ) : (
        <div className="alert alert-warning">
          <p className="alert-title">{t('releases.previewDenied')}</p>
          {reason && <p>{reason}</p>}
        </div>
      )}
      {decision.allowed && (
        <>
          <div className="stat-grid">
            {statItems.map(([label, value]) => (
              <div className="stat" key={label}>
                <span className="stat-label">{label}</span>
                <span className="stat-value">{fmt.number(value)}</span>
              </div>
            ))}
          </div>
          <h3>{t('releases.previewSample')}</h3>
          <ResultTable columns={result.columns} rows={result.rows} caption={t('releases.previewCaption')} />
        </>
      )}
    </div>
  );
}
