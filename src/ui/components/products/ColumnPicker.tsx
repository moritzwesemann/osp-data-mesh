import { type ReactNode, useState } from 'react';
import { useI18n } from '../../i18n/index.tsx';
import { uid } from '../../lib/util.ts';
import { Checkbox, Fieldset } from '../FormField.tsx';
import { EmptyState } from '../QueryState.tsx';
import {
  type ColumnEntry,
  columnIssues,
  defaultKey,
  type SourceGroup,
  type SourceOption,
  uniqueKey,
} from './sources.ts';

interface Props {
  options: readonly SourceOption[];
  value: readonly ColumnEntry[];
  onChange: (next: ColumnEntry[]) => void;
  /** Serverseitige Feldfehler je Spalte (Index, Feld) */
  serverError?: (index: number, field: 'key' | 'label') => string | undefined;
  /** Hinweis unter den verfügbaren Feldern (z. B. „Datensatz wählen“) */
  notice?: ReactNode;
  /** Fehler für die Spaltenliste insgesamt (z. B. keine Spalte gewählt) */
  error?: string;
  disabled?: boolean;
}

const GROUPS: readonly SourceGroup[] = ['athlete', 'record', 'data'];

/** Auswahl, Benennung und Reihenfolge der Produktspalten. */
export function ColumnPicker({ options, value, onChange, serverError, notice, error, disabled }: Props) {
  const i = useI18n();
  const { t } = i;
  const selected = new Set(value.map((c) => c.source));
  const issues = columnIssues(value);

  const groupLabel = (g: SourceGroup) =>
    g === 'athlete'
      ? t('products.groupAthlete')
      : g === 'record'
        ? t('products.groupRecord')
        : t('products.groupData');

  const toggle = (o: SourceOption, on: boolean) => {
    if (on) {
      const key = uniqueKey(
        defaultKey(o.source),
        value.map((c) => c.key),
      );
      onChange([...value, { uid: uid('col'), source: o.source, key, label: o.label }]);
    } else {
      onChange(value.filter((c) => c.source !== o.source));
    }
  };

  const patch = (id: string, p: Partial<ColumnEntry>) =>
    onChange(value.map((c) => (c.uid === id ? { ...c, ...p } : c)));

  const move = (index: number, delta: -1 | 1) => {
    const next = [...value];
    const target = index + delta;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    onChange(next);
  };

  const fieldName = (c: ColumnEntry) => options.find((o) => o.source === c.source)?.label ?? c.source;

  // Spaltenschlüssel nur bei Bedarf: eingeblendet bei eigenem Schlüssel oder Schlüsselfehler, sonst über den Schalter
  const keysNeeded = value.some(
    (c, n) =>
      c.key !== defaultKey(c.source) || Boolean(issues.get(c.uid)?.key) || Boolean(serverError?.(n, 'key')),
  );
  const [showKeys, setShowKeys] = useState(keysNeeded);
  const [lastNeeded, setLastNeeded] = useState(keysNeeded);
  if (keysNeeded !== lastNeeded) {
    setLastNeeded(keysNeeded);
    if (keysNeeded) setShowKeys(true);
  }

  return (
    <div className="stack">
      <Fieldset legend={t('products.availableFields')}>
        {GROUPS.map((g) => {
          const opts = options.filter((o) => o.group === g);
          if (opts.length === 0) return null;
          return (
            <div key={g} className="stack-sm">
              <p className="field-label">{groupLabel(g)}</p>
              <div className="checkbox-grid">
                {opts.map((o) => (
                  <Checkbox
                    key={o.source}
                    checked={selected.has(o.source)}
                    disabled={disabled}
                    onChange={(on) => toggle(o, on)}
                    label={
                      <>
                        {o.label}{' '}
                        <span className="muted small">
                          ({t(`fieldTypes.${o.type}`)}
                          {o.unit ? `, ${o.unit}` : ''})
                        </span>
                      </>
                    }
                  />
                ))}
              </div>
            </div>
          );
        })}
        {notice}
      </Fieldset>

      <div className="stack-sm">
        <div className="row-between">
          <h3>{t('products.selectedColumns')}</h3>
          {value.length > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-expanded={showKeys}
              onClick={() => setShowKeys((v) => !v)}
            >
              {showKeys ? t('products.hideKeys') : t('products.showKeys')}
            </button>
          )}
        </div>
        {showKeys && <p className="field-hint">{t('products.columnKeyHint')}</p>}
        {value.length === 0 ? (
          <EmptyState message={t('products.noColumnsSelected')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col" className="num">
                    #
                  </th>
                  <th scope="col">{t('products.columnField')}</th>
                  {showKeys && <th scope="col">{t('products.columnKey')}</th>}
                  <th scope="col">{t('products.columnLabel')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {value.map((c, n) => {
                  const issue = issues.get(c.uid);
                  const field = fieldName(c);
                  const keyError =
                    issue?.key === 'invalid'
                      ? t('products.invalidKey')
                      : issue?.key === 'duplicate'
                        ? t('products.duplicateKey')
                        : serverError?.(n, 'key');
                  const labelError = issue?.label ? t('products.missingLabel') : serverError?.(n, 'label');
                  const keyErrId = `${c.uid}-key-err`;
                  const labelErrId = `${c.uid}-label-err`;
                  return (
                    <tr key={c.uid}>
                      <td className="num muted">{n + 1}</td>
                      <td>
                        <div>{field}</div>
                        {showKeys && <div className="muted small mono">{c.source}</div>}
                      </td>
                      {showKeys && (
                        <td>
                          <input
                            className="input mono"
                            style={{ minWidth: 140 }}
                            value={c.key}
                            disabled={disabled}
                            aria-label={t('products.columnKeyFor', { field })}
                            aria-invalid={keyError ? true : undefined}
                            aria-describedby={keyError ? keyErrId : undefined}
                            onChange={(e) => patch(c.uid, { key: e.target.value.trim() })}
                          />
                          {keyError && (
                            <p id={keyErrId} className="field-error">
                              {keyError}
                            </p>
                          )}
                        </td>
                      )}
                      <td>
                        <input
                          className="input"
                          style={{ minWidth: 180 }}
                          value={c.label}
                          disabled={disabled}
                          aria-label={t('products.columnLabelFor', { field })}
                          aria-invalid={labelError ? true : undefined}
                          aria-describedby={labelError ? labelErrId : undefined}
                          onChange={(e) => patch(c.uid, { label: e.target.value })}
                        />
                        {labelError && (
                          <p id={labelErrId} className="field-error">
                            {labelError}
                          </p>
                        )}
                      </td>
                      <td className="nowrap">
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={disabled || n === 0}
                          aria-label={t('products.moveUpFor', { field })}
                          title={t('products.moveUp')}
                          onClick={() => move(n, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={disabled || n === value.length - 1}
                          aria-label={t('products.moveDownFor', { field })}
                          title={t('products.moveDown')}
                          onClick={() => move(n, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={disabled}
                          aria-label={t('products.removeFor', { field })}
                          title={t('common.remove')}
                          onClick={() => onChange(value.filter((x) => x.uid !== c.uid))}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
