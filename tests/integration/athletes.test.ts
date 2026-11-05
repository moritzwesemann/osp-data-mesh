import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Athlete, Consent } from '../../src/shared/contract/athletes.ts';
import { auditEntries } from '../helpers/integration.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';

let node: TestNode;
let steward: TestUser;
let analyst: TestUser;
let admin: TestUser;

beforeAll(async () => {
  node = await createTestNode();
  steward = await node.user(['data_steward']);
  analyst = await node.user(['analyst']);
  admin = await node.user(['admin']);
});
afterAll(async () => {
  await node?.close();
});

type ErrorJson = { error: { code: string; reason?: string; fields?: Record<string, string> } };
type AthleteDetail = Athlete & {
  identifiers: { system: string; value: string }[];
  consents: Consent[];
  recordCounts: { datasetId: string; datasetName: string; count: number }[];
};

const anna = {
  lastName: 'Musterfrau',
  firstName: 'Anna',
  dateOfBirth: '2001-04-24',
  sport: 'Rudern',
  squadStatus: 'PK',
  sex: 'f',
  club: 'Ruderclub Seewinkel',
  discipline: 'Einer',
};

async function create(body: Record<string, unknown>): Promise<Athlete> {
  const r = await node.request<Athlete>('POST', '/api/v1/athletes', { as: steward, body });
  if (r.status !== 200) throw new Error(`create failed: ${r.status} ${r.text}`);
  return r.json;
}

describe('Rollen', () => {
  test('Analyse und Administration haben keinen Zugriff auf den Athletenkern', async () => {
    for (const as of [analyst, admin]) {
      expect((await node.request('GET', '/api/v1/athletes', { as })).status).toBe(403);
      expect((await node.request('GET', '/api/v1/athletes/sports', { as })).status).toBe(403);
      expect((await node.request('POST', '/api/v1/athletes', { as, body: anna })).status).toBe(403);
      expect((await node.request('GET', `/api/v1/athletes/${crypto.randomUUID()}`, { as })).status).toBe(403);
    }
    const [denied] = await auditEntries(node, 'access.forbidden');
    expect(denied).toMatchObject({ outcome: 'denied', object_id: 'athletes.get', actor_id: admin.id });
    expect((await node.request('GET', '/api/v1/athletes')).status).toBe(401);
  });

  test('Zweck-Vokabular ist für alle Angemeldeten lesbar', async () => {
    const r = await node.request<{ items: { code: string; labelDe: string; active: boolean }[] }>(
      'GET',
      '/api/v1/purposes',
      { as: analyst },
    );
    expect(r.status).toBe(200);
    expect(r.json.items.map((p) => p.code)).toContain('performance_diagnostics');
    expect(r.json.items.find((p) => p.code === 'medical_care')).toMatchObject({
      labelDe: 'Medizinische Betreuung',
      active: true,
    });
  });
});

describe('Stammdaten', () => {
  let a: Athlete;

  test('anlegen', async () => {
    a = await create(anna);
    expect(a).toMatchObject(anna);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    const [audit] = await auditEntries(node, 'athlete.create');
    expect(audit).toMatchObject({ object_id: a.id, actor_id: steward.id });
    expect(JSON.stringify(audit!.details)).not.toContain('Musterfrau');
  });

  test('natürlicher Schlüssel ist eindeutig (409)', async () => {
    const r = await node.request<ErrorJson>('POST', '/api/v1/athletes', { as: steward, body: anna });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'conflict', reason: 'athlete_exists' });
  });

  test('Eingabeprüfung', async () => {
    const r = await node.request<ErrorJson>('POST', '/api/v1/athletes', {
      as: steward,
      body: { ...anna, dateOfBirth: '24.04.2001', squadStatus: 'XX', lastName: ' ' },
    });
    expect(r.status).toBe(400);
    expect(Object.keys(r.json.error.fields!).sort()).toEqual([
      'body.dateOfBirth',
      'body.lastName',
      'body.squadStatus',
    ]);
  });

  test('suchen, filtern, blättern (Zugriff protokolliert)', async () => {
    await create({
      lastName: 'Beispiel',
      firstName: 'Ben',
      dateOfBirth: '2003-02-02',
      sport: 'Judo',
      squadStatus: 'NK1',
    });
    await create({
      lastName: 'Muster',
      firstName: 'Max',
      dateOfBirth: '1999-09-09',
      sport: 'Rudern',
      squadStatus: 'OK',
    });
    await create({
      lastName: 'Zander',
      firstName: 'Zoë',
      dateOfBirth: '2005-05-05',
      sport: 'Fechten',
      squadStatus: 'none',
    });

    const all = await node.request<{ items: Athlete[]; total: number; page: number; pageSize: number }>(
      'GET',
      '/api/v1/athletes',
      { as: steward },
    );
    expect(all.json.total).toBe(4);
    expect(all.json.items.map((x) => x.lastName)).toEqual(['Beispiel', 'Muster', 'Musterfrau', 'Zander']);

    const q = await node.request<{ items: Athlete[]; total: number }>('GET', '/api/v1/athletes?q=muster', {
      as: steward,
    });
    expect(q.json.items.map((x) => x.firstName)).toEqual(['Max', 'Anna']);
    const two = await node.request<{ total: number }>(
      'GET',
      `/api/v1/athletes?q=${encodeURIComponent('muster an')}`,
      {
        as: steward,
      },
    );
    expect(two.json.total).toBe(1);
    const wildcard = await node.request<{ total: number }>('GET', '/api/v1/athletes?q=%25', { as: steward });
    expect(wildcard.json.total).toBe(0);

    const rudern = await node.request<{ total: number }>(
      'GET',
      '/api/v1/athletes?sport=Rudern&squadStatus=OK',
      {
        as: steward,
      },
    );
    expect(rudern.json.total).toBe(1);

    const page2 = await node.request<{ items: Athlete[]; total: number; page: number }>(
      'GET',
      '/api/v1/athletes?page=2&pageSize=3',
      { as: steward },
    );
    expect(page2.json).toMatchObject({ total: 4, page: 2 });
    expect(page2.json.items.map((x) => x.lastName)).toEqual(['Zander']);

    const [audit] = await auditEntries(node, 'athlete.list');
    expect(audit!.details).toEqual({ count: 1, total: 4, page: 2, filtered: false });

    // gezielt nach IDs (Startseite „Zuletzt geöffnet“): übliche Sortierung, angezeigte Personen im Audit
    const ids = [all.json.items[3]!.id, all.json.items[0]!.id];
    const byIds = await node.request<{ items: Athlete[]; total: number }>(
      'GET',
      `/api/v1/athletes?ids=${ids.join(',')}`,
      { as: steward },
    );
    expect(byIds.json.items.map((x) => x.lastName)).toEqual(['Beispiel', 'Zander']);
    const [idsAudit] = await auditEntries(node, 'athlete.list');
    expect(idsAudit!.details).toEqual({
      count: 2,
      total: 2,
      page: 1,
      filtered: true,
      ids: byIds.json.items.map((x) => x.id),
    });
    // Audit nennt nur, was geliefert wurde: unbekannte IDs und Seitengröße zählen nicht mit
    const unknown = '00000000-0000-4000-8000-000000000000';
    const onePage = await node.request<{ items: Athlete[]; total: number }>(
      'GET',
      `/api/v1/athletes?ids=${[...ids, unknown].join(',')}&pageSize=1&sport=${encodeURIComponent(all.json.items[0]!.sport)}`,
      { as: steward },
    );
    expect(onePage.json.items.map((x) => x.lastName)).toEqual(['Beispiel']);
    const [pageAudit] = await auditEntries(node, 'athlete.list');
    expect(pageAudit!.details).toMatchObject({ count: 1, ids: [all.json.items[0]!.id] });
    const badIds = await node.request('GET', '/api/v1/athletes?ids=keine-uuid', { as: steward });
    expect(badIds.status).toBe(400);

    const sports = await node.request<{ items: string[] }>('GET', '/api/v1/athletes/sports', { as: steward });
    expect(sports.json.items).toEqual(['Fechten', 'Judo', 'Rudern']);
  });

  test('ändern (nur angegebene Felder), Konflikt, unbekannt', async () => {
    const r = await node.request<Athlete>('PATCH', `/api/v1/athletes/${a.id}`, {
      as: steward,
      body: { squadStatus: 'OK', club: null },
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ squadStatus: 'OK', club: null, sex: 'f', discipline: 'Einer' });
    expect((await auditEntries(node, 'athlete.update'))[0]!.details).toEqual({
      fields: ['squadStatus', 'club'],
    });

    const clash = await node.request<ErrorJson>('PATCH', `/api/v1/athletes/${a.id}`, {
      as: steward,
      body: { lastName: 'Muster', firstName: 'Max', dateOfBirth: '1999-09-09' },
    });
    expect(clash.status).toBe(409);
    expect(
      (
        await node.request('PATCH', `/api/v1/athletes/${crypto.randomUUID()}`, {
          as: steward,
          body: { sport: 'Judo' },
        })
      ).status,
    ).toBe(404);
  });
});

describe('Einwilligungen', () => {
  let a: Athlete;
  let consent: Consent;

  beforeAll(async () => {
    a = await create({
      lastName: 'Einwilligung',
      firstName: 'Eva',
      dateOfBirth: '2002-03-03',
      sport: 'Schwimmen',
      squadStatus: 'EK',
    });
  });

  test('dokumentieren', async () => {
    const r = await node.request<Consent>('POST', `/api/v1/athletes/${a.id}/consents`, {
      as: steward,
      body: {
        purpose: 'medical_care',
        dataCategory: 'health',
        validFrom: '2026-01-01',
        evidenceNote: 'Formular 2026/17',
      },
    });
    expect(r.status).toBe(200);
    consent = r.json;
    expect(consent).toMatchObject({
      athleteId: a.id,
      purpose: 'medical_care',
      dataCategory: 'health',
      status: 'granted',
      validUntil: null,
      withdrawnAt: null,
    });
    const all = await node.request<Consent>('POST', `/api/v1/athletes/${a.id}/consents`, {
      as: steward,
      body: { purpose: '*', validFrom: '2026-01-01', validUntil: '2026-12-31' },
    });
    expect(all.json).toMatchObject({ purpose: '*', dataCategory: '*', validUntil: '2026-12-31' });
    const [audit] = await auditEntries(node, 'consent.create');
    expect(audit).toMatchObject({ object_id: all.json.id });
    expect(audit!.details).toEqual({ athleteId: a.id, purpose: '*', dataCategory: '*' });
  });

  test('Prüfung: unbekannter oder inaktiver Zweck, Kategorie, Zeitraum, Person', async () => {
    const post = (body: Record<string, unknown>, id = a.id) =>
      node.request<ErrorJson>('POST', `/api/v1/athletes/${id}/consents`, { as: steward, body });
    expect((await post({ purpose: 'werbung', validFrom: '2026-01-01' })).json.error.fields).toEqual({
      'body.purpose': 'unknown_purpose',
    });
    await node.deps.db.updateTable('purpose').set({ active: false }).where('code', '=', 'research').execute();
    expect((await post({ purpose: 'research', validFrom: '2026-01-01' })).status).toBe(400);
    expect(
      (await post({ purpose: 'reporting', dataCategory: 'finanzen', validFrom: '2026-01-01' })).status,
    ).toBe(400);
    expect(
      (await post({ purpose: 'reporting', validFrom: '2026-06-01', validUntil: '2026-01-01' })).json.error
        .fields,
    ).toEqual({ 'body.validUntil': 'before_valid_from' });
    expect((await post({ purpose: 'reporting', validFrom: '2026-01-01' }, crypto.randomUUID())).status).toBe(
      404,
    );
  });

  test('Widerruf: Ereignis in der Transaktion, Audit, kein zweiter Widerruf', async () => {
    const seen: { payload: unknown; statusInTx: string | undefined }[] = [];
    node.deps.events.onTx('consent.withdrawn', async (payload, trx) => {
      const row = await trx
        .selectFrom('consent_record')
        .select('status')
        .where('id', '=', payload.consentId)
        .executeTakeFirst();
      seen.push({ payload, statusInTx: row?.status });
    });
    const r = await node.request<Consent>('POST', `/api/v1/consents/${consent.id}/withdraw`, {
      as: steward,
      body: { note: 'per E-Mail' },
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('withdrawn');
    expect(r.json.withdrawnAt).not.toBeNull();
    expect(r.json.evidenceNote).toBe('Formular 2026/17\nWiderruf: per E-Mail');
    expect(seen).toEqual([
      {
        payload: { athleteId: a.id, consentId: consent.id, purpose: 'medical_care', dataCategory: 'health' },
        statusInTx: 'withdrawn',
      },
    ]);
    const [audit] = await auditEntries(node, 'consent.withdraw');
    expect(audit).toMatchObject({ object_id: consent.id, actor_id: steward.id });
    const row = await node.deps.db
      .selectFrom('consent_record')
      .select('withdrawn_by')
      .where('id', '=', consent.id)
      .executeTakeFirstOrThrow();
    expect(row.withdrawn_by).toBe(steward.id);

    const again = await node.request<ErrorJson>('POST', `/api/v1/consents/${consent.id}/withdraw`, {
      as: steward,
      body: {},
    });
    expect(again.status).toBe(409);
    expect(again.json.error.reason).toBe('already_withdrawn');
    expect(
      (
        await node.request('POST', `/api/v1/consents/${crypto.randomUUID()}/withdraw`, {
          as: steward,
          body: {},
        })
      ).status,
    ).toBe(404);
  });

  test('scheitert die Folge des Widerrufs, bleibt die Einwilligung bestehen', async () => {
    const other = await node.request<Consent>('POST', `/api/v1/athletes/${a.id}/consents`, {
      as: steward,
      body: { purpose: 'training_steering', validFrom: '2026-01-01' },
    });
    let fail = true;
    node.deps.events.onTx('consent.withdrawn', async () => {
      if (fail) throw new Error('outbox unavailable');
    });
    const r = await node.request('POST', `/api/v1/consents/${other.json.id}/withdraw`, {
      as: steward,
      body: {},
    });
    expect(r.status).toBe(500);
    fail = false;
    const row = await node.deps.db
      .selectFrom('consent_record')
      .select('status')
      .where('id', '=', other.json.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('granted');
  });

  test('Detail: Kennungen, Einwilligungen, Datenbestand (Zugriff protokolliert)', async () => {
    const ds = await node.deps.db
      .insertInto('dataset')
      .values({
        slug: 'testdaten',
        name: 'Testdaten',
        category: 'performance',
        fields: JSON.stringify([{ name: 'v', label: 'V', type: 'number', required: false }]),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await node.deps.db
      .insertInto('dataset_record')
      .values([
        { dataset_id: ds.id, athlete_id: a.id, record_key: 'k:[1]', data: JSON.stringify({ v: 1 }) },
        { dataset_id: ds.id, athlete_id: a.id, record_key: 'k:[2]', data: JSON.stringify({ v: 2 }) },
      ])
      .execute();
    await node.deps.db
      .insertInto('athlete_identifier')
      .values({ athlete_id: a.id, system: 'osp-id', value: 'T-1' })
      .execute();
    const r = await node.request<AthleteDetail>('GET', `/api/v1/athletes/${a.id}`, { as: steward });
    expect(r.status).toBe(200);
    expect(r.json.identifiers).toEqual([{ system: 'osp-id', value: 'T-1' }]);
    expect(r.json.consents.length).toBe(3);
    expect(r.json.recordCounts).toEqual([{ datasetId: ds.id, datasetName: 'Testdaten', count: 2 }]);
    expect((await auditEntries(node, 'athlete.read'))[0]).toMatchObject({
      object_id: a.id,
      actor_id: steward.id,
    });
    expect(
      (await node.request('GET', `/api/v1/athletes/${crypto.randomUUID()}`, { as: steward })).status,
    ).toBe(404);
  });

  test('Löschung (Recht auf Löschung): Kaskade, Ereignis in der Transaktion, Audit', async () => {
    const seen: { athleteId: string; existsInTx: boolean }[] = [];
    node.deps.events.onTx('athlete.deleted', async (payload, trx) => {
      const row = await trx
        .selectFrom('athlete')
        .select('id')
        .where('id', '=', payload.athleteId)
        .executeTakeFirst();
      seen.push({ athleteId: payload.athleteId, existsInTx: !!row });
    });
    const after: unknown[] = [];
    node.deps.events.onAfter('data.changed', async (p) => {
      after.push(p);
    });
    const r = await node.request('DELETE', `/api/v1/athletes/${a.id}`, { as: steward });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(seen).toEqual([{ athleteId: a.id, existsInTx: true }]);
    expect(after).toContainEqual({ datasetId: null });
    for (const table of ['dataset_record', 'consent_record', 'athlete_identifier'] as const) {
      const rows = await node.deps.db
        .selectFrom(table)
        .select('athlete_id')
        .where('athlete_id', '=', a.id)
        .execute();
      expect(rows).toEqual([]);
    }
    const [audit] = await auditEntries(node, 'athlete.delete');
    expect(audit).toMatchObject({ object_id: a.id, actor_id: steward.id });
    expect(audit!.details).toEqual({ records: 2, consents: 3, identifiers: 1 });
    expect((await node.request('GET', `/api/v1/athletes/${a.id}`, { as: steward })).status).toBe(404);
    expect((await node.request('DELETE', `/api/v1/athletes/${a.id}`, { as: steward })).status).toBe(404);
  });
});
