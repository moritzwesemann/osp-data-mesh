import { useI18n } from '../i18n/index.tsx';
import { describeError } from '../lib/errors.ts';

interface Props {
  error: unknown;
  onRetry?: () => void;
  /** Feldfehler als Liste anzeigen (Standard: ja) */
  showFields?: boolean;
}

/** Übersetzte Fehlermeldung mit optionalem Detailgrund, Feldliste, Wiederholen und Support-Referenz. */
export function ErrorMessage({ error, onRetry, showFields = true }: Props) {
  const i = useI18n();
  const d = describeError(i, error);
  return (
    <div className="alert alert-error" role="alert">
      <p className="alert-title">{d.message}</p>
      {d.detail && <p>{d.detail}</p>}
      {showFields && d.fields.length > 0 && (
        <>
          <p>{i.t('common.fieldErrorsTitle')}</p>
          <ul className="field-error-list">
            {d.fields.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>: {f.text}
              </li>
            ))}
          </ul>
        </>
      )}
      {onRetry && (
        <p>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            {i.t('common.retry')}
          </button>
        </p>
      )}
      {d.requestId && <p className="support-ref">{i.t('common.supportRef', { id: d.requestId })}</p>}
    </div>
  );
}
