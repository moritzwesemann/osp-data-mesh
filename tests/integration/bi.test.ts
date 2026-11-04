import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { lockDeliveries } from '../../src/server/core/locks.ts';
import type { Product } from '../../src/shared/contract/products.ts';
import type { Release } from '../../src/shared/contract/releases.ts';
import { queryAs } from '../helpers/db.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';
import { type StandardSeed, seedRelease, seedStandard } from '../helpers/seed.ts';

let node: TestNode;
let seed: StandardSeed;
let steward: TestUser;
let admin: TestUser;
let perf: Product;
let health: Product;
let biUrl: string;

async function product(body: Record<string, unknown>): Promise<Product> {
  const res = await node.request<Product>('POST', '/api/v1/products', { as: steward, body });
  if (res.status !== 200) throw new Error(`product create failed: ${res.text}`);
  return res.json;
}

async function biRelease(body: Record<string, unknown>): Promise<Release> {
  const res = await node.request<Release>('POST', '/api/v1/releases', {
    as: steward,
    body: {
      recipient: { type: 'role', role: 'bi' },
      purposes: ['reporting'],
      requiresConsent: false,
      ...body,
    },
  });
  if (res.status !== 200) throw new Error(`release create failed: ${res.text}`);
  return res.json;
}

async function refresh() {
  const res = await node.request<{ refreshed: number; errors: number }>('POST', '/api/v1/bi/refresh', {
    as: steward,
  });
  expect(res.status).toBe(200);
  return res.json;
}

async function biRows(view: string) {
  return (await queryAs(biUrl, `select * from bi.${view}`)).rows;
}

async function viewRow(releaseId: string) {
  return node.deps.db
    .selectFrom('bi_view')
    .selectAll()
    .where('release_id', '=', releaseId)
    .executeTakeFirst();
}

beforeAll(async () => {
  node = await createTestNode();
  biUrl = node.testDb.urls.bi;
  seed = await seedStandard(node.deps.db);
  steward = await node.user(['data_steward']);
  admin = await node.user(['admin']);
  perf = await product({
    slug: 'leistung',
    name: 'Leistung',
    sourceType: 'dataset',
    datasetId: seed.performance,
    columns: [
      { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
      { key: 'first_name', label: 'Vorname', source: 'athlete.first_name' },
      { key: 'sport', label: 'Sportart', source: 'athlete.sport' },
      { key: 'test_date', label: 'Testdatum', source: 'record.observed_at' },
      { key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' },
      { key: 'reps', label: 'Wiederholungen', source: 'data.reps' },
      { key: 'valid', label: 'Gültig', source: 'data.valid' },
      { key: 'protocol', label: 'Protokoll', source: 'data.protocol' },
    ],
  });
  health = await product({
    slug: 'gesundheit',
    name: 'Gesundheit',
    sourceType: 'dataset',
    datasetId: seed.health,
    columns: [
      { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
      { key: 'hr', label: 'Ruhepuls', source: 'data.resting_hr' },
    ],
  });
});

afterAll(async () => {
  await node?.close();
});

describe('BI: Materialisierung', () => {
  let release: Release;

  test('nach Freigabe und Aktualisierung: genau die freigegebenen Spalten und Zeilen mit SQL-Typen', async () => {
    release = await biRelease({
      productId: perf.id,
      columns: ['last_name', 'test_date', 'cmj', 'reps', 'valid', 'protocol'],
      rowFilter: [{ column: 'sport', op: 'eq', value: 'Rudern' }],
    });
    expect(await refresh()).toEqual({ refreshed: 1, errors: 0 });

    const rows = await biRows('leistung');
    expect(rows).toHaveLength(6);
    expect(Object.keys(rows[0]!)).toEqual(['last_name', 'test_date', 'cmj', 'reps', 'valid', 'protocol']);
    expect(new Set(rows.map((r) => r.last_name))).toEqual(new Set(['Adler', 'Berg', 'Eck']));
    const anna = rows.find((r) => r.last_name === 'Adler' && r.test_date === '2026-01-15');
    expect(anna).toEqual({
      last_name: 'Adler',
      test_date: '2026-01-15',
      cmj: 41.5,
      reps: 10,
      valid: true,
      protocol: 'A',
    });

    const types = await queryAs<{ column_name: string; data_type: string }>(
      biUrl,
      "select column_name, data_type from information_schema.columns where table_schema = 'bi' and table_name = 'leistung' order by ordinal_position",
    );
    expect(types.rows).toEqual([
      { column_name: 'last_name', data_type: 'text' },
      { column_name: 'test_date', data_type: 'date' },
      { column_name: 'cmj', data_type: 'double precision' },
      { column_name: 'reps', data_type: 'bigint' },
      { column_name: 'valid', data_type: 'boolean' },
      { column_name: 'protocol', data_type: 'text' },
    ]);

    const v = await viewRow(release.id);
    expect(v).toMatchObject({ view_name: 'leistung', status: 'ok', row_count: 6, error_code: null });
    const entry = await node.deps.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'bi.refresh')
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow();
    expect(entry.actor_id).toBe(steward.id);
    expect(entry.details).toMatchObject({ refreshed: 1, errors: 0 });
  });

  test('Datum/Zeitstempel als timestamptz, Einwilligungspflicht wird angewandt', async () => {
    const r = await biRelease({
      productId: health.id,
      purposes: ['medical_care'],
      columns: ['last_name', 'hr'],
      requiresConsent: true,
    });
    expect(await refresh()).toEqual({ refreshed: 2, errors: 0 });
    const rows = await biRows('gesundheit');
    expect(rows.map((x) => x.last_name).sort()).toEqual(['Adler', 'Berg']);
    expect((await viewRow(r.id))?.row_count).toBe(2);
  });

  test('BI-Rolle: nur Views im Schema bi, keine Rohdaten, keine Kerntabellen, nur lesend', async () => {
    const table = (await viewRow(release.id))!.table_name;
    await expect(queryAs(biUrl, `select * from bi_data.${table}`)).rejects.toThrow(/permission denied/);
    await expect(queryAs(biUrl, 'select * from public.data_release')).rejects.toThrow(/permission denied/);
    await expect(queryAs(biUrl, 'select * from public.athlete')).rejects.toThrow(/permission denied/);
    await expect(queryAs(biUrl, 'select * from public.consent_record')).rejects.toThrow(/permission denied/);
    await expect(queryAs(biUrl, "insert into bi.leistung (last_name) values ('x')")).rejects.toThrow();
    await expect(queryAs(biUrl, 'create table bi.evil (x int)')).rejects.toThrow();
    // die verborgene Personenspalte ist nicht Teil der View
    await expect(queryAs(biUrl, 'select _subject from bi.leistung')).rejects.toThrow(/does not exist/);
  });

  test('Einwilligungswiderruf entfernt die Zeilen der Person sofort (in der auslösenden Transaktion)', async () => {
    expect((await biRows('gesundheit')).map((x) => x.last_name)).toContain('Berg');
    await node.deps.db.transaction().execute(async (trx) => {
      // wie der Auslöser (athletes): Liefersperre als Erstes (core/locks.ts)
      await lockDeliveries(trx, 'exclusive');
      const c = await trx
        .updateTable('consent_record')
        .set({ status: 'withdrawn', withdrawn_at: new Date() })
        .where('athlete_id', '=', seed.athletes.ben)
        .where('purpose', '=', 'medical_care')
        .returning(['id', 'purpose', 'data_category'])
        .executeTakeFirstOrThrow();
      await node.deps.events.inTx(trx, 'consent.withdrawn', {
        athleteId: seed.athletes.ben,
        consentId: c.id,
        purpose: c.purpose,
        dataCategory: c.data_category,
      });
    });
    expect((await biRows('gesundheit')).map((x) => x.last_name)).toEqual(['Adler']);
    // Freigaben ohne Einwilligungspflicht bleiben unberührt (bis zur nächsten Aktualisierung)
    expect((await biRows('leistung')).some((x) => x.last_name === 'Berg')).toBe(true);
    // Neuaufbau bestätigt den Stand
    await refresh();
    expect((await biRows('gesundheit')).map((x) => x.last_name)).toEqual(['Adler']);
  });

  test('Widerruf: View ist sofort entfernt (ohne Aktualisierung)', async () => {
    const res = await node.request('POST', `/api/v1/releases/${release.id}/revoke`, {
      as: steward,
      body: { reason: 'Ende' },
    });
    expect(res.status).toBe(200);
    await expect(biRows('leistung')).rejects.toThrow(/does not exist/);
    expect((await viewRow(release.id))?.status).toBe('dropped');
    const table = (await viewRow(release.id))!.table_name;
    const reg = await sql<{ t: string | null }>`select to_regclass(${`bi_data.${table}`})::text as t`.execute(
      node.deps.db,
    );
    expect(reg.rows[0]?.t).toBeNull();
  });

  test('neue BI-Freigabe desselben Produkts nutzt wieder den View-Namen', async () => {
    release = await biRelease({ productId: perf.id, columns: ['last_name', 'cmj'] });
    await refresh();
    const rows = await biRows('leistung');
    expect(rows).toHaveLength(10);
    expect(Object.keys(rows[0]!)).toEqual(['last_name', 'cmj']);
    const all = await node.deps.db
      .selectFrom('bi_view')
      .select(['release_id', 'status'])
      .where('view_name', '=', 'leistung')
      .execute();
    expect(all.filter((x) => x.status === 'ok').map((x) => x.release_id)).toEqual([release.id]);
    expect(all.filter((x) => x.status === 'dropped')).toHaveLength(1);
  });

  test('Ablauf: View liefert sofort keine Zeilen mehr; Aktualisierung entfernt sie', async () => {
    expect(await biRows('leistung')).toHaveLength(10);
    await node.deps.db
      .updateTable('data_release')
      .set({ valid_from: new Date(Date.now() - 3600_000), valid_until: new Date(Date.now() - 1000) })
      .where('id', '=', release.id)
      .execute();
    expect(await biRows('leistung')).toHaveLength(0);
    await refresh();
    await expect(biRows('leistung')).rejects.toThrow(/does not exist/);
    expect((await viewRow(release.id))?.status).toBe('dropped');
  });

  test('Produktänderung: View liefert sofort keine Zeilen mehr (Freigabe veraltet)', async () => {
    release = await biRelease({ productId: perf.id, columns: ['last_name'] });
    await refresh();
    expect(await biRows('leistung')).toHaveLength(10);
    const res = await node.request('PATCH', `/api/v1/products/${perf.id}`, {
      as: steward,
      body: { filters: [{ column: 'valid', op: 'eq', value: true }] },
    });
    expect(res.status).toBe(200);
    expect(await biRows('leistung')).toHaveLength(0);
    await refresh();
    expect((await viewRow(release.id))?.status).toBe('dropped');
  });

  test('Ablehnung durch den PEP: Status error mit Grund, keine View', async () => {
    const p = await product({
      slug: 'fehlerfall',
      name: 'Fehlerfall',
      sourceType: 'athletes',
      columns: [{ key: 'last_name', label: 'Nachname', source: 'athlete.last_name' }],
    });
    // Freigabe direkt gespeichert, deren Spalten es nicht gibt (wie nach einer Datensatzänderung)
    const id = await seedRelease(node.deps.db, {
      productId: p.id,
      recipient: { type: 'role', role: 'bi' },
      purposes: ['reporting'],
      columns: ['gone'],
    });
    const result = await refresh();
    expect(result.errors).toBe(1);
    expect(await viewRow(id)).toMatchObject({ status: 'error', error_code: 'no_columns', row_count: 0 });
    await expect(biRows('fehlerfall')).rejects.toThrow(/does not exist/);
    await node.request('POST', `/api/v1/releases/${id}/revoke`, { as: steward, body: { reason: 'x' } });
    expect(await refresh()).toEqual({ refreshed: 1, errors: 0 });
    expect((await viewRow(id))?.status).toBe('dropped');
  });

  test('Löschung einer Person entfernt deren Zeilen sofort', async () => {
    expect((await biRows('gesundheit')).map((x) => x.last_name)).toEqual(['Adler']);
    await node.deps.db.transaction().execute(async (trx) => {
      await lockDeliveries(trx, 'exclusive');
      await node.deps.events.inTx(trx, 'athlete.deleted', { athleteId: seed.athletes.anna });
    });
    expect(await biRows('gesundheit')).toHaveLength(0);
  });
});

describe('BI: Endpunkte', () => {
  test('bi.views mit Produktname, Status und Verbindungsdaten (ohne Passwort)', async () => {
    const res = await node.request<{
      items: { releaseId: string; productName: string; viewName: string; status: string; rowCount: number }[];
      connection: {
        schema: string;
        role: string;
        database: string | null;
        host: string | null;
        port: number | null;
      };
    }>('GET', '/api/v1/bi/views', { as: admin });
    expect(res.status).toBe(200);
    const ok = res.json.items.filter((i) => i.status === 'ok');
    expect(ok.map((i) => i.viewName)).toEqual(['gesundheit']);
    expect(ok[0]!.productName).toBe('Gesundheit');
    expect(res.json.items.some((i) => i.status === 'dropped' && i.viewName === 'leistung')).toBe(true);
    expect(res.json.connection).toEqual({
      schema: 'bi',
      role: 'mesh_bi',
      database: node.testDb.dbName,
      host: '127.0.0.1',
      port: new URL(node.testDb.urls.app).port ? Number(new URL(node.testDb.urls.app).port) : 5432,
    });
    expect(JSON.stringify(res.json)).not.toContain('password');
  });

  test('nur Administration und Datenverantwortliche', async () => {
    const analyst = await node.user(['analyst']);
    expect((await node.request('GET', '/api/v1/bi/views', { as: analyst })).status).toBe(403);
    expect((await node.request('POST', '/api/v1/bi/refresh', { as: analyst })).status).toBe(403);
  });

  test('requestRefresh ist ohne Hintergrundaufgaben wirkungslos', async () => {
    const before = await node.deps.db
      .selectFrom('audit_log')
      .select('seq')
      .orderBy('seq', 'desc')
      .executeTakeFirst();
    node.deps.services.bi.requestRefresh();
    await new Promise((r) => setTimeout(r, 700));
    const after = await node.deps.db
      .selectFrom('audit_log')
      .select('seq')
      .orderBy('seq', 'desc')
      .executeTakeFirst();
    expect(after?.seq).toBe(before?.seq);
  });
});
