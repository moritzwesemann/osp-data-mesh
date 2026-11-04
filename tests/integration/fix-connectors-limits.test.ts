/**
 * Regression: Obergrenzen für Quellen. Zu breite oder zu lange Quellen führen zu einem fehlgeschlagenen
 * Lauf mit übersetzbarem Code (too_many_columns, too_many_rows), ohne den Knoten zu blockieren.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MAX_SOURCE_COLUMNS, MAX_SOURCE_ROWS } from '../../src/server/modules/connectors/pipeline.ts';
import type { Connector } from '../../src/shared/contract/connectors.ts';
import { IMPORT_ERROR_CODES, IMPORT_FAILURE_CODES } from '../../src/shared/contract/connectors.ts';
import { fileForm, importTemplate, startImport } from '../helpers/integration.ts';
import { TestMesh, type TestNode, type TestUser } from '../helpers/node.ts';

let mesh: TestMesh;
let node: TestNode;
let steward: TestUser;
let csv: Connector;
let api: Connector;
let apiBody: unknown = [];

beforeAll(async () => {
  mesh = new TestMesh();
  mesh.routes.set('https://measure.mesh.test', () => Response.json(apiBody));
  node = await mesh.add({ nodeId: 'osp-grenzen-test' });
  steward = await node.user(['data_steward']);
  csv = await importTemplate(node, steward, 'athleten-stammdaten-csv');
  api = await importTemplate(node, steward, 'sprungkraft-api', (def) => {
    if (def.connector.config.type === 'http_api') {
      def.connector.config.url = 'https://measure.mesh.test/v1/measurements';
      def.connector.config.itemsPath = '';
      def.connector.config.pagination = { type: 'none' };
    }
  });
});

afterAll(async () => {
  await mesh?.close();
});

async function errorsOf(runId: string) {
  const r = await node.request<{
    items: { rowNumber: number; code: string; params: Record<string, unknown> }[];
  }>('GET', `/api/v1/import-runs/${runId}/errors`, { as: steward });
  return r.json.items;
}

describe('Obergrenzen je Quelle', () => {
  test('neue Codes stehen im Vertrag (übersetzbar)', () => {
    for (const code of ['too_many_columns', 'too_many_rows'] as const) {
      expect(IMPORT_FAILURE_CODES).toContain(code);
      expect(IMPORT_ERROR_CODES).toContain(code);
    }
  });

  test('CSV mit 2 000 doppelten Spalten: Lauf schlägt sofort mit too_many_columns fehl', async () => {
    const header = Array.from({ length: 2000 }, () => 'Nachname').join(';');
    const t0 = performance.now();
    const r = await startImport(
      node,
      steward,
      csv.id,
      fileForm(`${header}\n${'x;'.repeat(1999)}x\n`, 'breit.csv'),
    );
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'too_many_columns', totalRows: 0 });
    expect(r.preview).toEqual({ sourceColumns: [], rows: [] });
    expect(await errorsOf(r.run.id)).toEqual([
      expect.objectContaining({
        rowNumber: 0,
        code: 'too_many_columns',
        params: { max: MAX_SOURCE_COLUMNS },
      }),
    ]);
  });

  test(`CSV mit mehr als ${MAX_SOURCE_ROWS} Zeilen: too_many_rows`, async () => {
    const header =
      'Athleten-ID;Nachname;Vorname;Geburtsdatum;Geschlecht;Sportart;Disziplin;Kaderstatus;Verein';
    const r = await startImport(
      node,
      steward,
      csv.id,
      fileForm(`${header}\n${'x\n'.repeat(MAX_SOURCE_ROWS + 1)}`, 'lang.csv'),
    );
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'too_many_rows' });
    expect(await errorsOf(r.run.id)).toEqual([
      expect.objectContaining({ rowNumber: 0, code: 'too_many_rows', params: { max: MAX_SOURCE_ROWS } }),
    ]);
  });

  test('API-Antwort mit zu vielen Feldern bzw. Einträgen', async () => {
    apiBody = [Object.fromEntries(Array.from({ length: MAX_SOURCE_COLUMNS + 1 }, (_, i) => [`f${i}`, i]))];
    const wide = await startImport(node, steward, api.id);
    expect(wide.run).toMatchObject({ status: 'failed', failureCode: 'too_many_columns' });
    apiBody = new Array(MAX_SOURCE_ROWS + 1).fill(0);
    const long = await startImport(node, steward, api.id);
    expect(long.run).toMatchObject({ status: 'failed', failureCode: 'too_many_rows' });
  });

  test('Analyse: zu breite Datei → 413 mit Grund; lange Datei liefert nur Beispielzeilen', async () => {
    const header = Array.from({ length: 2000 }, () => 'x').join(';');
    const wide = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      '/api/v1/connectors/inspect',
      { as: steward, form: fileForm(`${header}\n1\n`, 'breit.csv') },
    );
    expect(wide.status).toBe(413);
    expect(wide.json.error).toMatchObject({ code: 'payload_too_large', reason: 'too_many_columns' });

    const long = await node.request<{ columns: string[]; sampleRows: unknown[] }>(
      'POST',
      '/api/v1/connectors/inspect',
      { as: steward, form: fileForm(`a;b\n${'1;2\n'.repeat(MAX_SOURCE_ROWS + 5)}`, 'lang.csv') },
    );
    expect(long.status).toBe(200);
    expect(long.json.columns).toEqual(['a', 'b']);
    expect(long.json.sampleRows.length).toBe(10);
  });
});
