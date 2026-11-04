/**
 * Gemeinsame Hilfen für Quellen (Connectoren) und Importläufe.
 */
import { useCallback } from 'react';
import type { CsvConfig, Dataset, DateFormat } from '../../../shared/contract/index.ts';
import { type I18n, useI18n } from '../../i18n/index.tsx';
import { api, saveJson } from '../../lib/api.ts';
import { codeText, describeError } from '../../lib/errors.ts';
import { useToast } from '../Toast.tsx';

type Tr = Pick<I18n, 't' | 'tx'>;

export const ATHLETE_TARGETS = [
  'last_name',
  'first_name',
  'date_of_birth',
  'sport',
  'squad_status',
  'sex',
  'club',
  'discipline',
  'external_id',
] as const;
export type AthleteTarget = (typeof ATHLETE_TARGETS)[number];

export interface TargetOption {
  value: string;
  label: string;
  group: 'athlete' | 'data';
}

/** Zielfelder: Athletenkern (immer) und Felder des gewählten Datensatzes. */
export function targetOptions(i: Tr, dataset: Pick<Dataset, 'fields'> | null | undefined): TargetOption[] {
  const athlete = ATHLETE_TARGETS.map<TargetOption>((k) => ({
    value: `athlete.${k}`,
    label: i.t(`connectors.athleteTargets.${k}`),
    group: 'athlete',
  }));
  const data = (dataset?.fields ?? []).map<TargetOption>((f) => ({
    value: `data.${f.name}`,
    label: f.label,
    group: 'data',
  }));
  return [...athlete, ...data];
}

/** Lesbare Bezeichnung eines Zielfelds (athlete.* übersetzt, data.* mit Feldbezeichnung). */
export function targetLabel(
  i: Tr,
  target: string,
  dataset: Pick<Dataset, 'fields'> | null | undefined,
): string {
  if (target.startsWith('athlete.')) {
    return i.tx(`connectors.athleteTargets.${target.slice(8)}`) ?? target;
  }
  if (target.startsWith('data.')) {
    const name = target.slice(5);
    return dataset?.fields.find((f) => f.name === name)?.label ?? name;
  }
  return target;
}

/** Zeilen "schlüssel=wert" → Objekt; invalid, wenn eine nicht leere Zeile kein "=" enthält. */
export function parseKv(text: string): { map: Record<string, string>; invalid: boolean } {
  const map: Record<string, string> = {};
  let invalid = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const at = line.indexOf('=');
    if (at <= 0) {
      invalid = true;
      continue;
    }
    map[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { map, invalid };
}

export function formatKv(map: Record<string, string> | undefined): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function delimiterLabel(i: Tr, d: CsvConfig['delimiter'] | string | null): string {
  switch (d) {
    case 'auto':
      return i.t('connectors.delimiterAuto');
    case ',':
      return i.t('connectors.delimiterComma');
    case ';':
      return i.t('connectors.delimiterSemicolon');
    case '\t':
      return i.t('connectors.delimiterTab');
    default:
      return d ? `„${d}“` : i.t('common.empty');
  }
}

export function dateFormatLabel(i: Tr, f: DateFormat): string {
  return f === 'ISO_DATETIME' ? i.t('connectors.dateFormatIso') : f;
}

export const ENCODING_LABELS: Record<CsvConfig['encoding'], string> = {
  'utf-8': 'UTF-8',
  'windows-1252': 'Windows-1252',
  'iso-8859-1': 'ISO-8859-1',
};

/** Prüfcode eines Imports übersetzen (Importcodes zuerst, dann allgemeine Codes). */
export function importCodeText(i: Tr, code: string, params?: Record<string, string | number>): string {
  // Person zwischen Vorschau und Übernahme gelöscht (Hinweis mit params.phase)
  if (code === 'athlete_not_found' && params?.phase !== undefined) return i.t('importErrors.athlete_removed');
  return i.tx(`importErrors.${code}`) ?? codeText(i, code);
}

type Fmt = Pick<I18n, 'fmt'>['fmt'];

/** Zusatzangaben eines Prüfeintrags lesbar machen, z. B. "Spalte: Geburtsdatum", "Felder: Nachname, Vorname". */
export function importParamTexts(i: Tr & { fmt: Fmt }, params: Record<string, string | number>): string[] {
  const value = (key: string, v: string | number): string => {
    if (typeof v === 'number') return i.fmt.number(v);
    switch (key) {
      case 'phase':
        return i.tx(`importParams.phases.${v}`) ?? v;
      case 'reason':
        return i.tx(`importParams.reasons.${v}`) ?? v;
      case 'fields':
        return v
          .split(',')
          .map((f) => targetLabel(i, f.trim(), null))
          .join(', ');
      case 'format':
        return v === 'ISO_DATETIME' ? i.t('connectors.dateFormatIso') : v;
      default:
        return /^\d{4}-\d{2}-\d{2}$/.test(v) ? i.fmt.date(v) : v;
    }
  };
  return Object.entries(params).map(([key, v]) => {
    const label = i.tx(`importParams.${key}`) ?? key;
    return `${label}: ${value(key, v)}`;
  });
}

/** Connector-Definition exportieren und als JSON-Datei speichern. */
export function useConnectorExport(): (connector: { id: string; slug: string }) => Promise<void> {
  const i = useI18n();
  const toast = useToast();
  return useCallback(
    async (connector) => {
      try {
        const def = await api('connectors.export', { params: { id: connector.id } });
        saveJson(def, `${connector.slug}.connector.json`);
        toast.success(i.t('connectors.exported'));
      } catch (e) {
        toast.error(describeError(i, e).message);
      }
    },
    [i, toast],
  );
}
