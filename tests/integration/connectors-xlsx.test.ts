/**
 * Excel-Dateien (.xlsx) als Quelle: Anlegen, Analyse, Import mit Vorschau, Prüfung und Übernahme wie bei
 * CSV; feindliche oder unpassende Dateien ergeben fehlgeschlagene Läufe mit übersetzbarem Code.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_DIR } from '../../scripts/generate-fixtures.ts';
import type { Connector, ConnectorDefinition, ImportRun } from '../../src/shared/contract/connectors.ts';
import {
  auditEntries,
  commitRun,
  fileForm,
  importTemplate,
  type RunDetail,
  startImport,
} from '../helpers/integration.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';
import { buildXlsx, type Cell, deflateRepeated } from '../helpers/xlsx.ts';

let node: TestNode;
let steward: TestUser;

beforeAll(async () => {
  node = await createTestNode({ nodeId: 'osp-excel-test' });
  steward = await node.user(['data_steward']);
  // Personen für die Zuordnung über Nachname, Vorname und Geburtsdatum
  const athletes = await importTemplate(node, steward, 'athleten-stammdaten-csv');
  const run = await startImport(node, steward, athletes.id, fileForm('osp-nord/athleten.csv'));
  await commitRun(node, steward, run.run.id);
});

afterAll(async () => {
  await node?.close();
});

function xlsxForm(bytes: Uint8Array, name = 'leistungsdiagnostik.xlsx'): FormData {
  const form = new FormData();
  form.append(
    'file',
    new File([new Uint8Array(bytes)], name, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
  return form;
}

/** Leistungsdiagnostik-CSV der Demo als Excel-Arbeitsmappe: Titelzeile, Kopfzeile in Zeile 3, Datums- und Zahlenzellen */
function leistungsdiagnostikXlsx(): Uint8Array {
  const lines = readFileSync(join(FIXTURES_DIR, 'osp-nord/leistungsdiagnostik.csv'), 'utf8')
    .trim()
    .split('\n');
  const header = lines[0]!.split(',');
  const rows: (Cell[] | null)[] = [['Leistungsdiagnostik OSP Nord'], null, header];
  for (const [i, line] of lines.slice(1).entries()) {
    const [last, first, dob, testDate, protocol, vo2, lt, hf] = line.split(',');
    rows.push([
      last,
      first,
      { date: dob! },
      { date: testDate! },
      protocol,
      // jeder siebte Wert als Text im deutschen Format ("48,7"), sonst als Zahlenzelle
      i % 7 === 0 ? vo2!.replace('.', ',') : Number(vo2),
      lt ? (i % 5 === 0 ? `${lt}` : Number(lt)) : null,
      i % 9 === 0 ? `${hf}` : Number(hf),
    ]);
    if (i === 10) rows.push([]); // leere Zeile mitten in den Daten
  }
  return buildXlsx({
    sheets: [
      { name: 'Stufentests', rows },
      { name: 'Hinweise', rows: [['frei']] },
    ],
  });
}

async function errorsOf(runId: string) {
  const r = await node.request<{
    items: { rowNumber: number; code: string; params: Record<string, unknown> }[];
  }>('GET', `/api/v1/import-runs/${runId}/errors?pageSize=500`, { as: steward });
  expect(r.status).toBe(200);
  return r.json.items;
}

let ld: Connector;

describe('Excel-Vorlage Leistungsdiagnostik', () => {
  test('Vorlage: Art xlsx_upload, Excel-Einstellungen mit deutschen Standardwerten', async () => {
    ld = await importTemplate(node, steward, 'leistungsdiagnostik-xlsx');
    expect(ld).toMatchObject({
      slug: 'leistungsdiagnostik-xlsx',
      kind: 'xlsx_upload',
      targetType: 'dataset',
      targetDatasetName: 'Leistungsdiagnostik',
      config: { type: 'xlsx', sheet: '', headerRow: 1, decimalSeparator: ',', dateFormat: 'DD.MM.YYYY' },
    });
  });

  test('Analyse: Spalten, Beispielzeilen und Tabellenblätter', async () => {
    const form = xlsxForm(leistungsdiagnostikXlsx());
    form.append('config', JSON.stringify({ ...ld.config, headerRow: 3 }));
    const r = await node.request<{
      columns: string[];
      sampleRows: Record<string, string | null>[];
      sheets: string[];
      sheet: string;
      detectedDelimiter: string | null;
    }>('POST', '/api/v1/connectors/inspect', { as: steward, form });
    expect(r.status).toBe(200);
    expect(r.json.columns).toEqual([
      'Nachname',
      'Vorname',
      'Geburtsdatum',
      'Testdatum',
      'Protokoll',
      'VO2max',
      'Laktatschwelle_W',
      'HFmax',
    ]);
    expect(r.json.sampleRows.length).toBe(10);
    expect(r.json.sampleRows[0]).toMatchObject({
      Nachname: 'Lorenz',
      Geburtsdatum: '1997-05-10',
      VO2max: '48,7',
    });
    expect(r.json).toMatchObject({
      sheets: ['Stufentests', 'Hinweise'],
      sheet: 'Stufentests',
      detectedDelimiter: null,
    });
    const audit = (await auditEntries(node, 'connector.inspect'))[0]!;
    expect(audit.details).toMatchObject({ kind: 'xlsx', columns: 8, rows: 10, sheets: 2, truncated: true });
  });

  test('Analyse: unbekanntes Blatt und Nicht-Excel-Datei ergeben übersetzbare Gründe', async () => {
    const wrongSheet = xlsxForm(leistungsdiagnostikXlsx());
    wrongSheet.append('config', JSON.stringify({ ...ld.config, sheet: 'Archiv' }));
    const a = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      '/api/v1/connectors/inspect',
      {
        as: steward,
        form: wrongSheet,
      },
    );
    expect(a.status).toBe(422);
    expect(a.json.error).toMatchObject({ code: 'import_failed', reason: 'sheet_not_found' });
    const csv = fileForm('osp-nord/leistungsdiagnostik.csv');
    csv.append('config', JSON.stringify(ld.config));
    const b = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      '/api/v1/connectors/inspect',
      {
        as: steward,
        form: csv,
      },
    );
    expect(b.status).toBe(422);
    expect(b.json.error).toMatchObject({ code: 'import_failed', reason: 'not_xlsx' });
  });

  test('Titelzeile über der Tabelle: Kopfzeile automatisch in Zeile 3 erkannt, mit Hinweis', async () => {
    const r = await startImport(node, steward, ld.id, xlsxForm(leistungsdiagnostikXlsx()));
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 80, validRows: 78, errorRows: 2 });
    const notes = (await errorsOf(r.run.id)).filter((e) => e.code === 'header_row_detected');
    expect(notes).toEqual([expect.objectContaining({ rowNumber: 0, params: { headerRow: '3' } })]);
    // Vorschau verwerfen, damit die folgenden Läufe unabhängig bleiben
    const discarded = await node.request('POST', `/api/v1/import-runs/${r.run.id}/discard`, { as: steward });
    expect(discarded.status).toBe(200);
  });

  test('Kopfzeile weiter unten als der Suchbereich: fehlende Spalten wie bisher', async () => {
    const header = [
      'Nachname',
      'Vorname',
      'Geburtsdatum',
      'Testdatum',
      'Protokoll',
      'VO2max',
      'Laktatschwelle_W',
      'HFmax',
    ];
    const titles: Cell[][] = Array.from({ length: 12 }, (_, n) => [`Titelzeile ${n + 1}`]);
    const bytes = buildXlsx({ sheets: [{ name: 'Stufentests', rows: [...titles, header] }] });
    const r = await startImport(node, steward, ld.id, xlsxForm(bytes));
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'missing_column' });
  });

  let preview: RunDetail;
  test('Kopfzeile ab Zeile 3: dasselbe Prüfergebnis wie beim CSV-Import (78 gültig, 2 unplausibel)', async () => {
    const patched = await node.request<Connector>('PATCH', `/api/v1/connectors/${ld.id}`, {
      as: steward,
      body: { config: { ...ld.config, headerRow: 3 } },
    });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ version: 2, config: { headerRow: 3 } });
    preview = await startImport(node, steward, ld.id, xlsxForm(leistungsdiagnostikXlsx()));
    expect(preview.run).toMatchObject({
      status: 'previewed',
      sourceName: 'leistungsdiagnostik.xlsx',
      totalRows: 80,
      validRows: 78,
      errorRows: 2,
      warningRows: 0,
      connectorVersion: 2,
    });
    expect(preview.run.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.errorSummary.map((e) => `${e.code}:${e.field}`).sort()).toEqual([
      'future_date:data.test_date',
      'out_of_range:data.vo2max',
    ]);
    const row = preview.preview.rows[0]!;
    expect(row.raw).toMatchObject({ Geburtsdatum: '1997-05-10', VO2max: '48,7', HFmax: '193' });
    expect(row.mapped).toMatchObject({
      'data.test_date': '2026-09-09',
      'data.vo2max': 48.7,
      'data.max_heart_rate': 193,
    });
  });

  test('Übernahme; ein anschließender CSV-Import derselben Daten findet keine abweichenden Werte', async () => {
    const run = await commitRun(node, steward, preview.run.id);
    expect(run).toMatchObject({ status: 'committed', insertedRows: 78, updatedRows: 0 });
    const records = await node.request<{ items: { data: Record<string, unknown> }[]; total: number }>(
      'GET',
      `/api/v1/datasets/${ld.targetDatasetId}/records?pageSize=200`,
      { as: steward },
    );
    expect(records.json.total).toBe(78);
    for (const r of records.json.items) {
      expect(typeof r.data.vo2max).toBe('number');
      expect(r.data.test_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // gleiche Werte → keine Änderungshinweise (will_update), d. h. Excel- und CSV-Werte stimmen überein
    const csv = await importTemplate(node, steward, 'leistungsdiagnostik-csv');
    const again = await startImport(node, steward, csv.id, fileForm('osp-nord/leistungsdiagnostik.csv'));
    expect(again.run).toMatchObject({ totalRows: 80, validRows: 78, errorRows: 2, warningRows: 0 });
  });

  test('anderes Tabellenblatt gewählt, aber nicht vorhanden: Lauf schlägt mit sheet_not_found fehl', async () => {
    const p = await node.request<Connector>('PATCH', `/api/v1/connectors/${ld.id}`, {
      as: steward,
      body: { config: { ...ld.config, headerRow: 3, sheet: 'Archiv' } },
    });
    expect(p.status).toBe(200);
    const r = await startImport(node, steward, ld.id, xlsxForm(leistungsdiagnostikXlsx()));
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'sheet_not_found', totalRows: 0 });
    expect(await errorsOf(r.run.id)).toEqual([
      expect.objectContaining({ rowNumber: 0, code: 'sheet_not_found', params: { sheet: 'Archiv' } }),
    ]);
  });
});

describe('Feindliche und unpassende Dateien', () => {
  let c: Connector;
  beforeAll(async () => {
    c = await importTemplate(node, steward, 'leistungsdiagnostik-xlsx', (def) => {
      def.connector.slug = 'ld-excel-feindlich';
    });
  });

  test('CSV-Datei an einer Excel-Quelle: invalid_file (not_xlsx), protokolliert', async () => {
    const r = await startImport(node, steward, c.id, fileForm('osp-nord/leistungsdiagnostik.csv'));
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'invalid_file', totalRows: 0 });
    expect(await errorsOf(r.run.id)).toEqual([
      expect.objectContaining({ rowNumber: 0, code: 'invalid_file', params: { reason: 'not_xlsx' } }),
    ]);
    const audit = (await auditEntries(node, 'import.start'))[0]!;
    expect(audit).toMatchObject({ outcome: 'error', object_id: r.run.id });
  });

  test('ZIP-Bombe (200 MB Leerzeichen, als 1 KB angegeben): abgewiesen, ohne sie zu entpacken', async () => {
    const bomb = deflateRepeated(
      ' '.repeat(1024 * 1024),
      200,
      '<worksheet><sheetData>',
      '</sheetData></worksheet>',
    );
    const bytes = buildXlsx({
      sheets: [{ name: 'a', rows: [['x']] }],
      parts: {
        'xl/worksheets/sheet1.xml': {
          compressed: bomb.compressed,
          size: 1024,
          crc: bomb.crc,
          data: undefined,
        },
      },
    });
    const r = await startImport(node, steward, c.id, xlsxForm(bytes, 'bombe.xlsx'));
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'invalid_file' });
    expect(await errorsOf(r.run.id)).toEqual([
      expect.objectContaining({ code: 'invalid_file', params: { reason: 'xlsx_too_large' } }),
    ]);
  });

  test('Datei über 20 MB: 413 wie beim CSV-Upload', async () => {
    const r = await node.request<{ error: { code: string } }>('POST', `/api/v1/connectors/${c.id}/runs`, {
      as: steward,
      form: xlsxForm(new Uint8Array(20 * 1024 * 1024 + 1)),
    });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('payload_too_large');
  });

  test('ohne Datei: Pflichtfeld', async () => {
    const r = await node.request<{ error: { code: string; fields: Record<string, string> } }>(
      'POST',
      `/api/v1/connectors/${c.id}/runs`,
      { as: steward, form: new FormData() },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.fields).toEqual({ 'body.file': 'required' });
  });

  test('Formeln werden nicht ausgewertet: ohne gespeichertes Ergebnis ist der Wert leer (Pflichtfehler)', async () => {
    const rows: Cell[][] = [
      [
        'Nachname',
        'Vorname',
        'Geburtsdatum',
        'Testdatum',
        'Protokoll',
        'VO2max',
        'Laktatschwelle_W',
        'HFmax',
      ],
      [
        'Lorenz',
        'Lotta',
        { date: '1997-05-10' },
        { date: '2026-01-15' },
        'Stufentest Laufband',
        50,
        null,
        { f: '190+3' },
      ],
      [
        'Lorenz',
        'Lotta',
        { date: '1997-05-10' },
        { date: '2026-01-16' },
        'Stufentest Laufband',
        { f: 'F2+1', v: 51 },
        null,
        190,
      ],
    ];
    const r = await startImport(node, steward, c.id, xlsxForm(buildXlsx({ sheets: [{ name: 'a', rows }] })));
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 2, validRows: 1, errorRows: 1 });
    expect(r.errorSummary).toEqual([{ code: 'required', field: 'data.max_heart_rate', count: 1 }]);
    expect(r.preview.rows[1]!.mapped['data.vo2max']).toBe(51);
  });
});

describe('Quelle über die API anlegen, exportieren, Regeln', () => {
  const base = {
    name: 'Kaderliste (Excel)',
    targetType: 'athletes',
    mapping: [
      { source: 'ID', target: 'athlete.external_id' },
      { source: 'Name', target: 'athlete.last_name' },
      { source: 'Vorname', target: 'athlete.first_name' },
      { source: 'Geboren', target: 'athlete.date_of_birth' },
      { source: 'Sportart', target: 'athlete.sport' },
      { source: 'Kader', target: 'athlete.squad_status', valueMap: { Olympiakader: 'OK' } },
      { source: 'Verein', target: 'athlete.club' },
    ],
    athleteMatch: { strategy: 'external_id', system: 'kader-xlsx' },
  };

  test('Art und Konfiguration müssen zusammenpassen', async () => {
    for (const [kind, config] of [
      ['csv_upload', { type: 'xlsx' }],
      ['xlsx_upload', { type: 'csv' }],
    ] as const) {
      const r = await node.request<{ error: { code: string; fields: Record<string, string> } }>(
        'POST',
        '/api/v1/connectors',
        { as: steward, body: { ...base, slug: `mismatch-${kind.replace('_', '-')}`, kind, config } },
      );
      expect(r.status).toBe(400);
      expect(r.json.error.fields).toMatchObject({ 'body.config.type': 'kind_mismatch' });
    }
  });

  let kader: Connector;
  test('Athletenkern aus Excel: Datumszellen als Geburtsdatum, Wertübersetzung, Text mit Formelzeichen bleibt Text', async () => {
    const created = await node.request<Connector>('POST', '/api/v1/connectors', {
      as: steward,
      body: { ...base, slug: 'kader-xlsx', kind: 'xlsx_upload', config: { type: 'xlsx', sheet: 'Kader' } },
    });
    expect(created.status).toBe(200);
    kader = created.json;
    expect(kader.config).toEqual({
      type: 'xlsx',
      sheet: 'Kader',
      headerRow: 1,
      decimalSeparator: ',',
      dateFormat: 'DD.MM.YYYY',
    });
    const bytes = buildXlsx({
      sheets: [
        { name: 'Deckblatt', rows: [['Kaderliste 2026']] },
        {
          name: 'Kader',
          rows: [
            ['ID', 'Name', 'Vorname', 'Geboren', 'Sportart', 'Kader', 'Verein'],
            [
              'K-1',
              'Xaver',
              'Xenia',
              { date: '2004-07-01' },
              'Rudern',
              'Olympiakader',
              '=HYPERLINK("http://x")',
            ],
            ['K-2', 'Yilmaz', 'Yusuf', '01.02.2003', 'Judo', 'NK1', 'TSV'],
          ],
        },
      ],
    });
    const r = await startImport(node, steward, kader.id, xlsxForm(bytes, 'kader.xlsx'));
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 2, validRows: 2, errorRows: 0 });
    const run = await commitRun(node, steward, r.run.id);
    expect(run.insertedRows).toBe(2);
    const a = await node.deps.db
      .selectFrom('athlete')
      .select(['last_name', 'date_of_birth', 'squad_status', 'club'])
      .where('last_name', 'in', ['Xaver', 'Yilmaz'])
      .orderBy('last_name')
      .execute();
    expect(a).toEqual([
      { last_name: 'Xaver', date_of_birth: '2004-07-01', squad_status: 'OK', club: '=HYPERLINK("http://x")' },
      { last_name: 'Yilmaz', date_of_birth: '2003-02-01', squad_status: 'NK1', club: 'TSV' },
    ]);
  });

  test('Export und Re-Import der Definition behalten die Excel-Einstellungen; kein Zugangsgeheimnis', async () => {
    const exp = await node.request<ConnectorDefinition>('GET', `/api/v1/connectors/${kader.id}/export`, {
      as: steward,
    });
    expect(exp.status).toBe(200);
    expect(exp.json.connector).toMatchObject({
      kind: 'xlsx_upload',
      config: { type: 'xlsx', sheet: 'Kader' },
    });
    const def = { ...exp.json, connector: { ...exp.json.connector, slug: 'kader-xlsx-kopie' } };
    const imp = await node.request<Connector>('POST', '/api/v1/connectors/import', {
      as: steward,
      body: { definition: def },
    });
    expect(imp.status).toBe(200);
    expect(imp.json).toMatchObject({
      kind: 'xlsx_upload',
      config: { type: 'xlsx', sheet: 'Kader', headerRow: 1 },
    });
    const secret = await node.request<{ error: { fields: Record<string, string> } }>(
      'PUT',
      `/api/v1/connectors/${kader.id}/secret`,
      { as: steward, body: { secret: 'x' } },
    );
    expect(secret.status).toBe(400);
    expect(secret.json.error.fields).toEqual({ 'body.secret': 'not_supported' });
  });

  test('Importlauf-Liste zeigt Excel-Läufe wie CSV-Läufe', async () => {
    const r = await node.request<{ items: ImportRun[] }>('GET', `/api/v1/connectors/${kader.id}/runs`, {
      as: steward,
    });
    expect(r.json.items.map((i) => [i.status, i.sourceName])).toEqual([['committed', 'kader.xlsx']]);
  });
});
