/**
 * Regression (Sicherheitsbefund 4 und offener Punkt Ausgangspostfach):
 *  - Sperrt der Empfänger B den Datenhalter A, nimmt B Mitteilungen von A (Widerruf, Löschung) weiterhin an
 *    und löscht die Daten; alle anderen Nachrichten von A bleiben abgelehnt, ebenso Mitteilungen
 *    ausstehender oder unbekannter Knoten.
 *  - "Jetzt zustellen" versucht endgültig fehlgeschlagene Mitteilungen erneut.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { lockDeliveries } from '../../src/server/core/locks.ts';
import { PeerCallError, sendSigned } from '../../src/server/modules/federation/client.ts';
import { enqueueNotice, flushOutbox, MAX_ATTEMPTS } from '../../src/server/modules/federation/outbox.ts';
import type { Peer } from '../../src/shared/contract/federation.ts';
import {
  addPeer,
  adminOf,
  auditEntries,
  type FakeRelease,
  fakePep,
  onboard,
  peerRow,
  rawSend,
  TestClock,
  trustPeer,
} from '../helpers/federation.ts';
import { TestMesh, type TestNode, type TestUser } from '../helpers/node.ts';

const mesh = new TestMesh();
const clock = new TestClock();
const PURPOSE = 'training_steering';
let a: TestNode;
let b: TestNode;
let d: TestNode;
let bOnA: Peer;
let aOnB: Peer;
let steward: TestUser;

const releases = new Map<string, FakeRelease>();
const athleteX = randomUUID();
const athleteY = randomUUID();

async function flush(node: TestNode) {
  const r = await node.request<{ delivered: number; failed: number }>('POST', '/api/v1/outbox/flush', {
    as: await adminOf(node),
  });
  expect(r.status).toBe(200);
  return r.json;
}

async function receivedRows(releaseId: string) {
  return b.deps.db
    .selectFrom('received_row as r')
    .innerJoin('received_product as p', 'p.id', 'r.received_product_id')
    .select(['r.subject', 'p.status'])
    .where('p.remote_release_id', '=', releaseId)
    .execute();
}

async function pullFromA(releaseId: string) {
  const r = await b.request<{ status: string }>('POST', '/api/v1/received/pull', {
    as: steward,
    body: { peerId: aOnB.id, releaseId, purpose: PURPOSE },
  });
  expect(r.status).toBe(200);
}

async function outboxOfA() {
  return a.deps.db.selectFrom('outbox_message').selectAll().orderBy('created_at').execute();
}

beforeAll(async () => {
  a = await mesh.add({ nodeId: 'osp-a', now: clock.now });
  b = await mesh.add({ nodeId: 'osp-b', now: clock.now });
  d = await mesh.add({ nodeId: 'osp-d', now: clock.now });
  ({ bOnA, aOnB } = await onboard(a, b));
  steward = await b.user(['data_steward']);
  fakePep(a, releases);
});
afterAll(async () => {
  await mesh.close();
});

describe('Föderation: Mitteilungen eines gesperrten Datenhalters', () => {
  test('B sperrt A: Löschmitteilung von A wird angenommen und gelöscht; andere Nachrichten von A bleiben abgelehnt', async () => {
    const r1 = randomUUID();
    const r2 = randomUUID();
    const rows = [
      { athleteId: athleteX, values: { test_date: '2026-01-10', vo2max: 61.2 } },
      { athleteId: athleteY, values: { test_date: '2026-01-11', vo2max: 55.1 } },
    ];
    releases.set(r1, { id: r1, peerId: bOnA.id, purposes: [PURPOSE], rows });
    releases.set(r2, { id: r2, peerId: bOnA.id, purposes: [PURPOSE], rows });
    await pullFromA(r1);
    await pullFromA(r2);
    expect(await receivedRows(r1)).toHaveLength(2);

    const suspended = await b.request<Peer>('POST', `/api/v1/peers/${aOnB.id}/suspend`, {
      as: await adminOf(b),
    });
    expect(suspended.json.status).toBe('suspended');

    // A löscht Person X → subjects_withdrawn (erasure) je belieferter Freigabe
    await a.deps.db.transaction().execute(async (trx) => {
      await lockDeliveries(trx, 'exclusive');
      await a.deps.events.inTx(trx, 'athlete.deleted', { athleteId: athleteX });
    });
    expect(await flush(a)).toEqual({ delivered: 2, failed: 0 });
    const xSubject = a.deps.identity.pseudonym(r1, athleteX);
    const left = await receivedRows(r1);
    expect(left).toHaveLength(1);
    expect(left.map((r) => r.subject)).not.toContain(xSubject);
    expect(await receivedRows(r2)).toHaveLength(1);
    const received = (await auditEntries(b, 'exchange.notice.received')).filter(
      (e) => e.details.reason === 'erasure',
    );
    expect(received).toHaveLength(2);

    // Widerruf einer Freigabe ebenso
    const aOnBTarget = await peerRow(a, b);
    const revoke = await sendSigned(a.deps, aOnBTarget, 'notice', {
      kind: 'release_revoked',
      releaseId: r2,
      reason: 'Ende',
    });
    expect(revoke.body).toEqual({ ack: true, affectedRows: 1 });
    expect(await receivedRows(r2)).toHaveLength(0);

    // alles andere von A bleibt abgelehnt
    for (const type of ['ping', 'catalog', 'pull'] as const) {
      const body = type === 'pull' ? { releaseId: r1, purpose: PURPOSE } : {};
      const r = await rawSend(b, { from: a, type, body });
      expect(r.status).toBe(401);
      expect(r.json.error?.code).toBe('untrusted');
    }
    // Pfad "notice", aber anderer Nachrichtentyp im Umschlag → bad_request (nur Mitteilungen)
    const sneaky = await rawSend(b, { from: a, type: 'catalog', pathType: 'notice' });
    expect(sneaky.json.error?.code).toBe('bad_request');

    await trustPeer(b, aOnB);
  });

  test('ausstehender oder unbekannter Absender: auch Mitteilungen werden abgelehnt', async () => {
    // B kennt D nur als "pending"; D vertraut B
    await addPeer(b, d);
    await trustPeer(d, await addPeer(d, b));
    const notice = { kind: 'release_revoked' as const, releaseId: randomUUID(), reason: 'x' };
    const err = await sendSigned(d.deps, await peerRow(d, b), 'notice', notice).catch((e) => e);
    expect(err).toBeInstanceOf(PeerCallError);
    expect((err as PeerCallError).remoteCode).toBe('untrusted');

    const unknown = await rawSend(b, { from: d, headerNode: 'osp-nobody', type: 'notice', body: notice });
    expect(unknown.json.error?.code).toBe('unknown_node');
  });
});

describe('Ausgangspostfach: endgültig fehlgeschlagene Mitteilungen', () => {
  test('"Jetzt zustellen" versucht fehlgeschlagene Mitteilungen erneut (Versuche bleiben erhalten); der Hintergrundlauf nicht', async () => {
    await enqueueNotice(
      a.deps.db,
      bOnA.id,
      { kind: 'release_revoked', releaseId: randomUUID(), reason: 'Ende' },
      clock.now(),
    );
    const [m] = (await outboxOfA()).filter((x) => x.status === 'pending');
    await a.deps.db
      .updateTable('outbox_message')
      .set({ attempts: MAX_ATTEMPTS - 1 })
      .where('id', '=', m!.id)
      .execute();

    mesh.nodes.delete('osp-b');
    try {
      expect(await flush(a)).toEqual({ delivered: 0, failed: 1 });
      const failed = (await outboxOfA()).find((x) => x.id === m!.id)!;
      expect(failed).toMatchObject({
        status: 'failed',
        attempts: MAX_ATTEMPTS,
        last_error: 'peer_unreachable',
      });
      // erneuter Versuch, Partner weiter nicht erreichbar → sofort wieder fehlgeschlagen
      expect(await flush(a)).toEqual({ delivered: 0, failed: 1 });
      expect((await outboxOfA()).find((x) => x.id === m!.id)).toMatchObject({
        status: 'failed',
        attempts: MAX_ATTEMPTS + 1,
      });
    } finally {
      mesh.nodes.set('osp-b', b);
    }

    // Hintergrundlauf: fehlgeschlagene bleiben fehlgeschlagen
    expect(await flushOutbox(a.deps)).toEqual({ delivered: 0, failed: 0 });
    expect((await outboxOfA()).find((x) => x.id === m!.id)!.status).toBe('failed');

    // Administration stellt nach Behebung erneut zu
    expect(await flush(a)).toEqual({ delivered: 1, failed: 0 });
    expect((await outboxOfA()).find((x) => x.id === m!.id)).toMatchObject({
      status: 'delivered',
      attempts: MAX_ATTEMPTS + 2,
      last_error: null,
    });
    const requeues = await auditEntries(a, 'outbox.requeue');
    expect(requeues.map((e) => e.details.messages)).toEqual([1, 1]);
    expect((await auditEntries(a, 'outbox.flush')).at(-1)!.details).toMatchObject({
      delivered: 1,
      requeued: 1,
    });
  });
});
