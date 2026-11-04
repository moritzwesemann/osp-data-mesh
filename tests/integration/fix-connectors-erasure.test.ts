/**
 * Regression: Löschung einer Person (Art. 17) entfernt sie auch aus offenen Importläufen; Rohwerte im
 * Fehlerprotokoll enthalten keine Personenkennungen und bleiben nur während der Vorschau; nicht
 * übernommene Vorschauen verfallen nach 7 Tagen.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectorsModule } from '../../src/server/modules/connectors/index.ts';
import { expireStalePreviews } from '../../src/server/modules/connectors/retention.ts';
import type { Connector, ImportRun } from '../../src/shared/contract/connectors.ts';
import {
  auditEntries,
  commitRun,
  fileForm,
  importTemplate,
  type RunDetail,
  startImport,
} from '../helpers/integration.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';

let node: TestNode;
let steward: TestUser;
let injuries: Connector;
let athletes: Connector;

const HEADER =
  'Nachname;Vorname;Geburtsdatum;Verletzungsdatum;Körperregion;Verletzungsart;Ausfalltage;Status';
const INJURIES = [
  HEADER,
  'Vergessen;Otto;02.02.2003;15.09.2024;Knie;Bänderverletzung;46;akut',
  // ungültige Verletzungsart: Rohwert (Diagnose) landet im Fehlerprotokoll
  'Vergessen;Otto;02.02.2003;01.10.2024;Knie;Kreuzbandriss;10;akut',
  'Bleibt;Erika;01.01.2001;03.03.2024;Schulter;Prellung;3;ausgeheilt',
  // unbekannte Person: Zuordnungsfehler
  'Unbekannt;Hans;05.05.2000;03.03.2024;Schulter;Prellung;3;ausgeheilt',
].join('\n');

async function createAthlete(lastName: string, firstName: string, dateOfBirth: string): Promise<string> {
  const r = await node.request<{ id: string }>('POST', '/api/v1/athletes', {
    as: steward,
    body: { lastName, firstName, dateOfBirth, sport: 'Rudern', squadStatus: 'PK' },
  });
  if (r.status !== 200) throw new Error(`create athlete failed: ${r.status} ${r.text}`);
  return r.json.id;
}

async function deleteAthlete(id: string) {
  const r = await node.request('DELETE', `/api/v1/athletes/${id}`, { as: steward });
  expect(r.status).toBe(200);
}

async function errorsOf(runId: string) {
  const r = await node.request<{
    items: { rowNumber: number; field: string | null; code: string; rawValue: string | null }[];
  }>('GET', `/api/v1/import-runs/${runId}/errors?pageSize=500`, { as: steward });
  expect(r.status).toBe(200);
  return r.json.items;
}

async function storedRun(runId: string) {
  const run = await node.deps.db
    .selectFrom('import_run')
    .select(['status', 'staged', 'preview'])
    .where('id', '=', runId)
    .executeTakeFirstOrThrow();
  const errors = await node.deps.db
    .selectFrom('import_error')
    .select(['row_number', 'code', 'raw_value', 'params'])
    .where('run_id', '=', runId)
    .orderBy('row_number')
    .execute();
  return { ...run, errors, text: JSON.stringify({ run, errors }) };
}

beforeAll(async () => {
  node = await createTestNode();
  steward = await node.user(['data_steward']);
  injuries = await importTemplate(node, steward, 'verletzungen-csv', (def) => {
    def.connector.slug = 'verletzungen-name';
    def.connector.athleteMatch = { strategy: 'natural_key' };
    def.connector.mapping = [
      { source: 'Nachname', target: 'athlete.last_name', transform: 'trim' },
      { source: 'Vorname', target: 'athlete.first_name', transform: 'trim' },
      { source: 'Geburtsdatum', target: 'athlete.date_of_birth', transform: 'trim' },
      ...def.connector.mapping.filter((m) => m.target.startsWith('data.')),
    ];
  });
  athletes = await importTemplate(node, steward, 'athleten-stammdaten-csv');
});

afterAll(async () => {
  await node?.close();
});

describe('Löschung einer Person entfernt sie aus offenen Importläufen', () => {
  test('Vorschau in Gesundheitsdatensatz, Person löschen: Name und Diagnose sind weg', async () => {
    const otto = await createAthlete('Vergessen', 'Otto', '2003-02-02');
    await createAthlete('Bleibt', 'Erika', '2001-01-01');
    const preview = await startImport(node, steward, injuries.id, fileForm(INJURIES, 'verletzungen.csv'));
    expect(preview.run).toMatchObject({ status: 'previewed', totalRows: 4, validRows: 2, errorRows: 2 });
    expect(JSON.stringify(preview)).toContain('Vergessen');

    await deleteAthlete(otto);

    const detail = await node.request<RunDetail>('GET', `/api/v1/import-runs/${preview.run.id}`, {
      as: steward,
    });
    expect(detail.status).toBe(200);
    expect(detail.json.run.status).toBe('previewed');
    expect(detail.text).not.toContain('Vergessen');
    expect(detail.text).not.toContain('Otto');
    expect(detail.text).not.toContain('Kreuzbandriss');
    expect(detail.json.preview.rows.map((r) => r.rowNumber)).toEqual([3, 4]);

    const stored = await storedRun(preview.run.id);
    expect(stored.text).not.toContain('Vergessen');
    expect(stored.text).not.toContain('Kreuzbandriss');
    expect(stored.text).not.toContain(otto);
    // Erklärung im Fehlerprotokoll: Zeile 1 wurde wegen der Löschung aus der Übernahme genommen
    expect(stored.errors).toContainEqual(
      expect.objectContaining({ row_number: 1, code: 'athlete_not_found', params: { phase: 'erasure' } }),
    );
    // Fehlerzeile 2 der Person bleibt als Protokoll (Code), aber ohne Rohwert
    expect(stored.errors).toContainEqual(
      expect.objectContaining({ row_number: 2, code: 'invalid_enum', raw_value: null }),
    );
    const [erase] = await auditEntries(node, 'import.erase');
    expect(erase).toMatchObject({ object_id: preview.run.id, actor_type: 'system' });
    expect(erase!.details).toMatchObject({ rows: 2, staged: 1 });

    const run = await commitRun(node, steward, preview.run.id);
    expect(run).toMatchObject({ status: 'committed', insertedRows: 1 });
    const left = await node.deps.db
      .selectFrom('dataset_record')
      .select('athlete_id')
      .where('dataset_id', '=', injuries.targetDatasetId!)
      .execute();
    expect(left.length).toBe(1);
  });

  test('neue Person der Vorschau (noch ohne ID) wird über den natürlichen Schlüssel gefunden', async () => {
    const csv =
      'Athleten-ID;Nachname;Vorname;Geburtsdatum;Geschlecht;Sportart;Disziplin;Kaderstatus;Verein\n' +
      'NEU-1;Später;Paula;03.03.2004;w;Rudern;Einer;Perspektivkader;RC\n' +
      'NEU-2;Andere;Anna;04.04.2004;w;Rudern;Einer;Perspektivkader;RC\n';
    const preview = await startImport(node, steward, athletes.id, fileForm(csv, 'neu.csv'));
    expect(preview.run).toMatchObject({ status: 'previewed', validRows: 2 });
    // Person entsteht nach der Vorschau (z. B. manuell) und wird gelöscht
    const paula = await createAthlete('Später', 'Paula', '2004-03-03');
    await deleteAthlete(paula);

    const stored = await storedRun(preview.run.id);
    expect(stored.text).not.toContain('Später');
    expect(stored.text).not.toContain('NEU-1');
    const run = await commitRun(node, steward, preview.run.id);
    expect(run.insertedRows).toBe(1);
    const recreated = await node.deps.db
      .selectFrom('athlete')
      .select('id')
      .where('last_name', '=', 'Später')
      .execute();
    expect(recreated).toEqual([]);
  });

  test('Läufe im früheren Format (staged als Array) werden ebenfalls bereinigt und bleiben übernehmbar', async () => {
    const otto = await createAthlete('Vergessen', 'Otto', '2003-02-02');
    const preview = await startImport(node, steward, injuries.id, fileForm(INJURIES, 'alt-format.csv'));
    const current = await storedRun(preview.run.id);
    await node.deps.db
      .updateTable('import_run')
      .set({ staged: JSON.stringify((current.staged as { rows: unknown[] }).rows) })
      .where('id', '=', preview.run.id)
      .execute();
    await deleteAthlete(otto);
    const stored = await storedRun(preview.run.id);
    expect(JSON.stringify(stored.staged)).not.toContain(otto);
    // ohne Personenbezug je Zeile wird die Vorschau vorsorglich ganz geleert
    expect(stored.text).not.toContain('Vergessen');
    expect(stored.text).not.toContain('Kreuzbandriss');
    expect((stored.preview as { rows: unknown[] }).rows).toEqual([]);
    expect(stored.errors.every((e) => e.raw_value === null)).toBe(true);
    const run = await commitRun(node, steward, preview.run.id);
    expect(run.insertedRows + run.updatedRows).toBe(1);
  });

  test('Löschung ohne Bezug zu offenen Läufen ändert diese nicht', async () => {
    const someone = await createAthlete('Fremd', 'Felix', '1999-09-09');
    const preview = await startImport(node, steward, injuries.id, fileForm(INJURIES, 'verletzungen.csv'));
    const before = await storedRun(preview.run.id);
    await deleteAthlete(someone);
    const after = await storedRun(preview.run.id);
    expect(after.text).toBe(before.text);
    await node.request('POST', `/api/v1/import-runs/${preview.run.id}/discard`, { as: steward });
  });
});

describe('Fehlerprotokoll ohne Personenkennungen', () => {
  test('Zuordnungsfehler speichern keinen Namen und kein Geburtsdatum', async () => {
    const preview = await startImport(node, steward, injuries.id, fileForm(INJURIES, 'verletzungen.csv'));
    const errors = await errorsOf(preview.run.id);
    const notFound = errors.filter((e) => e.code === 'athlete_not_found');
    expect(notFound.length).toBeGreaterThan(0);
    for (const e of notFound) expect(e.rawValue).toBeNull();
    const stored = await storedRun(preview.run.id);
    expect(stored.errors.map((e) => e.raw_value)).not.toContain('Unbekannt, Hans, 2000-05-05');
    // andere Rohwerte bleiben während der Vorschau zur Korrektur sichtbar
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'invalid_enum', rawValue: 'Kreuzbandriss' }),
    );
    await node.request('POST', `/api/v1/import-runs/${preview.run.id}/discard`, { as: steward });
  });

  test('Übernahme und Verwerfen leeren alle Rohwerte; Codes und Zeilen bleiben', async () => {
    for (const action of ['commit', 'discard'] as const) {
      const preview = await startImport(node, steward, injuries.id, fileForm(INJURIES, 'verletzungen.csv'));
      expect((await storedRun(preview.run.id)).errors.some((e) => e.raw_value !== null)).toBe(true);
      const r = await node.request<ImportRun>('POST', `/api/v1/import-runs/${preview.run.id}/${action}`, {
        as: steward,
      });
      expect(r.status).toBe(200);
      const stored = await storedRun(preview.run.id);
      expect(stored.errors.length).toBeGreaterThan(0);
      expect(stored.errors.every((e) => e.raw_value === null)).toBe(true);
      expect(stored.staged).toBeNull();
      expect((stored.preview as { rows: unknown[] }).rows).toEqual([]);
    }
  });
});

describe('Ablauf nicht übernommener Vorschauen', () => {
  async function ageRun(runId: string, days: number) {
    await node.deps.db
      .updateTable('import_run')
      .set({ created_at: new Date(Date.now() - days * 86_400_000) })
      .where('id', '=', runId)
      .execute();
  }

  test('Vorschauen älter als 7 Tage werden verworfen und geleert', async () => {
    const old = await startImport(node, steward, injuries.id, fileForm(INJURIES, 'alt.csv'));
    const fresh = await startImport(node, steward, injuries.id, fileForm(INJURIES, 'neu.csv'));
    await ageRun(old.run.id, 8);
    await ageRun(fresh.run.id, 6);

    expect(await expireStalePreviews(node.deps)).toBe(1);

    const expired = await storedRun(old.run.id);
    expect(expired.status).toBe('discarded');
    expect(expired.staged).toBeNull();
    expect((expired.preview as { rows: unknown[] }).rows).toEqual([]);
    expect(expired.errors.every((e) => e.raw_value === null)).toBe(true);
    expect(expired.text).not.toContain('Bleibt');
    const [audit] = await auditEntries(node, 'import.expire');
    expect(audit).toMatchObject({ object_id: old.run.id, actor_type: 'system', outcome: 'success' });

    const kept = await storedRun(fresh.run.id);
    expect(kept.status).toBe('previewed');
    expect(kept.text).toContain('Bleibt');
    // ein abgelaufener Lauf kann nicht mehr übernommen werden
    const commit = await node.request<{ error: { reason: string } }>(
      'POST',
      `/api/v1/import-runs/${old.run.id}/commit`,
      { as: steward },
    );
    expect(commit.status).toBe(409);
    expect(commit.json.error.reason).toBe('run_not_previewed');
    expect(await expireStalePreviews(node.deps)).toBe(0);
    await node.request('POST', `/api/v1/import-runs/${fresh.run.id}/discard`, { as: steward });
  });

  test('Hintergrundaufgabe läuft beim Start des Moduls', async () => {
    const old = await startImport(node, steward, injuries.id, fileForm(INJURIES, 'alt.csv'));
    await ageRun(old.run.id, 30);
    try {
      await connectorsModule.start!(node.deps);
      expect((await storedRun(old.run.id)).status).toBe('discarded');
    } finally {
      await connectorsModule.stop!();
    }
  });
});
