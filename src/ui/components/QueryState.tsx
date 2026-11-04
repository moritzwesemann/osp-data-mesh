import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n/index.tsx';
import type { ApiError } from '../lib/api.ts';
import { ErrorMessage } from './ErrorMessage.tsx';

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <p className="loading" aria-busy="true">
      <span className="spinner" aria-hidden="true" />
      {label ?? t('common.loading')}
    </p>
  );
}

/** Platzhalterzeilen für Tabellen und Karten während des Ladens. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  const { t } = useI18n();
  return (
    <div className="skeleton" aria-busy="true">
      <span className="sr-only">{t('common.loading')}</span>
      {Array.from({ length: lines }, (_, n) => n).map((n) => (
        <div key={`sk${n}`} className="skeleton-line" />
      ))}
    </div>
  );
}

export function EmptyState({ message, action }: { message: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{message}</p>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

/**
 * Ehrliche Zustände einer Abfrage: Laden, Fehler (mit Wiederholen), Daten.
 * children erhält die Daten, sobald sie vorliegen.
 */
export function QueryView<T>({
  query,
  children,
  loading,
}: {
  query: UseQueryResult<T, ApiError>;
  children: (data: T) => ReactNode;
  loading?: ReactNode;
}) {
  if (query.isPending) return <>{loading ?? <Skeleton />}</>;
  if (query.isError) return <ErrorMessage error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}
