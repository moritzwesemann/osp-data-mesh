/**
 * Bedingungs-Editor für Basisfilter (Produkte) und Zeilenbeschränkungen (Freigaben).
 * Bearbeitet Entwürfe (Rohtext je Wert); draftsToConditions() liefert typisierte Bedingungen.
 */
import type { Condition, ConditionOp, FieldType } from '../../shared/contract/index.ts';
import { useI18n } from '../i18n/index.tsx';
import { isoToLocalInput, uid } from '../lib/util.ts';
import { EmptyState } from './QueryState.tsx';

export interface FilterColumn {
  key: string;
  label: string;
  type: FieldType;
  enumValues?: readonly string[];
}

export interface ConditionDraft {
  uid: string;
  column: string;
  op: ConditionOp;
  raw: string;
}

const ALL_OPS: readonly ConditionOp[] = [
  'eq',
  'neq',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_null',
  'not_null',
];
const BOOL_OPS: readonly ConditionOp[] = ['eq', 'neq', 'is_null', 'not_null'];
const LIST_SEP = ';';

export function opsFor(type: FieldType | undefined): readonly ConditionOp[] {
  return type === 'boolean' ? BOOL_OPS : ALL_OPS;
}

export function newDraft(column = ''): ConditionDraft {
  return { uid: uid('c'), column, op: 'eq', raw: '' };
}

function scalarToRaw(v: unknown, type: FieldType | undefined): string {
  if (v === null || v === undefined) return '';
  if (type === 'datetime' && typeof v === 'string') return isoToLocalInput(v);
  return String(v);
}

/** Bestehende Bedingung → Entwurf (zum Bearbeiten). */
export function conditionToDraft(c: Condition, columns: readonly FilterColumn[]): ConditionDraft {
  const type = columns.find((x) => x.key === c.column)?.type;
  const raw = Array.isArray(c.value)
    ? c.value.map((v) => scalarToRaw(v, type)).join(`${LIST_SEP} `)
    : scalarToRaw(c.value, type);
  return { uid: uid('c'), column: c.column, op: c.op, raw };
}

function parseScalar(raw: string, type: FieldType): string | number | boolean | undefined {
  const s = raw.trim();
  if (s === '') return undefined;
  switch (type) {
    case 'integer':
      return /^-?\d+$/.test(s) ? Number(s) : undefined;
    case 'number': {
      const n = Number(s.replace(',', '.'));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return s === 'true' ? true : s === 'false' ? false : undefined;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
    case 'datetime': {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    default:
      return s;
  }
}

/** Entwurf → Bedingung; null, wenn Spalte fehlt oder der Wert nicht zum Typ passt. */
export function draftToCondition(d: ConditionDraft, columns: readonly FilterColumn[]): Condition | null {
  const col = columns.find((c) => c.key === d.column);
  if (!col) return null;
  if (d.op === 'is_null' || d.op === 'not_null') return { column: d.column, op: d.op };
  if (d.op === 'in' || d.op === 'nin') {
    const parts = d.raw
      .split(LIST_SEP)
      .map((p) => p.trim())
      .filter((p) => p !== '');
    if (parts.length === 0) return null;
    const values = parts.map((p) => parseScalar(p, col.type));
    if (values.some((v) => v === undefined)) return null;
    return { column: d.column, op: d.op, value: values as (string | number | boolean)[] };
  }
  const v = parseScalar(d.raw, col.type);
  if (v === undefined) return null;
  return { column: d.column, op: d.op, value: v };
}

export function draftsToConditions(
  drafts: readonly ConditionDraft[],
  columns: readonly FilterColumn[],
): { conditions: Condition[]; invalid: string[] } {
  const conditions: Condition[] = [];
  const invalid: string[] = [];
  for (const d of drafts) {
    const c = draftToCondition(d, columns);
    if (c) conditions.push(c);
    else invalid.push(d.uid);
  }
  return { conditions, invalid };
}

interface Props {
  columns: readonly FilterColumn[];
  value: readonly ConditionDraft[];
  onChange: (next: ConditionDraft[]) => void;
  /** uids ungültiger Zeilen (Markierung) */
  invalid?: readonly string[];
  disabled?: boolean;
}

export function ConditionBuilder({ columns, value, onChange, invalid = [], disabled }: Props) {
  const { t } = useI18n();

  const update = (id: string, patch: Partial<ConditionDraft>) =>
    onChange(value.map((d) => (d.uid === id ? { ...d, ...patch } : d)));

  return (
    <div className="conditions">
      {value.length === 0 ? (
        <EmptyState message={t('conditions.none')} />
      ) : (
        <>
          <p className="field-hint">{t('conditions.allMustMatch')}</p>
          <ol className="condition-list">
            {value.map((d, n) => {
              const col = columns.find((c) => c.key === d.column);
              const ops = opsFor(col?.type);
              const isInvalid = invalid.includes(d.uid);
              const base = `${d.uid}-`;
              return (
                <li key={d.uid} className={isInvalid ? 'condition-row field-invalid' : 'condition-row'}>
                  <span className="sr-only">{t('conditions.rowLabel', { n: n + 1 })}</span>
                  <div className="field">
                    <label className="field-label" htmlFor={`${base}col`}>
                      {t('conditions.column')}
                    </label>
                    <select
                      id={`${base}col`}
                      className="input"
                      value={d.column}
                      disabled={disabled}
                      onChange={(e) => {
                        const nextCol = columns.find((c) => c.key === e.target.value);
                        const nextOps = opsFor(nextCol?.type);
                        update(d.uid, {
                          column: e.target.value,
                          op: nextOps.includes(d.op) ? d.op : 'eq',
                          raw: '',
                        });
                      }}
                    >
                      <option value="">{t('common.select')}</option>
                      {columns.map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor={`${base}op`}>
                      {t('conditions.operator')}
                    </label>
                    <select
                      id={`${base}op`}
                      className="input"
                      value={d.op}
                      disabled={disabled}
                      onChange={(e) => update(d.uid, { op: e.target.value as ConditionOp })}
                    >
                      {ops.map((op) => (
                        <option key={op} value={op}>
                          {t(`conditionOps.${op}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    {d.op !== 'is_null' && d.op !== 'not_null' && (
                      <>
                        <label className="field-label" htmlFor={`${base}val`}>
                          {t('conditions.value')}
                        </label>
                        <ValueInput
                          id={`${base}val`}
                          draft={d}
                          column={col}
                          disabled={disabled}
                          invalid={isInvalid}
                          onChange={(raw) => update(d.uid, { raw })}
                        />
                        {(d.op === 'in' || d.op === 'nin') && (
                          <p className="field-hint">{t('conditions.listHint')}</p>
                        )}
                        {isInvalid && <p className="field-error">{t('conditions.invalidValue')}</p>}
                      </>
                    )}
                  </div>
                  <div className="condition-remove">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={disabled}
                      onClick={() => onChange(value.filter((x) => x.uid !== d.uid))}
                    >
                      {t('conditions.remove')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled || columns.length === 0}
        onClick={() => onChange([...value, newDraft(columns[0]?.key ?? '')])}
      >
        {t('conditions.add')}
      </button>
    </div>
  );
}

function ValueInput({
  id,
  draft,
  column,
  disabled,
  invalid,
  onChange,
}: {
  id: string;
  draft: ConditionDraft;
  column: FilterColumn | undefined;
  disabled?: boolean;
  invalid: boolean;
  onChange: (raw: string) => void;
}) {
  const { t } = useI18n();
  const list = draft.op === 'in' || draft.op === 'nin';
  const common = {
    id,
    className: 'input',
    disabled,
    'aria-invalid': invalid || undefined,
    value: draft.raw,
  } as const;
  const type = column?.type ?? 'string';
  if (!list && type === 'boolean') {
    return (
      <select {...common} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('common.select')}</option>
        <option value="true">{t('common.yes')}</option>
        <option value="false">{t('common.no')}</option>
      </select>
    );
  }
  if (!list && type === 'enum' && column?.enumValues && column.enumValues.length > 0) {
    return (
      <select {...common} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('common.select')}</option>
        {column.enumValues.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }
  if (!list && type === 'date')
    return <input {...common} type="date" onChange={(e) => onChange(e.target.value)} />;
  if (!list && type === 'datetime')
    return <input {...common} type="datetime-local" onChange={(e) => onChange(e.target.value)} />;
  const numeric = type === 'integer' || type === 'number';
  return (
    <input
      {...common}
      type="text"
      inputMode={numeric && !list ? 'decimal' : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
