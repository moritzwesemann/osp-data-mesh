/**
 * Regression: Eine Neueinstufung eines Datensatzes (z. B. Kategorie → health) löste kein Ereignis aus und
 * änderte keine Produktversion. Die BI-View lieferte weiter Zeilen, die ohne Einwilligung freigegeben waren
 * (bis zur nächsten Aktualisierung, ohne Hintergrundaufgaben dauerhaft), und Partner behielten ihre Kopien.
 *
 * Jetzt: 'dataset.changed' → jedes betroffene Produkt erhält in derselben Transaktion eine neue Version
 * (Freigaben veraltet, BI-View sofort leer, Audit), bei Hochstufung zu besonderer Kategorie oder auf
 * "intern" werden zusätzlich alle Partnerfreigaben widerrufen (dataset_reclassified) → Partner löschen.
 *
 * A = Datenhalter, B = Partner.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Dataset } from '../../src/shared/contract/datasets.ts';
import type { ReceivedProduct } from '../../src/shared/contract/federation.ts';
import type { Product } from '../../src/shared/contract/products.ts';
import type { Release } from '../../src/shared/contract/releases.ts';
import { queryAs } from '../helpers/db.ts';
import { adminOf, auditEntries, onboard } from '../helpers/federation.ts';
import { TestMesh, type TestNode, type TestUser } from '../helpers/node.ts';
import { type StandardSeed, seedStandard } from '../helpers/seed.ts';

type ErrorJson = { error: { code: string; reason?: string } };

const mesh = new TestMesh();
let a: TestNode;
let b: TestNode;
let peerB: string; // Partner B auf A
let peerA: string; // Partner A auf B
let seed: StandardSeed;
let stewardA: TestUser;
let stewardB: TestUser;
let coachA: TestUser;

async function createProduct(body: Record<string, unknown>): Promise<Product> {
  const r = await a.request<Product>('POST', '/api/v1/products', { as: stewardA, body });
  if (r.status !== 200) throw new Error(`product create failed: ${r.text}`);
  return r.json;
}

async function createRelease(body: Record<string, unknown>): Promise<Release> {
  const r = await a.request<Release>('POST', '/api/v1/releases', {
    as: stewardA,
    body: { requiresConsent: false, ...body },
  });
  if (r.status !== 200) throw new Error(`release create failed: ${r.text}`);
  return r.json;
}

async function createDataset(body: Record<string, unknown>): Promise<Dataset> {
  const r = await a.request<Dataset>('POST', '/api/v1/datasets', { as: stewardA, body });
  if (r.status !== 200) throw new Error(`dataset create failed: ${r.text}`);
  return r.json;
}

async function patchDataset(id: string, body: Record<string, unknown>) {
  const r = await a.request<Dataset & ErrorJson>('PATCH', `/api/v1/datasets/${id}`, { as: stewardA, body });
  expect(r.status).toBe(200);
  return r.json;
}

async function product(id: string): Promise<Product> {
  return (await a.request<Product>('GET', `/api/v1/products/${id}`, { as: stewardA })).json;
}

async function release(id: string): Promise<Release> {
  return (await a.request<Release>('GET', `/api/v1/releases/${id}`, { as: stewardA })).json;
}

async function biRows(view: string) {
  return (await queryAs(a.testDb.urls.bi, `select * from bi.${view}`)).rows;
}

async function pendingNotices() {
  const rows = await a.deps.db
    .selectFrom('outbox_message')
    .selectAll()
    .where('status', '=', 'pending')
    .orderBy('created_at')
    .execute();
  return rows.map((m) => ({
    peerId: m.peer_id,
    ...(m.body as { kind: string; releaseId: string; reason?: string }),
  }));
}

async function flushA() {
  const r = await a.request<{ delivered: number; failed: number }>('POST', '/api/v1/outbox/flush', {
    as: await adminOf(a),
  });
  expect(r.status).toBe(200);
  return r.json;
}

const PERF_COLUMNS = [
  { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
  { key: 'test_date', label: 'Testdatum', source: 'record.observed_at' },
  { key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' },
];

beforeAll(async () => {
  a = await mesh.add({ nodeId: 'osp-a', displayName: 'OSP A' });
  b = await mesh.add({ nodeId: 'osp-b', displayName: 'OSP B' });
  const { bOnA, aOnB } = await onboard(a, b);
  peerB = bOnA.id;
  peerA = aOnB.id;
  seed = await seedStandard(a.deps.db);
  stewardA = await a.user(['data_steward']);
  stewardB = await b.user(['data_steward']);
  coachA = await a.user(['coach']);
});
afterAll(async () => {
  await mesh.close();
});

describe('Neueinstufung zu besonderer Kategorie (category → health)', () => {
  let leistung: Product;
  let kader: Product;
  let biRelease: Release;
  let coachRelease: Release;
  let peerRelease: Release;
  let kaderPeerRelease: Release;

  beforeAll(async () => {
    leistung = await createProduct({
      slug: 'leistung',
      name: 'Leistung',
      sourceType: 'dataset',
      datasetId: seed.performance,
      columns: PERF_COLUMNS,
    });
    // nutzt kein Feld des Datensatzes, ist aber ebenso eingestuft
    kader = await createProduct({
      slug: 'kader',
      name: 'Kader',
      sourceType: 'dataset',
      datasetId: seed.performance,
      columns: [{ key: 'sport', label: 'Sportart', source: 'athlete.sport' }],
    });
    biRelease = await createRelease({
      productId: leistung.id,
      recipient: { type: 'role', role: 'bi' },
      purposes: ['reporting'],
      columns: ['last_name', 'cmj'],
    });
    coachRelease = await createRelease({
      productId: leistung.id,
      recipient: { type: 'role', role: 'coach' },
      purposes: ['training_steering'],
      columns: ['last_name', 'cmj'],
    });
    peerRelease = await createRelease({
      productId: leistung.id,
      recipient: { type: 'peer', peerId: peerB },
      purposes: ['training_steering'],
      columns: ['test_date', 'cmj'],
    });
    kaderPeerRelease = await createRelease({
      productId: kader.id,
      recipient: { type: 'peer', peerId: peerB },
      purposes: ['training_steering'],
      columns: ['sport'],
    });
    expect((await a.request('POST', '/api/v1/bi/refresh', { as: stewardA })).status).toBe(200);
    expect(await biRows('leistung')).toHaveLength(10);
    const pulled = await b.request<ReceivedProduct>('POST', '/api/v1/received/pull', {
      as: stewardB,
      body: { peerId: peerA, releaseId: peerRelease.id, purpose: 'training_steering' },
    });
    expect(pulled.status).toBe(200);
    expect(pulled.json.rowCount).toBe(10);
  });

  test('Name/Beschreibung ändern betrifft keine Produkte', async () => {
    await patchDataset(seed.performance, { name: 'Leistungsdiagnostik (neu)', description: 'x' });
    expect((await product(leistung.id)).version).toBe(1);
    expect((await release(coachRelease.id)).status).toBe('active');
    expect(await biRows('leistung')).toHaveLength(10);
    expect(await pendingNotices()).toEqual([]);
  });

  test('Kategorie health: neue Produktversion, BI-View sofort leer, Freigaben veraltet, protokolliert', async () => {
    const ds = await patchDataset(seed.performance, { category: 'health' });
    expect(ds).toMatchObject({ category: 'health', specialCategory: true });

    expect((await product(leistung.id)).version).toBe(2);
    expect((await product(kader.id)).version).toBe(2);

    // ohne Aktualisierung: die SQL-Prüfung der View vergleicht die Produktversion
    expect(await biRows('leistung')).toHaveLength(0);

    const denied = await a.request<ErrorJson>(
      'GET',
      `/api/v1/access/${coachRelease.id}/data?purpose=training_steering`,
      { as: coachA },
    );
    expect(denied.status).toBe(403);
    expect(denied.json.error).toMatchObject({ code: 'access_denied', reason: 'product_changed' });
    expect((await release(coachRelease.id)).status).toBe('outdated');
    expect((await release(biRelease.id)).status).toBe('outdated');

    const updates = (await auditEntries(a, 'product.update')).filter(
      (e) => (e.details as { cause?: string }).cause === 'dataset_changed',
    );
    expect(updates.map((e) => e.object_id).sort()).toEqual([leistung.id, kader.id].sort());
    expect(updates[0]!.details).toMatchObject({
      datasetId: seed.performance,
      classificationChanged: true,
      versionChanged: true,
      peerReleasesRevoked: true,
    });
  });

  test('Partnerfreigaben widerrufen (dataset_reclassified); Partner löscht seine Kopie', async () => {
    for (const r of [peerRelease, kaderPeerRelease]) {
      expect(await release(r.id)).toMatchObject({
        status: 'revoked',
        revocationReason: 'dataset_reclassified',
      });
    }
    const revokes = (await auditEntries(a, 'release.revoke')).filter(
      (e) => (e.details as { cause?: string }).cause === 'dataset_reclassified',
    );
    expect(revokes.map((e) => e.object_id).sort()).toEqual([peerRelease.id, kaderPeerRelease.id].sort());

    const notices = await pendingNotices();
    expect(notices).toHaveLength(2);
    expect(notices).toEqual(
      expect.arrayContaining([
        { peerId: peerB, kind: 'release_revoked', releaseId: peerRelease.id, reason: 'dataset_reclassified' },
        {
          peerId: peerB,
          kind: 'release_revoked',
          releaseId: kaderPeerRelease.id,
          reason: 'dataset_reclassified',
        },
      ]),
    );

    expect(await flushA()).toEqual({ delivered: 2, failed: 0 });
    const copy = await b.deps.db
      .selectFrom('received_product')
      .selectAll()
      .where('remote_release_id', '=', peerRelease.id)
      .executeTakeFirstOrThrow();
    expect(copy).toMatchObject({ status: 'revoked', status_reason: 'dataset_reclassified', row_count: 0 });
    const rows = await b.deps.db
      .selectFrom('received_row')
      .select('id')
      .where('received_product_id', '=', copy.id)
      .execute();
    expect(rows).toHaveLength(0);

    // neuer Abruf wird abgelehnt
    const again = await b.request<ErrorJson>('POST', '/api/v1/received/pull', {
      as: stewardB,
      body: { peerId: peerA, releaseId: peerRelease.id, purpose: 'training_steering' },
    });
    expect(again.json.error).toMatchObject({ code: 'peer_rejected', reason: 'revoked' });
  });

  test('neue Freigaben nur mit Einwilligungspflicht', async () => {
    const r = await a.request<{ error: { code: string; fields?: Record<string, string> } }>(
      'POST',
      '/api/v1/releases',
      {
        as: stewardA,
        body: {
          productId: leistung.id,
          recipient: { type: 'role', role: 'coach' },
          purposes: ['training_steering'],
          columns: ['last_name', 'cmj'],
          requiresConsent: false,
        },
      },
    );
    expect(r.status).toBe(422);
    expect(r.json.error).toMatchObject({
      code: 'release_invalid',
      fields: { 'body.requiresConsent': 'special_category_requires_consent' },
    });
    await createRelease({
      productId: leistung.id,
      recipient: { type: 'role', role: 'coach' },
      purposes: ['training_steering'],
      columns: ['last_name', 'cmj'],
      requiresConsent: true,
    });
  });
});

describe('Weitere Datensatzänderungen', () => {
  let ds: Dataset;
  let usesA: Product;
  let usesB: Product;
  let peerOnA: Release;

  beforeAll(async () => {
    ds = await createDataset({
      slug: 'struktur',
      name: 'Struktur',
      category: 'performance',
      fields: [
        { name: 'd1', label: 'Datum 1', type: 'date', required: true },
        { name: 'd2', label: 'Datum 2', type: 'date' },
        { name: 'x', label: 'X', type: 'number', unit: 'cm' },
        { name: 'y', label: 'Y', type: 'number' },
      ],
      keyFields: ['d1'],
      observedAtField: 'd1',
    });
    usesA = await createProduct({
      slug: 'nutzt_x',
      name: 'Nutzt X',
      sourceType: 'dataset',
      datasetId: ds.id,
      columns: [{ key: 'x', label: 'X', source: 'data.x' }],
    });
    usesB = await createProduct({
      slug: 'nutzt_y',
      name: 'Nutzt Y',
      sourceType: 'dataset',
      datasetId: ds.id,
      columns: [{ key: 'y', label: 'Y', source: 'data.y' }],
    });
    peerOnA = await createRelease({
      productId: usesA.id,
      recipient: { type: 'peer', peerId: peerB },
      purposes: ['training_steering'],
      columns: ['x'],
    });
  });

  test('Label, Prüfregeln, neues Feld: keine neue Produktversion', async () => {
    const fields = ds.fields.map((f) => (f.name === 'x' ? { ...f, label: 'X neu', max: 100 } : f));
    await patchDataset(ds.id, { fields: [...fields, { name: 'z', label: 'Z', type: 'string' }] });
    expect((await product(usesA.id)).version).toBe(1);
    expect((await product(usesB.id)).version).toBe(1);
  });

  test('Einheit eines genutzten Felds: nur das betroffene Produkt erhält eine neue Version', async () => {
    const current = (await a.request<Dataset>('GET', `/api/v1/datasets/${ds.id}`, { as: stewardA })).json;
    await patchDataset(ds.id, {
      fields: current.fields.map((f) => (f.name === 'x' ? { ...f, unit: 'mm' } : f)),
    });
    expect((await product(usesA.id)).version).toBe(2);
    expect((await product(usesB.id)).version).toBe(1);
    // keine Hochstufung: veraltet, nicht widerrufen, keine Mitteilung
    expect((await release(peerOnA.id)).status).toBe('outdated');
    expect(await pendingNotices()).toEqual([]);
  });

  test('anderes Beobachtungsdatum und Kategorie ohne besondere Kategorie: alle Produkte, kein Widerruf', async () => {
    await patchDataset(ds.id, { observedAtField: 'd2' });
    expect((await product(usesA.id)).version).toBe(3);
    expect((await product(usesB.id)).version).toBe(2);
    await patchDataset(ds.id, { category: 'training' });
    expect((await product(usesA.id)).version).toBe(4);
    expect((await product(usesB.id)).version).toBe(3);
    expect((await release(peerOnA.id)).status).toBe('outdated');
    expect(await pendingNotices()).toEqual([]);
  });

  test('Teilbarkeit intern: Produkte intern, Partnerfreigaben widerrufen', async () => {
    const fresh = await createRelease({
      productId: usesA.id,
      recipient: { type: 'peer', peerId: peerB },
      purposes: ['training_steering'],
      columns: ['x'],
    });
    await patchDataset(ds.id, { shareability: 'internal' });
    expect(await product(usesA.id)).toMatchObject({ version: 5, shareability: 'internal' });
    expect(await product(usesB.id)).toMatchObject({ version: 4, shareability: 'internal' });
    // gespeichert intern (bleibt es, auch wenn der Datensatz später wieder teilbar wird)
    const stored = await a.deps.db
      .selectFrom('data_product')
      .select('shareability')
      .where('dataset_id', '=', ds.id)
      .execute();
    expect(stored.every((p) => p.shareability === 'internal')).toBe(true);
    for (const r of [peerOnA, fresh]) {
      expect(await release(r.id)).toMatchObject({
        status: 'revoked',
        revocationReason: 'dataset_reclassified',
      });
    }
    expect((await pendingNotices()).map((n) => n.releaseId).sort()).toEqual([peerOnA.id, fresh.id].sort());
    expect(await flushA()).toEqual({ delivered: 2, failed: 0 });
  });
});
