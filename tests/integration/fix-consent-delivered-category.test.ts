/**
 * Regression: Ein Einwilligungswiderruf wurde gegen die HEUTIGE Kategorie des Datensatzes geprüft. Nach einer
 * Neueinstufung eines nicht besonderen Datensatzes (performance → training; Partnerfreigaben bleiben
 * bestehen) erreichte der Widerruf der Einwilligung, unter der geliefert wurde (training_steering /
 * performance), den Partner nicht mehr: keine Mitteilung subjects_withdrawn, der Partner behielt die Daten.
 *
 * Jetzt protokolliert jede gelieferte Abgabe an Partner Datenkategorie und Einwilligungsbezug
 * (exchange_log.data_category, consent_applied; Migration 0500), und der Widerruf wird gegen das
 * Gelieferte geprüft. Außerdem: Pseudonyme sind 32 Hex-Zeichen; Lieferungen mit Pseudonymen der früheren
 * Form (base64url) werden bei Löschungen weiterhin gefunden.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { MIGRATIONS_DIR, migrate } from '../../src/server/core/migrate.ts';
import { createTestDb } from '../helpers/db.ts';
import { adminOf, onboard } from '../helpers/federation.ts';
import { TestMesh, type TestNode, type TestUser } from '../helpers/node.ts';
import { type StandardSeed, seedStandard } from '../helpers/seed.ts';

const mesh = new TestMesh();
let a: TestNode;
let b: TestNode;
let peerB: string;
let peerA: string;
let seed: StandardSeed;
let stewardA: TestUser;
let stewardB: TestUser;

beforeAll(async () => {
  a = await mesh.add({ nodeId: 'osp-a', displayName: 'OSP A' });
  b = await mesh.add({ nodeId: 'osp-b', displayName: 'OSP B' });
  const { bOnA, aOnB } = await onboard(a, b);
  peerB = bOnA.id;
  peerA = aOnB.id;
  seed = await seedStandard(a.deps.db);
  stewardA = await a.user(['data_steward']);
  stewardB = await b.user(['data_steward']);
});
afterAll(async () => {
  await mesh.close();
});

async function peerRelease(slug: string, purpose: string): Promise<string> {
  const p = await a.request<{ id: string }>('POST', '/api/v1/products', {
    as: stewardA,
    body: {
      slug,
      name: slug,
      sourceType: 'dataset',
      datasetId: seed.performance,
      columns: [
        { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
        { key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' },
      ],
    },
  });
  expect(p.status).toBe(200);
  const r = await a.request<{ id: string }>('POST', '/api/v1/releases', {
    as: stewardA,
    body: {
      productId: p.json.id,
      recipient: { type: 'peer', peerId: peerB },
      purposes: [purpose],
      columns: ['last_name', 'cmj'],
      requiresConsent: true,
    },
  });
  expect(r.status).toBe(200);
  return r.json.id;
}

async function pull(releaseId: string, purpose: string): Promise<string> {
  const pulled = await b.request<{ id: string }>('POST', '/api/v1/received/pull', {
    as: stewardB,
    body: { peerId: peerA, releaseId, purpose },
  });
  expect(pulled.status).toBe(200);
  return pulled.json.id;
}

async function namesAtB(receivedId: string): Promise<string[]> {
  const rows = await b.request<{ rows: Record<string, unknown>[] }>(
    'GET',
    `/api/v1/received/${receivedId}/rows?format=json&page=1&pageSize=100`,
    { as: stewardB },
  );
  expect(rows.status).toBe(200);
  return rows.json.rows.map((x) => String(x.last_name)).sort();
}

async function pendingNotices() {
  return (
    await a.deps.db.selectFrom('outbox_message').selectAll().where('status', '=', 'pending').execute()
  ).map((m) => m.body as { kind: string; releaseId: string; subjects?: string[]; reason?: string });
}

async function flush() {
  const r = await a.request<{ delivered: number; failed: number }>('POST', '/api/v1/outbox/flush', {
    as: await adminOf(a),
  });
  expect(r.status).toBe(200);
  return r.json;
}

async function withdraw(consentId: string) {
  const w = await a.request('POST', `/api/v1/consents/${consentId}/withdraw`, {
    as: stewardA,
    body: { note: '' },
  });
  expect(w.status).toBe(200);
}

describe('Einwilligungswiderruf gegen die Einstufung bei der Lieferung', () => {
  test('nach Neueinstufung performance → training: Widerruf der performance-Einwilligung erreicht den Partner', async () => {
    const releaseId = await peerRelease('leistung', 'training_steering');
    const received = await pull(releaseId, 'training_steering');
    expect(await namesAtB(received)).toEqual(['Adler', 'Adler', 'Berg', 'Berg']);

    // das Austauschprotokoll hält fest, unter welcher Einstufung geliefert wurde
    const logged = await a.deps.db
      .selectFrom('exchange_log')
      .select(['data_category', 'consent_applied', 'subjects'])
      .where('release_id', '=', releaseId)
      .where('outcome', '=', 'delivered')
      .executeTakeFirstOrThrow();
    expect(logged).toMatchObject({ data_category: 'performance', consent_applied: true });
    const benSubject = a.deps.identity.pseudonym(releaseId, seed.athletes.ben);
    expect(logged.subjects).toContain(benSubject);

    // Neueinstufung (nicht besonders): Partnerfreigaben bleiben, keine Mitteilung
    const patched = await a.request('PATCH', `/api/v1/datasets/${seed.performance}`, {
      as: stewardA,
      body: { category: 'training' },
    });
    expect(patched.status).toBe(200);
    expect(await pendingNotices()).toEqual([]);

    // Widerruf einer Einwilligung für die NEUE Kategorie erfasst die frühere Lieferung nicht
    const created = await a.request<{ id: string }>(
      'POST',
      `/api/v1/athletes/${seed.athletes.ben}/consents`,
      {
        as: stewardA,
        body: {
          purpose: 'training_steering',
          dataCategory: 'training',
          validFrom: '2020-01-01',
          evidenceNote: '',
        },
      },
    );
    expect(created.status).toBe(200);
    await withdraw(created.json.id);
    expect(await pendingNotices()).toEqual([]);

    // Widerruf der Einwilligung, unter der geliefert wurde
    const consent = await a.deps.db
      .selectFrom('consent_record')
      .select('id')
      .where('athlete_id', '=', seed.athletes.ben)
      .where('purpose', '=', 'training_steering')
      .where('data_category', '=', 'performance')
      .executeTakeFirstOrThrow();
    await withdraw(consent.id);
    expect(await pendingNotices()).toEqual([
      { kind: 'subjects_withdrawn', releaseId, subjects: [benSubject], reason: 'consent_withdrawn' },
    ]);
    expect(await flush()).toEqual({ delivered: 1, failed: 0 });
    expect(await namesAtB(received)).toEqual(['Adler', 'Adler']);
  });

  test('Löschung findet auch Lieferungen mit Pseudonymen der früheren Form (vor der Umstellung)', async () => {
    const releaseId = await peerRelease('leistung_alt', 'performance_diagnostics');
    const received = await pull(releaseId, 'performance_diagnostics');
    expect(await namesAtB(received)).toEqual(['Adler', 'Adler']);

    // Stand vor der Umstellung nachbilden: protokollierte und empfangene Pseudonyme in der früheren Form
    const toLegacy = new Map(
      Object.values(seed.athletes).map((id) => [
        a.deps.identity.pseudonym(releaseId, id),
        a.deps.identity.legacyPseudonym(releaseId, id),
      ]),
    );
    const log = await a.deps.db
      .selectFrom('exchange_log')
      .select(['id', 'subjects'])
      .where('release_id', '=', releaseId)
      .where('outcome', '=', 'delivered')
      .execute();
    for (const l of log) {
      await a.deps.db
        .updateTable('exchange_log')
        .set({ subjects: l.subjects.map((s) => toLegacy.get(s) ?? s) })
        .where('id', '=', l.id)
        .execute();
    }
    for (const [current, legacy] of toLegacy) {
      await b.deps.db
        .updateTable('received_row')
        .set({ subject: legacy })
        .where('subject', '=', current)
        .execute();
    }

    const del = await a.request('DELETE', `/api/v1/athletes/${seed.athletes.anna}`, { as: stewardA });
    expect(del.status).toBe(200);
    const notices = (await pendingNotices()).filter((n) => n.releaseId === releaseId);
    expect(notices).toEqual([
      {
        kind: 'subjects_withdrawn',
        releaseId,
        subjects: [a.deps.identity.legacyPseudonym(releaseId, seed.athletes.anna)],
        reason: 'erasure',
      },
    ]);
    await flush();
    expect(await namesAtB(received)).toEqual([]);
  });
});

describe('Migration 0500', () => {
  test('trägt Kategorie und Einwilligungsbezug bestehender Lieferungen aus dem heutigen Stand nach', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osp-migrations-'));
    try {
      for (const f of ['0001_core.sql', '0300_bi_view_names.sql', 'grants.sql'])
        copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
      const t = await createTestDb('m', { migrationsDir: dir });
      try {
        const db = t.db;
        const s = await seedStandard(db);
        const peer = await db
          .insertInto('peer')
          .values({
            node_id: 'osp-x',
            display_name: 'X',
            base_url: 'https://x.example',
            public_key: 'k',
            fingerprint: 'f',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const product = async (slug: string, sourceType: 'athletes' | 'dataset', datasetId: string | null) =>
          (
            await db
              .insertInto('data_product')
              .values({ slug, name: slug, source_type: sourceType, dataset_id: datasetId, columns: '[]' })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        const release = async (productId: string, requiresConsent: boolean) =>
          (
            await db
              .insertInto('data_release')
              .values({
                product_id: productId,
                product_version: 1,
                recipient_type: 'peer',
                recipient_peer_id: peer.id,
                purposes: ['training_steering'],
                columns: ['x'],
                requires_consent: requiresConsent,
              })
              .returning('id')
              .executeTakeFirstOrThrow()
          ).id;
        const rPerf = await release(await product('p_perf', 'dataset', s.performance), true);
        const rHealth = await release(await product('p_health', 'dataset', s.health), false);
        const rMaster = await release(await product('p_master', 'athletes', null), false);
        for (const [releaseId, outcome] of [
          [rPerf, 'delivered'],
          [rHealth, 'delivered'],
          [rMaster, 'delivered'],
          [rPerf, 'denied'],
        ] as const) {
          await sql`insert into exchange_log (direction, peer_id, peer_node_id, release_id, purpose, outcome, subjects)
            values ('outgoing', ${peer.id}, 'osp-x', ${releaseId}, 'training_steering', ${outcome},
              ${outcome === 'delivered' ? ['s1'] : []}::text[])`.execute(db);
        }

        const applied = await migrate(t.urls.owner);
        expect(applied.applied).toEqual(['0500_exchange_delivery_basis']);
        const rows = await sql<{
          release_id: string;
          outcome: string;
          data_category: string | null;
          consent_applied: boolean | null;
        }>`select release_id::text, outcome, data_category, consent_applied from exchange_log`.execute(db);
        const byKey = new Map(rows.rows.map((r) => [`${r.release_id}:${r.outcome}`, r]));
        expect(byKey.get(`${rPerf}:delivered`)).toMatchObject({
          data_category: 'performance',
          consent_applied: true,
        });
        expect(byKey.get(`${rHealth}:delivered`)).toMatchObject({
          data_category: 'health',
          consent_applied: true,
        });
        expect(byKey.get(`${rMaster}:delivered`)).toMatchObject({
          data_category: 'master',
          consent_applied: false,
        });
        expect(byKey.get(`${rPerf}:denied`)).toMatchObject({ data_category: null, consent_applied: null });
      } finally {
        await t.drop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
