import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Dataset, DatasetInput } from '../../src/shared/contract/datasets.ts';
import { auditEntries } from '../helpers/integration.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';

let node: TestNode;
let steward: TestUser;
let analyst: TestUser;

beforeAll(async () => {
  node = await createTestNode();
  steward = await node.user(['data_steward']);
  analyst = await node.user(['analyst']);
});
afterAll(async () => {
  await node?.close();
});

type ErrorJson = { error: { code: string; reason?: string; fields?: Record<string, string> } };

const input = (over: Partial<DatasetInput> = {}): Record<string, unknown> => ({
  slug: 'kraftdiagnostik',
  name: 'Kraftdiagnostik',
  category: 'performance',
  fields: [
    { name: 'test_date', label: 'Testdatum', type: 'date', required: true },
    {
      name: 'exercise',
      label: 'Übung',
      type: 'enum',
      required: true,
      enumValues: ['Kniebeuge', 'Bankdrücken'],
    },
    { name: 'one_rm', label: '1RM', type: 'number', unit: 'kg', min: 10, max: 400 },
  ],
  keyFields: ['test_date', 'exercise'],
  observedAtField: 'test_date',
  ...over,
});

async function create(body: Record<string, unknown>): Promise<Dataset> {
  const r = await node.request<Dataset>('POST', '/api/v1/datasets', { as: steward, body });
  if (r.status !== 200) throw new Error(`create failed: ${r.status} ${r.text}`);
  return r.json;
}

async function patch(id: string, body: Record<string, unknown>) {
  return node.request<Dataset & ErrorJson>('PATCH', `/api/v1/datasets/${id}`, { as: steward, body });
}

describe('Datensätze', () => {
  let ds: Dataset;

  test('nur Datenverantwortliche', async () => {
    expect((await node.request('GET', '/api/v1/datasets', { as: analyst })).status).toBe(403);
    expect((await node.request('POST', '/api/v1/datasets', { as: analyst, body: input() })).status).toBe(403);
  });

  test('anlegen', async () => {
    ds = await create(input());
    expect(ds).toMatchObject({
      slug: 'kraftdiagnostik',
      version: 1,
      recordCount: 0,
      specialCategory: false,
      shareability: 'on_request',
      keyFields: ['test_date', 'exercise'],
    });
    expect(ds.fields[2]).toMatchObject({ name: 'one_rm', required: false, unit: 'kg' });
    const [audit] = await auditEntries(node, 'dataset.create');
    expect(audit).toMatchObject({ object_id: ds.id, actor_id: steward.id });
    const dup = await node.request<ErrorJson>('POST', '/api/v1/datasets', { as: steward, body: input() });
    expect(dup.status).toBe(409);
    expect(dup.json.error.reason).toBe('slug_exists');
  });

  test('Prüfung der Felddefinitionen', async () => {
    const r = await node.request<ErrorJson>('POST', '/api/v1/datasets', {
      as: steward,
      body: input({
        slug: 'fehlerhaft',
        fields: [
          { name: 'a', label: 'A', type: 'string', required: false },
          { name: 'a', label: 'A2', type: 'string', required: false },
          { name: 'e', label: 'E', type: 'enum', required: false },
          { name: 'n', label: 'N', type: 'number', required: false, min: 10, max: 5 },
        ],
        keyFields: ['a', 'x'],
        observedAtField: 'n',
      }),
    });
    expect(r.status).toBe(400);
    expect(r.json.error.fields).toEqual({
      'body.fields.1.name': 'duplicate',
      'body.fields.2.enumValues': 'required',
      'body.fields.3.min': 'greater_than_max',
      'body.keyFields.1': 'unknown_field',
      'body.observedAtField': 'invalid_type',
    });
    const unknownObserved = await node.request<ErrorJson>('POST', '/api/v1/datasets', {
      as: steward,
      body: input({ slug: 'fehlerhaft2', observedAtField: 'gibt_es_nicht' }),
    });
    expect(unknownObserved.json.error.fields).toEqual({ 'body.observedAtField': 'unknown_field' });
  });

  test('Gesundheitsdaten sind immer besondere Kategorie', async () => {
    const health = await create(
      input({ slug: 'befunde', name: 'Befunde', category: 'health', specialCategory: false }),
    );
    expect(health.specialCategory).toBe(true);
    const r = await patch(ds.id, { category: 'health' });
    expect(r.json).toMatchObject({ category: 'health', specialCategory: true });
    await patch(ds.id, { category: 'performance', specialCategory: false });
  });

  test('ändern ohne Einträge: Version nur bei Strukturänderung, PATCH setzt nichts zurück', async () => {
    const renamed = await patch(ds.id, { name: 'Kraftdiagnostik (Maximalkraft)' });
    expect(renamed.json).toMatchObject({
      version: 1,
      keyFields: ['test_date', 'exercise'],
      observedAtField: 'test_date',
    });
    const removed = await patch(ds.id, {
      fields: ds.fields.filter((f) => f.name !== 'one_rm'),
    });
    expect(removed.status).toBe(200);
    expect(removed.json.version).toBe(2);
    const restored = await patch(ds.id, { fields: ds.fields });
    expect(restored.json.version).toBe(3);
    const [audit] = await auditEntries(node, 'dataset.update');
    expect(audit!.details).toEqual({ changed: ['fields'], version: 3 });
    ds = restored.json;
  });

  test('mit Einträgen: nur ergänzen oder umbenennen', async () => {
    const athlete = await node.deps.db
      .insertInto('athlete')
      .values({
        last_name: 'Kraft',
        first_name: 'Karl',
        date_of_birth: '2000-01-01',
        sport: 'Ringen',
        squad_status: 'LK',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await node.deps.db
      .insertInto('dataset_record')
      .values({
        dataset_id: ds.id,
        athlete_id: athlete.id,
        record_key: 'k:["2026-02-01","Kniebeuge"]',
        observed_at: new Date('2026-02-01T00:00:00Z'),
        data: JSON.stringify({ test_date: '2026-02-01', exercise: 'Kniebeuge', one_rm: 140 }),
      })
      .execute();

    const relabel = await patch(ds.id, {
      fields: ds.fields.map((f) =>
        f.name === 'one_rm' ? { ...f, label: 'Einer-Wiederholungs-Maximum', max: 450 } : f,
      ),
    });
    expect(relabel.status).toBe(200);
    expect(relabel.json.version).toBe(4);
    const added = await patch(ds.id, {
      fields: [
        ...relabel.json.fields,
        { name: 'bodyweight', label: 'Körpergewicht', type: 'number', unit: 'kg' },
      ],
    });
    expect(added.json).toMatchObject({ version: 5, recordCount: 1 });
    const moreEnum = await patch(ds.id, {
      fields: added.json.fields.map((f) =>
        f.name === 'exercise' ? { ...f, enumValues: [...(f.enumValues ?? []), 'Kreuzheben'] } : f,
      ),
    });
    expect(moreEnum.status).toBe(200);
    const current = moreEnum.json.fields;

    const conflicts: Record<string, unknown>[] = [
      { fields: current.filter((f) => f.name !== 'bodyweight') },
      { fields: current.map((f) => (f.name === 'one_rm' ? { ...f, type: 'integer' } : f)) },
      { fields: current.map((f) => (f.name === 'one_rm' ? { ...f, unit: 'lb' } : f)) },
      { fields: current.map((f) => (f.name === 'exercise' ? { ...f, enumValues: ['Kniebeuge'] } : f)) },
      { keyFields: ['test_date'] },
      { observedAtField: null },
    ];
    for (const body of conflicts) {
      const r = await patch(ds.id, body);
      expect(r.status).toBe(409);
      expect(r.json.error).toMatchObject({ code: 'conflict', reason: 'dataset_in_use' });
    }
  });

  test('Liste und Detail mit Anzahl der Einträge', async () => {
    const list = await node.request<{ items: Dataset[] }>('GET', '/api/v1/datasets', { as: steward });
    expect(list.json.items.map((d) => [d.slug, d.recordCount])).toEqual([
      ['befunde', 0],
      ['kraftdiagnostik', 1],
    ]);
    expect(
      (await node.request('GET', `/api/v1/datasets/${crypto.randomUUID()}`, { as: steward })).status,
    ).toBe(404);
  });

  test('Einträge: Person, Werte, Beobachtungsdatum; Lesezugriff protokolliert', async () => {
    const r = await node.request<{
      items: {
        athleteName: string;
        observedAt: string;
        data: Record<string, unknown>;
        importRunId: string | null;
      }[];
      total: number;
      page: number;
      pageSize: number;
    }>('GET', `/api/v1/datasets/${ds.id}/records?pageSize=10`, { as: steward });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(r.json.items[0]).toMatchObject({
      athleteName: 'Kraft, Karl',
      observedAt: '2026-02-01T00:00:00.000Z',
      data: { test_date: '2026-02-01', exercise: 'Kniebeuge', one_rm: 140 },
      importRunId: null,
    });
    const [audit] = await auditEntries(node, 'dataset.read');
    expect(audit).toMatchObject({ object_id: ds.id, actor_id: steward.id });
    expect(audit!.details).toEqual({ count: 1, total: 1, page: 1 });
    expect((await node.request('GET', `/api/v1/datasets/${ds.id}/records`, { as: analyst })).status).toBe(
      403,
    );
  });

  test('Einträge einer Person (Personenansicht): nur diese Person, Filter im Audit-Log', async () => {
    const other = await node.deps.db
      .insertInto('athlete')
      .values({
        last_name: 'Andere',
        first_name: 'Anna',
        date_of_birth: '2001-03-03',
        sport: 'Ringen',
        squad_status: 'NK1',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await node.deps.db
      .insertInto('dataset_record')
      .values({
        dataset_id: ds.id,
        athlete_id: other.id,
        record_key: 'k:["2026-03-01","Kniebeuge"]',
        observed_at: new Date('2026-03-01T00:00:00Z'),
        data: JSON.stringify({ test_date: '2026-03-01', exercise: 'Kniebeuge', one_rm: 95 }),
      })
      .execute();
    type Page = { items: { athleteId: string; athleteName: string }[]; total: number };

    const all = await node.request<Page>('GET', `/api/v1/datasets/${ds.id}/records`, { as: steward });
    expect(all.json.total).toBe(2);

    const one = await node.request<Page>('GET', `/api/v1/datasets/${ds.id}/records?athleteId=${other.id}`, {
      as: steward,
    });
    expect(one.status).toBe(200);
    expect(one.json.total).toBe(1);
    expect(one.json.items.map((r) => [r.athleteId, r.athleteName])).toEqual([[other.id, 'Andere, Anna']]);
    const [audit] = await auditEntries(node, 'dataset.read');
    expect(audit!.details).toEqual({ count: 1, total: 1, page: 1, athleteId: other.id });

    const none = await node.request<Page>(
      'GET',
      `/api/v1/datasets/${ds.id}/records?athleteId=${crypto.randomUUID()}`,
      { as: steward },
    );
    expect(none.json).toMatchObject({ total: 0, items: [] });
    expect(
      (await node.request('GET', `/api/v1/datasets/${ds.id}/records?athleteId=kein-uuid`, { as: steward }))
        .status,
    ).toBe(400);
    expect(
      (await node.request('GET', `/api/v1/datasets/${ds.id}/records?athleteId=${other.id}`, { as: analyst }))
        .status,
    ).toBe(403);
  });
});
