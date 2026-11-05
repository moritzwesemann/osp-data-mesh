/**
 * Excel-Import (.xlsx): Lesen von Tabellenblättern, Zahlen, Datumswerten und Formeln sowie Abwehr
 * feindlicher Dateien (ZIP-Bomben, ZIP64, Verschlüsselung, DTD/Entitäten, Obergrenzen).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toCsv } from '../../src/server/core/formats.ts';
import {
  clipValues,
  emptyLookup,
  PREVIEW_VALUE_CHARS,
  runPipeline,
} from '../../src/server/modules/connectors/pipeline.ts';
import {
  decodeXmlText,
  formatKind,
  MAX_CELL_CHARS,
  MAX_INFLATED_BYTES,
  MAX_SHEET_CHARS,
  numberText,
  readXlsx,
  serialText,
  type XlsxRead,
  type XlsxReadOptions,
  XmlScanner,
} from '../../src/server/modules/connectors/xlsx.ts';
import type { FieldDef } from '../../src/shared/contract/datasets.ts';
import { buildXlsx, type Cell, deflateRepeated, esc, type SheetSpec, zip } from '../helpers/xlsx.ts';

const OPTS: XlsxReadOptions = { sheet: '', headerRow: 1, decimalSeparator: ',' };

function read(bytes: Uint8Array, opts: Partial<XlsxReadOptions> = {}): XlsxRead {
  return readXlsx(bytes, { ...OPTS, ...opts });
}

function table(bytes: Uint8Array, opts: Partial<XlsxReadOptions> = {}) {
  const r = read(bytes, opts);
  if (!r.ok) throw new Error(`readXlsx failed: ${r.code} ${JSON.stringify(r.params)}`);
  return r.table;
}

function reason(bytes: Uint8Array): string | undefined {
  const r = read(bytes);
  if (r.ok) return 'ok';
  expect(r.code).toBe('invalid_file');
  return String(r.params.reason);
}

const sheet = (rows: (Cell[] | null)[], name = 'Tabelle1'): SheetSpec => ({ name, rows });
const one = (rows: (Cell[] | null)[], extra: Partial<Parameters<typeof buildXlsx>[0]> = {}) =>
  buildXlsx({ sheets: [sheet(rows)], ...extra });

describe('Tabellenblatt lesen', () => {
  test('Kopfzeile, gemeinsame Texte, Zahlen, Wahrheitswerte; leere Zeilen und Lücken übersprungen', () => {
    const t = table(
      one([
        ['Name', 'Wert', 'Aktiv'],
        ['Anna', 12.5, true],
        [],
        null,
        ['  ', null, undefined],
        ['Ben', 3, false],
      ]),
    );
    expect(t.columns).toEqual(['Name', 'Wert', 'Aktiv']);
    expect(t.rows.map((r) => ({ ...r.raw }))).toEqual([
      { Name: 'Anna', Wert: '12,5', Aktiv: 'true' },
      { Name: 'Ben', Wert: '3', Aktiv: 'false' },
    ]);
    // Zeilennummern wie beim CSV-Import: 1-basiert ohne Kopfzeile, nur nicht leere Zeilen
    expect(t.rows.map((r) => r.rowNumber)).toEqual([1, 2]);
    expect(t.issues).toEqual([]);
  });

  test('Zahlen mit Dezimalpunkt, wenn so eingestellt; 15 signifikante Stellen wie in Excel', () => {
    const t = table(
      one([
        ['a', 'b', 'c', 'd', 'e'],
        [0.1 + 0.2, 68.900000000000006, 123456789012345, 1.5e-7, -0],
      ]),
      { decimalSeparator: '.' },
    );
    expect({ ...t.rows[0]!.raw }).toEqual({ a: '0.3', b: '68.9', c: '123456789012345', d: '1.5e-7', e: '0' });
    expect(numberText(1234.5, ',')).toBe('1234,5');
    expect(numberText(1e21, ',')).toBe('1e+21');
  });

  test('Inline-Texte, Rich Text ohne phonetische Lesehilfe, Entitäten und Excel-Escapes', () => {
    const t = table(
      one(
        [
          ['Text', 'Rich', 'Esc'],
          [
            { inline: 'Müller & Söhne <GmbH>' },
            { rich: ['Fett', ' und normal'], phonetic: 'ふりがな' },
            'a_x000D_b',
          ],
        ],
        { sharedStrings: true },
      ),
    );
    expect({ ...t.rows[0]!.raw }).toEqual({
      Text: 'Müller & Söhne <GmbH>',
      Rich: 'Fett und normal',
      Esc: 'a\rb',
    });
    expect(decodeXmlText('&#x41;&#66;&amp;&lt;&unknown;&#0;')).toBe('AB&<&unknown;&#0;');
  });

  test('Elemente mit Namensraum-Präfix (z. B. OpenXML SDK: <x:row>)', () => {
    const t = table(
      one(
        [
          ['Nachname', 'Zahl'],
          ['Meier', 7],
        ],
        { prefix: 'x' },
      ),
    );
    expect({ ...t.rows[0]!.raw }).toEqual({ Nachname: 'Meier', Zahl: '7' });
  });

  test('Kopfzeile ab einer Zeilennummer: Titelzeilen davor werden übersprungen', () => {
    const bytes = one([['Leistungsdiagnostik 2026'], [], ['Name', '', 'Name'], ['A', 'x', 'B']]);
    // Standard (Zeile 1): die Titelzeile wäre die Kopfzeile
    expect(table(bytes).columns).toEqual(['Leistungsdiagnostik 2026']);
    const t = table(bytes, { headerRow: 2 });
    expect(t.columns).toEqual(['Name', 'Spalte 2', 'Name (2)']);
    expect({ ...t.rows[0]!.raw }).toEqual({ Name: 'A', 'Spalte 2': 'x', 'Name (2)': 'B' });
  });

  test('Werte außerhalb der Spalten der Kopfzeile: invalid_row (wie beim CSV-Import); kurze Zeilen sind gültig', () => {
    const t = table(
      one([
        [null, 'A', 'B'],
        [null, '1'],
        ['links', '2', '3'],
        [null, '4', '5', 'rechts'],
      ]),
    );
    expect(t.columns).toEqual(['A', 'B']);
    expect(t.rows.map((r) => ({ ...r.raw }))).toEqual([{ A: '1' }, { A: '2', B: '3' }, { A: '4', B: '5' }]);
    expect(t.issues.map((i) => [i.rowNumber, i.code, i.params])).toEqual([
      [2, 'invalid_row', { expected: 2, actual: 3 }],
      [3, 'invalid_row', { expected: 2, actual: 3 }],
    ]);
  });

  test('Spaltennamen wie "__proto__" und "constructor" sind gewöhnliche Schlüssel', () => {
    const t = table(
      one([
        ['__proto__', 'constructor', 'toString'],
        ['x', null, 'z'],
      ]),
    );
    const raw = t.rows[0]!.raw;
    expect(Object.getOwnPropertyDescriptor(raw, '__proto__')?.value).toBe('x');
    expect(raw.constructor).toBeUndefined();
    expect(Object.keys(raw)).toEqual(['__proto__', 'toString']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('Datum und Uhrzeit', () => {
  test('Datumszellen → ISO 8601 (eingebaute und eigene Formate), Uhrzeit, verstrichene Zeit', () => {
    const t = table(
      one([
        ['Datum', 'Zeitpunkt', 'Laufzeit', 'Dauer', 'DE', 'Bruch'],
        [
          { date: '2026-03-01' },
          { date: '2026-03-01T09:30:15' },
          { n: 52.3 / 86400, style: 'time' },
          { n: 1.25, style: 'elapsed' },
          { date: '2024-02-29', style: 'dateDe' },
          { n: 45352.75, style: 'date' },
        ],
      ]),
    );
    expect({ ...t.rows[0]!.raw }).toEqual({
      Datum: '2026-03-01',
      Zeitpunkt: '2026-03-01T09:30:15',
      Laufzeit: '00:00:52.300',
      Dauer: '30:00:00',
      DE: '2024-02-29',
      // Datumsformat ohne Uhrzeit: angezeigt (und übernommen) wird der Tag
      Bruch: '2024-03-01',
    });
  });

  test('1900-System (Schaltjahrfehler 29.02.1900) und 1904-System', () => {
    expect(serialText(1, 'date', false)).toBe('1900-01-01');
    expect(serialText(59, 'date', false)).toBe('1900-02-28');
    expect(serialText(60, 'date', false)).toBeNull();
    expect(serialText(61, 'date', false)).toBe('1900-03-01');
    expect(serialText(45292, 'date', false)).toBe('2024-01-01');
    expect(serialText(0, 'date', true)).toBe('1904-01-01');
    expect(serialText(-1, 'date', false)).toBeNull();
    expect(serialText(45292.5416666666, 'datetime', false)).toBe('2024-01-01T13:00:00');
    const t = table(
      one(
        [
          ['Testdatum', 'Unmöglich'],
          [{ date: '2026-06-01' }, { n: 60, style: 'date' }],
        ],
        { date1904: true },
      ),
    );
    // im 1904-System gespeichert, als Kalenderdatum gelesen; ungültige Seriennummer bleibt Zahl
    expect({ ...t.rows[0]!.raw }).toEqual({ Testdatum: '2026-06-01', Unmöglich: '1904-03-01' });
    const t1900 = table(one([['x'], [{ n: 60, style: 'date' }]]));
    expect(t1900.rows[0]!.raw.x).toBe('60');
  });

  test('Zahlenformate erkennen: Datum, Uhrzeit, Zahl', () => {
    expect(formatKind('dd.mm.yyyy')).toBe('date');
    expect(formatKind('[$-407]dd\\.mm\\.yyyy;@')).toBe('date');
    expect(formatKind('mmm yy')).toBe('date');
    expect(formatKind('dd/mm/yyyy\\ hh:mm')).toBe('datetime');
    expect(formatKind('h:mm AM/PM')).toBe('time');
    expect(formatKind('mm:ss.0')).toBe('time');
    expect(formatKind('[h]:mm:ss')).toBe('elapsed');
    expect(formatKind('General')).toBeNull();
    expect(formatKind('0.00')).toBeNull();
    expect(formatKind('#,##0 "Tage"')).toBeNull();
    expect(formatKind('[Red][<=100]0.0;[Blue]0.0')).toBeNull();
    expect(formatKind('0%')).toBeNull();
    expect(formatKind('@')).toBeNull();
  });

  test('Prozent und feste Nachkommastellen: übernommen wird der gespeicherte Wert, nicht die Anzeige', () => {
    const t = table(
      one([
        ['p', 'd'],
        [
          { n: 0.25, style: 'percent' },
          { n: 1.005, style: 'decimal2' },
        ],
      ]),
    );
    expect({ ...t.rows[0]!.raw }).toEqual({ p: '0,25', d: '1,005' });
  });
});

describe('Formeln werden nicht ausgewertet', () => {
  test('nur das gespeicherte Ergebnis zählt; ohne Ergebnis bleibt die Zelle leer; die Formel erscheint nie', () => {
    const t = table(
      one([
        ['mit', 'ohne', 'text', 'fehler', 'gefährlich'],
        [
          { f: 'A1+B1', v: 42 },
          { f: 'SUM(A1:A9)' },
          { f: 'CONCAT("a";"b")', v: 'ab', t: 'str' },
          { f: '1/0', v: '#DIV/0!', t: 'e' },
          { f: "cmd|' /C calc'!A0", v: 'harmlos', t: 'str' },
        ],
      ]),
    );
    expect({ ...t.rows[0]!.raw }).toEqual({
      mit: '42',
      text: 'ab',
      fehler: '#DIV/0!',
      gefährlich: 'harmlos',
    });
    expect(JSON.stringify(t)).not.toContain('SUM(');
    expect(JSON.stringify(t)).not.toContain('calc');
  });

  test('Text, der wie eine Formel aussieht, bleibt Text – und wird beim CSV-Export neutralisiert', () => {
    const t = table(one([['x'], ['=HYPERLINK("http://evil")'], ['+1'], ['@SUM(A1)']]));
    const values = t.rows.map((r) => r.raw.x ?? null);
    expect(values).toEqual(['=HYPERLINK("http://evil")', '+1', '@SUM(A1)']);
    // bestehende Formel-Neutralisierung der Exporte (core/formats.ts) greift auch für Excel-Werte
    const csv = toCsv(
      [{ key: 'x', label: 'x', type: 'string' }],
      values.map((x) => ({ x })),
    );
    expect(csv.split('\r\n').slice(1, 4)).toEqual(['"\'=HYPERLINK(""http://evil"")"', "'+1", "'@SUM(A1)"]);
  });
});

describe('Mehrere Tabellenblätter', () => {
  const bytes = buildXlsx({
    sheets: [sheet([['Erstes'], ['1']], 'Übersicht'), sheet([['Zweites'], ['2']], 'Messwerte 2026')],
  });

  test('Standard: erstes Blatt; Auswahl über den Namen (auch ohne Beachtung der Großschreibung)', () => {
    const first = read(bytes);
    expect(first.ok && first.sheet).toBe('Übersicht');
    expect(first.ok && first.table.columns).toEqual(['Erstes']);
    expect(first.sheets).toEqual(['Übersicht', 'Messwerte 2026']);
    const second = read(bytes, { sheet: 'messwerte 2026' });
    expect(second.ok && second.sheet).toBe('Messwerte 2026');
    expect(second.ok && second.table.rows[0]!.raw.Zweites).toBe('2');
  });

  test('unbekanntes Blatt: sheet_not_found mit den vorhandenen Namen', () => {
    expect(read(bytes, { sheet: 'Archiv' })).toEqual({
      ok: false,
      code: 'sheet_not_found',
      params: { sheet: 'Archiv' },
      sheets: ['Übersicht', 'Messwerte 2026'],
    });
  });

  test('Diagrammblätter zählen nicht als Tabellenblatt', () => {
    const b = buildXlsx({
      sheets: [sheet([['a'], ['1']], 'Daten')],
      sharedStrings: false,
      parts: {
        'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Diagramm" sheetId="2" r:id="rIdC"/><sheet name="Daten" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rIdC" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`,
      },
    });
    const r = read(b);
    expect(r.sheets).toEqual(['Daten']);
    expect(r.ok && r.table.columns).toEqual(['a']);
  });
});

describe('Weiterverarbeitung wie CSV (Pipeline)', () => {
  test('Zahlen- und Datumszellen sowie deutsche Textwerte werden korrekt konvertiert', () => {
    const fields: FieldDef[] = [
      { name: 'test_date', label: 'Testdatum', type: 'date', required: true },
      { name: 'vo2max', label: 'VO2max', type: 'number', required: true, min: 20, max: 95 },
      { name: 'hf', label: 'HFmax', type: 'integer', required: true },
    ];
    const t = table(
      one([
        ['Datum', 'VO2', 'HF'],
        [{ date: '2026-03-01' }, 48.7, 193],
        ['01.04.2026', '51,2', '190'],
        [{ date: '2026-03-02' }, { f: '1/0', v: '#DIV/0!', t: 'e' }, { f: 'A1' }],
      ]),
    );
    const { rows } = runPipeline(
      t,
      {
        targetType: 'dataset',
        mapping: [
          { source: 'Datum', target: 'data.test_date', transform: 'trim' },
          { source: 'VO2', target: 'data.vo2max', transform: 'trim' },
          { source: 'HF', target: 'data.hf', transform: 'trim' },
        ],
        athleteMatch: { strategy: 'external_id', system: 'x' },
        dataset: { fields, keyFields: [], observedAtField: 'test_date' },
        convert: {
          decimalSeparator: ',',
          dateFormat: 'DD.MM.YYYY',
          timeZone: 'Europe/Berlin',
          today: '2026-11-05',
        },
      },
      emptyLookup(),
    );
    expect(rows[0]!.data).toEqual({ test_date: '2026-03-01', vo2max: 48.7, hf: 193 });
    expect(rows[1]!.data).toEqual({ test_date: '2026-04-01', vo2max: 51.2, hf: 190 });
    const codes = rows[2]!.issues.filter((i) => i.field).map((i) => [i.field, i.code, i.rawValue]);
    expect(codes).toEqual([
      ['data.vo2max', 'invalid_number', '#DIV/0!'],
      ['data.hf', 'required', null],
    ]);
  });
});

describe('Obergrenzen', () => {
  test('mehr als 500 Spalten in der Kopfzeile: too_many_columns', () => {
    const header: Cell[] = [];
    header[0] = 'A';
    header[500] = 'Z';
    const t = table(one([header, ['1']]));
    expect(t).toEqual({ columns: [], rows: [], issues: [], limit: 'too_many_columns' });
  });

  test('mehr Datenzeilen als zulässig: too_many_rows mit den ersten Zeilen, Lesen endet früh', () => {
    const rows: Cell[][] = [['n']];
    for (let i = 1; i <= 25; i++) rows.push([i]);
    const t = table(one(rows), { maxRows: 10 });
    expect(t.limit).toBe('too_many_rows');
    expect(t.rows.length).toBe(10);
    expect(t.rows[9]!.raw.n).toBe('10');
  });

  test('Standardgrenze 100 000 Datenzeilen', () => {
    const body = Array.from(
      { length: 100_001 },
      (_, i) => `<row r="${i + 2}"><c r="A${i + 2}"><v>${i}</v></c></row>`,
    );
    const xml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>n</t></is></c></row>${body.join('')}</sheetData></worksheet>`;
    const t = table(buildXlsx({ sheets: [{ name: 'gross', xml }] }));
    expect(t.limit).toBe('too_many_rows');
    expect(t.rows.length).toBe(100_000);
  });

  test('ZIP-Bombe mit gelogener Größe: Abbruch beim Entpacken (Obergrenze je XML-Stück)', () => {
    // 200 MB Leerzeichen komprimieren auf wenige hundert KB; im Verzeichnis als 1 KB angegeben
    const bomb = deflateRepeated(
      ' '.repeat(1024 * 1024),
      200,
      '<worksheet><sheetData>',
      '</sheetData></worksheet>',
    );
    expect(bomb.compressed.length).toBeLessThan(1024 * 1024);
    const bytes = buildXlsx({
      sheets: [sheet([['x']])],
      parts: {
        'xl/worksheets/sheet1.xml': {
          compressed: bomb.compressed,
          size: 1024,
          crc: bomb.crc,
          data: undefined,
        },
      },
    });
    const started = performance.now();
    expect(reason(bytes)).toBe('xlsx_too_large');
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test('ZIP-Bombe aus gültig aussehendem XML: Gesamtobergrenze der entpackten Bytes', () => {
    // 1-MB-Blöcke aus kleinen Elementen: keine einzelne Grenze greift, nur die Summe (> 100 MB)
    const block = `<x>${'a'.repeat(1000)}</x>`.repeat(1000);
    const n = Math.ceil(MAX_INFLATED_BYTES / block.length) + 1;
    const bomb = deflateRepeated(block, n, '<worksheet><sheetData>', '</sheetData></worksheet>');
    const bytes = buildXlsx({
      sheets: [sheet([['x']])],
      parts: {
        'xl/worksheets/sheet1.xml': {
          compressed: bomb.compressed,
          size: 4096,
          crc: bomb.crc,
          data: undefined,
        },
      },
    });
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    expect(reason(bytes)).toBe('xlsx_too_large');
  });

  test('ehrlich angegebene, zu große Teile werden ohne Entpacken abgewiesen', () => {
    const big = deflateRepeated(' ', 10, '<worksheet>', '</worksheet>');
    const bytes = buildXlsx({
      sheets: [sheet([['x']])],
      parts: {
        'xl/worksheets/sheet1.xml': {
          compressed: big.compressed,
          size: MAX_INFLATED_BYTES + 1,
          crc: big.crc,
          data: undefined,
        },
      },
    });
    expect(reason(bytes)).toBe('xlsx_too_large');
  });

  test('zu viele Einträge im ZIP-Verzeichnis', () => {
    const files = Array.from({ length: 10_001 }, (_, i) => ({ name: `f${i}`, data: '', method: 0 as const }));
    expect(reason(zip(files))).toBe('xlsx_too_large');
  });

  test('einzelnes übergroßes XML-Element bzw. Textstück', () => {
    const xml = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(1_100_000)}</t></is></c></row></sheetData></worksheet>`;
    expect(reason(buildXlsx({ sheets: [{ name: 'a', xml }] }))).toBe('xlsx_too_large');
  });
});

describe('Feindliche und ungültige Dateien', () => {
  const valid = () => one([['a'], ['1']]);

  test('keine ZIP-Datei, alte .xls bzw. kennwortgeschützte Datei, anderes Office-Dokument', () => {
    expect(reason(new TextEncoder().encode('Nachname;Vorname\nMeier;Anna\n'))).toBe('not_xlsx');
    expect(reason(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]))).toBe(
      'xls_or_encrypted',
    );
    expect(reason(zip([{ name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet' }]))).toBe(
      'not_xlsx',
    );
    const docx = buildXlsx({
      sheets: [sheet([['a']])],
      parts: { 'xl/workbook.xml': '<document xmlns="urn:x"><body/></document>' },
    });
    expect(reason(docx)).toBe('not_xlsx');
  });

  test('ZIP64, verschlüsselte Einträge, unbekanntes Kompressionsverfahren', () => {
    const z64 = valid();
    // Ende des Verzeichnisses: Gesamtzahl der Einträge 0xFFFF (ZIP64-Platzhalter)
    const view = new DataView(z64.buffer, z64.byteOffset, z64.byteLength);
    view.setUint16(z64.length - 12, 0xffff, true);
    expect(reason(z64)).toBe('xlsx_unsupported');
    expect(
      reason(buildXlsx({ sheets: [sheet([['a']])], parts: { 'xl/workbook.xml': { flags: 0x1 } } })),
    ).toBe('xlsx_unsupported');
    expect(
      reason(
        buildXlsx({ sheets: [sheet([['a']])], parts: { 'xl/worksheets/sheet1.xml': { method: 12 as 8 } } }),
      ),
    ).toBe('xlsx_unsupported');
  });

  test('beschädigte Dateien: CRC, abgeschnittene Daten, doppelte Namen, falsche Indizes, ungültiges UTF-8', () => {
    expect(
      reason(buildXlsx({ sheets: [sheet([['a']])], parts: { 'xl/worksheets/sheet1.xml': { crc: 1 } } })),
    ).toBe('xlsx_corrupt');
    const truncated = valid().slice(0, 300);
    expect(reason(truncated)).toBe('xlsx_corrupt');
    const dup = buildXlsx({ sheets: [sheet([['a']])], parts: { 'XL/Workbook.xml': '<workbook/>' } });
    expect(reason(dup)).toBe('xlsx_corrupt');
    const badIndex = buildXlsx({
      sheets: [
        {
          name: 'a',
          xml: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>99</v></c></row></sheetData></worksheet>',
        },
      ],
    });
    expect(reason(badIndex)).toBe('xlsx_corrupt');
    const badUtf8 = buildXlsx({
      sheets: [sheet([['a']])],
      parts: { 'xl/worksheets/sheet1.xml': { data: new Uint8Array([0x3c, 0x61, 0xff, 0xfe, 0x3e]) } },
    });
    expect(reason(badUtf8)).toBe('xlsx_corrupt');
    const unordered = buildXlsx({
      sheets: [{ name: 'a', xml: '<worksheet><sheetData><row r="5"/><row r="2"/></sheetData></worksheet>' }],
    });
    expect(reason(unordered)).toBe('xlsx_corrupt');
  });

  test('DTD/Entitäten (XXE, Billion Laughs) werden abgelehnt, nicht aufgelöst', () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>`;
    expect(reason(buildXlsx({ sheets: [{ name: 'a', xml: laughs }] }))).toBe('xlsx_unsupported');
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><sst><si><t>&e;</t></si></sst>`;
    expect(reason(buildXlsx({ sheets: [sheet([['a']])], parts: { 'xl/sharedStrings.xml': xxe } }))).toBe(
      'xlsx_unsupported',
    );
  });

  test('unbekannte Entitäten bleiben wörtlicher Text; Attribute verändern keine Prototypen', () => {
    const xml = `<worksheet><sheetData><row r="1" __proto__="x" constructor="y"><c r="A1" t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>`;
    const t = table(buildXlsx({ sheets: [{ name: 'a', xml }] }));
    expect(t.columns).toEqual(['&e;']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('XML-Leser', () => {
  test('Ergebnis unabhängig von der Stückelung der Eingabe', () => {
    const xml = `<?xml version="1.0"?><!-- Kommentar --><a x="1" y='&gt;2'><b>T&amp;ext</b><![CDATA[<roh>]]><c/></a>`;
    const events = (chunks: string[]) => {
      const out: string[] = [];
      let text = '';
      const flush = () => {
        if (text) out.push(`#${text}`);
        text = '';
      };
      const s = new XmlScanner({
        open: (n, a) => {
          flush();
          out.push(`<${n} ${[...a].map(([k, v]) => `${k}=${v}`).join(',')}>`);
        },
        close: (n) => {
          flush();
          out.push(`</${n}>`);
        },
        text: (t) => {
          text += t;
        },
      });
      for (const c of chunks) s.feed(c);
      s.end();
      flush();
      return out;
    };
    const whole = events([xml]);
    expect(whole).toEqual(['<a x=1,y=>2>', '<b >', '#T&ext', '</b>', '#<roh>', '<c >', '</c>', '</a>']);
    for (const size of [1, 2, 3, 5, 7, 13]) {
      const chunks: string[] = [];
      for (let i = 0; i < xml.length; i += size) chunks.push(xml.slice(i, i + size));
      expect(events(chunks)).toEqual(whole);
    }
  });

  test('viele Zellen über Stückgrenzen des Entpackens hinweg (gespeichert und komprimiert)', () => {
    const rows: Cell[][] = [['t']];
    for (let i = 0; i < 20_000; i++) rows.push([`Wert ${i} ${esc('<&>')}`]);
    for (const method of [0, 8] as const) {
      const t = table(one(rows, { method }));
      expect(t.rows.length).toBe(20_000);
      expect(t.rows[19_999]!.raw.t).toBe('Wert 19999 &lt;&amp;&gt;');
    }
  });
});

describe('Datei eines unabhängigen Schreibers (openpyxl 3.1.5)', () => {
  const bytes = new Uint8Array(
    readFileSync(join(import.meta.dir, '../fixtures/xlsx/leistungsdiagnostik-openpyxl.xlsx')),
  );

  test('Titelzeile, Kopfzeile in Zeile 3, Datumszellen, Gleitkommarauschen, Text-Zahlen, Formel ohne Ergebnis', () => {
    const r = read(bytes, { headerRow: 2 });
    if (!r.ok) throw new Error(r.code);
    expect(r.sheets).toEqual(['Stufentests', 'Hinweise']);
    expect(r.table.columns).toEqual([
      'Nachname',
      'Vorname',
      'Geburtsdatum',
      'Testdatum',
      'Protokoll',
      'VO2max',
      'Laktatschwelle_W',
      'HFmax',
    ]);
    expect(r.table.rows.length).toBe(6);
    expect({ ...r.table.rows[1]!.raw }).toEqual({
      Nachname: 'Groß',
      Vorname: 'Hannes',
      Geburtsdatum: '2001-04-24',
      Testdatum: '2025-02-04',
      Protokoll: 'Stufentest Ruderergometer',
      VO2max: '68,9',
      Laktatschwelle_W: '414',
      HFmax: '201',
    });
    expect(r.table.rows[3]!.raw.Laktatschwelle_W).toBe('344,5');
    expect(r.table.rows[4]!.raw.Geburtsdatum).toBe('10.02.2009');
    // "=190+8" ohne gespeichertes Ergebnis: leer
    expect(r.table.rows[5]!.raw.HFmax).toBeUndefined();
  });
});

describe('Vervielfachung über gemeinsame Texte (Sicherheitsprüfung M1)', () => {
  test('ein langer gemeinsamer Text, tausendfach referenziert: abgewiesen statt Milliarden Zeichen', () => {
    // 1 Text mit 30 000 Zeichen (unter der Excel-Grenze), 50 Zeilen × 500 Spalten → 750 Mio. Zeichen
    const long = 'A'.repeat(30_000);
    const header: Cell[] = Array.from({ length: 500 }, (_, i) => ({ inline: `c${i}` }));
    const row: Cell[] = Array.from({ length: 500 }, () => long);
    const bytes = buildXlsx({
      sheets: [{ name: 'S', rows: [header, ...Array.from({ length: 50 }, () => row)] }],
    });
    expect(bytes.length).toBeLessThan(200_000);
    expect(reason(bytes)).toBe('xlsx_too_large');
  });

  test('Zellwert länger als Excel selbst speichern kann (32 767 Zeichen): abgewiesen', () => {
    const bytes = buildXlsx({ sheets: [{ name: 'S', rows: [['Name'], ['B'.repeat(MAX_CELL_CHARS + 1)]] }] });
    expect(reason(bytes)).toBe('xlsx_too_large');
  });

  test('Zellwert genau an der Excel-Grenze: gelesen', () => {
    const t = table(buildXlsx({ sheets: [{ name: 'S', rows: [['Name'], ['C'.repeat(MAX_CELL_CHARS)]] }] }));
    expect(t.rows[0]!.raw.Name?.length).toBe(MAX_CELL_CHARS);
  });

  test('Vorschau und Beispielzeilen kürzen lange Werte (vollständige Werte nur in der Verarbeitung)', () => {
    const input: Record<string, string | number | null> = {
      a: 'x'.repeat(PREVIEW_VALUE_CHARS + 10),
      b: 'kurz',
      c: 7,
      d: null,
    };
    const clipped = clipValues(input);
    expect(clipped.a).toBe(`${'x'.repeat(PREVIEW_VALUE_CHARS)}…`);
    expect({ ...clipped }).toEqual({ a: `${'x'.repeat(PREVIEW_VALUE_CHARS)}…`, b: 'kurz', c: 7, d: null });
  });
});

test('Gesamtgrenze der Zeichen je Lesevorgang entspricht der CSV-Höchstgröße', () => {
  expect(MAX_SHEET_CHARS).toBe(20_000_000);
});
