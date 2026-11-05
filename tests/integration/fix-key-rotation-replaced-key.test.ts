/**
 * Schlüsselwechsel (ADR 0013, Prüfbefund L1): Ein Partner hat die Rotationsmitteilung verpasst und den neuen
 * Schlüssel während der Übergangszeit manuell eingetragen (peers.replaceKey, Fingerprint abgeglichen). Der
 * Knoten signierte für ihn weiter mit dem bisherigen Schlüssel (keine Bestätigung) – der Partner lehnte bis zu
 * 30 Tage alles ab. Jetzt: einmalige Wiederholung mit dem neuen Schlüssel, bei Erfolg gilt der Partner als
 * bestätigt (protokolliert); die Rotationsmitteilung selbst bestätigt er ohne Änderung.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateEd25519 } from '../../src/server/core/crypto.ts';
import { sendSigned } from '../../src/server/modules/federation/client.ts';
import { rotateNodeKey } from '../../src/server/modules/federation/keys.ts';
import { flushOutbox } from '../../src/server/modules/federation/outbox.ts';
import type { Peer } from '../../src/shared/contract/federation.ts';
import { adminOf, auditEntries, cardOf, onboard, peerRow, TestClock } from '../helpers/federation.ts';
import { TestMesh, type TestNode } from '../helpers/node.ts';

const mesh = new TestMesh();
const clock = new TestClock();
const ACTOR = { type: 'system' as const, id: null, label: 'test' };
let a: TestNode;
let b: TestNode;
let c: TestNode;
let d: TestNode;
let aOnB: Peer;

async function ping(from: TestNode, to: TestNode) {
  try {
    await sendSigned(from.deps, await peerRow(from, to), 'ping', {});
    return 'ok';
  } catch (err) {
    return (err as { remoteCode?: string | null; code: string }).remoteCode ?? (err as { code: string }).code;
  }
}

async function confirmedAt(of: TestNode) {
  const peer = await peerRow(a, of);
  const r = await a.deps.db
    .selectFrom('node_key_rotation_peer')
    .select('confirmed_at')
    .where('peer_id', '=', peer.id)
    .executeTakeFirstOrThrow();
  return r.confirmed_at;
}

beforeAll(async () => {
  a = await mesh.add({ nodeId: 'l1-a', now: clock.now });
  b = await mesh.add({ nodeId: 'l1-b', now: clock.now });
  c = await mesh.add({ nodeId: 'l1-c', now: clock.now });
  d = await mesh.add({ nodeId: 'l1-d', now: clock.now });
  ({ aOnB } = await onboard(a, b));
  await onboard(a, c);
  await onboard(a, d);
  for (const n of [a, b, c, d]) {
    n.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
  }
});
afterAll(async () => {
  await mesh.close();
});

describe('Partner hat den neuen Schlüssel während der Übergangszeit manuell eingetragen', () => {
  test('erste Anfrage mit dem bisherigen Schlüssel abgelehnt → Wiederholung mit dem neuen, Partner bestätigt', async () => {
    // d kennt keinen der beiden Schlüssel (z. B. falsche Karte eingetragen)
    await d.deps.db
      .updateTable('peer')
      .set({ public_key: generateEd25519().publicKey })
      .where('node_id', '=', a.nodeId)
      .execute();
    mesh.nodes.delete(b.nodeId); // b verpasst die Mitteilung
    const old = a.deps.identity.publicKey;
    await rotateNodeKey(a.deps, { mode: 'routine', graceDays: 7, actor: ACTOR });
    // c übernimmt; b nicht erreichbar; d lehnt ab (auch die Wiederholung mit dem neuen Schlüssel)
    expect(await flushOutbox(a.deps)).toEqual({ delivered: 1, failed: 2 });
    mesh.nodes.set(b.nodeId, b);

    // b trägt die neue Karte manuell ein und gleicht den Fingerprint ab
    const admin = await adminOf(b);
    const card = await cardOf(a);
    expect(card.publicKey).not.toBe(old);
    expect(
      (await b.request('POST', `/api/v1/peers/${aOnB.id}/key`, { as: admin, body: { card } })).status,
    ).toBe(200);
    expect(
      (
        await b.request('POST', `/api/v1/peers/${aOnB.id}/trust`, {
          as: admin,
          body: { fingerprint: card.fingerprint },
        })
      ).status,
    ).toBe(200);
    expect((await a.deps.identity.signerFor(a.deps.db, b.nodeId, clock.now())).publicKey).toBe(old);
    expect(await confirmedAt(b)).toBeNull();

    // Anfrage an b: mit dem bisherigen abgelehnt, mit dem neuen angenommen
    expect(await ping(a, b)).toBe('ok');
    expect(await confirmedAt(b)).not.toBeNull();
    expect((await a.deps.identity.signerFor(a.deps.db, b.nodeId, clock.now())).publicKey).toBe(
      card.publicKey,
    );
    const confirmed = (await auditEntries(a, 'node.key_rotation.confirmed')).at(-1);
    expect(confirmed?.details).toMatchObject({
      peerNodeId: 'l1-b',
      via: 'new_key_accepted',
      messageType: 'ping',
      newlyConfirmed: true,
    });
    // Antworten von a an b jetzt ebenfalls mit dem neuen Schlüssel
    expect(await ping(b, a)).toBe('ok');

    // die noch ausstehende Rotationsmitteilung: b kennt den neuen Schlüssel schon → bestätigt ohne Änderung
    clock.advance(15_000);
    try {
      expect(await flushOutbox(a.deps)).toEqual({ delivered: 1, failed: 1 });
    } finally {
      clock.reset();
    }
    expect((await auditEntries(b, 'peer.key_rotated')).length).toBe(0);
    expect((await peerRow(b, a)).public_key).toBe(card.publicKey);
  });

  test('Partner kennt keinen der Schlüssel: Wiederholung scheitert, keine Bestätigung', async () => {
    expect(await ping(a, d)).toBe('bad_signature');
    expect(await confirmedAt(d)).toBeNull();
    expect((await a.deps.identity.signerFor(a.deps.db, d.nodeId, clock.now())).publicKey).not.toBe(
      a.deps.identity.publicKey,
    );
  });

  test('bestätigte Partner (c) bleiben beim neuen Schlüssel, keine zusätzliche Anfrage', async () => {
    expect(await confirmedAt(c)).not.toBeNull();
    const before = (await auditEntries(a, 'node.key_rotation.confirmed')).length;
    expect(await ping(a, c)).toBe('ok');
    expect((await auditEntries(a, 'node.key_rotation.confirmed')).length).toBe(before);
  });
});
