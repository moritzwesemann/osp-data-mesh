import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWindows1252, FIXTURES_DIR } from '../../scripts/generate-fixtures.ts';
import { createMockMeasurementApi } from '../../scripts/mock-measurement-api.ts';
import {
  type AthleteLookup,
  applyValueMap,
  decodeText,
  detectDelimiter,
  emptyLookup,
  existingRecordKey,
  flagRecordUpdates,
  flattenItem,
  getPath,
  type MappedRow,
  mapRow,
  markDuplicates,
  missingColumns,
  naturalKeyOf,
  type PipelineContext,
  parseCsv,
  prepareValue,
  recordKeyOf,
  resolveAthletes,
  runPipeline,
  summarize,
  tableFromItems,
} from '../../src/server/modules/connectors/pipeline.ts';
import {
  fetchApiItems,
  isHostAllowed,
  sourceNameOf,
} from '../../src/server/modules/connectors/source-http.ts';
import { loadTemplates } from '../../src/server/modules/connectors/templates.ts';
import { HttpApiConfig } from '../../src/shared/contract/connectors.ts';
import type { FieldDef } from '../../src/shared/contract/datasets.ts';

const convert = {
  decimalSeparator: '.' as const,
  dateFormat: 'YYYY-MM-DD' as const,
  timeZone: 'Europe/Berlin',
  today: '2026-11-04',
};

const fields: FieldDef[] = [
  { name: 'test_date', label: 'Testdatum', type: 'date', required: true },
  { name: 'protocol', label: 'Protokoll', type: 'enum', required: true, enumValues: ['A', 'B'] },
  { name: 'vo2max', label: 'VO2max', type: 'number', required: true, min: 20, max: 95 },
  { name: 'hr', label: 'HF', type: 'integer', required: false, min: 120, max: 230 },
];

function datasetCtx(over: Partial<PipelineContext> = {}): PipelineContext {
  return {
    targetType: 'dataset',
    mapping: [
      { source: 'Nachname', target: 'athlete.last_name', transform: 'trim' },
      { source: 'Vorname', target: 'athlete.first_name', transform: 'trim' },
      { source: 'Geburtsdatum', target: 'athlete.date_of_birth', transform: 'trim' },
      { source: 'Datum', target: 'data.test_date', transform: 'trim' },
      { source: 'Protokoll', target: 'data.protocol', transform: 'trim' },
      { source: 'VO2', target: 'data.vo2max', transform: 'trim' },
      { source: 'HF', target: 'data.hr', transform: 'trim' },
    ],
    athleteMatch: { strategy: 'natural_key' },
    dataset: { fields, keyFields: ['test_date', 'protocol'], observedAtField: 'test_date' },
    convert,
    ...over,
  };
}

const athletesCtx: PipelineContext = {
  targetType: 'athletes',
  mapping: [
    { source: 'ID', target: 'athlete.external_id', transform: 'trim' },
    { source: 'Nachname', target: 'athlete.last_name', transform: 'trim' },
    { source: 'Vorname', target: 'athlete.first_name', transform: 'trim' },
    { source: 'Geburtsdatum', target: 'athlete.date_of_birth', transform: 'trim' },
    { source: 'Sportart', target: 'athlete.sport', transform: 'trim' },
    {
      source: 'Kader',
      target: 'athlete.squad_status',
      transform: 'trim',
      valueMap: { Perspektivkader: 'PK' },
      defaultValue: 'none',
    },
  ],
  athleteMatch: { strategy: 'external_id', system: 'osp-id' },
  dataset: null,
  convert,
};

const row = (rowNumber: number, raw: Record<string, string | null>) => ({ rowNumber, raw });
const ldRow = (n: number, over: Record<string, string | null> = {}) =>
  row(n, {
    Nachname: 'Muster',
    Vorname: 'Anna',
    Geburtsdatum: '2001-04-24',
    Datum: '2025-03-01',
    Protokoll: 'A',
    VO2: '58.4',
    HF: '190',
    ...over,
  });
const codes = (r: MappedRow) => r.issues.map((i) => `${i.code}:${i.field ?? ''}`);

describe('Dekodierung', () => {
  test('UTF-8 mit BOM: BOM wird entfernt', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Nachname;Größe\nMüller;1')]);
    const d = decodeText(bytes, 'utf-8');
    expect(d.fallback).toBe(false);
    expect(d.text.startsWith('Nachname')).toBe(true);
    expect(parseCsv(d.text, 'auto').columns).toEqual(['Nachname', 'Größe']);
  });

  test('Windows-1252 mit Umlauten', () => {
    const bytes = encodeWindows1252(
      'Nachname;Verein\r\nMüller;Ruderclub Großsee\r\nKöhler;Fechtclub Schönau\r\n',
    );
    expect(bytes).toContain(0xfc); // ü
    const d = decodeText(bytes, 'windows-1252');
    const t = parseCsv(d.text, 'auto');
    expect(t.rows.map((r) => r.raw.Nachname)).toEqual(['Müller', 'Köhler']);
    expect(t.rows[0]!.raw.Verein).toBe('Ruderclub Großsee');
    expect(decodeText(bytes, 'iso-8859-1').text).toContain('Schönau');
  });

  test('kein gültiges UTF-8 → Windows-1252 mit Hinweis', () => {
    const d = decodeText(encodeWindows1252('Jäger;Süß'), 'utf-8');
    expect(d).toEqual({ text: 'Jäger;Süß', encoding: 'windows-1252', fallback: true });
  });

  test('Unicode-Normalisierung (NFC)', () => {
    const decomposed = 'Müller';
    expect(decodeText(new TextEncoder().encode(decomposed), 'utf-8').text).toBe('Müller');
  });
});

describe('CSV', () => {
  test('Trennzeichen erkennen', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    // Trennzeichen in Anführungszeichen zählen nicht
    expect(detectDelimiter('"a;x;y",b,c\n"1;2;3",2,3')).toBe(',');
    expect(detectDelimiter('Wert,mit;Semikolon;am;Ende\n1;2;3;4')).toBe(';');
    expect(detectDelimiter('nur_eine_spalte\n1')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });

  test('Kopfzeile, Anführungszeichen, Leerzeilen, CRLF, doppelte Spaltennamen', () => {
    const t = parseCsv('Name;Wert;Wert\r\n"Müller; Anna";"1,5";x\r\n\r\nSchmidt;2;\r\n', 'auto');
    expect(t.delimiter).toBe(';');
    expect(t.columns).toEqual(['Name', 'Wert', 'Wert (2)']);
    expect(t.rows).toEqual([
      { rowNumber: 1, raw: { Name: 'Müller; Anna', Wert: '1,5', 'Wert (2)': 'x' } },
      { rowNumber: 2, raw: { Name: 'Schmidt', Wert: '2', 'Wert (2)': '' } },
    ]);
    expect(t.issues).toEqual([]);
  });

  test('falsche Spaltenzahl → invalid_row; leere Zusatzzelle wird toleriert', () => {
    const t = parseCsv('a;b\n1;2;\n1;2;3\n1\n', ';');
    expect(t.issues.map((i) => [i.rowNumber, i.code])).toEqual([
      [2, 'invalid_row'],
      [3, 'invalid_row'],
    ]);
    // fehlende Zellen bleiben aus (keine Platzhalter je Spalte)
    expect(t.rows[2]!.raw).toEqual({ a: '1' });
  });

  test('leere Datei', () => {
    expect(parseCsv('', 'auto')).toMatchObject({ columns: [], rows: [] });
  });
});

describe('JSON-Quellen', () => {
  test('Punkt-Pfade und Abflachen', () => {
    const body = { data: { items: [1] }, meta: { next: 'abc' } };
    expect(getPath(body, 'data.items')).toEqual([1]);
    expect(getPath(body, 'meta.next')).toBe('abc');
    expect(getPath(body, '')).toBe(body);
    expect(getPath(body, 'x.y')).toBeUndefined();
    expect(
      flattenItem({ id: 1, athlete: { external_id: 'N-1', tags: ['a'] }, ok: true, v: null, z: 1.5 }),
    ).toEqual({
      id: '1',
      'athlete.external_id': 'N-1',
      'athlete.tags': '["a"]',
      ok: 'true',
      v: null,
      z: '1.5',
    });
  });

  test('Spalten aus der Vereinigung aller Schlüssel', () => {
    const t = tableFromItems([{ a: 1 }, { a: 2, b: { c: 3 } }]);
    expect(t.columns).toEqual(['a', 'b.c']);
    expect(t.rows[0]).toEqual({ rowNumber: 1, raw: { a: '1' } });
  });
});

describe('Zuordnung: Transformation, Wertübersetzung, Ersatzwert', () => {
  test('transform', () => {
    const m = { source: 's', target: 'data.x' } as const;
    expect(prepareValue('  Abc ', { ...m, transform: 'trim' })).toBe('Abc');
    expect(prepareValue('  Abc ', { ...m, transform: 'none' })).toBe('  Abc ');
    expect(prepareValue(' cmj ', { ...m, transform: 'upper' })).toBe('CMJ');
    expect(prepareValue(' ÄB ', { ...m, transform: 'lower' })).toBe('äb');
  });

  test('valueMap exakt und ohne Groß-/Kleinschreibung', () => {
    const map = { Perspektivkader: 'PK', 'kein Kader': 'none' };
    expect(applyValueMap('Perspektivkader', map)).toBe('PK');
    expect(applyValueMap('KEIN KADER', map)).toBe('none');
    expect(applyValueMap('Bundeskader', map)).toBe('Bundeskader');
    expect(applyValueMap('x', undefined)).toBe('x');
  });

  test('Ersatzwert nur für leere Werte', () => {
    const m = {
      source: 's',
      target: 'athlete.squad_status',
      transform: 'trim',
      defaultValue: 'none',
    } as const;
    expect(prepareValue('', m)).toBe('none');
    expect(prepareValue('   ', m)).toBe('none');
    expect(prepareValue(null, m)).toBe('none');
    expect(prepareValue('PK', m)).toBe('PK');
    expect(prepareValue('', { ...m, defaultValue: undefined })).toBeNull();
  });

  test('fehlende Quellspalten', () => {
    expect(missingColumns(['Nachname', 'Datum'], datasetCtx().mapping).map((m) => m.source)).toEqual([
      'Vorname',
      'Geburtsdatum',
      'Protokoll',
      'VO2',
      'HF',
    ]);
  });
});

describe('Zeilenprüfung', () => {
  test('gültige Zeile: Typen, Beobachtungsdatum, Schlüssel', () => {
    const r = mapRow(ldRow(1), datasetCtx());
    expect(r.issues).toEqual([]);
    expect(r.data).toEqual({ test_date: '2025-03-01', protocol: 'A', vo2max: 58.4, hr: 190 });
    expect(r.mapped['athlete.date_of_birth']).toBe('2001-04-24');
    expect(r.naturalKey).toBe('muster|anna|2001-04-24');
    expect(r.observedAt).toBe('2025-03-01T00:00:00.000Z');
    expect(r.recordKey).toBe('k:["2025-03-01","A"]');
  });

  test('jeder Feldfehler-Code', () => {
    const ctx = datasetCtx();
    expect(codes(mapRow(ldRow(1, { VO2: '' }), ctx))).toEqual(['required:data.vo2max']);
    expect(codes(mapRow(ldRow(1, { VO2: 'viel' }), ctx))).toEqual(['invalid_number:data.vo2max']);
    expect(codes(mapRow(ldRow(1, { VO2: '140' }), ctx))).toEqual(['out_of_range:data.vo2max']);
    expect(codes(mapRow(ldRow(1, { HF: '190.5' }), ctx))).toEqual(['invalid_integer:data.hr']);
    expect(codes(mapRow(ldRow(1, { Datum: '2025-02-30' }), ctx))).toEqual(['invalid_date:data.test_date']);
    expect(codes(mapRow(ldRow(1, { Datum: '2099-03-15' }), ctx))).toEqual(['future_date:data.test_date']);
    expect(codes(mapRow(ldRow(1, { Datum: '1985-06-01' }), ctx))).toEqual([
      'implausible_date:data.test_date',
    ]);
    expect(codes(mapRow(ldRow(1, { Protokoll: 'C' }), ctx))).toEqual(['invalid_enum:data.protocol']);
    expect(codes(mapRow(ldRow(1, { Geburtsdatum: '2024-01-01' }), ctx))).toEqual([
      'implausible_date:athlete.date_of_birth',
    ]);
    expect(codes(mapRow(ldRow(1, { Nachname: '' }), ctx))).toEqual(['required:athlete.last_name']);
    // optionale Felder dürfen leer sein
    expect(mapRow(ldRow(1, { HF: '' }), ctx).issues).toEqual([]);
  });

  test('Fehler enthalten Rohwert und Quellspalte', () => {
    const [issue] = mapRow(ldRow(7, { VO2: ' 140 ' }), datasetCtx()).issues;
    expect(issue).toEqual({
      rowNumber: 7,
      field: 'data.vo2max',
      code: 'out_of_range',
      severity: 'error',
      rawValue: ' 140 ',
      params: { column: 'VO2', min: 20, max: 95 },
    });
  });

  test('boolean, datetime und Datum als Beobachtungszeitpunkt (Ortszeit)', () => {
    const ctx = datasetCtx({
      mapping: [
        { source: 'ID', target: 'athlete.external_id', transform: 'trim' },
        { source: 'At', target: 'data.at', transform: 'trim' },
        { source: 'Ok', target: 'data.ok', transform: 'trim' },
      ],
      athleteMatch: { strategy: 'external_id', system: 'osp-id' },
      dataset: {
        fields: [
          { name: 'at', label: 'Zeit', type: 'datetime', required: true },
          { name: 'ok', label: 'Ok', type: 'boolean', required: false },
        ],
        keyFields: [],
        observedAtField: 'at',
      },
    });
    const good = mapRow(row(1, { ID: 'N-1', At: '2026-07-10T08:00:00', Ok: 'x' }), ctx);
    expect(good.issues).toEqual([]);
    expect(good.data).toEqual({ at: '2026-07-10T06:00:00.000Z', ok: true });
    expect(good.observedAt).toBe('2026-07-10T06:00:00.000Z');
    expect(good.recordKey).toMatch(/^h:[0-9a-f]{64}$/);
    expect(codes(mapRow(row(1, { ID: 'N-1', At: 'gestern', Ok: '' }), ctx))).toEqual([
      'invalid_datetime:data.at',
    ]);
    expect(codes(mapRow(row(1, { ID: 'N-1', At: '2026-07-10T08:00:00', Ok: 'jein' }), ctx))).toEqual([
      'invalid_boolean:data.ok',
    ]);
    // morgen (Ortszeit) ist noch zulässig, übermorgen nicht
    expect(mapRow(row(1, { ID: 'N-1', At: '2026-11-05T23:00:00', Ok: '' }), ctx).issues).toEqual([]);
    expect(codes(mapRow(row(1, { ID: 'N-1', At: '2026-11-06T00:30:00', Ok: '' }), ctx))).toEqual([
      'future_date:data.at',
    ]);
    expect(codes(mapRow(row(1, { ID: '', At: '2026-07-10T08:00:00', Ok: '' }), ctx))).toEqual([
      'required:athlete.external_id',
    ]);
  });

  test('Athletenkern: Pflichtfelder, Kaderstatus über Wertübersetzung, unbekannter Wert', () => {
    const base = {
      ID: 'N-1',
      Nachname: 'Muster',
      Vorname: 'Anna',
      Geburtsdatum: '2001-04-24',
      Sportart: 'Judo',
    };
    expect(mapRow(row(1, { ...base, Kader: 'Perspektivkader' }), athletesCtx).athlete.squad_status).toBe(
      'PK',
    );
    expect(mapRow(row(1, { ...base, Kader: '' }), athletesCtx).athlete.squad_status).toBe('none');
    expect(codes(mapRow(row(1, { ...base, Kader: 'Bundeskader' }), athletesCtx))).toEqual([
      'invalid_enum:athlete.squad_status',
    ]);
    expect(codes(mapRow(row(1, { ...base, Sportart: ' ', Kader: 'PK' }), athletesCtx))).toEqual([
      'required:athlete.sport',
    ]);
    expect(codes(mapRow(row(1, { ...base, ID: '', Kader: 'PK' }), athletesCtx))).toEqual([
      'required:athlete.external_id',
    ]);
  });
});

describe('Personenabgleich', () => {
  const lookup = (): AthleteLookup => {
    const l = emptyLookup();
    l.byNaturalKey.set(naturalKeyOf('Muster', 'Anna', '2001-04-24'), ['a1']);
    l.byNaturalKey.set(naturalKeyOf('Doppelt', 'Max', '2000-01-01'), ['a2', 'a3']);
    l.byExternalId.set('N-1', 'a1');
    l.athletes.set('a1', {
      last_name: 'Muster',
      first_name: 'Anna',
      date_of_birth: '2001-04-24',
      sport: 'Judo',
      squad_status: 'PK',
    });
    return l;
  };

  test('Datensatz: gefunden (auch ohne Groß-/Kleinschreibung), nicht gefunden, mehrdeutig', () => {
    const ctx = datasetCtx();
    const rows = [
      mapRow(ldRow(1, { Nachname: 'MUSTER' }), ctx),
      mapRow(ldRow(2, { Nachname: 'Unbekannt' }), ctx),
      mapRow(ldRow(3, { Nachname: 'Doppelt', Vorname: 'Max', Geburtsdatum: '2000-01-01' }), ctx),
    ];
    resolveAthletes(rows, lookup(), ctx);
    expect(rows[0]!.athleteId).toBe('a1');
    expect(codes(rows[1]!)).toEqual(['athlete_not_found:']);
    // keine Personenkennung als Rohwert, nur die Zuordnungsfelder als Hinweis
    expect(rows[1]!.issues[0]).toMatchObject({
      rawValue: null,
      params: { fields: 'athlete.last_name,athlete.first_name,athlete.date_of_birth' },
    });
    expect(rows[2]!.issues[0]).toMatchObject({ code: 'athlete_ambiguous', params: { count: 2 } });
  });

  test('Datensatz über Kennung, ersatzweise natürlicher Schlüssel', () => {
    const ctx = datasetCtx({
      mapping: [...datasetCtx().mapping, { source: 'ID', target: 'athlete.external_id', transform: 'trim' }],
      athleteMatch: { strategy: 'external_id', system: 'osp-id' },
    });
    const rows = [
      mapRow(ldRow(1, { ID: 'N-1', Nachname: 'Anders' }), ctx),
      mapRow(ldRow(2, { ID: 'N-2' }), ctx),
      mapRow(ldRow(3, { ID: 'N-3', Nachname: 'Fremd' }), ctx),
    ];
    resolveAthletes(rows, lookup(), ctx);
    expect(rows[0]!.athleteId).toBe('a1');
    expect(rows[1]!.athleteId).toBe('a1');
    expect(rows[2]!.issues[0]).toMatchObject({
      code: 'athlete_not_found',
      field: 'athlete.external_id',
      rawValue: null,
      params: { system: 'osp-id' },
    });
  });

  test('Athletenkern: neu, unverändert, geändert (Hinweis will_update), Konflikt', () => {
    const base = {
      Nachname: 'Muster',
      Vorname: 'Anna',
      Geburtsdatum: '2001-04-24',
      Sportart: 'Judo',
      Kader: 'PK',
    };
    const rows = [
      mapRow(row(1, { ...base, ID: 'N-9', Nachname: 'Neu' }), athletesCtx),
      mapRow(row(2, { ...base, ID: 'N-1' }), athletesCtx),
      mapRow(row(3, { ...base, ID: 'N-1', Kader: 'OK' }), athletesCtx),
      mapRow(row(4, { ...base, ID: 'N-7' }), athletesCtx),
      mapRow(
        row(5, { ...base, ID: 'N-1', Nachname: 'Doppelt', Vorname: 'Max', Geburtsdatum: '2000-01-01' }),
        athletesCtx,
      ),
    ];
    resolveAthletes(rows, lookup(), athletesCtx);
    expect(rows[0]!.athleteId).toBeNull();
    expect(rows[0]!.issues).toEqual([]);
    expect(rows[1]!.athleteId).toBe('a1');
    expect(rows[1]!.issues).toEqual([]);
    expect(rows[1]!.changed).toBe(false);
    expect(rows[2]!.issues).toEqual([
      expect.objectContaining({
        code: 'will_update',
        severity: 'warning',
        params: { fields: 'squad_status' },
      }),
    ]);
    expect(rows[2]!.changed).toBe(true);
    // unbekannte Kennung, aber Person über Name + Geburtsdatum vorhanden → wird verknüpft
    expect(rows[3]!.athleteId).toBe('a1');
    expect(rows[4]!.issues[0]).toMatchObject({
      code: 'athlete_ambiguous',
      params: { reason: 'natural_key_conflict' },
    });
  });
});

describe('Dubletten und Schlüssel', () => {
  test('gleicher Schlüssel in einer Quelle: zweites Vorkommen ist Fehler', () => {
    const ctx = datasetCtx();
    const rows = [
      mapRow(ldRow(1), ctx),
      mapRow(ldRow(2, { Protokoll: 'B' }), ctx),
      mapRow(ldRow(3, { VO2: '60' }), ctx),
      mapRow(ldRow(4, { Nachname: 'Anders' }), ctx),
    ];
    markDuplicates(rows, ctx);
    expect(rows.map((r) => r.issues.map((i) => i.code))).toEqual([[], [], ['duplicate_in_source'], []]);
    expect(rows[2]!.issues[0]!.params).toEqual({ firstRow: 1 });
  });

  test('Athletenkern: gleiche Kennung oder gleicher natürlicher Schlüssel', () => {
    const base = {
      Nachname: 'Muster',
      Vorname: 'Anna',
      Geburtsdatum: '2001-04-24',
      Sportart: 'Judo',
      Kader: 'PK',
    };
    const rows = [
      mapRow(row(1, { ...base, ID: 'N-1' }), athletesCtx),
      mapRow(row(2, { ...base, ID: 'N-1', Vorname: 'Berta' }), athletesCtx),
      mapRow(row(3, { ...base, ID: 'N-2' }), athletesCtx),
      mapRow(row(4, { ...base, ID: 'N-3', Vorname: 'Clara' }), athletesCtx),
    ];
    markDuplicates(rows, athletesCtx);
    expect(rows.map((r) => r.issues.map((i) => i.code))).toEqual([
      [],
      ['duplicate_in_source'],
      ['duplicate_in_source'],
      [],
    ]);
  });

  test('record_key ist deterministisch', () => {
    const a = { test_date: '2025-03-01', protocol: 'A', vo2max: 58.4 };
    const b = { vo2max: 58.4, protocol: 'A', test_date: '2025-03-01' };
    expect(recordKeyOf(a, ['test_date', 'protocol'])).toBe('k:["2025-03-01","A"]');
    expect(recordKeyOf(a, ['protocol', 'test_date'])).toBe('k:["A","2025-03-01"]');
    expect(recordKeyOf({ ...a, vo2max: 60 }, ['test_date', 'protocol'])).toBe(
      recordKeyOf(a, ['test_date', 'protocol']),
    );
    expect(recordKeyOf(a, ['missing'])).toBe('k:[null]');
    // ohne Schlüsselfelder: Hash über alle nicht-leeren Werte, unabhängig von der Reihenfolge
    expect(recordKeyOf(a, [])).toBe(recordKeyOf(b, []));
    expect(recordKeyOf({ ...a, hr: null }, [])).toBe(recordKeyOf(a, []));
    expect(recordKeyOf({ ...a, vo2max: 58.5 }, [])).not.toBe(recordKeyOf(a, []));
    expect(recordKeyOf(a, [])).toMatch(/^h:[0-9a-f]{64}$/);
  });

  test('vorhandener Eintrag: Hinweis nur bei geänderten Werten', () => {
    const ctx = datasetCtx();
    const rows = [mapRow(ldRow(1), ctx), mapRow(ldRow(2, { Protokoll: 'B', VO2: '61' }), ctx)];
    rows[0]!.athleteId = 'a1';
    rows[1]!.athleteId = 'a1';
    const existing = new Map([
      [existingRecordKey('a1', rows[0]!.recordKey!), { ...rows[0]!.data }],
      [existingRecordKey('a1', rows[1]!.recordKey!), { ...rows[1]!.data, vo2max: 60 }],
    ]);
    flagRecordUpdates(rows, existing);
    expect(rows[0]!.issues).toEqual([]);
    expect(rows[1]!.issues[0]).toMatchObject({ code: 'will_update', params: { fields: 'vo2max' } });
  });

  test('Zusammenfassung: Zähler und Vorschau', () => {
    const ctx = datasetCtx();
    const rows = [
      mapRow(ldRow(1), ctx),
      mapRow(ldRow(2, { VO2: 'x' }), ctx),
      mapRow(ldRow(3, { Protokoll: 'B' }), ctx),
    ];
    rows[2]!.issues.push({
      rowNumber: 3,
      field: null,
      code: 'will_update',
      severity: 'warning',
      rawValue: null,
      params: {},
    });
    const s = summarize(rows, [
      {
        rowNumber: 0,
        field: null,
        code: 'encoding_fallback',
        severity: 'warning',
        rawValue: null,
        params: {},
      },
    ]);
    expect(s).toMatchObject({ totalRows: 3, validRows: 2, errorRows: 1, warningRows: 1 });
    expect(s.valid.map((r) => r.rowNumber)).toEqual([1, 3]);
    expect(s.preview.map((p) => p.status)).toEqual(['valid', 'error', 'warning']);
    expect(s.issues.map((i) => i.code)).toEqual(['encoding_fallback', 'invalid_number', 'will_update']);
  });
});

describe('HTTP-Quelle', () => {
  const config = (over: Record<string, unknown> = {}) =>
    HttpApiConfig.parse({
      type: 'http_api',
      url: 'https://measure.mesh.test/v1/measurements',
      itemsPath: 'data',
      auth: { type: 'bearer' },
      pagination: { type: 'page', pageParam: 'page', sizeParam: 'page_size', pageSize: 50 },
      ...over,
    });
  const api = createMockMeasurementApi({ token: 'geheim' });
  const fetchVia =
    (handler: (req: Request) => Response | Promise<Response>) =>
    (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handler(input instanceof Request ? input : new Request(String(input), init)));

  test('Freigabeliste host[:port]', () => {
    const allowed = ['measure.mesh.test', '127.0.0.1:4410'];
    expect(isHostAllowed('http://MEASURE.mesh.test/x', allowed)).toBe(true);
    expect(isHostAllowed('http://127.0.0.1:4410/v1', allowed)).toBe(true);
    expect(isHostAllowed('http://127.0.0.1:4411/v1', allowed)).toBe(false);
    expect(isHostAllowed('http://measure.mesh.test:8080/x', allowed)).toBe(false);
    expect(isHostAllowed('http://evil.test/?h=measure.mesh.test', allowed)).toBe(false);
    expect(isHostAllowed('kein url', allowed)).toBe(false);
    expect(sourceNameOf('http://measure.mesh.test/v1/m?token=x')).toBe('http://measure.mesh.test/v1/m');
  });

  test('seitenweiser Abruf mit Bearer-Token', async () => {
    const r = await fetchApiItems(fetchVia(api), config(), 'geheim');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items.length).toBe(123);
    expect(r.pages).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.size).toBeGreaterThan(1000);
  });

  test('maxPages begrenzt den Abruf', async () => {
    const r = await fetchApiItems(
      fetchVia(api),
      config({
        pagination: { type: 'page', pageParam: 'page', sizeParam: 'page_size', pageSize: 50, maxPages: 2 },
      }),
      'geheim',
    );
    expect(r).toMatchObject({ ok: true, pages: 2, truncated: true });
  });

  test('Cursor-Paginierung', async () => {
    const pages: Record<string, unknown> = {
      '': { items: [{ id: 1 }, { id: 2 }], next: 'c2' },
      c2: { items: [{ id: 3 }], next: null },
    };
    const seen: string[] = [];
    const handler = (req: Request) => {
      const cursor = new URL(req.url).searchParams.get('cursor') ?? '';
      seen.push(cursor);
      return Response.json(pages[cursor]);
    };
    const r = await fetchApiItems(
      fetchVia(handler),
      config({
        itemsPath: 'items',
        auth: { type: 'none' },
        pagination: { type: 'cursor', cursorParam: 'cursor', nextCursorPath: 'next' },
      }),
      null,
    );
    expect(seen).toEqual(['', 'c2']);
    expect(r).toMatchObject({ ok: true, pages: 2 });
  });

  test('Fehler: HTTP-Status, Netzwerk, kein JSON, kein Array', async () => {
    expect(await fetchApiItems(fetchVia(api), config(), null)).toMatchObject({
      ok: false,
      code: 'source_unreachable',
      params: { status: 401 },
    });
    expect(
      await fetchApiItems(() => Promise.reject(new TypeError('fetch failed')), config(), null),
    ).toMatchObject({ ok: false, code: 'source_unreachable', params: { reason: 'network' } });
    expect(
      await fetchApiItems(
        fetchVia(() => new Response('<html>')),
        config(),
        null,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_response', params: { reason: 'not_json' } });
    expect(
      await fetchApiItems(
        fetchVia(() => Response.json({ data: { x: 1 } })),
        config(),
        null,
      ),
    ).toMatchObject({ ok: false, code: 'invalid_response', params: { reason: 'items_not_array' } });
    expect(
      await fetchApiItems(
        fetchVia(() => new Response(null, { status: 302, headers: { location: 'http://x' } })),
        config(),
        null,
      ),
    ).toMatchObject({ ok: false, code: 'source_unreachable', params: { status: 302 } });
  });

  test('Header-Authentifizierung und Query-Parameter', async () => {
    let seen: Request | null = null;
    const handler = (req: Request) => {
      seen = req;
      return Response.json([]);
    };
    await fetchApiItems(
      fetchVia(handler),
      config({
        itemsPath: '',
        auth: { type: 'header', headerName: 'X-Api-Key' },
        pagination: { type: 'none' },
        query: { since: '2026-01-01' },
      }),
      'k1',
    );
    expect(seen!.headers.get('x-api-key')).toBe('k1');
    expect(seen!.headers.get('authorization')).toBeNull();
    expect(new URL(seen!.url).searchParams.get('since')).toBe('2026-01-01');
  });
});

describe('Vorlagen und Demo-Dateien', () => {
  const templates = loadTemplates();

  test('alle Vorlagen sind gültige Connector-Definitionen', () => {
    expect(templates.map((t) => t.id)).toEqual([
      'athleten-stammdaten-csv',
      'leistungsdiagnostik-csv',
      'sprungkraft-api',
      'verletzungen-csv',
    ]);
    const verletzungen = templates.find((t) => t.id === 'verletzungen-csv')!.definition.dataset!;
    expect(verletzungen).toMatchObject({ category: 'health', specialCategory: true });
  });

  function ctxFor(id: string): PipelineContext {
    const def = templates.find((t) => t.id === id)!.definition;
    const config = def.connector.config;
    return {
      targetType: def.connector.targetType,
      mapping: def.connector.mapping,
      athleteMatch: def.connector.athleteMatch,
      dataset: def.dataset,
      convert: {
        ...convert,
        decimalSeparator: config.type === 'csv' ? config.decimalSeparator : '.',
        dateFormat: config.dateFormat,
      },
    };
  }

  test('osp-nord/athleten.csv: genau 3 fehlerhafte Zeilen', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, 'osp-nord/athleten.csv')));
    const table = parseCsv(decodeText(bytes, 'utf-8').text, 'auto');
    const { summary } = runPipeline(table, ctxFor('athleten-stammdaten-csv'), emptyLookup());
    expect(summary).toMatchObject({ totalRows: 43, validRows: 40, errorRows: 3, warningRows: 0 });
    expect(summary.issues.map((i) => [i.rowNumber, i.code, i.field])).toEqual([
      [13, 'invalid_date', 'athlete.date_of_birth'],
      [27, 'required', 'athlete.sport'],
      [38, 'invalid_enum', 'athlete.squad_status'],
    ]);
  });

  test('osp-mitte/athleten.csv (Windows-1252) mit UTF-8-Vorlage: Rückfall, korrekte Umlaute', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, 'osp-mitte/athleten.csv')));
    const decoded = decodeText(bytes, 'utf-8');
    expect(decoded.fallback).toBe(true);
    const { summary, rows } = runPipeline(
      parseCsv(decoded.text, 'auto'),
      ctxFor('athleten-stammdaten-csv'),
      emptyLookup(),
    );
    expect(summary).toMatchObject({ totalRows: 25, errorRows: 0 });
    expect(rows.some((r) => /[äöüß]/.test(String(r.athlete.last_name)))).toBe(true);
  });

  test('osp-nord/leistungsdiagnostik.csv: 2 unplausible Zeilen', () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, 'osp-nord/leistungsdiagnostik.csv')));
    const table = parseCsv(decodeText(bytes, 'utf-8').text, ',');
    const ctx = ctxFor('leistungsdiagnostik-csv');
    // alle Personen "vorhanden"
    const lookup = emptyLookup();
    for (const r of table.rows) {
      const nk = naturalKeyOf(r.raw.Nachname!, r.raw.Vorname!, r.raw.Geburtsdatum!);
      lookup.byNaturalKey.set(nk, [nk]);
    }
    const { summary } = runPipeline(table, ctx, lookup);
    expect(summary).toMatchObject({ totalRows: 80, errorRows: 2 });
    expect(summary.issues.map((i) => i.code).sort()).toEqual(['future_date', 'out_of_range']);
  });
});
