/**
 * Föderation: Abruf (Pull) mit Herkunftsnachweis, Pseudonyme, Ablehnungen, Mitteilungen über das
 * Ausgangspostfach (Widerruf, Einwilligungswiderruf, Löschung), Wiederholungen, Discovery,
 * Aufbewahrung, empfangene Daten und Austauschprotokoll.
 *
 * A = Datenhalter, B = Empfänger, C = weiterer Partner von B.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sendSigned } from '../../src/server/modules/federation/client.ts';
import { runRetention } from '../../src/server/modules/federation/outbox.ts';
import type { ServedRow } from '../../src/server/modules/releases/engine.ts';
import type { DiscoveryResult, Peer, ReceivedProduct } from '../../src/shared/contract/federation.ts';
import type { ExchangeLogEntry } from '../../src/shared/contract/releases.ts';
import {
  adminOf,
  auditEntries,
  type FakeRelease,
  fakeOffers,
  fakePep,
  onboard,
  peerRow,
  sampleOffer,
  TEST_COLUMNS,
  TestClock,
} from '../helpers/federation.ts';
import { TestMesh, type TestNode, type TestUser } from '../helpers/node.ts';

const mesh = new TestMesh();
const clockA = new TestClock();
const clockB = new TestClock();
let a: TestNode;
let b: TestNode;
let c: TestNode;
let bOnA: Peer;
let aOnB: Peer;
let cOnB: Peer;
let steward: TestUser;
let analyst: TestUser;

const releases = new Map<string, FakeRelease>();
const PURPOSE = 'training_steering';

interface Fixture {
  athlete1: string;
  athlete2: string;
  consent1: string;
  r1: string;
  r2: string;
  /** dritte Freigabe, erst im Nebenläufigkeitstest geliefert */
  r3: string;
}
let fx: Fixture;

type ErrorJson = { error: { code: string; reason?: string } };
type ReceivedDetail = ReceivedProduct & {
  provenance: Record<string, unknown>;
  history: ExchangeLogEntry[];
};

/** Fachliche Daten auf A: zwei Personen, Datensatz, Produkt, zwei Partnerfreigaben für B */
async function createFixture(node: TestNode, peerId: string): Promise<Fixture> {
  const db = node.deps.db;
  const athlete = (last: string) =>
    db
      .insertInto('athlete')
      .values({
        last_name: last,
        first_name: 'Test',
        date_of_birth: '2001-02-03',
        sport: 'Rudern',
        squad_status: 'OK',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  const a1 = await athlete('Eins');
  const a2 = await athlete('Zwei');
  const consent = (athleteId: string) =>
    db
      .insertInto('consent_record')
      .values({
        athlete_id: athleteId,
        purpose: PURPOSE,
        data_category: 'performance',
        status: 'granted',
        valid_from: '2020-01-01',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  const c1 = await consent(a1.id);
  await consent(a2.id);
  const ds = await db
    .insertInto('dataset')
    .values({ slug: 'spiro', name: 'Spiroergometrie', category: 'performance', fields: JSON.stringify([]) })
    .returning('id')
    .executeTakeFirstOrThrow();
  const product = await db
    .insertInto('data_product')
    .values({
      slug: 'leistungsdiagnostik',
      name: 'Leistungsdiagnostik',
      source_type: 'dataset',
      dataset_id: ds.id,
      columns: JSON.stringify([
        { key: 'test_date', label: 'Testdatum', source: 'record.observed_at' },
        { key: 'vo2max', label: 'VO2max', source: 'data.vo2max' },
      ]),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const release = () =>
    db
      .insertInto('data_release')
      .values({
        product_id: product.id,
        product_version: 1,
        recipient_type: 'peer',
        recipient_peer_id: peerId,
        purposes: [PURPOSE],
        columns: ['test_date', 'vo2max'],
        requires_consent: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  const r1 = await release();
  const r2 = await release();
  const r3 = await release();
  return { athlete1: a1.id, athlete2: a2.id, consent1: c1.id, r1: r1.id, r2: r2.id, r3: r3.id };
}

function rowsFor(fixture: Fixture): ServedRow[] {
  return [
    // zusätzlicher, nicht freigegebener Wert: darf den Knoten nie verlassen
    { athleteId: fixture.athlete1, values: { test_date: '2026-01-10', vo2max: 61.2, intern: 'geheim' } },
    { athleteId: fixture.athlete1, values: { test_date: '2026-03-10', vo2max: 62.5 } },
    { athleteId: fixture.athlete2, values: { test_date: '2026-01-11', vo2max: 55.1 } },
    { athleteId: null, values: { test_date: '2026-01-12', vo2max: 49.9 } },
  ];
}

async function pull(releaseId: string, purpose = PURPOSE) {
  return b.request<ReceivedProduct & ErrorJson>('POST', '/api/v1/received/pull', {
    as: steward,
    body: { peerId: aOnB.id, releaseId, purpose },
  });
}

async function receivedRows(releaseId: string) {
  return b.deps.db
    .selectFrom('received_row as r')
    .innerJoin('received_product as p', 'p.id', 'r.received_product_id')
    .select(['r.subject', 'r.data', 'p.purpose'])
    .where('p.remote_release_id', '=', releaseId)
    .orderBy('r.id')
    .execute();
}

async function receivedProduct(releaseId: string, purpose = PURPOSE) {
  return b.deps.db
    .selectFrom('received_product')
    .selectAll()
    .where('remote_release_id', '=', releaseId)
    .where('purpose', '=', purpose)
    .executeTakeFirstOrThrow();
}

async function outbox(node: TestNode) {
  return node.deps.db.selectFrom('outbox_message').selectAll().orderBy('created_at').execute();
}

async function flush(node: TestNode) {
  const r = await node.request<{ delivered: number; failed: number }>('POST', '/api/v1/outbox/flush', {
    as: await adminOf(node),
  });
  expect(r.status).toBe(200);
  return r.json;
}

beforeAll(async () => {
  a = await mesh.add({ nodeId: 'osp-a', displayName: 'OSP A', now: clockA.now });
  b = await mesh.add({ nodeId: 'osp-b', displayName: 'OSP B', now: clockB.now });
  c = await mesh.add({ nodeId: 'osp-c', displayName: 'OSP C' });
  ({ bOnA, aOnB } = await onboard(a, b));
  ({ bOnA: cOnB } = await onboard(b, c));
  steward = await b.user(['data_steward']);
  analyst = await b.user(['analyst']);
  fx = await createFixture(a, bOnA.id);
  releases.set(fx.r1, { id: fx.r1, peerId: bOnA.id, purposes: [PURPOSE], rows: rowsFor(fx) });
  releases.set(fx.r2, { id: fx.r2, peerId: bOnA.id, purposes: [PURPOSE], rows: rowsFor(fx) });
});
afterAll(async () => {
  await mesh.close();
});

describe('Föderation: Abruf', () => {
  test('Abruf speichert Zeilen mit Herkunftsnachweis; Protokoll und Audit auf beiden Seiten', async () => {
    const calls = fakePep(a, releases);
    const r = await pull(fx.r1);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      remoteReleaseId: fx.r1,
      remoteProductSlug: 'leistungsdiagnostik',
      title: 'Leistungsdiagnostik',
      purpose: PURPOSE,
      status: 'active',
      rowCount: 4,
      columns: TEST_COLUMNS,
      peer: { nodeId: 'osp-a' },
    });
    expect(r.json.payloadSha256).toMatch(/^[0-9a-f]{64}$/);

    // PEP wurde mit dem anfragenden Partner als Empfänger gefragt
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      releaseId: fx.r1,
      purpose: PURPOSE,
      requester: { type: 'peer', peerId: bOnA.id, peerStatus: 'trusted' },
    });

    // Zeilen: nur freigegebene Spalten, Pseudonyme statt IDs
    const rows = await receivedRows(fx.r1);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(Object.keys(row.data as object).sort()).toEqual(['test_date', 'vo2max']);
    const p1 = a.deps.identity.pseudonym(fx.r1, fx.athlete1);
    const p2 = a.deps.identity.pseudonym(fx.r1, fx.athlete2);
    expect(rows.map((x) => x.subject).slice(0, 3)).toEqual([p1, p1, p2]);
    expect(rows[3]!.subject).toBe(a.deps.identity.pseudonym(fx.r1, 'row:3'));
    expect(JSON.stringify(rows)).not.toContain(fx.athlete1);
    expect(JSON.stringify(rows)).not.toContain('geheim');

    // Austauschprotokoll beider Seiten passt zusammen (gleicher Hash, gleiche Nachrichten-id)
    const out = await a.deps.db
      .selectFrom('exchange_log')
      .selectAll()
      .where('direction', '=', 'outgoing')
      .execute();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      outcome: 'delivered',
      release_id: fx.r1,
      peer_id: bOnA.id,
      peer_node_id: 'osp-b',
      purpose: PURPOSE,
      row_count: 4,
      columns: ['test_date', 'vo2max'],
      product_ref: 'leistungsdiagnostik',
    });
    expect([...out[0]!.subjects].sort()).toEqual([p1, p2, a.deps.identity.pseudonym(fx.r1, 'row:3')].sort());
    const inc = await b.deps.db
      .selectFrom('exchange_log')
      .selectAll()
      .where('direction', '=', 'incoming')
      .execute();
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({
      outcome: 'delivered',
      remote_release_id: fx.r1,
      row_count: 4,
      peer_node_id: 'osp-a',
    });
    expect(inc[0]!.payload_sha256).toBe(out[0]!.payload_sha256);
    expect(inc[0]!.payload_sha256).toBe(r.json.payloadSha256);
    expect(inc[0]!.request_id).toBe(out[0]!.request_id);

    const served = await auditEntries(a, 'exchange.pull.served');
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ actor_type: 'peer', actor_id: 'osp-b', outcome: 'success' });
    expect(served[0]!.details).toMatchObject({ releaseId: fx.r1, purpose: PURPOSE, rowCount: 4 });
    expect(JSON.stringify(served[0]!.details)).not.toContain(fx.athlete1);
    const received = await auditEntries(b, 'exchange.pull.received');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ actor_type: 'user', actor_id: steward.id, outcome: 'success' });

    // Herkunftsnachweis
    const g = await b.request<ReceivedDetail>('GET', `/api/v1/received/${r.json.id}`, { as: analyst });
    expect(g.status).toBe(200);
    expect(g.json.provenance).toMatchObject({
      sourceNodeId: 'osp-a',
      sourceNodeName: 'OSP A',
      sourceFingerprint: a.deps.identity.fingerprint,
      remoteReleaseId: fx.r1,
      productVersion: 1,
      purpose: PURPOSE,
      payloadSha256: r.json.payloadSha256,
    });
    expect(String(g.json.provenance.responseSignature)).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(g.json.history).toHaveLength(1);
    expect((await peerRow(b, a)).last_seen_at).not.toBeNull();
  });

  test('Pseudonyme sind je Freigabe stabil und zwischen Freigaben verschieden; Abruf ersetzt die Kopie', async () => {
    const before = (await receivedRows(fx.r1)).map((r) => r.subject);
    const again = await pull(fx.r1);
    expect(again.status).toBe(200);
    expect(again.json.rowCount).toBe(4);
    const after = (await receivedRows(fx.r1)).map((r) => r.subject);
    expect(after).toEqual(before);

    const other = await pull(fx.r2);
    expect(other.status).toBe(200);
    const r2Subjects = (await receivedRows(fx.r2)).map((r) => r.subject);
    expect(r2Subjects[0]).toBe(a.deps.identity.pseudonym(fx.r2, fx.athlete1));
    expect(r2Subjects[0]).not.toBe(before[0]);
    expect(new Set([...before, ...r2Subjects]).size).toBe(6);
  });

  test('abgelehnter Abruf → peer_rejected mit Grund; release_not_found/recipient_mismatch nur als not_found', async () => {
    const denied = await pull(fx.r1, 'research');
    expect(denied.status).toBe(502);
    expect(denied.json.error).toMatchObject({ code: 'peer_rejected', reason: 'purpose_not_allowed' });

    const unknown = randomUUID();
    const nf = await pull(unknown);
    expect(nf.status).toBe(502);
    expect(nf.json.error).toMatchObject({ code: 'peer_rejected', reason: 'not_found' });

    const foreign = randomUUID();
    releases.set(foreign, { id: foreign, peerId: randomUUID() });
    const mismatch = await pull(foreign);
    expect(mismatch.json.error).toMatchObject({ code: 'peer_rejected', reason: 'not_found' });

    const aDenied = await a.deps.db
      .selectFrom('exchange_log')
      .selectAll()
      .where('outcome', '=', 'denied')
      .orderBy('at')
      .execute();
    expect(aDenied.map((e) => e.deny_reason)).toEqual([
      'purpose_not_allowed',
      'release_not_found',
      'recipient_mismatch',
    ]);
    expect(aDenied.every((e) => e.direction === 'outgoing' && e.peer_id === bOnA.id)).toBe(true);
    expect(await auditEntries(a, 'exchange.pull.denied')).toHaveLength(3);
    const bDenied = await b.deps.db
      .selectFrom('exchange_log')
      .selectAll()
      .where('outcome', '=', 'denied')
      .execute();
    expect(bDenied.map((e) => e.deny_reason).sort()).toEqual([
      'not_found',
      'not_found',
      'purpose_not_allowed',
    ]);
    expect(
      (await auditEntries(b, 'exchange.pull.received')).filter((e) => e.outcome === 'denied'),
    ).toHaveLength(3);
    // bestehende Kopie bleibt bei solchen Ablehnungen erhalten
    expect((await receivedProduct(fx.r1)).status).toBe('active');
  });

  test('Mitteilung eines Knotens, der nicht Datenhalter ist, betrifft keine Zeilen', async () => {
    const bOnC = await peerRow(c, b);
    const subjects = (await receivedRows(fx.r1)).map((r) => r.subject);
    const revoke = await sendSigned(c.deps, bOnC, 'notice', {
      kind: 'release_revoked',
      releaseId: fx.r1,
      reason: 'x',
    });
    expect(revoke.body).toEqual({ ack: true, affectedRows: 0 });
    const withdraw = await sendSigned(c.deps, bOnC, 'notice', {
      kind: 'subjects_withdrawn',
      releaseId: fx.r1,
      subjects,
      reason: 'erasure',
    });
    expect(withdraw.body).toEqual({ ack: true, affectedRows: 0 });
    expect(await receivedRows(fx.r1)).toHaveLength(4);
    expect((await receivedProduct(fx.r1)).status).toBe('active');
  });

  test('Rollen: nur Datenverantwortliche rufen ab; nur vertrauenswürdige Partner', async () => {
    for (const roles of [['analyst'], ['admin']] as const) {
      const u = await b.user([...roles]);
      const r = await b.request('POST', '/api/v1/received/pull', {
        as: u,
        body: { peerId: aOnB.id, releaseId: fx.r1, purpose: PURPOSE },
      });
      expect(r.status).toBe(403);
    }
    await b.request('POST', `/api/v1/peers/${cOnB.id}/suspend`, { as: await adminOf(b) });
    const r = await b.request<ErrorJson>('POST', '/api/v1/received/pull', {
      as: steward,
      body: { peerId: cOnB.id, releaseId: fx.r1, purpose: PURPOSE },
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('peer_untrusted');
    await b.request('POST', `/api/v1/peers/${cOnB.id}/trust`, {
      as: await adminOf(b),
      body: { fingerprint: cOnB.fingerprint },
    });
  });
});

describe('Föderation: Mitteilungen über das Ausgangspostfach', () => {
  test('Einwilligungswiderruf → subjects_withdrawn → nur Zeilen dieser Person werden beim Empfänger gelöscht', async () => {
    // Widerruf für einen anderen Zweck: keine Mitteilung
    await a.deps.db.transaction().execute((trx) =>
      a.deps.events.inTx(trx, 'consent.withdrawn', {
        athleteId: fx.athlete1,
        consentId: randomUUID(),
        purpose: 'research',
        dataCategory: '*',
      }),
    );
    expect(await outbox(a)).toHaveLength(0);

    await a.deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('consent_record')
        .set({ status: 'withdrawn', withdrawn_at: new Date() })
        .where('id', '=', fx.consent1)
        .execute();
      await a.deps.events.inTx(trx, 'consent.withdrawn', {
        athleteId: fx.athlete1,
        consentId: fx.consent1,
        purpose: PURPOSE,
        dataCategory: 'performance',
      });
    });
    const pending = await outbox(a);
    // je gelieferter Freigabe eine Mitteilung
    expect(pending).toHaveLength(2);
    expect(pending.map((m) => (m.body as { releaseId: string }).releaseId).sort()).toEqual(
      [fx.r1, fx.r2].sort(),
    );
    expect(pending[0]!.body).toMatchObject({
      kind: 'subjects_withdrawn',
      reason: 'consent_withdrawn',
      subjects: [expect.any(String)],
    });

    expect(await flush(a)).toEqual({ delivered: 2, failed: 0 });
    const p1 = a.deps.identity.pseudonym(fx.r1, fx.athlete1);
    const left = await receivedRows(fx.r1);
    expect(left).toHaveLength(2);
    expect(left.some((r) => r.subject === p1)).toBe(false);
    expect((await receivedProduct(fx.r1)).row_count).toBe(2);
    expect((await receivedProduct(fx.r1)).status).toBe('active');
    expect(await receivedRows(fx.r2)).toHaveLength(2);

    expect((await outbox(a)).every((m) => m.status === 'delivered' && m.delivered_at !== null)).toBe(true);
    const sent = await auditEntries(a, 'exchange.notice.sent');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.details).toMatchObject({ kind: 'subjects_withdrawn', affectedRows: 2 });
    // (die beiden Mitteilungen von C aus dem vorigen Test sind ebenfalls protokolliert, mit 0 Zeilen)
    const fromC = (await auditEntries(b, 'exchange.notice.received')).filter((e) => e.actor_id === 'osp-c');
    expect(fromC.map((e) => e.details.affectedRows)).toEqual([0, 0]);
    const rec = (await auditEntries(b, 'exchange.notice.received')).filter((e) => e.actor_id === 'osp-a');
    expect(rec).toHaveLength(2);
    expect(rec[0]).toMatchObject({ actor_type: 'peer', actor_id: 'osp-a' });
    expect(rec[0]!.details).toMatchObject({ kind: 'subjects_withdrawn', affectedRows: 2 });
  });

  test('Löschung einer Person → erasure-Mitteilung für alle gelieferten Freigaben', async () => {
    await a.deps.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('athlete').where('id', '=', fx.athlete2).execute();
      await a.deps.events.inTx(trx, 'athlete.deleted', { athleteId: fx.athlete2 });
    });
    const pending = (await outbox(a)).filter((m) => m.status === 'pending');
    expect(pending).toHaveLength(2);
    expect(pending[0]!.body).toMatchObject({ kind: 'subjects_withdrawn', reason: 'erasure' });
    expect(await flush(a)).toEqual({ delivered: 2, failed: 0 });
    for (const r of [fx.r1, fx.r2]) {
      const rows = await receivedRows(r);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.subject).toBe(a.deps.identity.pseudonym(r, 'row:3'));
    }
  });

  test('Widerruf → release_revoked über das Ausgangspostfach → Kopie gelöscht, Status revoked', async () => {
    await a.deps.db.transaction().execute((trx) =>
      a.deps.events.inTx(trx, 'release.revoked', {
        releaseId: fx.r2,
        productId: randomUUID(),
        recipientType: 'peer',
        recipientRole: null,
        recipientPeerId: bOnA.id,
        reason: 'Kooperation beendet',
      }),
    );
    // lokale Rollenfreigaben erzeugen keine Mitteilung
    await a.deps.db.transaction().execute((trx) =>
      a.deps.events.inTx(trx, 'release.revoked', {
        releaseId: randomUUID(),
        productId: randomUUID(),
        recipientType: 'role',
        recipientRole: 'analyst',
        recipientPeerId: null,
        reason: 'x',
      }),
    );
    const list = await a.request<{ items: { status: string; peerNodeId: string; type: string }[] }>(
      'GET',
      '/api/v1/outbox',
      { as: await adminOf(a) },
    );
    expect(list.status).toBe(200);
    expect(list.json.items.filter((m) => m.status === 'pending')).toEqual([
      expect.objectContaining({ peerNodeId: 'osp-b', type: 'notice' }),
    ]);

    expect(await flush(a)).toEqual({ delivered: 1, failed: 0 });
    const rp = await receivedProduct(fx.r2);
    expect(rp).toMatchObject({ status: 'revoked', status_reason: 'Kooperation beendet', row_count: 0 });
    expect(rp.status_changed_at).not.toBeNull();
    expect(await receivedRows(fx.r2)).toHaveLength(0);
    const notices = await b.deps.db
      .selectFrom('exchange_log')
      .selectAll()
      .where('product_ref', '=', 'notice:release_revoked')
      .where('peer_node_id', '=', 'osp-a')
      .execute();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ direction: 'incoming', remote_release_id: fx.r2, row_count: 1 });
  });

  test('Ablehnung "revoked" beim Abruf löscht die lokale Kopie', async () => {
    releases.set(fx.r1, { ...releases.get(fx.r1)!, deny: 'revoked' });
    const r = await pull(fx.r1);
    expect(r.status).toBe(502);
    expect(r.json.error).toMatchObject({ code: 'peer_rejected', reason: 'revoked' });
    expect(await receivedRows(fx.r1)).toHaveLength(0);
    expect(await receivedProduct(fx.r1)).toMatchObject({
      status: 'revoked',
      status_reason: 'revoked',
      row_count: 0,
    });
    // erneut freigegeben → Abruf aktiviert die Kopie wieder
    releases.set(fx.r1, { ...releases.get(fx.r1)!, deny: undefined });
    const again = await pull(fx.r1);
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('active');
  });

  test('Wiederholung bei nicht erreichbarem Partner mit Backoff', async () => {
    await a.deps.db.transaction().execute((trx) =>
      a.deps.events.inTx(trx, 'release.revoked', {
        releaseId: fx.r1,
        productId: randomUUID(),
        recipientType: 'peer',
        recipientRole: null,
        recipientPeerId: bOnA.id,
        reason: 'Ende',
      }),
    );
    mesh.nodes.delete('osp-b');
    try {
      const t0 = a.deps.now().getTime();
      expect(await flush(a)).toEqual({ delivered: 0, failed: 1 });
      const [m] = (await outbox(a)).filter((x) => x.status === 'pending');
      expect(m).toMatchObject({ attempts: 1, last_error: 'peer_unreachable' });
      const wait = m!.next_attempt_at.getTime() - t0;
      expect(wait).toBeGreaterThanOrEqual(9_000);
      expect(wait).toBeLessThanOrEqual(15_000);
      // noch nicht fällig
      expect(await flush(a)).toEqual({ delivered: 0, failed: 0 });
    } finally {
      mesh.nodes.set('osp-b', b);
    }
    expect(await flush(a)).toEqual({ delivered: 0, failed: 0 });
    clockA.advance(11_000);
    expect(await flush(a)).toEqual({ delivered: 1, failed: 0 });
    const done = (await outbox(a)).at(-1)!;
    expect(done).toMatchObject({ status: 'delivered', attempts: 2, last_error: null });
    expect((await receivedProduct(fx.r1)).status).toBe('revoked');
  });

  test('Einwilligungswiderruf während eines laufenden Abrufs wird nicht übersehen (Liefersperre)', async () => {
    const base = a.deps.services.pep;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered = false;
    a.deps.services.pep = {
      async serve(req) {
        entered = true;
        await gate;
        return base.serve(req);
      },
    };
    releases.set(fx.r3, { id: fx.r3, peerId: bOnA.id, purposes: [PURPOSE], rows: rowsFor(fx) });
    try {
      // Abruf von r3 (noch nie geliefert) hängt im PEP, die Einwilligung wird gleichzeitig widerrufen
      const pulling = pull(fx.r3);
      while (!entered) await Bun.sleep(5);
      let committed = false;
      const withdrawing = a.deps.db
        .transaction()
        .execute((trx) =>
          a.deps.events.inTx(trx, 'consent.withdrawn', {
            athleteId: fx.athlete1,
            consentId: randomUUID(),
            purpose: PURPOSE,
            dataCategory: '*',
          }),
        )
        .then(() => {
          committed = true;
        });
      await Bun.sleep(100);
      expect(committed).toBe(false); // wartet auf die laufende Lieferung
      open();
      expect((await pulling).status).toBe(200);
      await withdrawing;
    } finally {
      a.deps.services.pep = base;
    }
    const pending = (await outbox(a)).filter((m) => m.status === 'pending');
    expect(pending.map((m) => (m.body as { releaseId: string }).releaseId)).toContain(fx.r3);
    expect((await flush(a)).failed).toBe(0);
    const p1 = a.deps.identity.pseudonym(fx.r3, fx.athlete1);
    const rows = await receivedRows(fx.r3);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.subject === p1)).toBe(false);
  });

  test('Mitteilung, die während eines Abrufs eintrifft, wird auf die gespeicherte Antwort angewandt', async () => {
    const bOnARow = await peerRow(a, b);
    const original = b.deps.fetch;
    let notice: unknown = null;
    // Antwort von A liegt vor, aber bevor B sie speichert, trifft eine Mitteilung von A ein
    b.deps.fetch = async (input, init) => {
      const res = await original(input, init);
      if (notice) await sendSigned(a.deps, bOnARow, 'notice', notice);
      return res;
    };
    try {
      const p1 = a.deps.identity.pseudonym(fx.r3, fx.athlete1);
      notice = { kind: 'subjects_withdrawn', releaseId: fx.r3, subjects: [p1], reason: 'consent_withdrawn' };
      const r = await pull(fx.r3);
      expect(r.status).toBe(200);
      expect(r.json.rowCount).toBe(2);
      expect((await receivedRows(fx.r3)).some((x) => x.subject === p1)).toBe(false);

      notice = { kind: 'release_revoked', releaseId: fx.r3, reason: 'Ende' };
      const revoked = await pull(fx.r3);
      expect(revoked.status).toBe(502);
      expect(revoked.json.error).toMatchObject({ code: 'peer_rejected', reason: 'revoked' });
      expect(await receivedProduct(fx.r3)).toMatchObject({ status: 'revoked', row_count: 0 });
      expect(await receivedRows(fx.r3)).toHaveLength(0);
    } finally {
      b.deps.fetch = original;
    }
    // erneuter Abruf ohne Mitteilung aktiviert die Kopie wieder
    expect((await pull(fx.r3)).status).toBe(200);
  });
});

describe('Föderation: Discovery', () => {
  test('parallele Katalogabfrage; Teilergebnisse mit Status je Partner', async () => {
    fakeOffers(a, (peerId) => (peerId === bOnA.id ? [sampleOffer(fx.r1)] : []));
    fakeOffers(c, () => []);
    const search = () =>
      b.request<typeof DiscoveryResult._output>('GET', '/api/v1/discovery?q=leistung', { as: analyst });

    const all = await search();
    expect(all.status).toBe(200);
    const byNode = (r: typeof all) => Object.fromEntries(r.json.results.map((x) => [x.peer.nodeId, x]));
    expect(byNode(all)['osp-a']).toMatchObject({ status: 'ok', errorCode: null });
    expect(byNode(all)['osp-a']!.offers[0]!.releases[0]!.releaseId).toBe(fx.r1);
    expect(byNode(all)['osp-c']).toMatchObject({ status: 'ok', offers: [] });

    mesh.nodes.delete('osp-c');
    try {
      const partial = await search();
      expect(partial.status).toBe(200);
      expect(byNode(partial)['osp-a']!.status).toBe('ok');
      expect(byNode(partial)['osp-c']).toMatchObject({
        status: 'unreachable',
        errorCode: 'peer_unreachable',
      });
    } finally {
      mesh.nodes.set('osp-c', c);
    }

    // C sperrt B → abgelehnt
    const bOnC = await peerRow(c, b);
    await c.request('POST', `/api/v1/peers/${bOnC.id}/suspend`, { as: await adminOf(c) });
    const rejected = await search();
    expect(byNode(rejected)['osp-c']).toMatchObject({ status: 'rejected', errorCode: 'untrusted' });

    expect((await auditEntries(a, 'exchange.catalog.served')).length).toBeGreaterThanOrEqual(3);
    expect((await auditEntries(b, 'discovery.search')).at(-1)!.details).toMatchObject({ peers: 2, ok: 1 });
    // Ergebnisse werden nicht gespeichert; Admin hat keinen Zugriff
    expect((await b.request('GET', '/api/v1/discovery', { as: await adminOf(b) })).status).toBe(403);
  });
});

describe('Föderation: empfangene Daten', () => {
  test('Zeilen lesen (JSON paginiert, CSV) mit Zugriffsprotokoll', async () => {
    expect((await pull(fx.r1)).status).toBe(200);
    const product = await receivedProduct(fx.r1);
    const page = await b.request<{
      columns: { key: string }[];
      rows: Record<string, unknown>[];
      total: number;
    }>('GET', `/api/v1/received/${product.id}/rows?pageSize=2`, { as: analyst });
    expect(page.status).toBe(200);
    expect(page.json.total).toBe(4);
    expect(page.json.rows).toHaveLength(2);
    expect(page.json.columns.map((x) => x.key)).toEqual(['subject', 'test_date', 'vo2max']);
    expect(page.json.rows[0]).toMatchObject({ test_date: '2026-01-10', vo2max: 61.2 });

    const csv = await b.request('GET', `/api/v1/received/${product.id}/rows?format=csv`, { as: analyst });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.text).toContain('subject,test_date,vo2max');
    expect(csv.text.trim().split('\r\n')).toHaveLength(5);

    const reads = await auditEntries(b, 'received.read');
    expect(reads.map((e) => e.details.format)).toEqual(['json', 'csv']);
    expect(reads[0]).toMatchObject({ actor_id: analyst.id, object_id: product.id });

    const coach = await b.user(['coach']);
    expect((await b.request('GET', `/api/v1/received/${product.id}/rows`, { as: coach })).status).toBe(403);
    const list = await b.request<{ items: ReceivedProduct[] }>('GET', '/api/v1/received', { as: analyst });
    expect(list.json.items.map((x) => x.remoteReleaseId).sort()).toEqual([fx.r1, fx.r2, fx.r3].sort());
  });

  test('lokale Kopie löschen', async () => {
    const product = await receivedProduct(fx.r1);
    expect((await b.request('DELETE', `/api/v1/received/${product.id}`, { as: analyst })).status).toBe(403);
    const r = await b.request('DELETE', `/api/v1/received/${product.id}`, { as: steward });
    expect(r.status).toBe(200);
    expect(await receivedProduct(fx.r1)).toMatchObject({ status: 'deleted', row_count: 0 });
    expect(await receivedRows(fx.r1)).toHaveLength(0);
    expect(await auditEntries(b, 'received.delete')).toHaveLength(1);
  });

  test('Aufbewahrung: abgelaufene Kopien werden gelöscht, alte Nonces entfernt', async () => {
    const r3 = randomUUID();
    releases.set(r3, {
      id: r3,
      peerId: bOnA.id,
      rows: rowsFor(fx).slice(3),
      validUntil: new Date(clockB.now().getTime() + 60 * 60_000),
    });
    const r = await pull(r3);
    expect(r.status).toBe(200);
    expect(r.json.releaseValidUntil).not.toBeNull();

    expect((await runRetention(b.deps)).expired).toBe(0);
    clockB.advance(2 * 60 * 60_000);
    try {
      const result = await runRetention(b.deps);
      expect(result.expired).toBe(1);
      expect(result.noncesPurged).toBeGreaterThan(0);
    } finally {
      clockB.reset();
    }
    expect(await receivedProduct(r3)).toMatchObject({ status: 'expired', row_count: 0 });
    expect(await receivedRows(r3)).toHaveLength(0);
    expect(await auditEntries(b, 'received.expire')).toHaveLength(1);
    const noncesLeft = await b.deps.db.selectFrom('federation_nonce').selectAll().execute();
    expect(noncesLeft).toHaveLength(0);
  });

  test('Austauschprotokoll: Revision liest, Filter nach Richtung', async () => {
    const auditor = await b.user(['auditor']);
    const all = await b.request<{ items: ExchangeLogEntry[]; total: number }>(
      'GET',
      '/api/v1/exchange-log?pageSize=500',
      {
        as: auditor,
      },
    );
    expect(all.status).toBe(200);
    expect(all.json.total).toBe(all.json.items.length);
    const incoming = await b.request<{ items: ExchangeLogEntry[]; total: number }>(
      'GET',
      '/api/v1/exchange-log?direction=incoming',
      { as: auditor },
    );
    expect(incoming.json.items.every((e) => e.direction === 'incoming')).toBe(true);
    expect(incoming.json.total).toBeGreaterThan(5);
    expect((await b.request('GET', '/api/v1/exchange-log', { as: analyst })).status).toBe(403);
    // Hash des Abrufs entspricht dem Hash der Rohantwort
    const delivered = all.json.items.find(
      (e) => e.outcome === 'delivered' && e.productRef === 'leistungsdiagnostik',
    );
    expect(delivered?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
