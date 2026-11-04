/**
 * Weboberfläche: Jeder Code, den der Server an die Oberfläche schickt (Fehlercode, Detailgrund, Prüfcode,
 * Statusgrund), muss in beiden Sprachen übersetzbar sein – die Oberfläche zeigt nie Server-Freitext und
 * sonst „Unbekannter Code (…)“. Dazu die Hilfen, die Feldpfade, Importangaben und Gründe aufbereiten.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DENY_REASONS } from '../../src/server/modules/releases/engine.ts';
import { FederationErrorCode } from '../../src/shared/contract/federation-wire.ts';
import { ERROR_CODES, IMPORT_ERROR_CODES, IMPORT_FAILURE_CODES } from '../../src/shared/contract/index.ts';
import { importCodeText, importParamTexts } from '../../src/ui/components/connectors/shared.ts';
import { createTranslator, type Lang } from '../../src/ui/i18n/index.tsx';
import { ApiError } from '../../src/ui/lib/api.ts';
import {
  codeText,
  describeError,
  rawFieldError,
  reasonText,
  receivedReasonText,
  revocationReasonText,
} from '../../src/ui/lib/errors.ts';

const LANGS: Lang[] = ['de', 'en'];
const SERVER_DIR = join(import.meta.dir, '../../src/server');

function serverSources(dir = SERVER_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return serverSources(path);
    return name.endsWith('.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}

/** Detailgründe, die der Server als Literal in Fehlerantworten schreibt (conflict, AppError, PeerCallError) */
function literalReasons(): string[] {
  const found = new Set<string>();
  const patterns = [
    /conflict\('([a-z_]+)'\)/g,
    /new AppError\('[a-z_]+', \{ reason: '([a-z_]+)'/g,
    /new PeerCallError\('[a-z_]+', \{ reason: '([a-z_]+)'/g,
  ];
  for (const src of serverSources()) {
    for (const re of patterns) for (const m of src.matchAll(re)) found.add(m[1] as string);
  }
  return [...found].sort();
}

/** Gründe aus Rückgabewerten statt Literalen (Passwortregel, Quellabruf, Sicherung, BI, Pull-Prüfung, Austausch) */
const COMPUTED_REASONS = [
  'too_short',
  'equals_email',
  'equals_current',
  'insecure_http',
  'too_many_columns',
  'too_many_rows',
  'network',
  'timeout',
  'too_large',
  'not_json',
  'items_not_array',
  'invalid_url',
  'https_required',
  'backup_key_missing',
  'backup_dir_unavailable',
  'pg_dump_unavailable',
  'pg_dump_failed',
  'backup_write_failed',
  'refresh_failed',
  'no_purpose',
  'release_mismatch',
  'purpose_mismatch',
  'invalid_columns',
  'invalid_subject',
  'unexpected_column',
  'audit_failed',
  'session_required',
];

describe('UI: Übersetzung aller Server-Codes', () => {
  test('die Suche nach Literalen findet die bekannten Gründe', () => {
    const reasons = literalReasons();
    for (const r of ['slug_exists', 'email_exists', 'backup_running', 'session_required', 'insecure_http']) {
      expect(reasons).toContain(r);
    }
  });

  for (const lang of LANGS) {
    const i = createTranslator(lang);
    const unknown = i.t('common.unknownCode', { code: '' }).replace(/\(\)$/, '');

    test(`${lang}: Fehlercodes, Ablehnungs- und Föderationscodes`, () => {
      for (const code of ERROR_CODES) expect(i.tx(`errors.${code}`)).toBeString();
      for (const r of DENY_REASONS) expect(reasonText(i, r)).toBeString();
      for (const c of FederationErrorCode.options) expect(codeText(i, c)).not.toStartWith(unknown);
    });

    test(`${lang}: Detailgründe (error.reason) aus dem Servercode`, () => {
      const missing = [...literalReasons(), ...COMPUTED_REASONS].filter((r) => !reasonText(i, r));
      expect(missing).toEqual([]);
    });

    test(`${lang}: Prüf- und Fehlercodes von Importen`, () => {
      for (const code of IMPORT_ERROR_CODES) expect(importCodeText(i, code)).not.toStartWith(unknown);
      for (const code of IMPORT_FAILURE_CODES) expect(codeText(i, code)).not.toStartWith(unknown);
    });

    test(`${lang}: Statusgründe empfangener Daten`, () => {
      for (const r of [
        'revoked',
        'expired',
        'release_expired',
        'product_retired',
        'product_inactive',
        'dataset_reclassified',
      ]) {
        expect(receivedReasonText(i, r)).not.toStartWith(unknown);
      }
    });
  }
});

describe('UI: Aufbereitung von Fehlern und Gründen', () => {
  const de = createTranslator('de');

  test('HTTP-Status einer Datenquelle (http_<status>)', () => {
    expect(reasonText(de, 'http_401')).toBe('Die Datenquelle hat mit HTTP-Status 401 geantwortet.');
  });

  test('Feldfehler: Präfix body., Unterpfade und Freigabevorschau (body.release.)', () => {
    const err = new ApiError({
      status: 422,
      code: 'release_invalid',
      fields: { 'body.columns.3': 'unknown_column', 'body.release.dataUntil': 'invalid_data_window' },
    });
    expect(rawFieldError(err, 'columns')).toBe('unknown_column');
    expect(rawFieldError(err, 'dataUntil')).toBe('invalid_data_window');
    expect(rawFieldError(err, 'dataFrom')).toBeUndefined();
  });

  test('Detailgrund erscheint als zweite Zeile, nie als Freitext', () => {
    const d = describeError(
      de,
      new ApiError({ status: 400, code: 'source_not_allowed', reason: 'insecure_http' }),
    );
    expect(d.message).toBe('Die Adresse der Datenquelle ist für Abrufe nicht freigegeben.');
    expect(d.detail).toContain('HTTPS');
  });

  test('Statusgrund: Code übersetzt, Begründung des Datenhalters als Zitat', () => {
    expect(receivedReasonText(de, 'dataset_reclassified')).toContain('neu eingestuft');
    expect(receivedReasonText(de, 'Kooperation beendet (Demo)')).toBe(
      'Begründung des Datenhalters: „Kooperation beendet (Demo)“',
    );
    expect(revocationReasonText(de, 'product_retired')).toBe('Das Datenprodukt ist stillgelegt.');
    expect(revocationReasonText(de, 'Kooperation beendet')).toBe('Kooperation beendet');
  });

  test('Importangaben lesbar: Spalte, Felder, Löschung nach der Vorschau', () => {
    expect(importParamTexts(de, { column: 'Geburtsdatum', format: 'DD.MM.YYYY' })).toEqual([
      'Spalte: Geburtsdatum',
      'Format: DD.MM.YYYY',
    ]);
    expect(
      importParamTexts(de, {
        reason: 'natural_key_conflict',
        fields: 'athlete.last_name,athlete.first_name,athlete.date_of_birth',
      }),
    ).toEqual([
      'Grund: Kennung und Name/Geburtsdatum gehören zu verschiedenen Personen',
      'Felder: Nachname, Vorname, Geburtsdatum',
    ]);
    expect(importParamTexts(de, { max: '2026-11-05' })).toEqual(['Höchstens: 05.11.2026']);
    expect(importCodeText(de, 'athlete_not_found', { phase: 'erasure' })).toBe(
      'Die Person wurde zwischenzeitlich gelöscht; die Zeile wird nicht übernommen.',
    );
    expect(importParamTexts(de, { phase: 'erasure' })).toEqual([
      'Bemerkt: durch Löschung der Person nach der Vorschau',
    ]);
  });
});
