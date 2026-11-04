import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ServeRequest, ServeResult } from '../../src/server/core/deps.ts';
import type { Requester } from '../../src/server/modules/releases/engine.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';
import {
  type StandardSeed,
  seedAthlete,
  seedConsent,
  seedDataset,
  seedPeer,
  seedProduct,
  seedRecord,
  seedRelease,
  seedStandard,
} from '../helpers/seed.ts';

const T0 = new Date('2026-06-01T10:00:00Z');
let clock = T0;
let node: TestNode;
let seed: StandardSeed;
let steward: TestUser;
let perfProduct: string;
let healthProduct: string;
let athletesProduct: string;

const analyst: Requester = {
  type: 'user',
  userId: '00000000-0000-4000-8000-000000000001',
  roles: ['analyst'],
};

async function serve(releaseId: string, over: Partial<ServeRequest> = {}): Promise<ServeResult> {
  return node.deps.services.pep.serve({
    releaseId,
    requester: analyst,
    purpose: 'training_steering',
    ...over,
  });
}

function reason(r: ServeResult): string {
  return r.allowed ? 'allowed' : r.reason;
}

function allowed(r: ServeResult): Extract<ServeResult, { allowed: true }> {
  if (!r.allowed) throw new Error(`expected allowed, got ${r.reason}`);
  return r;
}

const PERF_COLUMNS = [
  { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
  { key: 'sport', label: 'Sportart', source: 'athlete.sport' },
  { key: 'birth_year', label: 'Geburtsjahr', source: 'athlete.birth_year' },
  { key: 'test_date', label: 'Testdatum', source: 'record.observed_at' },
  { key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' },
  { key: 'reps', label: 'Wiederholungen', source: 'data.reps' },
  { key: 'valid', label: 'Gültig', source: 'data.valid' },
  { key: 'protocol', label: 'Protokoll', source: 'data.protocol' },
];

beforeAll(async () => {
  node = await createTestNode({ now: () => clock });
  seed = await seedStandard(node.deps.db);
  steward = await node.user(['data_steward']);
  perfProduct = await seedProduct(node.deps.db, {
    slug: 'leistung',
    datasetId: seed.performance,
    columns: PERF_COLUMNS,
  });
  healthProduct = await seedProduct(node.deps.db, {
    slug: 'gesundheit_check',
    datasetId: seed.health,
    columns: [
      { key: 'last_name', source: 'athlete.last_name' },
      { key: 'check_date', source: 'record.observed_at' },
      { key: 'hr', source: 'data.resting_hr' },
    ],
  });
  athletesProduct = await seedProduct(node.deps.db, {
    slug: 'kader',
    sourceType: 'athletes',
    columns: [
      { key: 'last_name', source: 'athlete.last_name' },
      { key: 'squad', source: 'athlete.squad_status' },
      { key: 'birth_year', source: 'athlete.birth_year' },
    ],
  });
});

afterAll(async () => {
  await node?.close();
});

describe('PEP: Grundsätzliches', () => {
  test('unbekannte oder ungültige Freigabe-ID: release_not_found', async () => {
    expect(reason(await serve(crypto.randomUUID()))).toBe('release_not_found');
    expect(reason(await serve('not-a-uuid'))).toBe('release_not_found');
    expect(reason(await serve("'; drop table athlete; --"))).toBe('release_not_found');
  });

  test('Spalten: nur freigegebene, in Produktreihenfolge, mit Typ und Einheit', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['cmj', 'last_name', 'unknown_column'],
    });
    const r = allowed(await serve(id));
    expect(r.columns).toEqual([
      { key: 'last_name', label: 'Nachname', type: 'string' },
      { key: 'cmj', label: 'CMJ', type: 'number', unit: 'cm' },
    ]);
    expect(r.rows).toHaveLength(10);
    for (const row of r.rows) expect(Object.keys(row.values).sort()).toEqual(['cmj', 'last_name']);
    expect(r.stats).toEqual({
      total: 10,
      returned: 10,
      excludedByFilter: 0,
      excludedByTime: 0,
      excludedByConsent: 0,
    });
    expect(r.product.slug).toBe('leistung');
  });

  test('Werte haben den Typ der Spalte (Datum, Zahl, Ganzzahl, Boolesch, Aufzählung)', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: PERF_COLUMNS.map((c) => c.key),
    });
    const r = allowed(await serve(id));
    const anna = r.rows.find((x) => x.values.last_name === 'Adler' && x.values.test_date === '2026-01-15');
    expect(anna?.values).toEqual({
      last_name: 'Adler',
      sport: 'Rudern',
      birth_year: 2004,
      test_date: '2026-01-15',
      cmj: 41.5,
      reps: 10,
      valid: true,
      protocol: 'A',
    });
    expect(anna?.athleteId).toBe(seed.athletes.anna);
  });

  test('Athletenkern als Quelle: eine Zeile je Person', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: athletesProduct,
      recipient: { type: 'role', role: 'coach' },
      purposes: ['talent_development'],
      columns: ['last_name', 'squad', 'birth_year'],
    });
    const r = allowed(
      await serve(id, {
        requester: { type: 'user', userId: 'coach-1', roles: ['coach'] },
        purpose: 'talent_development',
      }),
    );
    expect(r.rows.map((x) => x.values.last_name)).toEqual(['Adler', 'Berg', 'Clausen', 'Dorn', 'Eck']);
    expect(r.rows[0]!.values).toEqual({ last_name: 'Adler', squad: 'OK', birth_year: 2004 });
  });

  test('Limit begrenzt die ausgelieferten Zeilen', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
    });
    const r = allowed(await serve(id, { limit: 3 }));
    expect(r.rows).toHaveLength(3);
    expect(r.stats.total).toBe(10);
    expect(r.stats.returned).toBe(3);
  });
});

describe('PEP: Zeilen, Zeit und Zweck', () => {
  test('Zeilenbeschränkung auch auf nicht freigegebene Spalte; Spalte bleibt verborgen', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name', 'cmj'],
      rowFilter: [
        { column: 'sport', op: 'eq', value: 'Kanu' },
        { column: 'cmj', op: 'gte', value: 34 },
      ],
    });
    const r = allowed(await serve(id));
    expect(r.rows.map((x) => x.values.last_name).sort()).toEqual(['Clausen', 'Clausen', 'Dorn']);
    expect(r.rows.every((x) => !('sport' in x.values))).toBe(true);
    expect(r.stats.excludedByFilter).toBe(7);
  });

  test('Basisfilter des Produkts wird immer angewandt', async () => {
    const pid = await seedProduct(node.deps.db, {
      slug: 'nur_gueltige',
      datasetId: seed.performance,
      columns: PERF_COLUMNS,
      filters: [{ column: 'valid', op: 'eq', value: true }],
    });
    const id = await seedRelease(node.deps.db, {
      productId: pid,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name', 'test_date'],
    });
    const r = allowed(await serve(id));
    expect(r.rows).toHaveLength(9);
    expect(r.rows.some((x) => x.values.last_name === 'Berg' && x.values.test_date === '2026-03-15')).toBe(
      false,
    );
  });

  test('Datenzeitraum: nur Beobachtungen im Zeitraum (inklusive)', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name', 'test_date'],
      dataFrom: '2026-03-15',
      dataUntil: '2026-03-15',
    });
    const r = allowed(await serve(id));
    expect(r.rows).toHaveLength(5);
    expect(new Set(r.rows.map((x) => x.values.test_date))).toEqual(new Set(['2026-03-15']));
    expect(r.stats.excludedByTime).toBe(5);
  });

  test('Datenzeitraum gilt für das Datum in der Knotenzeitzone (Europe/Berlin)', async () => {
    const ds = await seedDataset(node.deps.db, {
      slug: 'messung_zeit',
      category: 'training',
      fields: [
        { name: 'measured_at', type: 'datetime' },
        { name: 'value', type: 'number' },
      ],
      observedAtField: 'measured_at',
    });
    const a = await seedAthlete(node.deps.db, { lastName: 'Zeit' });
    // 2026-02-28 23:30 UTC = 2026-03-01 00:30 in Berlin
    await seedRecord(node.deps.db, {
      datasetId: ds,
      athleteId: a,
      observedAt: '2026-02-28T23:30:00Z',
      data: { value: 1 },
    });
    // 2026-02-28 22:30 UTC = 2026-02-28 23:30 in Berlin
    await seedRecord(node.deps.db, {
      datasetId: ds,
      athleteId: a,
      observedAt: '2026-02-28T22:30:00Z',
      data: { value: 2 },
    });
    const pid = await seedProduct(node.deps.db, {
      slug: 'messung_zeit',
      datasetId: ds,
      columns: [
        { key: 'at', source: 'record.observed_at' },
        { key: 'value', source: 'data.value' },
      ],
    });
    const id = await seedRelease(node.deps.db, {
      productId: pid,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['at', 'value'],
      dataFrom: '2026-03-01',
    });
    const r = allowed(await serve(id));
    expect(r.columns[0]).toEqual({ key: 'at', label: 'at', type: 'datetime' });
    expect(r.rows.map((x) => x.values)).toEqual([{ at: '2026-02-28T23:30:00.000Z', value: 1 }]);

    // Zeitstempel-Filter mit Zeitzonenversatz wird beim Erteilen normalisiert (chronologischer Vergleich)
    const created = await node.request<{ id: string; rowFilter: unknown[] }>('POST', '/api/v1/releases', {
      as: steward,
      body: {
        productId: pid,
        recipient: { type: 'role', role: 'analyst' },
        purposes: ['training_steering'],
        columns: ['at', 'value'],
        rowFilter: [{ column: 'at', op: 'gte', value: '2026-03-01T00:00:00+01:00' }],
        requiresConsent: false,
      },
    });
    expect(created.status).toBe(200);
    expect(created.json.rowFilter).toEqual([{ column: 'at', op: 'gte', value: '2026-02-28T23:00:00.000Z' }]);
    const filtered = allowed(await serve(created.json.id));
    expect(filtered.rows.map((x) => x.values.value)).toEqual([1]);
  });

  test('Zweckbindung: nicht freigegebener Zweck wird abgelehnt', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering', 'performance_diagnostics'],
      columns: ['last_name'],
    });
    expect(reason(await serve(id, { purpose: 'research' }))).toBe('purpose_not_allowed');
    expect(reason(await serve(id, { purpose: 'performance_diagnostics' }))).toBe('allowed');
  });

  test('Empfänger: andere Rolle, BI und Partner sind keine Empfänger einer Rollenfreigabe', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
    });
    expect(
      reason(await serve(id, { requester: { type: 'user', userId: 'x', roles: ['coach', 'admin'] } })),
    ).toBe('recipient_mismatch');
    expect(reason(await serve(id, { requester: { type: 'bi' } }))).toBe('recipient_mismatch');
    expect(
      reason(
        await serve(id, {
          requester: { type: 'peer', peerId: seed.peers.trusted.id, peerStatus: 'trusted' },
        }),
      ),
    ).toBe('recipient_mismatch');
  });
});

describe('PEP: Einwilligungen (consent_record)', () => {
  test('nur Personen mit gültiger Einwilligung für Zweck und Kategorie', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
      requiresConsent: true,
    });
    const r = allowed(await serve(id));
    // anna: * / *; ben: training_steering / performance
    // carla: widerrufen, dario: anderer Zweck, eva: abgelaufen
    expect(new Set(r.rows.map((x) => x.values.last_name))).toEqual(new Set(['Adler', 'Berg']));
    expect(r.rows).toHaveLength(4);
    expect(r.stats.excludedByConsent).toBe(6);
  });

  test('Zweck "*" deckt jeden Zweck; Einwilligung für anderen Zweck nur dort', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['research'],
      columns: ['last_name'],
      requiresConsent: true,
    });
    const r = allowed(await serve(id, { purpose: 'research' }));
    expect(new Set(r.rows.map((x) => x.values.last_name))).toEqual(new Set(['Adler', 'Dorn']));
  });

  test('Ablauf: vor dem Enddatum gilt die Einwilligung, danach nicht', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
      requiresConsent: true,
    });
    const before = allowed(await serve(id, { at: new Date('2025-12-31T21:00:00Z') }));
    expect(before.rows.some((x) => x.values.last_name === 'Eck')).toBe(true);
    // 2025-12-31 23:30 UTC ist in Berlin bereits der 01.01.2026
    const after = allowed(await serve(id, { at: new Date('2025-12-31T23:30:00Z') }));
    expect(after.rows.some((x) => x.values.last_name === 'Eck')).toBe(false);
  });

  test('Widerruf einer Einwilligung wirkt beim nächsten Abruf', async () => {
    const a = await seedAthlete(node.deps.db, { lastName: 'Widerruf', sport: 'Rudern' });
    const consentId = await seedConsent(node.deps.db, { athleteId: a, purpose: 'training_steering' });
    await seedRecord(node.deps.db, {
      datasetId: seed.performance,
      athleteId: a,
      observedAt: '2026-04-01',
      data: { test_date: '2026-04-01', cmj_cm: 30 },
    });
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
      requiresConsent: true,
    });
    expect(allowed(await serve(id)).rows.some((x) => x.values.last_name === 'Widerruf')).toBe(true);
    await node.deps.db
      .updateTable('consent_record')
      .set({ status: 'withdrawn', withdrawn_at: new Date() })
      .where('id', '=', consentId)
      .execute();
    expect(allowed(await serve(id)).rows.some((x) => x.values.last_name === 'Widerruf')).toBe(false);
    await node.deps.db.deleteFrom('dataset_record').where('athlete_id', '=', a).execute();
  });

  test('ohne Einwilligungspflicht (keine besondere Kategorie): alle Personen', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
      requiresConsent: false,
    });
    expect(allowed(await serve(id)).rows).toHaveLength(10);
  });
});

describe('PEP: besondere Kategorien (Gesundheit)', () => {
  test('Freigabe ohne Einwilligungspflicht liefert nie Gesundheitsdaten', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: healthProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['medical_care'],
      columns: ['last_name', 'hr'],
      requiresConsent: false,
    });
    expect(reason(await serve(id, { purpose: 'medical_care' }))).toBe('special_category_requires_consent');
  });

  test('mit Einwilligungspflicht: nur Personen mit Einwilligung für Gesundheitsdaten', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: healthProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['medical_care'],
      columns: ['last_name', 'hr'],
      requiresConsent: true,
    });
    const r = allowed(await serve(id, { purpose: 'medical_care' }));
    expect(r.rows.map((x) => x.values)).toEqual([
      { last_name: 'Adler', hr: 52 },
      { last_name: 'Berg', hr: 58 },
    ]);
    expect(r.product.specialCategory).toBe(true);
    expect(r.product.category).toBe('health');
  });

  test('Einwilligung für Leistungsdaten deckt keine Gesundheitsdaten', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: healthProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
      requiresConsent: true,
    });
    // ben hat training_steering nur für performance
    const r = allowed(await serve(id));
    expect(r.rows.map((x) => x.values.last_name)).toEqual(['Adler']);
  });
});

describe('PEP: Produktänderung, Stilllegung, Widerruf, Gültigkeit', () => {
  test('Produktänderung (neue Version) → product_changed', async () => {
    const pid = await seedProduct(node.deps.db, {
      slug: 'aenderung',
      datasetId: seed.performance,
      columns: PERF_COLUMNS.slice(0, 2),
    });
    const id = await seedRelease(node.deps.db, {
      productId: pid,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
    });
    expect(reason(await serve(id))).toBe('allowed');
    const res = await node.request<{ version: number }>('PATCH', `/api/v1/products/${pid}`, {
      as: steward,
      body: { columns: PERF_COLUMNS.slice(0, 3) },
    });
    expect(res.status).toBe(200);
    expect(res.json.version).toBe(2);
    expect(reason(await serve(id))).toBe('product_changed');
  });

  test('stillgelegtes Produkt → product_inactive; Stilllegung über die API widerruft Freigaben', async () => {
    const pid = await seedProduct(node.deps.db, {
      slug: 'still',
      datasetId: seed.performance,
      columns: PERF_COLUMNS,
    });
    const id = await seedRelease(node.deps.db, {
      productId: pid,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
    });
    await node.deps.db.updateTable('data_product').set({ status: 'retired' }).where('id', '=', pid).execute();
    expect(reason(await serve(id))).toBe('product_inactive');

    const pid2 = await seedProduct(node.deps.db, {
      slug: 'still2',
      datasetId: seed.performance,
      columns: PERF_COLUMNS,
    });
    const id2 = await seedRelease(node.deps.db, {
      productId: pid2,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
    });
    const res = await node.request('POST', `/api/v1/products/${pid2}/retire`, { as: steward });
    expect(res.status).toBe(200);
    expect(reason(await serve(id2))).toBe('revoked');
  });

  test('widerrufene Freigabe → revoked (ab Widerrufszeitpunkt)', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
    });
    const res = await node.request('POST', `/api/v1/releases/${id}/revoke`, {
      as: steward,
      body: { reason: 'Test' },
    });
    expect(res.status).toBe(200);
    expect(reason(await serve(id))).toBe('revoked');
    // nicht rückwirkend: Abruf zu einem früheren Zeitpunkt
    expect(reason(await serve(id, { at: new Date(T0.getTime() - 1000) }))).toBe('allowed');
  });

  test('Gültigkeit: noch nicht gültig, gültig, abgelaufen (Uhr des Knotens)', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
      validFrom: new Date(T0.getTime() + 3600_000),
      validUntil: new Date(T0.getTime() + 2 * 3600_000),
    });
    try {
      clock = T0;
      expect(reason(await serve(id))).toBe('not_yet_valid');
      clock = new Date(T0.getTime() + 3600_000);
      expect(reason(await serve(id))).toBe('allowed');
      clock = new Date(T0.getTime() + 2 * 3600_000);
      expect(reason(await serve(id))).toBe('expired');
    } finally {
      clock = T0;
    }
  });
});

describe('PEP: Partnerknoten', () => {
  test('nur der benannte, vertrauenswürdige Partner', async () => {
    const id = await seedRelease(node.deps.db, {
      productId: perfProduct,
      recipient: { type: 'peer', peerId: seed.peers.trusted.id },
      purposes: ['training_steering'],
      columns: ['last_name', 'cmj'],
    });
    const ok = allowed(
      await serve(id, { requester: { type: 'peer', peerId: seed.peers.trusted.id, peerStatus: 'trusted' } }),
    );
    expect(ok.rows).toHaveLength(10);
    expect(ok.rows.every((r) => typeof r.athleteId === 'string')).toBe(true);
    expect(
      reason(
        await serve(id, {
          requester: { type: 'peer', peerId: seed.peers.trusted.id, peerStatus: 'suspended' },
        }),
      ),
    ).toBe('peer_not_trusted');
    expect(
      reason(
        await serve(id, {
          requester: { type: 'peer', peerId: seed.peers.trusted.id, peerStatus: 'pending' },
        }),
      ),
    ).toBe('peer_not_trusted');
    expect(
      reason(
        await serve(id, {
          requester: { type: 'peer', peerId: seed.peers.suspended.id, peerStatus: 'trusted' },
        }),
      ),
    ).toBe('recipient_mismatch');
    expect(reason(await serve(id))).toBe('recipient_mismatch');
  });

  test('internes Produkt wird nie an Partner ausgegeben', async () => {
    const pid = await seedProduct(node.deps.db, {
      slug: 'intern',
      datasetId: seed.performance,
      columns: PERF_COLUMNS,
      shareability: 'internal',
    });
    const id = await seedRelease(node.deps.db, {
      productId: pid,
      recipient: { type: 'peer', peerId: seed.peers.trusted.id },
      purposes: ['training_steering'],
      columns: ['last_name'],
    });
    expect(
      reason(
        await serve(id, {
          requester: { type: 'peer', peerId: seed.peers.trusted.id, peerStatus: 'trusted' },
        }),
      ),
    ).toBe('not_shareable');
  });

  test('Produkt eines internen Datensatzes ist intern, auch wenn das Produkt teilbar gespeichert ist', async () => {
    const ds = await seedDataset(node.deps.db, {
      slug: 'intern_ds',
      category: 'training',
      shareability: 'internal',
      fields: [{ name: 'x', type: 'integer' }],
    });
    const a = await seedAthlete(node.deps.db, { lastName: 'Intern' });
    await seedRecord(node.deps.db, { datasetId: ds, athleteId: a, data: { x: 1 } });
    const pid = await seedProduct(node.deps.db, {
      slug: 'intern_ds_prod',
      datasetId: ds,
      columns: [{ key: 'x', source: 'data.x' }],
      shareability: 'on_request',
    });
    const id = await seedRelease(node.deps.db, {
      productId: pid,
      recipient: { type: 'peer', peerId: seed.peers.trusted.id },
      purposes: ['training_steering'],
      columns: ['x'],
    });
    expect(
      reason(
        await serve(id, {
          requester: { type: 'peer', peerId: seed.peers.trusted.id, peerStatus: 'trusted' },
        }),
      ),
    ).toBe('not_shareable');
  });
});

describe('Katalogangebote für Partner (services.offers)', () => {
  test('nur aktive, teilbare Produkte; Freigaben nur des anfragenden Partners', async () => {
    const offers = await node.deps.services.offers.offersForPeer(seed.peers.trusted.id);
    const slugs = offers.map((o) => o.slug);
    expect(slugs).toContain('leistung');
    expect(slugs).not.toContain('intern');
    expect(slugs).not.toContain('intern_ds_prod');
    expect(slugs).not.toContain('still');
    const leistung = offers.find((o) => o.slug === 'leistung')!;
    expect(leistung.columns.find((c) => c.key === 'cmj')).toEqual({
      key: 'cmj',
      label: 'CMJ',
      type: 'number',
      unit: 'cm',
    });
    expect(leistung.releases.length).toBeGreaterThanOrEqual(1);
    expect(leistung.releases[0]!.columns).toEqual(['last_name', 'cmj']);
    // Produkte ohne Freigabe sind als Metadaten sichtbar
    const kader = offers.find((o) => o.slug === 'kader')!;
    expect(kader.releases).toEqual([]);
    expect(kader.category).toBe('master');

    const filtered = await node.deps.services.offers.offersForPeer(seed.peers.trusted.id, 'kad');
    expect(filtered.map((o) => o.slug)).toEqual(['kader']);
    expect(await node.deps.services.offers.offersForPeer(seed.peers.trusted.id, '%')).toEqual([]);

    // anderer Partner sieht keine fremden Freigaben; ausstehende und gesperrte Partner gar nichts
    const otherPeer = await seedPeer(node.deps.db, { status: 'trusted' });
    const other = await node.deps.services.offers.offersForPeer(otherPeer.id);
    expect(other.find((o) => o.slug === 'leistung')?.releases).toEqual([]);
    expect(await node.deps.services.offers.offersForPeer(seed.peers.pending.id)).toEqual([]);
    expect(await node.deps.services.offers.offersForPeer(seed.peers.suspended.id)).toEqual([]);
  });
});
