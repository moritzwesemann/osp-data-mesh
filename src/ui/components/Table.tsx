import { Fragment, type ReactNode } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { cx } from '../lib/util.ts';
import { EmptyState } from './QueryState.tsx';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** z. B. "num" (rechtsbündig), "nowrap", "mono" */
  className?: string;
}

interface Props<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** unsichtbare Tabellenbeschriftung für Screenreader */
  caption?: string;
  /** Anzeige bei leerer Liste (statt leerer Tabelle) */
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  /** zusätzliche Zeile unterhalb einer Zeile (z. B. aufgeklappte Details) */
  expanded?: (row: T) => ReactNode;
}

/** Tabelle mit horizontalem Scrollen im eigenen Container auf schmalen Bildschirmen. */
export function Table<T>({ columns, rows, rowKey, caption, empty, rowClassName, expanded }: Props<T>) {
  if (rows.length === 0 && empty !== undefined) {
    return typeof empty === 'string' ? <EmptyState message={empty} /> : empty;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.className}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const extra = expanded?.(row);
            return (
              <Fragment key={key}>
                <tr className={rowClassName?.(row)}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.className}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
                {extra && (
                  <tr className="row-expanded">
                    <td colSpan={columns.length}>{extra}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
}

/** Seitenweise Navigation mit Bereichsanzeige. */
export function Pagination({ page, pageSize, total, onPageChange, className }: PaginationProps) {
  const { t } = useI18n();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && page <= 1) return null;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className={cx('pagination', className)} aria-label={t('common.pagination')}>
      <span className="pagination-range">{t('common.rangeOf', { from, to, total })}</span>
      <div className="pagination-buttons">
        <button
          type="button"
          className="btn btn-sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          {t('common.previous')}
        </button>
        <span className="pagination-page">{t('common.pageOf', { page, pages })}</span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          {t('common.next')}
        </button>
      </div>
    </nav>
  );
}
