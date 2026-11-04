/**
 * Feldzuordnung einer Quelle: Beispiel analysieren (connectors.inspect), je Quellfeld ein Zielfeld
 * wählen, optional Umwandlung, Ersatzwert und Wertübersetzung.
 */
import { type Dispatch, type KeyboardEvent, type SetStateAction, useState } from 'react';
import type { z } from 'zod';
import type { ConnectorConfig, FieldMapping } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import type { ApiOutput } from '../../lib/api.ts';
import { useApiMutation } from '../../lib/query.ts';
import { uid } from '../../lib/util.ts';
import { ErrorMessage } from '../ErrorMessage.tsx';
import { FormField } from '../FormField.tsx';
import { EmptyState } from '../QueryState.tsx';
import { ResultTable } from '../ResultTable.tsx';
import { delimiterLabel, formatKv, parseKv, type TargetOption } from './shared.ts';

export type Transform = FieldMapping['transform'];
const TRANSFORMS: readonly Transform[] = ['none', 'trim', 'upper', 'lower'];

export interface MappingDraft {
  uid: string;
  source: string;
  /** '' = nicht übernehmen */
  target: string;
  transform: Transform;
  defaultValue: string;
  valueMapText: string;
}

export type MappingField = 'source' | 'target' | 'transform' | 'defaultValue' | 'valueMap';

export function newMappingDraft(source: string, target = ''): MappingDraft {
  return { uid: uid('m'), source, target, transform: 'trim', defaultValue: '', valueMapText: '' };
}

export function draftsFromMapping(mapping: readonly FieldMapping[]): MappingDraft[] {
  return mapping.map((m) => ({
    uid: uid('m'),
    source: m.source,
    target: m.target,
    transform: m.transform,
    defaultValue: m.defaultValue ?? '',
    valueMapText: formatKv(m.valueMap),
  }));
}

/** Entwürfe → Zuordnungen (nur Zeilen mit Zielfeld); mappedUids in derselben Reihenfolge. */
export function buildMapping(drafts: readonly MappingDraft[]): {
  mapping: z.input<typeof FieldMapping>[];
  mappedUids: string[];
  invalidValueMaps: string[];
} {
  const mapping: z.input<typeof FieldMapping>[] = [];
  const mappedUids: string[] = [];
  const invalidValueMaps: string[] = [];
  for (const d of drafts) {
    if (!d.target) continue;
    const vm = parseKv(d.valueMapText);
    if (vm.invalid) invalidValueMaps.push(d.uid);
    const entry: z.input<typeof FieldMapping> = {
      source: d.source.trim(),
      target: d.target,
      transform: d.transform,
    };
    if (Object.keys(vm.map).length > 0) entry.valueMap = vm.map;
    if (d.defaultValue.trim() !== '') entry.defaultValue = d.defaultValue.trim();
    mapping.push(entry);
    mappedUids.push(d.uid);
  }
  return { mapping, mappedUids, invalidValueMaps };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

/** Zielfeld anhand des Spaltennamens vorschlagen (exakter Abgleich mit Feldname oder Bezeichnung). */
function guessTarget(column: string, options: readonly TargetOption[], used: Set<string>): string {
  const n = normalize(column);
  if (!n) return '';
  for (const o of options) {
    if (used.has(o.value)) continue;
    const key = normalize(o.value.replace(/^(athlete|data)\./, ''));
    if (key === n || normalize(o.label) === n) return o.value;
  }
  return '';
}

type InspectResult = ApiOutput<'connectors.inspect'>;

interface Props {
  kind: 'csv_upload' | 'http_api';
  /** aktuelle Konfiguration (für die Analyse) */
  config: z.input<typeof ConnectorConfig>;
  options: readonly TargetOption[];
  datasetName: string | null;
  value: readonly MappingDraft[];
  setValue: Dispatch<SetStateAction<MappingDraft[]>>;
  /** übersetzter Fehler je Zeile und Feld */
  rowError: (uid: string, field: MappingField) => string | undefined;
  invalidValueMaps: readonly string[];
  /** allgemeiner Fehler der Zuordnung (z. B. leer) */
  error?: string;
}

export function MappingEditor({
  kind,
  config,
  options,
  datasetName,
  value,
  setValue,
  rowError,
  invalidValueMaps,
  error,
}: Props) {
  const i = useI18n();
  const { t } = i;
  const [file, setFile] = useState<File | null>(null);
  const [sample, setSample] = useState<InspectResult | null>(null);
  const [newSource, setNewSource] = useState('');

  const inspect = useApiMutation('connectors.inspect');

  const runInspect = () => {
    const fd = new FormData();
    if (kind === 'csv_upload') {
      if (!file) return;
      fd.append('file', file);
    }
    fd.append('config', JSON.stringify(config));
    inspect.mutate(
      { body: fd },
      {
        onSuccess: (result) => {
          setSample(result);
          setValue((prev) => {
            const known = new Set(prev.map((d) => d.source));
            const used = new Set(prev.map((d) => d.target).filter(Boolean));
            const added: MappingDraft[] = [];
            for (const col of result.columns) {
              if (known.has(col)) continue;
              const target = guessTarget(col, options, used);
              if (target) used.add(target);
              added.push(newMappingDraft(col, target));
            }
            return [...prev, ...added];
          });
        },
      },
    );
  };

  const update = (id: string, patch: Partial<MappingDraft>) =>
    setValue((prev) => prev.map((d) => (d.uid === id ? { ...d, ...patch } : d)));

  const addSource = () => {
    const s = newSource.trim();
    if (!s) return;
    setValue((prev) => (prev.some((d) => d.source === s) ? prev : [...prev, newMappingDraft(s)]));
    setNewSource('');
  };

  const onNewSourceKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSource();
    }
  };

  const targetCounts = new Map<string, number>();
  for (const d of value) if (d.target) targetCounts.set(d.target, (targetCounts.get(d.target) ?? 0) + 1);
  const mappedCount = value.filter((d) => d.target).length;
  const athleteOptions = options.filter((o) => o.group === 'athlete');
  const dataOptions = options.filter((o) => o.group === 'data');

  return (
    <div className="stack">
      <p className="field-hint">
        {kind === 'csv_upload' ? t('connectors.mappingIntroCsv') : t('connectors.mappingIntroApi')}
      </p>

      <div className="toolbar">
        {kind === 'csv_upload' && (
          <FormField label={t('connectors.sampleFile')} className="field-grow">
            {(a) => (
              <input
                {...a}
                className="input"
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            )}
          </FormField>
        )}
        <button
          type="button"
          className="btn"
          disabled={inspect.isPending || (kind === 'csv_upload' && !file)}
          onClick={runInspect}
        >
          {inspect.isPending
            ? t('connectors.analyzing')
            : kind === 'csv_upload'
              ? t('connectors.analyze')
              : t('connectors.fetchSample')}
        </button>
      </div>
      {inspect.error && <ErrorMessage error={inspect.error} />}

      {sample && (
        <div className="stack-sm">
          <p className="small">
            {t('connectors.detectedColumns', { count: sample.columns.length })}
            {sample.detectedDelimiter !== null && (
              <>
                {' '}
                {t('connectors.detectedDelimiter', { value: delimiterLabel(i, sample.detectedDelimiter) })}
              </>
            )}
          </p>
          {sample.sampleRows.length > 0 && (
            <>
              <h3 className="small">{t('connectors.sampleRows')}</h3>
              <ResultTable
                caption={t('connectors.sampleRows')}
                numbered
                columns={sample.columns.map((c) => ({ key: c, label: c, type: 'string' as const }))}
                rows={sample.sampleRows.slice(0, 5)}
              />
            </>
          )}
        </div>
      )}

      {value.length === 0 ? (
        <EmptyState message={t('connectors.mappingEmpty')} />
      ) : (
        <>
          <p className="small muted">
            {t('connectors.mappedCount', { count: mappedCount, total: value.length })}
          </p>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">{t('connectors.sectionMapping')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('connectors.sourceField')}</th>
                  <th scope="col">{t('connectors.targetField')}</th>
                  <th scope="col">{t('connectors.transform')}</th>
                  <th scope="col">{t('connectors.defaultValue')}</th>
                  <th scope="col">{t('connectors.valueMap')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {value.map((d) => {
                  const dup = d.target !== '' && (targetCounts.get(d.target) ?? 0) > 1;
                  const sourceErr = rowError(d.uid, 'source');
                  const targetErr =
                    rowError(d.uid, 'target') ?? (dup ? t('connectors.duplicateTarget') : undefined);
                  const defaultErr = rowError(d.uid, 'defaultValue');
                  const vmErr = invalidValueMaps.includes(d.uid)
                    ? t('connectors.kvInvalid')
                    : rowError(d.uid, 'valueMap');
                  const label = (field: string) => `${field}: ${d.source || '…'}`;
                  return (
                    <tr key={d.uid}>
                      <td>
                        <input
                          className="input mono input-cell-md"
                          aria-label={label(t('connectors.sourceField'))}
                          aria-invalid={sourceErr ? true : undefined}
                          value={d.source}
                          onChange={(e) => update(d.uid, { source: e.target.value })}
                        />
                        {sourceErr && <p className="field-error">{sourceErr}</p>}
                      </td>
                      <td>
                        <select
                          className="input input-cell-lg"
                          aria-label={label(t('connectors.targetField'))}
                          aria-invalid={targetErr ? true : undefined}
                          value={d.target}
                          onChange={(e) => update(d.uid, { target: e.target.value })}
                        >
                          <option value="">{t('connectors.notMapped')}</option>
                          <optgroup label={t('connectors.groupAthlete')}>
                            {athleteOptions.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </optgroup>
                          {dataOptions.length > 0 && (
                            <optgroup label={t('connectors.groupDataset', { name: datasetName ?? '' })}>
                              {dataOptions.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </optgroup>
                          )}
                          {d.target !== '' && !options.some((o) => o.value === d.target) && (
                            <option value={d.target}>{d.target}</option>
                          )}
                        </select>
                        {targetErr && <p className="field-error">{targetErr}</p>}
                      </td>
                      <td>
                        <select
                          className="input input-cell-md"
                          aria-label={label(t('connectors.transform'))}
                          value={d.transform}
                          disabled={!d.target}
                          onChange={(e) => update(d.uid, { transform: e.target.value as Transform })}
                        >
                          {TRANSFORMS.map((tr) => (
                            <option key={tr} value={tr}>
                              {t(`transform.${tr}`)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="input input-cell-sm"
                          aria-label={label(t('connectors.defaultValue'))}
                          aria-invalid={defaultErr ? true : undefined}
                          value={d.defaultValue}
                          disabled={!d.target}
                          onChange={(e) => update(d.uid, { defaultValue: e.target.value })}
                        />
                        {defaultErr && <p className="field-error">{defaultErr}</p>}
                      </td>
                      <td>
                        <textarea
                          className="input mono input-cell-lg input-cell-area"
                          rows={1}
                          aria-label={label(t('connectors.valueMap'))}
                          aria-invalid={vmErr ? true : undefined}
                          placeholder={t('connectors.valueMapHint')}
                          value={d.valueMapText}
                          disabled={!d.target}
                          onChange={(e) => update(d.uid, { valueMapText: e.target.value })}
                        />
                        {vmErr && <p className="field-error">{vmErr}</p>}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setValue((prev) => prev.filter((x) => x.uid !== d.uid))}
                        >
                          {t('connectors.removeMapping')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="field-hint">{t('connectors.valueMapHint')}</p>
        </>
      )}
      {error && <p className="field-error">{error}</p>}

      <div className="toolbar">
        <FormField label={t('connectors.newSourceField')} className="field-grow">
          {(a) => (
            <input
              {...a}
              className="input mono"
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              onKeyDown={onNewSourceKey}
            />
          )}
        </FormField>
        <button type="button" className="btn" disabled={!newSource.trim()} onClick={addSource}>
          {t('connectors.addSource')}
        </button>
      </div>
    </div>
  );
}
