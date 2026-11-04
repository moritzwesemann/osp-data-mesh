/**
 * Format- und Plausibilitätsprüfung einzelner Werte beim Import (reine Funktionen).
 *
 * Eingabe ist immer ein nicht-leerer Text (Leerwerte und Pflichtprüfung behandelt pipeline.ts);
 * Ergebnis ist der typisierte Wert oder ein übersetzbarer Fehlercode (IMPORT_ERROR_CODES).
 */
import { type Scalar, SQUAD_STATUSES } from '../../../shared/contract/common.ts';
import type { DateFormat, IMPORT_ERROR_CODES } from '../../../shared/contract/connectors.ts';
import type { FieldDef } from '../../../shared/contract/datasets.ts';

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];
export type IssueParams = Record<string, string | number>;

export type Converted =
  | { ok: true; value: Scalar }
  | { ok: false; code: ImportErrorCode; params?: IssueParams };

export interface ConvertOptions {
  decimalSeparator: '.' | ',';
  dateFormat: DateFormat;
  /** IANA-Zeitzone für Zeitangaben ohne Offset und für Datumsgrenzen */
  timeZone: string;
  /** heutiges Datum (YYYY-MM-DD) in timeZone */
  today: string;
}

/** Frühestes plausibles Beobachtungsdatum */
export const MIN_OBSERVATION_DATE = '1990-01-01';
/** Plausibles Alter einer Athletin/eines Athleten (Jahre, inklusive) */
export const MIN_AGE = 6;
export const MAX_AGE = 80;
export const MAX_TEXT_LENGTH = 2000;

const ok = (value: Scalar): Converted => ({ ok: true, value });
const fail = (code: ImportErrorCode, params?: IssueParams): Converted =>
  params ? { ok: false, code, params } : { ok: false, code };

// ---------------------------------------------------------------------------------------------
// Zahlen, Wahrheitswerte
// ---------------------------------------------------------------------------------------------

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Zahl mit konfiguriertem Dezimaltrennzeichen (ohne Tausendertrennzeichen) oder null */
export function parseNumber(input: string, decimalSeparator: '.' | ','): number | null {
  let s = input.replace(/[\s ]/g, '');
  if (decimalSeparator === ',') {
    if (s.includes('.')) return null;
    s = s.replace(',', '.');
  } else if (s.includes(',')) {
    return null;
  }
  if (!NUMBER_RE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const TRUE_VALUES = new Set(['true', 'wahr', 'ja', 'j', 'yes', 'y', '1', 'x']);
const FALSE_VALUES = new Set(['false', 'falsch', 'nein', 'n', 'no', '0']);

export function parseBoolean(input: string): boolean | null {
  const s = input.trim().toLowerCase();
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Datum und Zeit
// ---------------------------------------------------------------------------------------------

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;
const DOT_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

interface DateParts {
  y: number;
  m: number;
  d: number;
  hasTime: boolean;
  h: number;
  mi: number;
  s: number;
  ms: number;
  /** Offset in Minuten, falls angegeben */
  offset: number | null;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validParts(p: DateParts): DateParts | null {
  if (p.y < 1000 || p.y > 9999 || p.m < 1 || p.m > 12 || p.d < 1 || p.d > daysInMonth(p.y, p.m)) return null;
  if (p.h > 23 || p.mi > 59 || p.s > 59) return null;
  return p;
}

function splitDate(input: string, format: DateFormat): DateParts | null {
  const s = input.trim();
  const iso = ISO_RE.exec(s);
  // ISO 8601 ist eindeutig und wird unabhängig vom konfigurierten Format akzeptiert
  if (iso) {
    let offset: number | null = null;
    if (iso[8]) {
      if (iso[8].toUpperCase() === 'Z') offset = 0;
      else {
        const sign = iso[8].startsWith('-') ? -1 : 1;
        const digits = iso[8].slice(1).replace(':', '');
        offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
      }
    }
    return validParts({
      y: Number(iso[1]),
      m: Number(iso[2]),
      d: Number(iso[3]),
      hasTime: iso[4] !== undefined,
      h: Number(iso[4] ?? 0),
      mi: Number(iso[5] ?? 0),
      s: Number(iso[6] ?? 0),
      ms: iso[7] ? Math.floor(Number(`0.${iso[7]}`) * 1000) : 0,
      offset,
    });
  }
  let m: RegExpExecArray | null = null;
  let order: 'dmy' | 'mdy' = 'dmy';
  if (format === 'DD.MM.YYYY') m = DOT_RE.exec(s);
  else if (format === 'DD/MM/YYYY') m = SLASH_RE.exec(s);
  else if (format === 'MM/DD/YYYY') {
    m = SLASH_RE.exec(s);
    order = 'mdy';
  }
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return validParts({
    y: Number(m[3]),
    m: order === 'dmy' ? b : a,
    d: order === 'dmy' ? a : b,
    hasTime: m[4] !== undefined,
    h: Number(m[4] ?? 0),
    mi: Number(m[5] ?? 0),
    s: Number(m[6] ?? 0),
    ms: 0,
    offset: null,
  });
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Kalenderdatum (YYYY-MM-DD) im konfigurierten Format (ISO immer zulässig) oder null */
export function parseDate(input: string, format: DateFormat): string | null {
  const p = splitDate(input, format);
  return p ? `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}` : null;
}

/**
 * Zeitpunkt als ISO-String (UTC). Angaben ohne Offset werden in der Zeitzone timeZone interpretiert,
 * reine Datumsangaben als 00:00 Uhr Ortszeit.
 */
export function parseDateTime(input: string, format: DateFormat, timeZone: string): string | null {
  const p = splitDate(input, format);
  if (!p) return null;
  const local = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, p.ms);
  const ms = p.offset !== null ? local - p.offset * 60_000 : zonedToUtc(local, timeZone);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function wallClock(instant: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    y: parts.year ?? 1970,
    m: parts.month ?? 1,
    d: parts.day ?? 1,
    h: (parts.hour ?? 0) % 24,
    mi: parts.minute ?? 0,
    s: parts.second ?? 0,
  };
}

/** Abstand der Ortszeit zu UTC (ms) zu einem Zeitpunkt */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Ortszeit (als UTC-Millisekunden kodiert) → tatsächlicher Zeitpunkt */
export function zonedToUtc(localMs: number, timeZone: string): number {
  const first = localMs - zoneOffsetMs(localMs, timeZone);
  const second = localMs - zoneOffsetMs(first, timeZone);
  return second;
}

/** Kalenderdatum (YYYY-MM-DD) eines Zeitpunkts in einer Zeitzone */
export function localDate(instant: Date, timeZone: string): string {
  const w = wallClock(instant.getTime(), timeZone);
  return `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** volle Lebensjahre am Stichtag */
export function ageOn(dateOfBirth: string, today: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** Beobachtungs-/Messdatum: nicht vor 1990, nicht nach morgen (Ortszeit) */
export function checkObservationDate(date: string, today: string): Converted | null {
  if (date < MIN_OBSERVATION_DATE) return fail('implausible_date', { min: MIN_OBSERVATION_DATE });
  const max = addDays(today, 1);
  if (date > max) return fail('future_date', { max });
  return null;
}

/** Geburtsdatum: Alter am Importtag zwischen 6 und 80 Jahren */
export function checkBirthDate(dateOfBirth: string, today: string): Converted | null {
  const age = ageOn(dateOfBirth, today);
  if (age < MIN_AGE || age > MAX_AGE) return fail('implausible_date', { minAge: MIN_AGE, maxAge: MAX_AGE });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Felder eines Datensatzes
// ---------------------------------------------------------------------------------------------

function inRange(n: number, field: Pick<FieldDef, 'min' | 'max'>): Converted {
  if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
    const params: IssueParams = {};
    if (field.min !== undefined) params.min = field.min;
    if (field.max !== undefined) params.max = field.max;
    return fail('out_of_range', params);
  }
  return ok(n);
}

function matchEnum(value: string, allowed: readonly string[]): string | null {
  if (allowed.includes(value)) return value;
  const lower = value.toLocaleLowerCase('de');
  return allowed.find((a) => a.toLocaleLowerCase('de') === lower) ?? null;
}

/** Konvertiert einen nicht-leeren Text in den Typ eines Datensatz-Felds und prüft Grenzen/Werte. */
export function convertField(value: string, field: FieldDef, opts: ConvertOptions): Converted {
  switch (field.type) {
    case 'string':
      return value.length > MAX_TEXT_LENGTH ? fail('too_long', { max: MAX_TEXT_LENGTH }) : ok(value);
    case 'integer': {
      const n = parseNumber(value, opts.decimalSeparator);
      if (n === null || !Number.isSafeInteger(n)) return fail('invalid_integer');
      return inRange(n, field);
    }
    case 'number': {
      const n = parseNumber(value, opts.decimalSeparator);
      if (n === null) return fail('invalid_number');
      return inRange(n, field);
    }
    case 'date': {
      const d = parseDate(value, opts.dateFormat);
      return d === null ? fail('invalid_date', { format: opts.dateFormat }) : ok(d);
    }
    case 'datetime': {
      const d = parseDateTime(value, opts.dateFormat, opts.timeZone);
      return d === null ? fail('invalid_datetime', { format: opts.dateFormat }) : ok(d);
    }
    case 'boolean': {
      const b = parseBoolean(value);
      return b === null ? fail('invalid_boolean') : ok(b);
    }
    case 'enum': {
      const allowed = field.enumValues ?? [];
      const v = matchEnum(value, allowed);
      return v === null ? fail('invalid_enum', { allowed: allowed.join(', ') }) : ok(v);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Felder des Athletenkerns
// ---------------------------------------------------------------------------------------------

export const ATHLETE_FIELDS = [
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
export type AthleteField = (typeof ATHLETE_FIELDS)[number];

const ATHLETE_MAX_LENGTH: Record<string, number> = {
  last_name: 100,
  first_name: 100,
  sport: 100,
  club: 200,
  discipline: 200,
  external_id: 200,
};

export function convertAthleteField(field: AthleteField, value: string, opts: ConvertOptions): Converted {
  switch (field) {
    case 'date_of_birth': {
      const d = parseDate(value, opts.dateFormat);
      if (d === null) return fail('invalid_date', { format: opts.dateFormat });
      return checkBirthDate(d, opts.today) ?? ok(d);
    }
    case 'squad_status': {
      const v = matchEnum(value, SQUAD_STATUSES);
      return v === null ? fail('invalid_enum', { allowed: SQUAD_STATUSES.join(', ') }) : ok(v);
    }
    case 'sex': {
      const v = value.trim().toLowerCase();
      return v === 'f' || v === 'm' || v === 'd' ? ok(v) : fail('invalid_enum', { allowed: 'f, m, d' });
    }
    default: {
      const max = ATHLETE_MAX_LENGTH[field] ?? MAX_TEXT_LENGTH;
      return value.length > max ? fail('too_long', { max }) : ok(value);
    }
  }
}
