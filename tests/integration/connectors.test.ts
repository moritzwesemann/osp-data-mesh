import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BAD_MEASUREMENTS, createMockMeasurementApi } from '../../scripts/mock-measurement-api.ts';
import { secretAad } from '../../src/server/modules/connectors/index.ts';
import type { Connector, ConnectorDefinition, ImportRun } from '../../src/shared/contract/connectors.ts';
import type { Dataset } from '../../src/shared/contract/datasets.ts';
import {
  auditEntries,
  commitRun,
  fileForm,
  importTemplate,
  type RunDetail,
  startImport,
  templateDefinition,
} from '../helpers/integration.ts';
import { TestMesh, type TestNode, type TestUser } from '../helpers/node.ts';

const API_TOKEN = 'test-messsystem-token';
// Zugangsgeheimnisse gehen nur über https (bzw. an Loopback-Adressen)
const API_URL = 'https://measure.mesh.test/v1/measurements';

let mesh: TestMesh;
let node: TestNode;
let steward: TestUser;
let analyst: TestUser;
const apiRequests: string[] = [];

beforeAll(async () => {
  mesh = new TestMesh();
  const api = createMockMeasurementApi({ token: API_TOKEN });
  mesh.routes.set('https://measure.mesh.test', (req) => {
    apiRequests.push(req.url);
    return api(req);
  });
  node = await mesh.add({ nodeId: 'osp-nord-test' });
  steward = await node.user(['data_steward']);
  analyst = await node.user(['analyst']);
});

afterAll(async () => {
  await mesh?.close();
});

type ErrorsPage = {
  items: {
    rowNumber: number;
    field: string | null;
    code: string;
    severity: string;
    rawValue: string | null;
    params: Record<string, string | number>;
  }[];
  total: number;
};

async function errorsOf(runId: string): Promise<ErrorsPage> {
  const r = await node.request<ErrorsPage>('GET', `/api/v1/import-runs/${runId}/errors?pageSize=500`, {
    as: steward,
  });
  expect(r.status).toBe(200);
  return r.json;
}

async function athleteCount(): Promise<number> {
  const r = await node.deps.db
    .selectFrom('athlete')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

describe('Vorlagen und Rollen', () => {
  test('mitgelieferte Vorlagen', async () => {
    const r = await node.request<{ items: { id: string; name: string; definition: ConnectorDefinition }[] }>(
      'GET',
      '/api/v1/connector-templates',
      { as: steward },
    );
    expect(r.status).toBe(200);
    expect(r.json.items.map((t) => t.id)).toEqual([
      'athleten-stammdaten-csv',
      'leistungsdiagnostik-csv',
      'leistungsdiagnostik-xlsx',
      'sprungkraft-api',
      'sprungkraft-oauth2-api',
      'verletzungen-csv',
    ]);
    expect(r.json.items[0]!.name).toBe('Athleten-Stammdaten (CSV)');
  });

  test('nur Datenverantwortliche verwalten Quellen', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/connectors'],
      ['GET', '/api/v1/connector-templates'],
      ['POST', '/api/v1/connectors/inspect'],
    ] as const) {
      expect((await node.request(method, path, { as: analyst })).status).toBe(403);
    }
    expect((await node.request('GET', '/api/v1/connectors')).status).toBe(401);
  });
});

let athletesConnector: Connector;
let ldConnector: Connector;
let ldDataset: Dataset;

describe('CSV: Athleten-Stammdaten (osp-nord)', () => {
  let preview: RunDetail;

  test('Connector aus Vorlage anlegen', async () => {
    athletesConnector = await importTemplate(node, steward, 'athleten-stammdaten-csv');
    expect(athletesConnector).toMatchObject({
      slug: 'athleten-stammdaten-csv',
      kind: 'csv_upload',
      targetType: 'athletes',
      targetDatasetId: null,
      version: 1,
      hasSecret: false,
      lastRun: null,
      athleteMatch: { strategy: 'external_id', system: 'osp-id' },
    });
  });

  test('Vorschau mit den 3 erwarteten Fehlern', async () => {
    preview = await startImport(node, steward, athletesConnector.id, fileForm('osp-nord/athleten.csv'));
    expect(preview.run).toMatchObject({
      status: 'previewed',
      sourceName: 'athleten.csv',
      totalRows: 43,
      validRows: 40,
      errorRows: 3,
      warningRows: 0,
      insertedRows: 0,
      failureCode: null,
      connectorVersion: 1,
    });
    expect(preview.run.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.run.sourceSize).toBeGreaterThan(1000);
    expect(preview.preview.sourceColumns).toContain('Athleten-ID');
    expect(preview.preview.rows.length).toBe(43);
    expect(preview.preview.rows[12]!.status).toBe('error');
    expect(preview.preview.rows[0]!.mapped['athlete.squad_status']).toBe('PK');
    expect(preview.preview.rows[0]!.raw.Kaderstatus).toBe('Perspektivkader');
    expect(preview.errorSummary.map((e) => `${e.code}:${e.field}:${e.count}`).sort()).toEqual([
      'invalid_date:athlete.date_of_birth:1',
      'invalid_enum:athlete.squad_status:1',
      'required:athlete.sport:1',
    ]);
    const errors = await errorsOf(preview.run.id);
    expect(errors.total).toBe(3);
    expect(errors.items.map((e) => [e.rowNumber, e.code, e.rawValue])).toEqual([
      [13, 'invalid_date', '31.02.2004'],
      [27, 'required', ''],
      [38, 'invalid_enum', 'Bundeskader'],
    ]);
    // Rohdatei wird nicht gespeichert, nur vorgemerkte gültige Zeilen
    const row = await node.deps.db
      .selectFrom('import_run')
      .select('staged')
      .where('id', '=', preview.run.id)
      .executeTakeFirstOrThrow();
    expect((row.staged as { rows: unknown[] }).rows.length).toBe(40);
    expect(await athleteCount()).toBe(0);
  });

  test('Übernahme legt Personen mit Kennungen an', async () => {
    const run = await commitRun(node, steward, preview.run.id);
    expect(run).toMatchObject({ status: 'committed', insertedRows: 40, updatedRows: 0 });
    expect(run.finishedAt).not.toBeNull();
    expect(await athleteCount()).toBe(40);

    const list = await node.request<{ items: { id: string; lastName: string }[]; total: number }>(
      'GET',
      '/api/v1/athletes?q=NORD-0001',
      { as: steward },
    );
    expect(list.json.total).toBe(1);
    const detail = await node.request<{
      identifiers: { system: string; value: string }[];
      squadStatus: string;
      sex: string;
    }>('GET', `/api/v1/athletes/${list.json.items[0]!.id}`, { as: steward });
    expect(detail.json.identifiers).toEqual([{ system: 'osp-id', value: 'NORD-0001' }]);
    expect(detail.json.squadStatus).toBe('PK');
    expect(detail.json.sex).toBe('f');

    const stored = await node.deps.db
      .selectFrom('import_run')
      .select(['staged', 'status', 'committed_by'])
      .where('id', '=', preview.run.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ staged: null, status: 'committed', committed_by: steward.id });
    // keine verbleibenden Rohdaten mit Personenbezug in der Vorschau
    const detailAfter = await node.request<RunDetail>('GET', `/api/v1/import-runs/${preview.run.id}`, {
      as: steward,
    });
    expect(detailAfter.json.preview).toEqual({ sourceColumns: preview.preview.sourceColumns, rows: [] });
    expect(detailAfter.json.run.status).toBe('committed');
    expect(detailAfter.json.errorSummary.length).toBe(3);

    const [audit] = await auditEntries(node, 'import.commit');
    expect(audit).toMatchObject({ object_id: preview.run.id, actor_id: steward.id, outcome: 'success' });
    expect(audit!.details).toMatchObject({ inserted: 40, updated: 0, skipped: 0, targetType: 'athletes' });
    const [start] = await auditEntries(node, 'import.start');
    expect(start!.details).toMatchObject({ status: 'previewed', totalRows: 43, errorRows: 3 });
  });

  test('erneuter Import aktualisiert statt zu duplizieren', async () => {
    const again = await startImport(node, steward, athletesConnector.id, fileForm('osp-nord/athleten.csv'));
    expect(again.run).toMatchObject({ validRows: 40, errorRows: 3, warningRows: 0 });
    const run = await commitRun(node, steward, again.run.id);
    expect(run).toMatchObject({ insertedRows: 0, updatedRows: 40 });
    expect(await athleteCount()).toBe(40);
  });

  test('geänderte Stammdaten: Hinweis will_update und Aktualisierung', async () => {
    const csv =
      'Athleten-ID;Nachname;Vorname;Geburtsdatum;Geschlecht;Sportart;Disziplin;Kaderstatus;Verein\n';
    const first = await node.deps.db
      .selectFrom('athlete as a')
      .innerJoin('athlete_identifier as i', 'i.athlete_id', 'a.id')
      .selectAll('a')
      .where('i.value', '=', 'NORD-0002')
      .executeTakeFirstOrThrow();
    const dob = first.date_of_birth.split('-').reverse().join('.');
    const content = `${csv}NORD-0002;${first.last_name};${first.first_name};${dob};m;${first.sport};${first.discipline};Olympiakader;${first.club}\n`;
    const r = await startImport(node, steward, athletesConnector.id, fileForm(content, 'kader.csv'));
    expect(r.run).toMatchObject({ validRows: 1, warningRows: 1, errorRows: 0 });
    expect(r.errorSummary).toEqual([{ code: 'will_update', field: null, count: 1 }]);
    expect(r.preview.rows[0]!.status).toBe('warning');
    await commitRun(node, steward, r.run.id);
    const after = await node.deps.db
      .selectFrom('athlete')
      .select('squad_status')
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow();
    expect(after.squad_status).toBe('OK');
  });

  test('fehlende Spalte: Lauf schlägt mit missing_column fehl', async () => {
    const r = await startImport(
      node,
      steward,
      athletesConnector.id,
      fileForm('osp-nord/leistungsdiagnostik.csv'),
    );
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'missing_column', totalRows: 80 });
    expect(r.preview.sourceColumns).toContain('Testdatum');
    const errors = await errorsOf(r.run.id);
    expect(errors.items.every((e) => e.rowNumber === 0 && e.code === 'missing_column')).toBe(true);
    expect(errors.items.map((e) => e.params.column)).toContain('Athleten-ID');
    const commit = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      `/api/v1/import-runs/${r.run.id}/commit`,
      { as: steward },
    );
    expect(commit.status).toBe(409);
    expect(commit.json.error.reason).toBe('run_not_previewed');
  });

  test('ohne Datei: validation_failed', async () => {
    const r = await node.request<{ error: { code: string; fields: Record<string, string> } }>(
      'POST',
      `/api/v1/connectors/${athletesConnector.id}/runs`,
      { as: steward, form: new FormData() },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.fields).toEqual({ 'body.file': 'required' });
  });
});

describe('CSV: Windows-1252 (osp-mitte)', () => {
  test('ausdrücklich konfigurierte Kodierung', async () => {
    const c = await importTemplate(node, steward, 'athleten-stammdaten-csv', (def) => {
      def.connector.slug = 'athleten-mitte';
      def.connector.name = 'Athleten osp-mitte';
      if (def.connector.config.type === 'csv') def.connector.config.encoding = 'windows-1252';
    });
    const r = await startImport(node, steward, c.id, fileForm('osp-mitte/athleten.csv'));
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 25, validRows: 25, errorRows: 0 });
    expect(r.errorSummary).toEqual([]);
    const names = r.preview.rows.map((row) => String(row.mapped['athlete.last_name']));
    expect(names.some((n) => /[äöüß]/.test(n))).toBe(true);
    expect(names.join('')).not.toContain('�');
    const run = await commitRun(node, steward, r.run.id);
    expect(run.insertedRows).toBe(25);
    const hit = await node.request<{ total: number }>('GET', '/api/v1/athletes?q=MITTE-0001', {
      as: steward,
    });
    expect(hit.json.total).toBe(1);
  });

  test('Vorlage unverändert (UTF-8): Rückfall auf Windows-1252 mit Hinweis', async () => {
    const r = await startImport(node, steward, athletesConnector.id, fileForm('osp-mitte/athleten.csv'));
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 25, errorRows: 0 });
    expect(r.errorSummary).toContainEqual({ code: 'encoding_fallback', field: null, count: 1 });
    const names = r.preview.rows.map((row) => String(row.mapped['athlete.last_name']));
    expect(names.join('')).not.toContain('�');
    const discard = await node.request<ImportRun>('POST', `/api/v1/import-runs/${r.run.id}/discard`, {
      as: steward,
    });
    expect(discard.status).toBe(200);
  });
});

describe('CSV: Leistungsdiagnostik (natürlicher Schlüssel)', () => {
  test('Vorlage legt den Datensatz an', async () => {
    ldConnector = await importTemplate(node, steward, 'leistungsdiagnostik-csv');
    expect(ldConnector.targetType).toBe('dataset');
    expect(ldConnector.targetDatasetName).toBe('Leistungsdiagnostik');
    const ds = await node.request<Dataset>('GET', `/api/v1/datasets/${ldConnector.targetDatasetId}`, {
      as: steward,
    });
    ldDataset = ds.json;
    expect(ldDataset).toMatchObject({
      slug: 'leistungsdiagnostik',
      category: 'performance',
      keyFields: ['test_date', 'protocol'],
      observedAtField: 'test_date',
      recordCount: 0,
      version: 1,
    });
  });

  test('Import: 2 unplausible Zeilen, Übernahme der übrigen', async () => {
    const r = await startImport(node, steward, ldConnector.id, fileForm('osp-nord/leistungsdiagnostik.csv'));
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 80, validRows: 78, errorRows: 2 });
    expect(r.errorSummary.map((e) => `${e.code}:${e.field}`).sort()).toEqual([
      'future_date:data.test_date',
      'out_of_range:data.vo2max',
    ]);
    const run = await commitRun(node, steward, r.run.id);
    expect(run).toMatchObject({ insertedRows: 78, updatedRows: 0 });

    const records = await node.request<{
      items: {
        athleteName: string;
        observedAt: string | null;
        data: Record<string, unknown>;
        importRunId: string;
      }[];
      total: number;
    }>('GET', `/api/v1/datasets/${ldDataset.id}/records?pageSize=5`, { as: steward });
    expect(records.json.total).toBe(78);
    const first = records.json.items[0]!;
    expect(first.athleteName).toMatch(/^.+, .+$/);
    expect(first.observedAt).toMatch(/T00:00:00\.000Z$/);
    expect(first.observedAt!.slice(0, 10)).toBe(first.data.test_date as string);
    expect(typeof first.data.vo2max).toBe('number');
    expect(first.importRunId).toBe(r.run.id);
    const ds = await node.request<Dataset>('GET', `/api/v1/datasets/${ldDataset.id}`, { as: steward });
    expect(ds.json.recordCount).toBe(78);
  });

  test('erneuter Import: keine Duplikate', async () => {
    const r = await startImport(node, steward, ldConnector.id, fileForm('osp-nord/leistungsdiagnostik.csv'));
    expect(r.run).toMatchObject({ validRows: 78, warningRows: 0 });
    const run = await commitRun(node, steward, r.run.id);
    expect(run).toMatchObject({ insertedRows: 0, updatedRows: 78 });
    const ds = await node.request<Dataset>('GET', `/api/v1/datasets/${ldDataset.id}`, { as: steward });
    expect(ds.json.recordCount).toBe(78);
  });

  test('onError=abort blockiert die Übernahme; Verwerfen löscht vorgemerkte Zeilen', async () => {
    const strict = await importTemplate(node, steward, 'leistungsdiagnostik-csv', (def) => {
      def.connector.slug = 'ld-streng';
      def.connector.onError = 'abort';
    });
    expect(strict.targetDatasetId).toBe(ldDataset.id);
    const r = await startImport(node, steward, strict.id, fileForm('osp-nord/leistungsdiagnostik.csv'));
    expect(r.run.errorRows).toBe(2);
    const commit = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      `/api/v1/import-runs/${r.run.id}/commit`,
      { as: steward },
    );
    expect(commit.status).toBe(409);
    expect(commit.json.error).toMatchObject({ code: 'conflict', reason: 'import_has_errors' });

    const discard = await node.request<ImportRun>('POST', `/api/v1/import-runs/${r.run.id}/discard`, {
      as: steward,
    });
    expect(discard.json.status).toBe('discarded');
    const row = await node.deps.db
      .selectFrom('import_run')
      .select(['staged', 'preview'])
      .where('id', '=', r.run.id)
      .executeTakeFirstOrThrow();
    expect(row.staged).toBeNull();
    expect((row.preview as { rows: unknown[] }).rows).toEqual([]);
    expect((await auditEntries(node, 'import.discard'))[0]!.object_id).toBe(r.run.id);
    const again = await node.request('POST', `/api/v1/import-runs/${r.run.id}/discard`, { as: steward });
    expect(again.status).toBe(409);
  });

  test('inzwischen gelöschte Person wird bei der Übernahme übersprungen', async () => {
    const content =
      'Nachname,Vorname,Geburtsdatum,Testdatum,Protokoll,VO2max,Laktatschwelle_W,HFmax\n' +
      'Testperson,Erika,2002-02-02,2026-01-15,Stufentest Laufband,55.5,,190\n';
    const person = {
      lastName: 'Testperson',
      firstName: 'Erika',
      dateOfBirth: '2002-02-02',
      sport: 'Leichtathletik',
      squadStatus: 'LK',
    };
    // Löschung über die API: Person wird sofort aus der offenen Vorschau entfernt
    const created = await node.request<{ id: string }>('POST', '/api/v1/athletes', {
      as: steward,
      body: person,
    });
    const r = await startImport(node, steward, ldConnector.id, fileForm(content, 'eine-zeile.csv'));
    expect(r.run.validRows).toBe(1);
    expect(
      (await node.request('DELETE', `/api/v1/athletes/${created.json.id}`, { as: steward })).status,
    ).toBe(200);
    const run = await commitRun(node, steward, r.run.id);
    expect(run).toMatchObject({ insertedRows: 0, updatedRows: 0 });
    expect((await auditEntries(node, 'import.commit'))[0]!.details).toMatchObject({ skipped: 0 });
    expect((await errorsOf(r.run.id)).items).toContainEqual(
      expect.objectContaining({
        rowNumber: 1,
        code: 'athlete_not_found',
        severity: 'warning',
        params: { phase: 'erasure' },
      }),
    );

    // Absicherung bei der Übernahme (Person fehlt, ohne dass der Lauf bereinigt wurde)
    const again = await node.request<{ id: string }>('POST', '/api/v1/athletes', {
      as: steward,
      body: person,
    });
    const r2 = await startImport(node, steward, ldConnector.id, fileForm(content, 'eine-zeile.csv'));
    await node.deps.db.deleteFrom('athlete').where('id', '=', again.json.id).execute();
    const run2 = await commitRun(node, steward, r2.run.id);
    expect(run2).toMatchObject({ insertedRows: 0, updatedRows: 0 });
    expect((await auditEntries(node, 'import.commit'))[0]!.details).toMatchObject({ skipped: 1 });
    expect((await errorsOf(r2.run.id)).items).toContainEqual(
      expect.objectContaining({
        rowNumber: 1,
        code: 'athlete_not_found',
        severity: 'warning',
        params: { phase: 'commit' },
      }),
    );
  });
});

describe('CSV: Verletzungen (Gesundheitsdaten, Kennung)', () => {
  test('Import in Datensatz der besonderen Kategorie', async () => {
    const c = await importTemplate(node, steward, 'verletzungen-csv');
    const ds = await node.request<Dataset>('GET', `/api/v1/datasets/${c.targetDatasetId}`, { as: steward });
    expect(ds.json).toMatchObject({ slug: 'verletzungen', category: 'health', specialCategory: true });
    const r = await startImport(node, steward, c.id, fileForm('osp-nord/verletzungen.csv'));
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 25, validRows: 25, errorRows: 0 });
    const run = await commitRun(node, steward, r.run.id);
    expect(run.insertedRows).toBe(25);
    const records = await node.request<{ total: number; items: { data: Record<string, unknown> }[] }>(
      'GET',
      `/api/v1/datasets/${c.targetDatasetId}/records`,
      { as: steward },
    );
    expect(records.json.total).toBe(25);
    expect(['akut', 'in Reha', 'ausgeheilt']).toContain(records.json.items[0]!.data.status as string);
    expect((await auditEntries(node, 'dataset.read'))[0]!.object_id).toBe(c.targetDatasetId);
  });
});

describe('API-Quelle: Sprungkraft-Messsystem', () => {
  let api: Connector;

  test('Connector aus Vorlage, URL auf Testhost', async () => {
    api = await importTemplate(node, steward, 'sprungkraft-api');
    const r = await node.request<Connector>('PATCH', `/api/v1/connectors/${api.id}`, {
      as: steward,
      body: { config: { ...api.config, url: API_URL } },
    });
    expect(r.status).toBe(200);
    expect(r.json.version).toBe(2);
    // PATCH ändert nur angegebene Felder
    expect(r.json.athleteMatch).toEqual({ strategy: 'external_id', system: 'osp-id' });
    expect(r.json.mapping).toEqual(api.mapping);
    api = r.json;
  });

  test('ohne Geheimnis: 401 der Quelle → fehlgeschlagener Lauf', async () => {
    const r = await startImport(node, steward, api.id);
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'source_unreachable', totalRows: 0 });
    expect(r.run.sourceName).toBe(API_URL);
    const errors = await errorsOf(r.run.id);
    expect(errors.items).toEqual([
      {
        rowNumber: 0,
        field: null,
        code: 'source_unreachable',
        severity: 'error',
        rawValue: null,
        params: { status: 401 },
      },
    ]);
    const [audit] = await auditEntries(node, 'import.start');
    expect(audit).toMatchObject({ outcome: 'error', object_id: r.run.id });
  });

  test('Geheimnis wird verschlüsselt gespeichert und nie ausgegeben', async () => {
    const r = await node.request('PUT', `/api/v1/connectors/${api.id}/secret`, {
      as: steward,
      body: { secret: API_TOKEN },
    });
    expect(r.status).toBe(200);
    const c = await node.request<Connector>('GET', `/api/v1/connectors/${api.id}`, { as: steward });
    expect(c.json.hasSecret).toBe(true);
    expect(c.text).not.toContain(API_TOKEN);
    const row = await node.deps.db
      .selectFrom('connector')
      .select('secret_enc')
      .where('id', '=', api.id)
      .executeTakeFirstOrThrow();
    expect(row.secret_enc).not.toContain(API_TOKEN);
    expect(node.deps.box.open(row.secret_enc!, secretAad(api.id))).toBe(API_TOKEN);
    expect(() => node.deps.box.open(row.secret_enc!, 'connector.secret:other')).toThrow();
    const [audit] = await auditEntries(node, 'connector.secret_set');
    expect(JSON.stringify(audit!.details)).not.toContain(API_TOKEN);
    const exported = await node.request('GET', `/api/v1/connectors/${api.id}/export`, { as: steward });
    expect(exported.text).not.toContain(API_TOKEN);
  });

  test('seitenweiser Abruf, Prüfung und Übernahme', async () => {
    apiRequests.length = 0;
    const r = await startImport(node, steward, api.id);
    expect(apiRequests.length).toBe(3);
    expect(new URL(apiRequests[2]!).searchParams.get('page')).toBe('3');
    expect(new URL(apiRequests[0]!).searchParams.get('page_size')).toBe('50');
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 123, validRows: 120, errorRows: 3 });
    expect(r.preview.sourceColumns).toEqual(
      expect.arrayContaining([
        'measurement_id',
        'athlete.external_id',
        'athlete.display_name',
        'contact_time_ms',
      ]),
    );
    expect(r.errorSummary.map((e) => `${e.code}:${e.field}`).sort()).toEqual([
      'athlete_not_found:athlete.external_id',
      'invalid_enum:data.test_type',
      'out_of_range:data.jump_height_cm',
    ]);
    const errors = await errorsOf(r.run.id);
    // keine Personenkennung als Rohwert, nur Zeile, Feld und Kennungssystem
    const notFound = errors.items.find((e) => e.code === 'athlete_not_found')!;
    expect(notFound).toMatchObject({
      field: 'athlete.external_id',
      rawValue: null,
      params: { system: 'osp-id' },
    });
    expect(JSON.stringify(errors)).not.toContain(BAD_MEASUREMENTS.unknownAthlete);
    const run = await commitRun(node, steward, r.run.id);
    expect(run).toMatchObject({ insertedRows: 120, updatedRows: 0 });
    const records = await node.request<{
      total: number;
      items: { observedAt: string; data: Record<string, unknown> }[];
    }>('GET', `/api/v1/datasets/${api.targetDatasetId}/records?pageSize=1`, { as: steward });
    expect(records.json.total).toBe(120);
    expect(records.json.items[0]!.observedAt).toBe(records.json.items[0]!.data.measured_at as string);
    // Anzeigename aus dem Messsystem wird nicht übernommen
    expect(Object.keys(records.json.items[0]!.data).sort()).toEqual([
      'contact_time_ms',
      'jump_height_cm',
      'measured_at',
      'measurement_id',
      'peak_power_w',
      'test_type',
    ]);
  });

  test('erneuter Abruf aktualisiert statt zu duplizieren', async () => {
    const r = await startImport(node, steward, api.id);
    const run = await commitRun(node, steward, r.run.id);
    expect(run).toMatchObject({ insertedRows: 0, updatedRows: 120 });
    const list = await node.request<{ items: Connector[] }>('GET', '/api/v1/connectors', { as: steward });
    expect(list.json.items.find((c) => c.id === api.id)!.lastRun).toMatchObject({
      id: r.run.id,
      status: 'committed',
    });
    const runs = await node.request<{ items: ImportRun[] }>('GET', `/api/v1/connectors/${api.id}/runs`, {
      as: steward,
    });
    expect(runs.json.items.map((x) => x.status)).toEqual(['committed', 'committed', 'failed']);
  });

  test('nicht freigegebener Host: 400 source_not_allowed, Ablehnung protokolliert', async () => {
    const c = await importTemplate(node, steward, 'sprungkraft-api', (def) => {
      def.connector.slug = 'sprungkraft-fremd';
      if (def.connector.config.type === 'http_api')
        def.connector.config.url = 'http://evil.example/v1/measurements';
    });
    const r = await node.request<{ error: { code: string } }>('POST', `/api/v1/connectors/${c.id}/runs`, {
      as: steward,
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('source_not_allowed');
    const [audit] = await auditEntries(node, 'import.start');
    expect(audit).toMatchObject({ outcome: 'denied', object_id: c.id });
    expect(audit!.details).toMatchObject({ reason: 'source_not_allowed', host: 'evil.example' });
  });

  test('nicht erreichbarer Host: fehlgeschlagener Lauf mit failure_code', async () => {
    // 127.0.0.1:4410 ist freigegeben, im Test aber nicht erreichbar
    const c = await importTemplate(node, steward, 'sprungkraft-api', (def) => {
      def.connector.slug = 'sprungkraft-offline';
    });
    const r = await startImport(node, steward, c.id);
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'source_unreachable' });
    const errors = await errorsOf(r.run.id);
    expect(errors.items[0]!.params).toEqual({ reason: 'network' });
  });

  test('Analyse einer API-Antwort (inspect)', async () => {
    const form = new FormData();
    form.append('config', JSON.stringify({ ...api.config }));
    form.append('connectorId', api.id);
    const r = await node.request<{
      columns: string[];
      sampleRows: Record<string, string | null>[];
      detectedDelimiter: null;
    }>('POST', '/api/v1/connectors/inspect', { as: steward, form });
    expect(r.status).toBe(200);
    expect(r.json.columns).toEqual(
      expect.arrayContaining(['measurement_id', 'athlete.external_id', 'measured_at']),
    );
    expect(r.json.sampleRows.length).toBe(10);
    expect(r.json.detectedDelimiter).toBeNull();

    const noSecret = new FormData();
    noSecret.append('config', JSON.stringify({ ...api.config }));
    const denied = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      '/api/v1/connectors/inspect',
      {
        as: steward,
        form: noSecret,
      },
    );
    expect(denied.status).toBe(502);
    expect(denied.json.error).toMatchObject({ code: 'source_unreachable', reason: 'http_401' });

    const evil = new FormData();
    evil.append('config', JSON.stringify({ ...api.config, url: 'http://169.254.169.254/latest' }));
    const blocked = await node.request<{ error: { code: string } }>('POST', '/api/v1/connectors/inspect', {
      as: steward,
      form: evil,
    });
    expect(blocked.status).toBe(400);
    expect(blocked.json.error.code).toBe('source_not_allowed');
  });
});

describe('Analyse von CSV-Dateien (inspect)', () => {
  test('Spalten, Beispielzeilen, erkanntes Trennzeichen', async () => {
    const r = await node.request<{
      columns: string[];
      sampleRows: Record<string, string | null>[];
      detectedDelimiter: string;
    }>('POST', '/api/v1/connectors/inspect', { as: steward, form: fileForm('osp-nord/athleten.csv') });
    expect(r.status).toBe(200);
    expect(r.json.detectedDelimiter).toBe(';');
    expect(r.json.columns).toEqual([
      'Athleten-ID',
      'Nachname',
      'Vorname',
      'Geburtsdatum',
      'Geschlecht',
      'Sportart',
      'Disziplin',
      'Kaderstatus',
      'Verein',
    ]);
    expect(r.json.sampleRows.length).toBe(10);
    const ld = await node.request<{ detectedDelimiter: string }>('POST', '/api/v1/connectors/inspect', {
      as: steward,
      form: fileForm('osp-nord/leistungsdiagnostik.csv'),
    });
    expect(ld.json.detectedDelimiter).toBe(',');
    expect(
      (await node.request('POST', '/api/v1/connectors/inspect', { as: steward, form: new FormData() }))
        .status,
    ).toBe(400);
  });
});

describe('Connector-Definitionen', () => {
  test('Export → Import (Rundreise) nutzt den vorhandenen Datensatz', async () => {
    const exported = await node.request<ConnectorDefinition>(
      'GET',
      `/api/v1/connectors/${ldConnector.id}/export`,
      {
        as: steward,
      },
    );
    expect(exported.status).toBe(200);
    const def = exported.json;
    expect(def.format).toBe('osp-data-mesh/connector@1');
    expect(def.connector.targetDatasetSlug).toBe('leistungsdiagnostik');
    expect(def.dataset).toMatchObject({ slug: 'leistungsdiagnostik', keyFields: ['test_date', 'protocol'] });
    expect(def.connector).not.toHaveProperty('targetDatasetId');

    const conflict = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      '/api/v1/connectors/import',
      {
        as: steward,
        body: { definition: def },
      },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.reason).toBe('slug_exists');

    def.connector.slug = 'leistungsdiagnostik-kopie';
    const imported = await node.request<Connector>('POST', '/api/v1/connectors/import', {
      as: steward,
      body: { definition: def },
    });
    expect(imported.status).toBe(200);
    expect(imported.json.targetDatasetId).toBe(ldConnector.targetDatasetId);
    expect(imported.json.mapping).toEqual(ldConnector.mapping);
    expect(imported.json.config).toEqual(ldConnector.config);
    const again = await node.request<ConnectorDefinition>(
      'GET',
      `/api/v1/connectors/${imported.json.id}/export`,
      {
        as: steward,
      },
    );
    expect({ ...again.json.connector, slug: 'x' }).toEqual({ ...def.connector, slug: 'x' });
    expect(again.json.dataset).toEqual(def.dataset);
  });

  test('Import ohne vorhandenen Datensatz und ohne createDataset schlägt fehl', async () => {
    const def = await templateDefinition(node, steward, 'leistungsdiagnostik-csv');
    def.connector.slug = 'ld-neu';
    def.connector.targetDatasetSlug = 'gibt_es_nicht';
    def.dataset = null;
    const r = await node.request<{ error: { fields: Record<string, string> } }>(
      'POST',
      '/api/v1/connectors/import',
      {
        as: steward,
        body: { definition: def, createDataset: false },
      },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.fields).toEqual({ 'body.definition.connector.targetDatasetSlug': 'not_found' });
  });
});

describe('Prüfung von Connector-Definitionen', () => {
  const base = {
    name: 'Test',
    kind: 'csv_upload',
    config: { type: 'csv' },
  };

  test('Art und Konfiguration müssen zusammenpassen', async () => {
    const r = await node.request<{ error: { fields: Record<string, string> } }>(
      'POST',
      '/api/v1/connectors',
      {
        as: steward,
        body: {
          ...base,
          slug: 'falsch',
          kind: 'http_api',
          targetType: 'athletes',
          mapping: [{ source: 'a', target: 'athlete.last_name' }],
        },
      },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.fields['body.config.type']).toBe('kind_mismatch');
  });

  test('Athletenkern: Pflichtzuordnungen und nur athlete.*-Ziele', async () => {
    const r = await node.request<{ error: { fields: Record<string, string> } }>(
      'POST',
      '/api/v1/connectors',
      {
        as: steward,
        body: {
          ...base,
          slug: 'unvollstaendig',
          targetType: 'athletes',
          mapping: [
            { source: 'N', target: 'athlete.last_name' },
            { source: 'V', target: 'athlete.first_name' },
            { source: 'G', target: 'athlete.date_of_birth' },
            { source: 'X', target: 'data.vo2max' },
          ],
        },
      },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.fields).toEqual({
      'body.mapping.3.target': 'not_allowed',
      'body.mapping[athlete.sport]': 'required',
      'body.mapping[athlete.squad_status]': 'required',
    });
  });

  test('Datensatz: Felder müssen existieren, Pflichtfelder zugeordnet, Personenzuordnung vollständig', async () => {
    const r = await node.request<{ error: { fields: Record<string, string> } }>(
      'POST',
      '/api/v1/connectors',
      {
        as: steward,
        body: {
          ...base,
          slug: 'ld-unvollstaendig',
          targetType: 'dataset',
          targetDatasetId: ldDataset.id,
          mapping: [
            { source: 'N', target: 'athlete.last_name' },
            { source: 'T', target: 'data.test_date' },
            { source: 'S', target: 'athlete.sport' },
            { source: 'Q', target: 'data.unbekannt' },
            { source: 'T2', target: 'data.test_date' },
          ],
        },
      },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.fields).toEqual({
      'body.mapping.2.target': 'not_allowed',
      'body.mapping.3.target': 'unknown_field',
      'body.mapping.4.target': 'duplicate_target',
      'body.mapping[data.protocol]': 'required',
      'body.mapping[data.vo2max]': 'required',
      'body.mapping[data.max_heart_rate]': 'required',
      'body.mapping[athlete.first_name]': 'required',
      'body.mapping[athlete.date_of_birth]': 'required',
    });
    const missing = await node.request<{ error: { fields: Record<string, string> } }>(
      'POST',
      '/api/v1/connectors',
      {
        as: steward,
        body: {
          ...base,
          slug: 'ohne-datensatz',
          targetType: 'dataset',
          targetDatasetId: crypto.randomUUID(),
          mapping: [{ source: 'a', target: 'athlete.external_id' }],
          athleteMatch: { strategy: 'external_id', system: 'osp-id' },
        },
      },
    );
    expect(missing.json.error.fields).toEqual({ 'body.targetDatasetId': 'not_found' });
  });

  test('Geheimnis nur für API-Quellen; unbekannte Connectoren und Läufe', async () => {
    const r = await node.request('PUT', `/api/v1/connectors/${athletesConnector.id}/secret`, {
      as: steward,
      body: { secret: 'x' },
    });
    expect(r.status).toBe(400);
    const unknown = crypto.randomUUID();
    expect((await node.request('GET', `/api/v1/connectors/${unknown}`, { as: steward })).status).toBe(404);
    expect((await node.request('GET', `/api/v1/import-runs/${unknown}`, { as: steward })).status).toBe(404);
    expect(
      (await node.request('POST', `/api/v1/import-runs/${unknown}/commit`, { as: steward })).status,
    ).toBe(404);
  });

  test('Änderung erhöht die Version; Vorschau eines älteren Stands kann nicht übernommen werden', async () => {
    const r = await startImport(node, steward, athletesConnector.id, fileForm('osp-sued/athleten.csv'));
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 20, errorRows: 0 });
    const upd = await node.request<Connector>('PATCH', `/api/v1/connectors/${athletesConnector.id}`, {
      as: steward,
      body: { description: 'geändert' },
    });
    expect(upd.json.version).toBe(athletesConnector.version + 1);
    expect(upd.json.athleteMatch).toEqual(athletesConnector.athleteMatch);
    const commit = await node.request<{ error: { reason: string } }>(
      'POST',
      `/api/v1/import-runs/${r.run.id}/commit`,
      {
        as: steward,
      },
    );
    expect(commit.status).toBe(409);
    expect(commit.json.error.reason).toBe('connector_changed');
    const detail = await node.request<RunDetail>('GET', `/api/v1/import-runs/${r.run.id}`, { as: steward });
    expect(detail.json.run.status).toBe('previewed');
    expect(detail.json.preview.rows.length).toBe(20);
    expect((await auditEntries(node, 'import.read'))[0]!.object_id).toBe(r.run.id);
  });
});
