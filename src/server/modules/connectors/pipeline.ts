/**
 * Import-Pipeline als reine Funktionen (ohne Datenbank, ohne Netzwerk):
 *
 *   Bytes ─decodeText→ Text ─parseCsv→ SourceTable ─mapRow→ MappedRow[]
 *   JSON  ─tableFromItems→ SourceTable                    │
 *                                     resolveAthletes (mit AthleteLookup aus der DB)
 *                                     markDuplicates
 *                                     flagRecordUpdates (mit vorhandenen Einträgen aus der DB)
 *                                     summarize → Zähler, Vorschau, Fehlerprotokoll
 *
 * Datenbankzugriffe (Nachschlagen, Speichern, Übernahme) liegen in runs.ts.
 */
import { createHash } from 'node:crypto';
import Papa from 'papaparse';
import type { Scalar } from '../../../shared/contract/common.ts';
import type { AthleteMatch, CsvConfig, FieldMapping } from '../../../shared/contract/connectors.ts';
import type { FieldDef } from '../../../shared/contract/datasets.ts';
import {
  ATHLETE_FIELDS,
  type AthleteField,
  type Converted,
  type ConvertOptions,
  checkObservationDate,
  convertAthleteField,
  convertField,
  type ImportErrorCode,
  type IssueParams,
  localDate,
} from './validate.ts';

// ---------------------------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------------------------

export interface Issue {
  /** 1-basiert ohne Kopfzeile; 0 = betrifft die ganze Quelle */
  rowNumber: number;
  /** Mapping-Ziel (z. B. "athlete.date_of_birth", "data.vo2max") oder null */
  field: string | null;
  code: ImportErrorCode;
  severity: 'error' | 'warning';
  rawValue: string | null;
  params: IssueParams;
}

export interface SourceRow {
  rowNumber: number;
  raw: Record<string, string | null>;
}

/** Grund, aus dem eine Quelle nicht verarbeitet wird (Fehlercode des Laufs, params.max) */
export type SourceLimit = 'too_many_columns' | 'too_many_rows';

export interface SourceTable {
  columns: string[];
  rows: SourceRow[];
  /** strukturelle Probleme einzelner Zeilen (z. B. falsche Spaltenzahl) */
  issues: Issue[];
  /** Obergrenze überschritten: Quelle wurde nicht (vollständig) gelesen */
  limit?: SourceLimit;
}

export interface DatasetShape {
  fields: FieldDef[];
  keyFields: string[];
  observedAtField: string | null;
}

export interface PipelineContext {
  targetType: 'athletes' | 'dataset';
  mapping: FieldMapping[];
  athleteMatch: AthleteMatch;
  dataset: DatasetShape | null;
  convert: ConvertOptions;
}

export type AthleteValues = Partial<Record<AthleteField, string | null>>;

export interface MappedRow {
  rowNumber: number;
  raw: Record<string, string | null>;
  /** konvertierte Werte je Mapping-Ziel (für die Vorschau) */
  mapped: Record<string, Scalar>;
  /** Werte des Athletenkerns (nur zugeordnete Felder) */
  athlete: AthleteValues;
  /** Werte des Datensatzes (nur zugeordnete Felder) */
  data: Record<string, Scalar>;
  issues: Issue[];
  externalId: string | null;
  /** normalisierter natürlicher Schlüssel (Nachname|Vorname|Geburtsdatum) */
  naturalKey: string | null;
  recordKey: string | null;
  observedAt: string | null;
  /** zugeordnete vorhandene Person (oder null = neu anzulegen bzw. nicht gefunden) */
  athleteId: string | null;
  /** vorhandene Person/vorhandener Eintrag wird mit abweichenden Werten überschrieben */
  changed: boolean;
}

export interface AthleteLookup {
  /** Kennung (im System der Zuordnung) → Personen-ID */
  byExternalId: Map<string, string>;
  /** normalisierter natürlicher Schlüssel → Personen-IDs */
  byNaturalKey: Map<string, string[]>;
  /** aktuelle Werte vorhandener Personen (für Änderungshinweise) */
  athletes: Map<string, AthleteValues>;
}

export const PREVIEW_ROWS = 50;
/** Längster Wert, der in Vorschau und Beispielzeilen angezeigt wird (wie Rohwerte im Fehlerprotokoll) */
export const PREVIEW_VALUE_CHARS = 500;

/** Lange Texte für Vorschau und Beispielzeilen kürzen (vollständige Werte nur in der Verarbeitung) */
export function clipValues<T extends string | number | boolean | null | undefined>(
  record: Readonly<Record<string, T>>,
): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  for (const [k, v] of Object.entries(record)) {
    out[k] = (
      typeof v === 'string' && v.length > PREVIEW_VALUE_CHARS ? `${v.slice(0, PREVIEW_VALUE_CHARS)}…` : v
    ) as T;
  }
  return out;
}
export const SAMPLE_ROWS = 10;
/** Obergrenzen je Quelle (Schutz vor Überlastung des Knotens durch eine einzelne Datei/Antwort) */
export const MAX_SOURCE_ROWS = 100_000;
export const MAX_SOURCE_COLUMNS = 500;
/** Verschachtelungstiefe beim Abflachen von JSON-Einträgen; tiefer liegende Teile bleiben JSON-Text */
export const MAX_FLATTEN_DEPTH = 32;

// ---------------------------------------------------------------------------------------------
// Dekodierung und CSV
// ---------------------------------------------------------------------------------------------

/**
 * Bytes → Text. UTF-8 wird streng geprüft (BOM wird entfernt); ist die Datei kein gültiges UTF-8,
 * wird sie als Windows-1252 gelesen (typischer Excel-Export) und fallback=true gemeldet.
 */
export function decodeText(
  bytes: Uint8Array,
  encoding: CsvConfig['encoding'],
): { text: string; encoding: CsvConfig['encoding']; fallback: boolean } {
  if (encoding === 'utf-8') {
    try {
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC'),
        encoding,
        fallback: false,
      };
    } catch {
      return {
        text: new TextDecoder('windows-1252').decode(bytes).normalize('NFC'),
        encoding: 'windows-1252',
        fallback: true,
      };
    }
  }
  // WHATWG: "iso-8859-1" wird als windows-1252 dekodiert (Obermenge)
  return { text: new TextDecoder(encoding).decode(bytes).normalize('NFC'), encoding, fallback: false };
}

const DELIMITERS = [';', ',', '\t'] as const;
const DETECT_PREFIX_CHARS = 256 * 1024;
export type Delimiter = (typeof DELIMITERS)[number];

function countOutsideQuotes(line: string, ch: string): number {
  let n = 0;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === ch) n++;
  }
  return n;
}

/**
 * Trennzeichen erkennen: Kandidat, der in den ersten Zeilen am häufigsten und gleichmäßig vorkommt
 * (Kopfzeile zählt doppelt). Ohne Treffer: Komma.
 */
export function detectDelimiter(text: string): Delimiter {
  // nur der Anfang zählt; nicht die ganze Datei in Zeilen zerlegen
  const lines = text
    .slice(0, DETECT_PREFIX_CHARS)
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim() !== '')
    .slice(0, 6);
  if (lines.length === 0) return ',';
  let best: Delimiter = ',';
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const header = counts[0] ?? 0;
    if (header === 0) continue;
    const consistent = counts.filter((c) => c === header).length;
    const score = header * 2 + consistent;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Spaltennamen eindeutig machen: leere Namen → "Spalte N", Wiederholungen → "Name (2)", "Name (3)" …
 * Linear (Menge + Zähler je Grundname), damit eine präparierte Kopfzeile den Knoten nicht blockiert.
 */
export function uniqueColumnNames(cells: readonly (string | null | undefined)[]): string[] {
  const columns: string[] = [];
  const taken = new Set<string>();
  const nextSuffix = new Map<string, number>();
  for (const cell of cells) {
    const base = (cell ?? '').replace(/^\uFEFF/, '').trim() || `Spalte ${columns.length + 1}`;
    let name = base;
    if (taken.has(name)) {
      // vergebene Namen werden nie wieder frei: der Zähler muss nie zurückgehen
      let i = nextSuffix.get(base) ?? 2;
      while (taken.has(`${base} (${i})`)) i++;
      name = `${base} (${i})`;
      nextSuffix.set(base, i + 1);
    }
    taken.add(name);
    columns.push(name);
  }
  return columns;
}

/**
 * Vorprüfung ohne Zerlegen: hat die erste nicht-leere Zeile mehr als max Zellen? Zählt Trennzeichen
 * außerhalb von Anführungszeichen; Abweichungen zum Parser führen höchstens zu weniger Zellen (die
 * eigentliche Prüfung erfolgt beim Parsen).
 */
function headerExceeds(text: string, delimiter: string, max: number): boolean {
  let cells = 1;
  let quoted = false;
  let content = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      quoted = !quoted;
      content = true;
    } else if (!quoted && (c === '\n' || c === '\r')) {
      if (content) return false;
    } else if (!quoted && c === delimiter) {
      content = true;
      if (++cells > max) return true;
    } else if (c !== ' ' && c !== '\t') {
      content = true;
    }
  }
  return false;
}

/**
 * CSV mit Kopfzeile parsen. Leere Zeilen werden übersprungen; Zeilennummern 1-basiert ohne Kopfzeile.
 * Obergrenzen: höchstens MAX_SOURCE_COLUMNS Spalten (sonst limit=too_many_columns, keine Zeilen) und
 * maxRows Datenzeilen (sonst limit=too_many_rows mit den ersten maxRows Zeilen); das Parsen endet dann.
 */
export function parseCsv(
  text: string,
  delimiter: CsvConfig['delimiter'],
  opts: { maxRows?: number } = {},
): SourceTable & { delimiter: Delimiter } {
  const maxRows = opts.maxRows ?? MAX_SOURCE_ROWS;
  const d: Delimiter = delimiter === 'auto' ? detectDelimiter(text) : delimiter;
  const input = text.replace(/^\uFEFF/, '');
  const tooWide = { columns: [], rows: [], issues: [], delimiter: d, limit: 'too_many_columns' as const };
  if (headerExceeds(input, d, MAX_SOURCE_COLUMNS)) return tooWide;

  let headerRow: string[] | null = null;
  let limit: SourceLimit | undefined;
  const body: { cells: string[]; broken: boolean }[] = [];
  Papa.parse<string[]>(input, {
    delimiter: d,
    header: false,
    skipEmptyLines: 'greedy',
    step: (result, parser) => {
      if (headerRow === null) {
        headerRow = result.data;
        if (headerRow.length > MAX_SOURCE_COLUMNS) {
          limit = 'too_many_columns';
          parser.abort();
        }
        return;
      }
      if (body.length >= maxRows) {
        limit = 'too_many_rows';
        parser.abort();
        return;
      }
      body.push({ cells: result.data, broken: result.errors.length > 0 });
    },
  });
  if (limit === 'too_many_columns') return tooWide;
  if (!headerRow) return { columns: [], rows: [], issues: [], delimiter: d };
  const columns = uniqueColumnNames(headerRow);
  const issues: Issue[] = [];
  const rows: SourceRow[] = body.map(({ cells, broken }, i) => {
    const rowNumber = i + 1;
    // nur vorhandene Zellen: kurze Zeilen erzeugen keine Platzhalter je Spalte (fehlend = leer)
    const raw: Record<string, string | null> = {};
    const n = Math.min(cells.length, columns.length);
    for (let j = 0; j < n; j++) raw[columns[j]!] = cells[j] ?? null;
    // überzählige Zellen sind nur zulässig, wenn sie leer sind (z. B. Semikolon am Zeilenende)
    const extra = cells.slice(columns.length).some((c) => c.trim() !== '');
    if (extra || cells.length < columns.length || broken) {
      issues.push({
        rowNumber,
        field: null,
        code: 'invalid_row',
        severity: 'error',
        rawValue: null,
        params: { expected: columns.length, actual: cells.length },
      });
    }
    return { rowNumber, raw };
  });
  return { columns, rows, issues, delimiter: d, ...(limit ? { limit } : {}) };
}

// ---------------------------------------------------------------------------------------------
// JSON-Quellen (API)
// ---------------------------------------------------------------------------------------------

/** Wert an einem Punkt-Pfad ("data.items"); leerer Pfad = Wurzel */
export function getPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function jsonText(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    // z. B. Stapelüberlauf bei extrem tiefer Verschachtelung
    return null;
  }
}

/**
 * Verschachteltes Objekt → flache Spalten mit Punkt-Pfaden; Werte als Text (null bleibt null).
 * Arrays und Teile unterhalb von MAX_FLATTEN_DEPTH werden als JSON-Text übernommen.
 */
export function flattenItem(
  item: unknown,
  prefix = '',
  out: Record<string, string | null> = {},
  depth = 0,
): Record<string, string | null> {
  if (item === null || item === undefined) {
    if (prefix) out[prefix] = null;
    return out;
  }
  if (Array.isArray(item) || (typeof item === 'object' && depth >= MAX_FLATTEN_DEPTH)) {
    if (prefix) out[prefix] = jsonText(item);
    return out;
  }
  if (typeof item === 'object') {
    for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
      flattenItem(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    }
    return out;
  }
  out[prefix || 'value'] = String(item);
  return out;
}

/** JSON-Einträge → Tabelle; Spalten = Vereinigung aller Schlüssel (höchstens MAX_SOURCE_COLUMNS) */
export function tableFromItems(items: readonly unknown[]): SourceTable {
  if (items.length > MAX_SOURCE_ROWS) return { columns: [], rows: [], issues: [], limit: 'too_many_rows' };
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows: SourceRow[] = [];
  for (const [i, item] of items.entries()) {
    const raw = flattenItem(item);
    for (const k of Object.keys(raw)) {
      if (!seen.has(k)) {
        if (seen.size >= MAX_SOURCE_COLUMNS) {
          return { columns: [], rows: [], issues: [], limit: 'too_many_columns' };
        }
        seen.add(k);
        columns.push(k);
      }
    }
    rows.push({ rowNumber: i + 1, raw });
  }
  return { columns, rows, issues: [] };
}

// ---------------------------------------------------------------------------------------------
// Zuordnung (Mapping), Konvertierung, Prüfung
// ---------------------------------------------------------------------------------------------

/** Zuordnungen, deren Quellspalte in der Quelle fehlt */
export function missingColumns(columns: readonly string[], mapping: readonly FieldMapping[]): FieldMapping[] {
  const present = new Set(columns);
  return mapping.filter((m) => !present.has(m.source));
}

export function applyTransform(value: string, transform: FieldMapping['transform']): string {
  switch (transform) {
    case 'none':
      return value;
    case 'upper':
      return value.trim().toLocaleUpperCase('de');
    case 'lower':
      return value.trim().toLocaleLowerCase('de');
    default:
      return value.trim();
  }
}

export function applyValueMap(value: string, valueMap: Record<string, string> | undefined): string {
  if (!valueMap) return value;
  if (Object.hasOwn(valueMap, value)) return valueMap[value]!;
  const needle = value.trim().toLocaleLowerCase('de');
  for (const [k, v] of Object.entries(valueMap)) {
    if (k.trim().toLocaleLowerCase('de') === needle) return v;
  }
  return value;
}

/** Quellwert → bereinigter Text (Transformation, Wertübersetzung, Ersatzwert) oder null (leer) */
export function prepareValue(raw: string | null | undefined, m: FieldMapping): string | null {
  let v = raw ?? null;
  if (v !== null) {
    v = applyTransform(v, m.transform);
    if (v.trim() !== '') v = applyValueMap(v, m.valueMap);
  }
  if (v === null || v.trim() === '')
    v = m.defaultValue !== undefined && m.defaultValue !== '' ? m.defaultValue : null;
  return v;
}

function normalizeName(s: string): string {
  return s.normalize('NFC').toLocaleLowerCase('de').replace(/\s+/g, ' ').trim();
}

export function naturalKeyOf(lastName: string, firstName: string, dateOfBirth: string): string {
  return `${normalizeName(lastName)}|${normalizeName(firstName)}|${dateOfBirth}`;
}

/** Pflichtziele je Zielart und Zuordnungsstrategie */
export function requiredTargets(
  ctx: Pick<PipelineContext, 'targetType' | 'athleteMatch' | 'dataset'>,
): Set<string> {
  const req = new Set<string>();
  if (ctx.targetType === 'athletes') {
    for (const f of ['last_name', 'first_name', 'date_of_birth', 'sport', 'squad_status'])
      req.add(`athlete.${f}`);
  } else {
    for (const f of ctx.dataset?.fields ?? []) if (f.required) req.add(`data.${f.name}`);
    if (ctx.athleteMatch.strategy === 'natural_key') {
      for (const f of ['last_name', 'first_name', 'date_of_birth']) req.add(`athlete.${f}`);
    }
  }
  if (ctx.athleteMatch.strategy === 'external_id') req.add('athlete.external_id');
  return req;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/**
 * Fachlicher Schlüssel eines Eintrags (zusätzlich zur Person): Werte der Schlüsselfelder in fester
 * Reihenfolge; ohne Schlüsselfelder ein Hash über alle nicht-leeren Werte.
 */
export function recordKeyOf(data: Record<string, Scalar>, keyFields: readonly string[]): string {
  if (keyFields.length > 0) return `k:${JSON.stringify(keyFields.map((f) => data[f] ?? null))}`;
  const nonNull = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined));
  return `h:${createHash('sha256').update(canonicalJson(nonNull)).digest('hex')}`;
}

/** Zeitstempel für dataset_record.observed_at: Datum → 00:00 UTC (Datum bleibt beim ISO-Export erhalten) */
export function observedAtOf(value: Scalar, type: FieldDef['type']): string | null {
  if (typeof value !== 'string') return null;
  if (type === 'date') return `${value}T00:00:00.000Z`;
  if (type === 'datetime') return value;
  return null;
}

/** Eine Quellzeile zuordnen, konvertieren und prüfen (ohne Personenabgleich) */
export function mapRow(row: SourceRow, ctx: PipelineContext, structural: readonly Issue[] = []): MappedRow {
  const out: MappedRow = {
    rowNumber: row.rowNumber,
    raw: row.raw,
    mapped: {},
    athlete: {},
    data: {},
    issues: [...structural],
    externalId: null,
    naturalKey: null,
    recordKey: null,
    observedAt: null,
    athleteId: null,
    changed: false,
  };
  const required = requiredTargets(ctx);
  const fieldsByName = new Map((ctx.dataset?.fields ?? []).map((f) => [f.name, f]));
  const failed = new Set<string>();
  const error = (
    field: string | null,
    code: ImportErrorCode,
    rawValue: string | null,
    params: IssueParams = {},
  ) => out.issues.push({ rowNumber: row.rowNumber, field, code, severity: 'error', rawValue, params });

  for (const m of ctx.mapping) {
    const rawValue = row.raw[m.source] ?? null;
    const value = prepareValue(rawValue, m);
    const [kind, name] = m.target.split('.', 2) as ['athlete' | 'data', string];
    if (value === null) {
      out.mapped[m.target] = null;
      if (kind === 'athlete') out.athlete[name as AthleteField] = null;
      else out.data[name] = null;
      if (required.has(m.target)) {
        error(m.target, 'required', rawValue, { column: m.source });
        failed.add(m.target);
      }
      continue;
    }
    let result: Converted;
    if (kind === 'athlete') {
      result = (ATHLETE_FIELDS as readonly string[]).includes(name)
        ? convertAthleteField(name as AthleteField, value, ctx.convert)
        : { ok: false, code: 'invalid_row' };
    } else {
      const def = fieldsByName.get(name);
      result = def ? convertField(value, def, ctx.convert) : { ok: false, code: 'invalid_row' };
    }
    if (!result.ok) {
      error(m.target, result.code, rawValue, { column: m.source, ...(result.params ?? {}) });
      failed.add(m.target);
      out.mapped[m.target] = null;
      continue;
    }
    out.mapped[m.target] = result.value;
    if (kind === 'athlete') out.athlete[name as AthleteField] = result.value as string;
    else out.data[name] = result.value;
  }

  // Schlüssel der Person
  const ext = out.athlete.external_id;
  if (typeof ext === 'string' && ext !== '') out.externalId = ext;
  const { last_name, first_name, date_of_birth } = out.athlete;
  if (last_name && first_name && date_of_birth)
    out.naturalKey = naturalKeyOf(last_name, first_name, date_of_birth);

  if (ctx.targetType === 'dataset' && ctx.dataset) {
    const ds = ctx.dataset;
    // Beobachtungsdatum: plausibel und nicht in der Zukunft
    if (ds.observedAtField && !failed.has(`data.${ds.observedAtField}`)) {
      const def = fieldsByName.get(ds.observedAtField);
      const v = out.data[ds.observedAtField];
      if (def && typeof v === 'string') {
        const day = def.type === 'datetime' ? localDate(new Date(v), ctx.convert.timeZone) : v;
        const check = checkObservationDate(day, ctx.convert.today);
        const mapping = ctx.mapping.find((m) => m.target === `data.${ds.observedAtField}`);
        if (check && !check.ok) {
          error(
            `data.${ds.observedAtField}`,
            check.code,
            mapping ? (row.raw[mapping.source] ?? null) : null,
            {
              ...(mapping ? { column: mapping.source } : {}),
              ...(check.params ?? {}),
            },
          );
          failed.add(`data.${ds.observedAtField}`);
        } else {
          out.observedAt = observedAtOf(v, def.type);
        }
      }
    }
    const keyFailed =
      ds.keyFields.length > 0
        ? ds.keyFields.some((k) => failed.has(`data.${k}`))
        : out.issues.some((i) => i.severity === 'error');
    if (!keyFailed) out.recordKey = recordKeyOf(out.data, ds.keyFields);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Personenabgleich, Dubletten, Änderungen
// ---------------------------------------------------------------------------------------------

function hasErrors(row: MappedRow): boolean {
  return row.issues.some((i) => i.severity === 'error');
}

/**
 * Zuordnungsfehler speichern keine Personenkennungen (Name, Geburtsdatum, Kennung) als Rohwert, nur die
 * für die Zuordnung verwendeten Felder als Hinweis; die Zeile ist über ihre Nummer auffindbar.
 */
const NATURAL_KEY_HINT = 'athlete.last_name,athlete.first_name,athlete.date_of_birth';

/** Ordnet Zeilen vorhandenen Personen zu (Kennung, ersatzweise natürlicher Schlüssel). */
export function resolveAthletes(rows: MappedRow[], lookup: AthleteLookup, ctx: PipelineContext): void {
  const byExternal = ctx.athleteMatch.strategy === 'external_id';
  for (const row of rows) {
    // ohne Schlüssel der gewählten Strategie wurde bereits ein Pflichtfehler gemeldet
    if (!(byExternal ? row.externalId : row.naturalKey)) continue;
    const viaExternal =
      byExternal && row.externalId ? (lookup.byExternalId.get(row.externalId) ?? null) : null;
    const viaNatural = row.naturalKey ? (lookup.byNaturalKey.get(row.naturalKey) ?? []) : [];

    if (ctx.targetType === 'dataset') {
      // Kennung zuerst; unbekannte Kennung → ersatzweise natürlicher Schlüssel (falls zugeordnet)
      const candidates = viaExternal ? [viaExternal] : viaNatural;
      if (candidates.length === 1) {
        row.athleteId = candidates[0]!;
      } else if (candidates.length > 1) {
        row.issues.push({
          rowNumber: row.rowNumber,
          field: null,
          code: 'athlete_ambiguous',
          severity: 'error',
          rawValue: null,
          params: { count: candidates.length, fields: NATURAL_KEY_HINT },
        });
      } else {
        row.issues.push({
          rowNumber: row.rowNumber,
          field: byExternal ? 'athlete.external_id' : null,
          code: 'athlete_not_found',
          severity: 'error',
          rawValue: null,
          params:
            ctx.athleteMatch.strategy === 'external_id'
              ? { system: ctx.athleteMatch.system }
              : { fields: NATURAL_KEY_HINT },
        });
      }
      continue;
    }

    // Ziel Athletenkern: vorhandene Person aktualisieren oder neue anlegen
    let id: string | null = viaExternal;
    if (id) {
      if (viaNatural.length > 0 && !viaNatural.includes(id)) {
        row.issues.push({
          rowNumber: row.rowNumber,
          field: null,
          code: 'athlete_ambiguous',
          severity: 'error',
          rawValue: null,
          params: { reason: 'natural_key_conflict', fields: NATURAL_KEY_HINT },
        });
        continue;
      }
    } else if (viaNatural.length > 1) {
      row.issues.push({
        rowNumber: row.rowNumber,
        field: null,
        code: 'athlete_ambiguous',
        severity: 'error',
        rawValue: null,
        params: { count: viaNatural.length, fields: NATURAL_KEY_HINT },
      });
      continue;
    } else if (viaNatural.length === 1) {
      id = viaNatural[0]!;
    }
    row.athleteId = id;
    if (id && !hasErrors(row)) {
      const existing = lookup.athletes.get(id) ?? {};
      const changed = (Object.keys(row.athlete) as AthleteField[]).filter(
        (k) => k !== 'external_id' && (existing[k] ?? null) !== (row.athlete[k] ?? null),
      );
      if (changed.length > 0) {
        row.changed = true;
        row.issues.push({
          rowNumber: row.rowNumber,
          field: null,
          code: 'will_update',
          severity: 'warning',
          rawValue: null,
          params: { fields: changed.join(',') },
        });
      }
    }
  }
}

/** Gleicher Schlüssel mehrfach in einer Quelle: jede weitere Zeile ist ein Fehler. */
export function markDuplicates(rows: MappedRow[], ctx: PipelineContext): void {
  const seen = new Map<string, number>();
  for (const row of rows) {
    const keys: string[] = [];
    if (ctx.targetType === 'athletes') {
      if (row.externalId) keys.push(`e:${row.externalId}`);
      if (row.naturalKey) keys.push(`n:${row.naturalKey}`);
      if (row.athleteId) keys.push(`i:${row.athleteId}`);
    } else if (row.recordKey) {
      const person = row.athleteId
        ? `i:${row.athleteId}`
        : row.externalId
          ? `e:${row.externalId}`
          : row.naturalKey
            ? `n:${row.naturalKey}`
            : null;
      if (person) keys.push(`${person}#${row.recordKey}`);
    }
    const first = keys.map((k) => seen.get(k)).find((n) => n !== undefined);
    if (first !== undefined) {
      row.issues.push({
        rowNumber: row.rowNumber,
        field: null,
        code: 'duplicate_in_source',
        severity: 'error',
        rawValue: null,
        params: { firstRow: first },
      });
      continue;
    }
    for (const k of keys) seen.set(k, row.rowNumber);
  }
}

export function existingRecordKey(athleteId: string, recordKey: string): string {
  return `${athleteId}\u0000${recordKey}`;
}

/** Hinweis, wenn ein vorhandener Eintrag mit abweichenden Werten überschrieben wird. */
export function flagRecordUpdates(rows: MappedRow[], existing: Map<string, Record<string, Scalar>>): void {
  for (const row of rows) {
    if (!row.athleteId || !row.recordKey || hasErrors(row)) continue;
    const before = existing.get(existingRecordKey(row.athleteId, row.recordKey));
    if (!before) continue;
    const merged = { ...before, ...row.data };
    if (canonicalJson(merged) !== canonicalJson(before)) {
      row.changed = true;
      const fields = Object.keys(row.data).filter(
        (k) => canonicalJson(before[k] ?? null) !== canonicalJson(row.data[k] ?? null),
      );
      row.issues.push({
        rowNumber: row.rowNumber,
        field: null,
        code: 'will_update',
        severity: 'warning',
        rawValue: null,
        params: { fields: fields.join(',') },
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Zusammenfassung
// ---------------------------------------------------------------------------------------------

export type RowStatus = 'valid' | 'warning' | 'error';

export function rowStatus(row: MappedRow): RowStatus {
  if (row.issues.some((i) => i.severity === 'error')) return 'error';
  if (row.issues.some((i) => i.severity === 'warning')) return 'warning';
  return 'valid';
}

export interface Summary {
  totalRows: number;
  validRows: number;
  errorRows: number;
  /** gültige Zeilen mit mindestens einem Hinweis */
  warningRows: number;
  issues: Issue[];
  preview: {
    rowNumber: number;
    raw: Record<string, string | null>;
    mapped: Record<string, Scalar>;
    status: RowStatus;
  }[];
  /** gültige Zeilen (werden zur Übernahme vorgemerkt) */
  valid: MappedRow[];
}

export function summarize(rows: readonly MappedRow[], sourceIssues: readonly Issue[] = []): Summary {
  let errorRows = 0;
  let warningRows = 0;
  const valid: MappedRow[] = [];
  const issues: Issue[] = [...sourceIssues];
  for (const row of rows) {
    const status = rowStatus(row);
    if (status === 'error') errorRows++;
    else {
      if (status === 'warning') warningRows++;
      valid.push(row);
    }
    issues.push(...row.issues);
  }
  return {
    totalRows: rows.length,
    validRows: rows.length - errorRows,
    errorRows,
    warningRows,
    issues,
    preview: rows.slice(0, PREVIEW_ROWS).map((r) => ({
      rowNumber: r.rowNumber,
      raw: clipValues(r.raw),
      mapped: clipValues(r.mapped),
      status: rowStatus(r),
    })),
    valid,
  };
}

/** Vollständiger reiner Durchlauf (für Tests und Werkzeuge): Quelle → Prüfergebnis */
export function runPipeline(
  table: SourceTable,
  ctx: PipelineContext,
  lookup: AthleteLookup,
  existingRecords: Map<string, Record<string, Scalar>> = new Map(),
): { rows: MappedRow[]; summary: Summary } {
  const structural = new Map<number, Issue[]>();
  for (const i of table.issues) structural.set(i.rowNumber, [...(structural.get(i.rowNumber) ?? []), i]);
  const rows = table.rows.map((r) => mapRow(r, ctx, structural.get(r.rowNumber) ?? []));
  resolveAthletes(rows, lookup, ctx);
  markDuplicates(rows, ctx);
  if (ctx.targetType === 'dataset') flagRecordUpdates(rows, existingRecords);
  return { rows, summary: summarize(rows) };
}

export function emptyLookup(): AthleteLookup {
  return { byExternalId: new Map(), byNaturalKey: new Map(), athletes: new Map() };
}
