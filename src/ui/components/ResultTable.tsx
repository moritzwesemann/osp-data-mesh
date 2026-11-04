import type { ColumnDef, FieldType, Scalar } from '../../shared/contract/index.ts';
import { type I18n, useI18n } from '../i18n/index.tsx';
import { EmptyState } from './QueryState.tsx';

/** Formatiert einen Skalar nach Spaltentyp (Zahl, Datum, Ja/Nein). */
export function formatScalar(
  i: Pick<I18n, 't' | 'fmt'>,
  value: Scalar | undefined,
  type?: FieldType,
): string {
  if (value === null || value === undefined || value === '') return i.t('common.empty');
  if (typeof value === 'boolean') return value ? i.t('common.yes') : i.t('common.no');
  // Ganzzahlige Datenwerte (Jahrgang, Kennzahlen) ohne Tausenderpunkt: 2001, nicht 2.001
  if (typeof value === 'number') {
    const integer = type ? type === 'integer' : Number.isInteger(value);
    return i.fmt.number(value, 6, !integer);
  }
  if (type === 'date') return i.fmt.date(value);
  if (type === 'datetime') return i.fmt.dateTime(value);
  return value;
}

interface Props {
  columns: readonly ColumnDef[];
  rows: readonly Record<string, Scalar>[];
  caption?: string;
  /** Zeilennummer als erste Spalte zeigen */
  numbered?: boolean;
  offset?: number;
}

/** Tabelle für Datenergebnisse (Datenprodukte, Vorschau, empfangene Daten). */
export function ResultTable({ columns, rows, caption, numbered, offset = 0 }: Props) {
  const i = useI18n();
  if (columns.length === 0) return <EmptyState message={i.t('common.noColumns')} />;
  if (rows.length === 0) return <EmptyState message={i.t('common.noRows')} />;
  return (
    <div className="table-wrap">
      <table className="table table-data">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {numbered && (
              <th scope="col" className="num">
                #
              </th>
            )}
            {columns.map((c) => (
              <th key={c.key} scope="col" className={isNumeric(c.type) ? 'num' : undefined}>
                <span className="col-label">{c.label}</span>
                {c.unit && <span className="col-unit"> ({c.unit})</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, n) => (
            // Datenzeilen haben keine stabile ID; Position innerhalb der Seite ist eindeutig
            // biome-ignore lint/suspicious/noArrayIndexKey: Zeilen ohne eigene Kennung
            <tr key={n}>
              {numbered && <td className="num muted">{offset + n + 1}</td>}
              {columns.map((c) => (
                <td key={c.key} className={isNumeric(c.type) ? 'num' : undefined}>
                  {formatScalar(i, row[c.key], c.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isNumeric(type: FieldType): boolean {
  return type === 'integer' || type === 'number';
}
