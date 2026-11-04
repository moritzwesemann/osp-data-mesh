import { describe, expect, test } from 'bun:test';
import {
  addDays,
  ageOn,
  type ConvertOptions,
  checkBirthDate,
  checkObservationDate,
  convertAthleteField,
  convertField,
  localDate,
  parseBoolean,
  parseDate,
  parseDateTime,
  parseNumber,
  zonedToUtc,
} from '../../src/server/modules/connectors/validate.ts';
import type { FieldDef } from '../../src/shared/contract/datasets.ts';

const TZ = 'Europe/Berlin';
const opts: ConvertOptions = {
  decimalSeparator: '.',
  dateFormat: 'YYYY-MM-DD',
  timeZone: TZ,
  today: '2026-11-04',
};
const de: ConvertOptions = { ...opts, decimalSeparator: ',', dateFormat: 'DD.MM.YYYY' };
const field = (f: Partial<FieldDef> & Pick<FieldDef, 'type'>): FieldDef => ({
  name: 'x',
  label: 'X',
  required: false,
  ...f,
});

describe('Zahlen', () => {
  test('Dezimalpunkt', () => {
    expect(parseNumber('58.4', '.')).toBe(58.4);
    expect(parseNumber(' -3 ', '.')).toBe(-3);
    expect(parseNumber('.5', '.')).toBe(0.5);
    expect(parseNumber('1e3', '.')).toBe(1000);
    expect(parseNumber('58,4', '.')).toBeNull();
    expect(parseNumber('1,234.5', '.')).toBeNull();
    expect(parseNumber('abc', '.')).toBeNull();
    expect(parseNumber('', '.')).toBeNull();
  });

  test('Dezimalkomma', () => {
    expect(parseNumber('58,4', ',')).toBe(58.4);
    expect(parseNumber('1 234,5', ',')).toBe(1234.5);
    expect(parseNumber('58.4', ',')).toBeNull();
    expect(parseNumber('1.234,5', ',')).toBeNull();
  });

  test('integer und number mit Grenzen', () => {
    const int = field({ type: 'integer', min: 120, max: 230 });
    expect(convertField('190', int, opts)).toEqual({ ok: true, value: 190 });
    expect(convertField('190.0', int, opts)).toEqual({ ok: true, value: 190 });
    expect(convertField('190.5', int, opts)).toMatchObject({ ok: false, code: 'invalid_integer' });
    expect(convertField('hoch', int, opts)).toMatchObject({ ok: false, code: 'invalid_integer' });
    expect(convertField('250', int, opts)).toEqual({
      ok: false,
      code: 'out_of_range',
      params: { min: 120, max: 230 },
    });
    const num = field({ type: 'number', min: 20, max: 95 });
    expect(convertField('58,4', num, de)).toEqual({ ok: true, value: 58.4 });
    expect(convertField('20', num, opts)).toEqual({ ok: true, value: 20 });
    expect(convertField('95', num, opts)).toEqual({ ok: true, value: 95 });
    expect(convertField('140.0', num, opts)).toMatchObject({ ok: false, code: 'out_of_range' });
    expect(convertField('19.9', num, opts)).toMatchObject({ ok: false, code: 'out_of_range' });
    expect(convertField('n/a', num, opts)).toMatchObject({ ok: false, code: 'invalid_number' });
    expect(convertField('-5', field({ type: 'number', max: 10 }), opts)).toEqual({ ok: true, value: -5 });
  });
});

describe('Wahrheitswerte', () => {
  test('true/false/ja/nein/1/0/x', () => {
    for (const v of ['true', 'TRUE', 'ja', 'Ja', '1', 'x', 'X']) expect(parseBoolean(v)).toBe(true);
    for (const v of ['false', 'nein', 'NEIN', '0']) expect(parseBoolean(v)).toBe(false);
    expect(parseBoolean('vielleicht')).toBeNull();
    expect(convertField('ja', field({ type: 'boolean' }), opts)).toEqual({ ok: true, value: true });
    expect(convertField('jein', field({ type: 'boolean' }), opts)).toMatchObject({
      ok: false,
      code: 'invalid_boolean',
    });
  });
});

describe('Datum und Zeit', () => {
  test('Datumsformate', () => {
    expect(parseDate('2024-02-29', 'YYYY-MM-DD')).toBe('2024-02-29');
    expect(parseDate('15.03.2025', 'DD.MM.YYYY')).toBe('2025-03-15');
    expect(parseDate('5.3.2025', 'DD.MM.YYYY')).toBe('2025-03-05');
    expect(parseDate('15/03/2025', 'DD/MM/YYYY')).toBe('2025-03-15');
    expect(parseDate('03/15/2025', 'MM/DD/YYYY')).toBe('2025-03-15');
    // ISO ist eindeutig und in jedem Format zulässig
    expect(parseDate('2025-03-15', 'DD.MM.YYYY')).toBe('2025-03-15');
    expect(parseDate('2025-03-15T10:00:00Z', 'ISO_DATETIME')).toBe('2025-03-15');
  });

  test('ungültige Kalenderdaten', () => {
    expect(parseDate('31.02.2004', 'DD.MM.YYYY')).toBeNull();
    expect(parseDate('29.02.2023', 'DD.MM.YYYY')).toBeNull();
    expect(parseDate('2025-13-01', 'YYYY-MM-DD')).toBeNull();
    expect(parseDate('15.03.2025', 'YYYY-MM-DD')).toBeNull();
    expect(parseDate('15/03/2025', 'MM/DD/YYYY')).toBeNull();
    expect(parseDate('morgen', 'DD.MM.YYYY')).toBeNull();
    expect(convertField('31.02.2004', field({ type: 'date' }), de)).toEqual({
      ok: false,
      code: 'invalid_date',
      params: { format: 'DD.MM.YYYY' },
    });
  });

  test('Zeitpunkte: Offset, Ortszeit (Sommer-/Winterzeit), reines Datum', () => {
    expect(parseDateTime('2026-03-14T09:30:00Z', 'ISO_DATETIME', TZ)).toBe('2026-03-14T09:30:00.000Z');
    expect(parseDateTime('2026-03-14T09:30:00+01:00', 'ISO_DATETIME', TZ)).toBe('2026-03-14T08:30:00.000Z');
    expect(parseDateTime('2026-03-14T09:30:00.250-0200', 'ISO_DATETIME', TZ)).toBe(
      '2026-03-14T11:30:00.250Z',
    );
    // ohne Offset: Europe/Berlin (Winter +1, Sommer +2)
    expect(parseDateTime('2026-01-10 12:00', 'ISO_DATETIME', TZ)).toBe('2026-01-10T11:00:00.000Z');
    expect(parseDateTime('2026-07-10T12:00:00', 'ISO_DATETIME', TZ)).toBe('2026-07-10T10:00:00.000Z');
    expect(parseDateTime('10.07.2026 12:00', 'DD.MM.YYYY', TZ)).toBe('2026-07-10T10:00:00.000Z');
    expect(parseDateTime('10.07.2026', 'DD.MM.YYYY', TZ)).toBe('2026-07-09T22:00:00.000Z');
    expect(parseDateTime('2026-07-10T25:00', 'ISO_DATETIME', TZ)).toBeNull();
    expect(convertField('gestern', field({ type: 'datetime' }), opts)).toMatchObject({
      ok: false,
      code: 'invalid_datetime',
    });
  });

  test('Zeitzonen-Hilfsfunktionen', () => {
    // Umstellung auf Sommerzeit am 29.03.2026: 23:30 UTC = 01:30 Ortszeit am Folgetag
    expect(localDate(new Date('2026-03-29T23:30:00Z'), TZ)).toBe('2026-03-30');
    expect(localDate(new Date('2026-03-29T21:30:00Z'), TZ)).toBe('2026-03-29');
    expect(new Date(zonedToUtc(Date.UTC(2026, 9, 25, 12, 0), TZ)).toISOString()).toBe(
      '2026-10-25T11:00:00.000Z',
    );
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(ageOn('2010-11-05', '2026-11-04')).toBe(15);
    expect(ageOn('2010-11-04', '2026-11-04')).toBe(16);
  });

  test('Beobachtungsdatum: nicht vor 1990, höchstens morgen', () => {
    expect(checkObservationDate('1989-12-31', '2026-11-04')).toMatchObject({
      ok: false,
      code: 'implausible_date',
    });
    expect(checkObservationDate('1990-01-01', '2026-11-04')).toBeNull();
    expect(checkObservationDate('2026-11-05', '2026-11-04')).toBeNull();
    expect(checkObservationDate('2026-11-06', '2026-11-04')).toEqual({
      ok: false,
      code: 'future_date',
      params: { max: '2026-11-05' },
    });
  });

  test('Geburtsdatum: Alter zwischen 6 und 80 Jahren', () => {
    expect(checkBirthDate('2020-11-04', '2026-11-04')).toBeNull();
    expect(checkBirthDate('2020-11-05', '2026-11-04')).toMatchObject({ ok: false, code: 'implausible_date' });
    expect(checkBirthDate('1946-11-04', '2026-11-04')).toBeNull();
    expect(checkBirthDate('1945-11-04', '2026-11-04')).toMatchObject({ ok: false, code: 'implausible_date' });
    expect(convertAthleteField('date_of_birth', '01.01.2030', de)).toMatchObject({
      ok: false,
      code: 'implausible_date',
    });
    expect(convertAthleteField('date_of_birth', '31.02.2004', de)).toMatchObject({
      ok: false,
      code: 'invalid_date',
    });
    expect(convertAthleteField('date_of_birth', '24.04.2001', de)).toEqual({ ok: true, value: '2001-04-24' });
  });
});

describe('Auswahlwerte und Texte', () => {
  test('enum: exakt oder ohne Groß-/Kleinschreibung, sonst invalid_enum', () => {
    const f = field({ type: 'enum', enumValues: ['CMJ', 'SJ', 'DJ'] });
    expect(convertField('CMJ', f, opts)).toEqual({ ok: true, value: 'CMJ' });
    expect(convertField('cmj', f, opts)).toEqual({ ok: true, value: 'CMJ' });
    expect(convertField('BJ', f, opts)).toEqual({
      ok: false,
      code: 'invalid_enum',
      params: { allowed: 'CMJ, SJ, DJ' },
    });
  });

  test('Kaderstatus und Geschlecht', () => {
    expect(convertAthleteField('squad_status', 'PK', opts)).toEqual({ ok: true, value: 'PK' });
    expect(convertAthleteField('squad_status', 'nk1', opts)).toEqual({ ok: true, value: 'NK1' });
    expect(convertAthleteField('squad_status', 'Bundeskader', opts)).toMatchObject({
      ok: false,
      code: 'invalid_enum',
    });
    expect(convertAthleteField('sex', 'F', opts)).toEqual({ ok: true, value: 'f' });
    expect(convertAthleteField('sex', 'x', opts)).toMatchObject({ ok: false, code: 'invalid_enum' });
  });

  test('Textlänge', () => {
    expect(convertAthleteField('last_name', 'a'.repeat(100), opts)).toMatchObject({ ok: true });
    expect(convertAthleteField('last_name', 'a'.repeat(101), opts)).toEqual({
      ok: false,
      code: 'too_long',
      params: { max: 100 },
    });
    expect(convertField('a'.repeat(2001), field({ type: 'string' }), opts)).toMatchObject({
      ok: false,
      code: 'too_long',
    });
  });
});
