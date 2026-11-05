import { useI18n } from '../../i18n/index.tsx';
import type { ApiOutput } from '../../lib/api.ts';
import { codeText } from '../../lib/errors.ts';
import { ResultTable } from '../ResultTable.tsx';

type PreviewResult = ApiOutput<'releases.preview'>;

/** Ergebnis von releases.preview: Entscheidung, gelieferte und ausgeschlossene Zeilen, Beispielzeilen. */
export function ReleasePreviewResult({ result, stale }: { result: PreviewResult; stale: boolean }) {
  const i = useI18n();
  const { t, fmt } = i;
  const { decision, stats } = result;
  const reason = decision.reason
    ? (i.tx(`denyReasons.${decision.reason}`) ?? codeText(i, decision.reason))
    : undefined;

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
          <p>
            {t('releases.previewReturned', {
              returned: fmt.number(stats.returned),
              total: fmt.number(stats.total),
            })}
          </p>
        </div>
      ) : (
        <div className="alert alert-warning">
          <p className="alert-title">{t('releases.previewDenied')}</p>
          {reason && <p>{reason}</p>}
        </div>
      )}
      {decision.allowed && (
        <>
          <p className="small muted">
            {t('releases.previewExcluded', {
              filter: fmt.number(stats.excludedByFilter),
              time: fmt.number(stats.excludedByTime),
              consent: fmt.number(stats.excludedByConsent),
            })}
          </p>
          <h3>{t('releases.previewSample')}</h3>
          <ResultTable columns={result.columns} rows={result.rows} caption={t('releases.previewCaption')} />
        </>
      )}
    </div>
  );
}
