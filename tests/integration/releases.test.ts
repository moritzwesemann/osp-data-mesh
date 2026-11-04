import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Product } from '../../src/shared/contract/products.ts';
import type { ExchangeLogEntry, Release } from '../../src/shared/contract/releases.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';
import { type StandardSeed, seedRelease, seedStandard } from '../helpers/seed.ts';

let node: TestNode;
let seed: StandardSeed;
let steward: TestUser;
let auditor: TestUser;
let analyst: TestUser;
let perf: Product;
let health: Product;
let internal: Product;

interface ErrorJson {
  error: { code: string; reason?: string; fields?: Record<string, string> };
}

const revokedInTx: { releaseId: string; reason: string; revokedInTrx: boolean }[] = [];
const revokedAfter: string[] = [];
const createdInTx: string[] = [];
let failRevocationFor: string | null = null;

async function product(body: Record<string, unknown>): Promise<Product> {
  const res = await node.request<Product>('POST', '/api/v1/products', { as: steward, body });
  if (res.status !== 200) throw new Error(`product create failed: ${res.text}`);
  return res.json;
}

function release(body: Record<string, unknown>) {
  return node.request<Release & ErrorJson>('POST', '/api/v1/releases', {
    as: steward,
    body: {
      productId: perf.id,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name', 'cmj'],
      requiresConsent: false,
      ...body,
    },
  });
}

async function audit(action: string) {
  return node.deps.db
    .selectFrom('audit_log')
    .selectAll()
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
}

beforeAll(async () => {
  node = await createTestNode();
  seed = await seedStandard(node.deps.db);
  steward = await node.user(['data_steward']);
  auditor = await node.user(['auditor']);
  analyst = await node.user(['analyst']);

  node.deps.events.onTx('release.revoked', async (p, trx) => {
    if (failRevocationFor === p.releaseId) throw new Error('simulated outbox failure');
    const row = await trx
      .selectFrom('data_release')
      .select('revoked_at')
      .where('id', '=', p.releaseId)
      .executeTakeFirst();
    revokedInTx.push({ releaseId: p.releaseId, reason: p.reason, revokedInTrx: !!row?.revoked_at });
  });
  node.deps.events.onAfter('release.revoked', async (p) => {
    revokedAfter.push(p.releaseId);
  });
  node.deps.events.onTx('release.created', async (p) => {
    createdInTx.push(p.releaseId);
  });

  const columns = [
    { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
    { key: 'sport', label: 'Sportart', source: 'athlete.sport' },
    { key: 'test_date', label: 'Testdatum', source: 'record.observed_at' },
    { key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' },
  ];
  perf = await product({
    slug: 'leistung',
    name: 'Leistung',
    sourceType: 'dataset',
    datasetId: seed.performance,
    columns,
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
  internal = await product({
    slug: 'intern',
    name: 'Intern',
    sourceType: 'dataset',
    datasetId: seed.performance,
    columns,
    shareability: 'internal',
  });
});

afterAll(async () => {
  await node?.close();
});

describe('Freigabe erteilen: Prüfungen', () => {
  test('Art.-9-Daten ohne Einwilligungspflicht → 422 release_invalid', async () => {
    const res = await release({
      productId: health.id,
      purposes: ['medical_care'],
      columns: ['last_name', 'hr'],
      requiresConsent: false,
    });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe('release_invalid');
    expect(res.json.error.fields).toEqual({ 'body.requiresConsent': 'special_category_requires_consent' });
  });

  test('internes Produkt an Partner → 422 not_shareable', async () => {
    const res = await release({
      productId: internal.id,
      recipient: { type: 'peer', peerId: seed.peers.trusted.id },
    });
    expect(res.status).toBe(422);
    expect(res.json.error.fields).toEqual({ 'body.recipient': 'not_shareable' });
  });

  test('unbekannter Zweck, unbekannte Spalte, unpassender Filterwert, Zeitfenster', async () => {
    const res = await release({
      purposes: ['training_steering', 'world_domination'],
      columns: ['last_name', 'secret'],
      rowFilter: [
        { column: 'cmj', op: 'gt', value: 'hoch' },
        { column: 'nope', op: 'is_null' },
      ],
      validFrom: '2026-01-02T00:00:00Z',
      validUntil: '2026-01-01T00:00:00Z',
      dataFrom: '2026-02-01',
      dataUntil: '2026-01-01',
    });
    expect(res.status).toBe(422);
    expect(res.json.error.fields).toEqual({
      'body.purposes.1': 'unknown_purpose',
      'body.columns.1': 'unknown_column',
      'body.rowFilter.0.value': 'invalid_filter_value',
      'body.rowFilter.1.column': 'unknown_filter_column',
      'body.validUntil': 'invalid_time_window',
      'body.dataUntil': 'invalid_data_window',
    });
  });

  test('inaktiver Zweck gilt als unbekannt', async () => {
    await node.deps.db.updateTable('purpose').set({ active: false }).where('code', '=', 'research').execute();
    try {
      const res = await release({ purposes: ['research'] });
      expect(res.status).toBe(422);
      expect(res.json.error.fields).toEqual({ 'body.purposes.0': 'unknown_purpose' });
    } finally {
      await node.deps.db
        .updateTable('purpose')
        .set({ active: true })
        .where('code', '=', 'research')
        .execute();
    }
  });

  test('Partner: unbekannt → 422, ausstehend/gesperrt → 409 peer_untrusted', async () => {
    let res = await release({ recipient: { type: 'peer', peerId: crypto.randomUUID() } });
    expect(res.status).toBe(422);
    expect(res.json.error.fields).toEqual({ 'body.recipient.peerId': 'not_found' });
    res = await release({ recipient: { type: 'peer', peerId: seed.peers.suspended.id } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('peer_untrusted');
    res = await release({ recipient: { type: 'peer', peerId: seed.peers.pending.id } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('peer_untrusted');
  });

  test('Produkt unbekannt oder stillgelegt', async () => {
    let res = await release({ productId: crypto.randomUUID() });
    expect(res.status).toBe(422);
    expect(res.json.error.fields).toEqual({ 'body.productId': 'not_found' });
    const retired = await product({
      slug: 'alt',
      name: 'Alt',
      sourceType: 'athletes',
      columns: [{ key: 'last_name', label: 'Nachname', source: 'athlete.last_name' }],
    });
    await node.request('POST', `/api/v1/products/${retired.id}/retire`, { as: steward });
    res = await release({ productId: retired.id, columns: ['last_name'] });
    expect(res.status).toBe(422);
    expect(res.json.error.fields).toEqual({ 'body.productId': 'product_inactive' });
  });

  test('BI: genau ein Zweck; höchstens eine aktive BI-Freigabe je Produkt', async () => {
    let res = await release({
      recipient: { type: 'role', role: 'bi' },
      purposes: ['reporting', 'research'],
    });
    expect(res.status).toBe(422);
    expect(res.json.error.fields).toEqual({ 'body.purposes': 'bi_requires_single_purpose' });

    res = await release({ recipient: { type: 'role', role: 'bi' }, purposes: ['reporting'] });
    expect(res.status).toBe(200);
    const first = res.json.id;
    res = await release({ recipient: { type: 'role', role: 'bi' }, purposes: ['reporting'] });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
    // nach Widerruf ist eine neue BI-Freigabe möglich
    await node.request('POST', `/api/v1/releases/${first}/revoke`, { as: steward, body: { reason: 'neu' } });
    res = await release({ recipient: { type: 'role', role: 'bi' }, purposes: ['reporting'] });
    expect(res.status).toBe(200);
  });

  test('nur Datenverantwortliche erteilen Freigaben', async () => {
    const res = await node.request('POST', '/api/v1/releases', {
      as: analyst,
      body: {
        productId: perf.id,
        recipient: { type: 'role', role: 'analyst' },
        purposes: ['training_steering'],
        columns: ['last_name'],
        requiresConsent: false,
      },
    });
    expect(res.status).toBe(403);
  });
});

describe('Freigabe erteilen: Erfolg', () => {
  test('Freigabe wird mit aktueller Produktversion gespeichert, protokolliert, Ereignis ausgelöst', async () => {
    const res = await release({
      recipient: { type: 'peer', peerId: seed.peers.trusted.id },
      rowFilter: [{ column: 'sport', op: 'eq', value: 'Rudern' }],
      dataFrom: '2026-01-01',
      legalBasis: 'Kooperationsvertrag',
    });
    expect(res.status).toBe(200);
    const r = res.json;
    expect(r.status).toBe('active');
    expect(r.productVersion).toBe(perf.version);
    expect(r.currentProductVersion).toBe(perf.version);
    expect(r.productSlug).toBe('leistung');
    expect(r.recipient).toEqual({
      type: 'peer',
      peerId: seed.peers.trusted.id,
      peerNodeId: seed.peers.trusted.nodeId,
      peerName: `Partner ${seed.peers.trusted.nodeId}`,
    });
    expect(r.legalBasis).toBe('Kooperationsvertrag');
    expect(createdInTx).toContain(r.id);
    const entry = (await audit('release.create')).find((e) => e.object_id === r.id)!;
    expect(entry.actor_id).toBe(steward.id);
    expect(entry.details).toMatchObject({
      recipient: { type: 'peer', peerId: seed.peers.trusted.id },
      purposes: ['training_steering'],
      columns: ['last_name', 'cmj'],
      rowFilterCount: 1,
      dataFrom: '2026-01-01',
      dataUntil: null,
      requiresConsent: false,
    });
  });

  test('Gesundheitsdaten mit Einwilligungspflicht sind zulässig', async () => {
    const res = await release({
      productId: health.id,
      purposes: ['medical_care'],
      columns: ['last_name', 'hr'],
      requiresConsent: true,
    });
    expect(res.status).toBe(200);
  });
});

describe('Vorschau', () => {
  test('zeigt Spalten, Zeilen (max. 20) und Statistik; protokolliert', async () => {
    const res = await node.request<{
      decision: { allowed: boolean; reason: string | null };
      columns: { key: string }[];
      rows: Record<string, unknown>[];
      stats: { total: number; returned: number; excludedByConsent: number };
    }>('POST', '/api/v1/releases/preview', {
      as: steward,
      body: {
        release: {
          productId: perf.id,
          recipient: { type: 'role', role: 'coach' },
          purposes: ['training_steering'],
          columns: ['cmj', 'last_name'],
          requiresConsent: true,
        },
        purpose: 'training_steering',
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.decision).toEqual({ allowed: true, reason: null });
    expect(res.json.columns.map((c) => c.key)).toEqual(['last_name', 'cmj']);
    expect(res.json.stats.total).toBe(10);
    expect(res.json.stats.excludedByConsent).toBe(6);
    expect(new Set(res.json.rows.map((r) => r.last_name))).toEqual(new Set(['Adler', 'Berg']));
    const entry = (await audit('release.preview')).at(-1)!;
    expect(entry.details).toMatchObject({ allowed: true, purpose: 'training_steering', rowCount: 4 });
    // Vorschau legt keine Freigabe an
    const count = await node.deps.db
      .selectFrom('data_release')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('recipient_role', '=', 'coach')
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });

  test('höchstens 20 Zeilen', async () => {
    const res = await node.request<{ rows: unknown[]; stats: { returned: number } }>(
      'POST',
      '/api/v1/releases/preview',
      {
        as: steward,
        body: {
          release: {
            productId: perf.id,
            recipient: { type: 'peer', peerId: seed.peers.trusted.id },
            purposes: ['training_steering'],
            columns: ['last_name'],
            requiresConsent: false,
          },
          purpose: 'training_steering',
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.json.rows).toHaveLength(10);
    expect(res.json.stats.returned).toBe(10);
  });

  test('Ablehnungsgrund bei nicht freigegebenem Zweck', async () => {
    const res = await node.request<{
      decision: { allowed: boolean; reason: string | null };
      rows: unknown[];
    }>('POST', '/api/v1/releases/preview', {
      as: steward,
      body: {
        release: {
          productId: perf.id,
          recipient: { type: 'role', role: 'analyst' },
          purposes: ['training_steering'],
          columns: ['last_name'],
          requiresConsent: false,
        },
        purpose: 'research',
      },
    });
    expect(res.json.decision).toEqual({ allowed: false, reason: 'purpose_not_allowed' });
    expect(res.json.rows).toEqual([]);
  });

  test('ungültige Freigabe → 422 mit Feldern unter body.release', async () => {
    const res = await node.request<ErrorJson>('POST', '/api/v1/releases/preview', {
      as: steward,
      body: {
        release: {
          productId: health.id,
          recipient: { type: 'role', role: 'analyst' },
          purposes: ['medical_care'],
          columns: ['hr'],
          requiresConsent: false,
        },
        purpose: 'medical_care',
      },
    });
    expect(res.status).toBe(422);
    expect(res.json.error.fields).toEqual({
      'body.release.requiresConsent': 'special_category_requires_consent',
    });
  });
});

describe('Widerruf', () => {
  test('setzt Widerrufsangaben, Ereignis in der Transaktion und danach, Audit; zweiter Widerruf → 409', async () => {
    const created = await release({});
    const id = created.json.id;
    const res = await node.request<Release>('POST', `/api/v1/releases/${id}/revoke`, {
      as: steward,
      body: { reason: 'Kooperation beendet' },
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('revoked');
    expect(res.json.revocationReason).toBe('Kooperation beendet');
    expect(res.json.revokedAt).not.toBeNull();
    expect(revokedInTx.find((x) => x.releaseId === id)).toEqual({
      releaseId: id,
      reason: 'Kooperation beendet',
      revokedInTrx: true,
    });
    expect(revokedAfter).toContain(id);
    const row = await node.deps.db
      .selectFrom('data_release')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.revoked_by).toBe(steward.id);
    const entry = (await audit('release.revoke')).find((e) => e.object_id === id)!;
    expect(entry.actor_id).toBe(steward.id);
    expect(entry.details).toMatchObject({ cause: 'manual', previousStatus: 'active' });

    const again = await node.request<ErrorJson>('POST', `/api/v1/releases/${id}/revoke`, {
      as: steward,
      body: { reason: 'nochmal' },
    });
    expect(again.status).toBe(409);
    expect(
      (
        await node.request('POST', `/api/v1/releases/${crypto.randomUUID()}/revoke`, {
          as: steward,
          body: { reason: 'x' },
        })
      ).status,
    ).toBe(404);
  });

  test('scheitert die Folge in der Transaktion (z. B. Widerrufsmitteilung), bleibt die Freigabe unverändert', async () => {
    const created = await release({ recipient: { type: 'peer', peerId: seed.peers.trusted.id } });
    const id = created.json.id;
    failRevocationFor = id;
    try {
      const res = await node.request('POST', `/api/v1/releases/${id}/revoke`, {
        as: steward,
        body: { reason: 'x' },
      });
      expect(res.status).toBe(500);
    } finally {
      failRevocationFor = null;
    }
    const row = await node.deps.db
      .selectFrom('data_release')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).toBeNull();
    expect((await audit('release.revoke')).some((e) => e.object_id === id)).toBe(false);
  });

  test('Stilllegung eines Produkts widerruft alle seine Freigaben', async () => {
    const p = await product({
      slug: 'stilllegung',
      name: 'Stilllegung',
      sourceType: 'athletes',
      columns: [{ key: 'last_name', label: 'Nachname', source: 'athlete.last_name' }],
    });
    const a = (await release({ productId: p.id, columns: ['last_name'] })).json.id;
    const b = (
      await release({
        productId: p.id,
        columns: ['last_name'],
        recipient: { type: 'peer', peerId: seed.peers.trusted.id },
      })
    ).json.id;
    const res = await node.request('POST', `/api/v1/products/${p.id}/retire`, { as: steward });
    expect(res.status).toBe(200);
    for (const id of [a, b]) {
      const r = await node.request<Release>('GET', `/api/v1/releases/${id}`, { as: steward });
      expect(r.json.status).toBe('revoked');
      expect(r.json.revocationReason).toBe('product_retired');
      expect(revokedInTx.find((x) => x.releaseId === id)).toMatchObject({
        reason: 'product_retired',
        revokedInTrx: true,
      });
      expect(revokedAfter).toContain(id);
      const entry = (await audit('release.revoke')).find((e) => e.object_id === id)!;
      expect(entry.actor_type).toBe('system');
      expect(entry.details).toMatchObject({ cause: 'product_retired' });
    }
  });
});

describe('Anzeige: Liste, Status, Austauschhistorie', () => {
  let ids: Record<string, string>;

  beforeAll(async () => {
    const p = await product({
      slug: 'status',
      name: 'Status',
      sourceType: 'athletes',
      columns: [
        { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
        { key: 'sport', label: 'Sportart', source: 'athlete.sport' },
      ],
    });
    const base = {
      productId: p.id,
      recipient: { type: 'role', role: 'analyst' } as const,
      purposes: ['training_steering'],
      columns: ['last_name'],
    };
    const now = Date.now();
    ids = {
      active: await seedRelease(node.deps.db, base),
      scheduled: await seedRelease(node.deps.db, { ...base, validFrom: new Date(now + 86_400_000) }),
      expired: await seedRelease(node.deps.db, {
        ...base,
        validFrom: new Date(now - 86_400_000),
        validUntil: new Date(now - 1000),
      }),
      revoked: await seedRelease(node.deps.db, { ...base, revokedAt: new Date(now - 1000) }),
      outdated: await seedRelease(node.deps.db, { ...base, productVersion: p.version }),
    };
    // Produktänderung: die bisher aktiven Freigaben werden "veraltet"
    await node.request('PATCH', `/api/v1/products/${p.id}`, {
      as: steward,
      body: { columns: [{ key: 'last_name', label: 'Nachname', source: 'athlete.last_name' }] },
    });
    // nach der Änderung neu erteilt
    ids.formerActive = ids.active!;
    ids.active = await seedRelease(node.deps.db, base);
    await node.deps.db
      .insertInto('exchange_log')
      .values([
        {
          direction: 'outgoing',
          peer_node_id: 'osp-x',
          release_id: ids.active,
          outcome: 'delivered',
          row_count: 5,
          columns: ['last_name'],
          purpose: 'training_steering',
          at: new Date(now - 60_000),
        },
        {
          direction: 'outgoing',
          peer_node_id: 'osp-x',
          release_id: ids.active,
          outcome: 'denied',
          deny_reason: 'purpose_not_allowed',
          purpose: 'research',
          at: new Date(now - 1000),
        },
      ])
      .execute();
  });

  test('Status je Freigabe: active, scheduled, expired, revoked, outdated', async () => {
    const res = await node.request<{ items: Release[] }>('GET', '/api/v1/releases', { as: steward });
    expect(res.status).toBe(200);
    const byId = new Map(res.json.items.map((r) => [r.id, r]));
    for (const [key, id] of Object.entries(ids)) {
      const expected = key === 'formerActive' ? 'outdated' : key;
      expect(byId.get(id)?.status).toBe(expected as Release['status']);
    }
    const outdated = byId.get(ids.outdated!)!;
    expect(outdated.currentProductVersion).toBe(outdated.productVersion + 1);
  });

  test('Filter nach Produkt und Status', async () => {
    const productId = (await node.request<Release>('GET', `/api/v1/releases/${ids.active}`, { as: steward }))
      .json.productId;
    const res = await node.request<{ items: Release[] }>(
      'GET',
      `/api/v1/releases?productId=${productId}&status=outdated`,
      { as: steward },
    );
    // die vor der Produktänderung erteilten, aktiven Freigaben sind beide veraltet
    expect(res.json.items.map((r) => r.id).sort()).toEqual([ids.formerActive!, ids.outdated!].sort());
    const all = await node.request<{ items: Release[] }>('GET', `/api/v1/releases?productId=${productId}`, {
      as: auditor,
    });
    expect(all.status).toBe(200);
    expect(all.json.items).toHaveLength(6);
  });

  test('Detail mit Austauschhistorie (neueste zuerst)', async () => {
    const res = await node.request<Release & { exchanges: ExchangeLogEntry[] }>(
      'GET',
      `/api/v1/releases/${ids.active}`,
      { as: auditor },
    );
    expect(res.status).toBe(200);
    expect(res.json.exchanges.map((e) => e.outcome)).toEqual(['denied', 'delivered']);
    expect(res.json.exchanges[0]).toMatchObject({
      direction: 'outgoing',
      peerNodeId: 'osp-x',
      releaseId: ids.active,
      denyReason: 'purpose_not_allowed',
      rowCount: 0,
    });
    expect(
      (await node.request('GET', `/api/v1/releases/${crypto.randomUUID()}`, { as: steward })).status,
    ).toBe(404);
  });

  test('Analyse-Rolle sieht keine Freigabenverwaltung', async () => {
    expect((await node.request('GET', '/api/v1/releases', { as: analyst })).status).toBe(403);
  });
});
