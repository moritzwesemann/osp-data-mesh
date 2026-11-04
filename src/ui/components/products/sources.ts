/**
 * Spaltenquellen von Datenprodukten (Athletenkern, Eintrag, Datensatzfelder) und Hilfen zur Anzeige.
 */
import {
  ATHLETE_SOURCE_FIELDS,
  type Condition,
  type Dataset,
  type FieldType,
  type Scalar,
} from '../../../shared/contract/index.ts';
import type { I18n } from '../../i18n/index.tsx';
import { formatScalar } from '../ResultTable.tsx';

type Tr = Pick<I18n, 't' | 'tx'>;

export type SourceGroup = 'athlete' | 'record' | 'data';

export interface SourceOption {
  source: string;
  group: SourceGroup;
  /** Feldname ohne Präfix */
  field: string;
  label: string;
  type: FieldType;
  unit?: string;
  enumValues?: readonly string[];
}

/** Ausgewählte Produktspalte im Formular */
export interface ColumnEntry {
  uid: string;
  source: string;
  key: string;
  label: string;
}

export const COLUMN_KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;

function athleteLabel(i: Tr, field: string, fallback: string): string {
  return i.tx(`products.sources.${field}`) ?? fallback;
}

/** Verfügbare Quellen: Athletenkern immer, bei Datensatz zusätzlich Beobachtungsdatum und Felder. */
export function sourceOptions(i: Tr, dataset: Dataset | null): SourceOption[] {
  const out: SourceOption[] = ATHLETE_SOURCE_FIELDS.map((f) => {
    const field = f.source.slice('athlete.'.length);
    return {
      source: f.source,
      group: 'athlete',
      field,
      label: athleteLabel(i, field, f.label),
      type: f.type,
    };
  });
  if (dataset) {
    if (dataset.observedAtField) {
      const obsType = dataset.fields.find((f) => f.name === dataset.observedAtField)?.type;
      out.push({
        source: 'record.observed_at',
        group: 'record',
        field: 'observed_at',
        label: i.t('products.sources.observed_at'),
        type: obsType === 'date' ? 'date' : 'datetime',
      });
    }
    for (const f of dataset.fields) {
      out.push({
        source: `data.${f.name}`,
        group: 'data',
        field: f.name,
        label: f.label,
        type: f.type,
        unit: f.unit,
        enumValues: f.enumValues,
      });
    }
  }
  return out;
}

/** Standard-Spaltenschlüssel: athlete.last_name → last_name, data.x → x */
export function defaultKey(source: string): string {
  return source.slice(source.indexOf('.') + 1);
}

/** Lesbare Herkunft einer Spalte, z. B. "Athletenkern: Nachname". */
export function sourceText(i: Tr, source: string, dataLabel?: string): string {
  const dot = source.indexOf('.');
  const prefix = source.slice(0, dot);
  const field = source.slice(dot + 1);
  if (prefix === 'athlete')
    return i.t('products.sourceAthleteField', { field: athleteLabel(i, field, field) });
  if (prefix === 'record')
    return i.t('products.sourceRecordField', { field: i.t('products.sources.observed_at') });
  if (prefix === 'data') return i.t('products.sourceDataField', { field: dataLabel ?? field });
  return source;
}

export interface ColumnIssue {
  key?: 'invalid' | 'duplicate';
  label?: 'missing';
}

/** Prüft Schlüssel (Format, Eindeutigkeit) und Bezeichnungen der ausgewählten Spalten. */
export function columnIssues(entries: readonly ColumnEntry[]): Map<string, ColumnIssue> {
  const issues = new Map<string, ColumnIssue>();
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
  for (const e of entries) {
    const issue: ColumnIssue = {};
    if (!COLUMN_KEY_RE.test(e.key)) issue.key = 'invalid';
    else if ((counts.get(e.key) ?? 0) > 1) issue.key = 'duplicate';
    if (e.label.trim() === '') issue.label = 'missing';
    if (issue.key || issue.label) issues.set(e.uid, issue);
  }
  return issues;
}

/** Freier, noch nicht verwendeter Schlüssel (hängt _2, _3 … an). */
export function uniqueKey(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** Bedingung als lesbarer Satz: „Kaderstatus ist einer von „OK“, „PK““. */
export function conditionText(
  i: Pick<I18n, 't' | 'fmt' | 'lang'>,
  c: Condition,
  columns: readonly { key: string; label: string; type: FieldType }[],
): string {
  const col = columns.find((x) => x.key === c.column);
  const label = col?.label ?? c.column;
  const op = i.t(`conditionOps.${c.op}`);
  if (c.op === 'is_null' || c.op === 'not_null') return `${label} ${op}`;
  const quote = (s: string) => (i.lang === 'de' ? `„${s}“` : `“${s}”`);
  const one = (v: Scalar) =>
    typeof v === 'string' && (!col || col.type === 'string' || col.type === 'enum')
      ? quote(v)
      : formatScalar(i, v, col?.type);
  const value = Array.isArray(c.value) ? c.value.map(one).join(', ') : one(c.value ?? null);
  return `${label} ${op} ${value}`;
}
