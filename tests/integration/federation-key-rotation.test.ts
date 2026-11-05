/**
 * Wechsel des Ed25519-Knotenschlüssels mit Benachrichtigung der Partner (S4, ADR 0013):
 *  - planmäßiger Wechsel: signierte Mitteilung (alter + neuer Schlüssel) über das Ausgangspostfach, Partner
 *    übernehmen den neuen Schlüssel, beide Seiten protokollieren; Knotenkarte zeigt den neuen Fingerprint
 *  - Übergang: Partner ohne Bestätigung erhalten weiter mit dem bisherigen Schlüssel Signiertes und
 *    brechen nicht; verlorene Mitteilung wird wiederholt
 *  - bisheriger Schlüssel nur in der Übergangszeit angenommen, nie für eine weitere Rotation
 *  - gefälschte, veraltete, wiederholte Mitteilungen und Mitteilungen gesperrter oder unbekannter Knoten
 *    werden abgelehnt und protokolliert
 *  - Ablauf der Übergangszeit ohne Bestätigung → manueller Schlüsseltausch mit Fingerprint-Abgleich
 *  - Wechsel wegen Kompromittierung ohne Benachrichtigung; CLI rotate-node-key
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { runCli } from '../../src/server/cli/main.ts';
import { ed25519Sign, fingerprint, generateEd25519, SecretBox } from '../../src/server/core/crypto.ts';
import { NodeIdentity } from '../../src/server/core/node-identity.ts';
import { createSession, hashPassword } from '../../src/server/modules/auth/sessions.ts';
import { sendSigned } from '../../src/server/modules/federation/client.ts';
import {
  buildRotationStatement,
  checkRotationStatement,
  runKeyMaintenance,
  verifyPeerSignature,
} from '../../src/server/modules/federation/keys.ts';
import { flushOutbox } from '../../src/server/modules/federation/outbox.ts';
import type { NodeCard, Peer } from '../../src/shared/contract/federation.ts';
import {
  adminOf,
  auditEntries,
  cardOf,
  type FakeRelease,
  fakePep,
  onboard,
  peerRow,
  rawSend,
  TestClock,
} from '../helpers/federation.ts';
import { TestMesh, type TestNode, type TestUser } from '../helpers/node.ts';

const DAY = 24 * 60 * 60 * 1000;
const PURPOSE = 'training_steering';

const mesh = new TestMesh();
const clock = new TestClock();
let a: TestNode;
let b: TestNode;
let c: TestNode;
let d: TestNode;
const peersOfA = new Map<string, Peer>();
const aOn = new Map<string, Peer>();
const releases = new Map<string, FakeRelease>();

interface KeyStatus {
  fingerprint: string;
  publicKey: string;
  rotation: null | {
    id: string;
    mode: string;
    running: boolean;
    graceUntil: string;
    previousFingerprint: string;
    peers: {
      nodeId: string;
      confirmedAt: string | null;
      deliveryStatus: string | null;
      lastError: string | null;
    }[];
  };
}

/** Admin-Sitzung nach der (verstellbaren) Uhr des Knotens */
async function adminNow(node: TestNode): Promise<TestUser> {
  const email = `admin-${randomUUID().slice(0, 8)}@${node.nodeId}.test`;
  const row = await node.deps.db
    .insertInto('app_user')
    .values({
      email,
      display_name: 'Admin',
      password_hash: await hashPassword('x'.repeat(16)),
      roles: ['admin'],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const { token } = await createSession(node.deps.db, row.id, 1, '127.0.0.1', 'test', node.deps.now());
  return { id: row.id, email, password: '', roles: ['admin'], cookie: `osp_session=${token}` };
}

/** Aktueller privater Schlüssel eines Knotens (zum Nachstellen von Nachrichten mit einem bisherigen Schlüssel) */
async function currentKey(node: TestNode) {
  const row = await node.deps.db
    .selectFrom('node_identity')
    .select(['public_key', 'private_key_enc'])
    .executeTakeFirstOrThrow();
  const privateKey = node.deps.box.open(row.private_key_enc, 'node_identity.private_key');
  return { publicKey: row.public_key, privateKey, sign: (data: string) => ed25519Sign(privateKey, data) };
}

function rotationNotice(o: {
  nodeId: string;
  old: { publicKey: string; privateKey: string };
  next: { publicKey: string; privateKey: string };
  graceUntil?: Date;
  signOldWith?: string;
  signNewWith?: string;
}) {
  const now = clock.now();
  const statement = buildRotationStatement({
    nodeId: o.nodeId,
    oldPublicKey: o.old.publicKey,
    newPublicKey: o.next.publicKey,
    rotatedAt: now.toISOString(),
    graceUntil: (o.graceUntil ?? new Date(now.getTime() + 7 * DAY)).toISOString(),
  });
  return {
    kind: 'key_rotated' as const,
    statement,
    signatureOld: ed25519Sign(o.signOldWith ?? o.old.privateKey, statement),
    signatureNew: ed25519Sign(o.signNewWith ?? o.next.privateKey, statement),
  };
}

async function rotate(node: TestNode, body: Record<string, unknown>, as?: TestUser) {
  return node.request<KeyStatus>('POST', '/api/v1/node/key/rotate', {
    as: as ?? (await adminNow(node)),
    body,
  });
}

async function keyStatus(node: TestNode) {
  const r = await node.request<KeyStatus>('GET', '/api/v1/node/key', { as: await adminNow(node) });
  expect(r.status).toBe(200);
  return r.json;
}

async function ping(from: TestNode, to: TestNode) {
  const peer = await peerRow(from, to);
  try {
    await sendSigned(from.deps, peer, 'ping', {});
    return 'ok';
  } catch (err) {
    return (err as { remoteCode?: string | null; code: string }).remoteCode ?? (err as { code: string }).code;
  }
}

/** Partner offline bzw. wieder erreichbar (TestMesh-Routing) */
function offline(node: TestNode) {
  mesh.nodes.delete(node.nodeId);
}
function online(node: TestNode) {
  mesh.nodes.set(node.nodeId, node);
}

beforeAll(async () => {
  a = await mesh.add({ nodeId: 'osp-a', now: clock.now });
  b = await mesh.add({ nodeId: 'osp-b', now: clock.now });
  c = await mesh.add({ nodeId: 'osp-c', now: clock.now });
  d = await mesh.add({ nodeId: 'osp-d', now: clock.now });
  for (const other of [b, c, d]) {
    const { bOnA, aOnB } = await onboard(a, other);
    peersOfA.set(other.nodeId, bOnA);
    aOn.set(other.nodeId, aOnB);
  }
  fakePep(a, releases);
  // Zustellung im Test ausdrücklich (flushOutbox), nicht im Hintergrund nach der Route
  for (const n of [a, b, c, d]) {
    n.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
  }
});
afterAll(async () => {
  await mesh.close();
});

describe('Schlüsselwechsel: Berechtigung und Eingaben', () => {
  test('nur Administration; ohne ausdrückliche Bestätigung abgelehnt; Ausgangsstand ohne Wechsel', async () => {
    for (const roles of [['auditor'], ['data_steward']] as const) {
      const u = await a.user([...roles]);
      expect((await rotate(a, { mode: 'routine', confirm: true }, u)).status).toBe(403);
      expect((await a.request('GET', '/api/v1/node/key', { as: u })).status).toBe(403);
    }
    expect((await rotate(a, { mode: 'routine' })).status).toBe(400);
    expect((await rotate(a, { mode: 'routine', confirm: true, graceDays: 31 })).status).toBe(400);
    const s = await keyStatus(a);
    expect(s.rotation).toBeNull();
    expect(s.fingerprint).toBe(a.deps.identity.fingerprint);
  });
});

describe('Planmäßiger Wechsel mit Benachrichtigung der Partner', () => {
  let oldKey: Awaited<ReturnType<typeof currentKey>>;
  let newPublicKey: string;
  const releaseId = randomUUID();

  test('neuer Schlüssel, signierte Mitteilung je Partner; Knotenkarte zeigt den neuen Fingerprint', async () => {
    oldKey = await currentKey(a);
    const oldFp = fingerprint(oldKey.publicKey);
    offline(d); // d verpasst die erste Zustellung
    const r = await rotate(a, { mode: 'routine', graceDays: 7, confirm: true });
    expect(r.status).toBe(200);
    newPublicKey = r.json.publicKey;
    expect(newPublicKey).not.toBe(oldKey.publicKey);
    expect(r.json.fingerprint).toBe(fingerprint(newPublicKey));
    expect(r.json.rotation?.running).toBe(true);
    expect(r.json.rotation?.previousFingerprint).toBe(oldFp);
    expect(r.json.rotation?.peers.map((p) => p.nodeId).sort()).toEqual(['osp-b', 'osp-c', 'osp-d']);

    const card = await a.request<NodeCard>('GET', '/api/v1/node/card', { as: await adminNow(a) });
    expect(card.json.publicKey).toBe(newPublicKey);
    expect(card.json.fingerprint).toBe(fingerprint(newPublicKey));
    const ownRow = await a.deps.db.selectFrom('node_identity').selectAll().executeTakeFirstOrThrow();
    expect(ownRow.previous_public_key).toBe(oldKey.publicKey);
    // privater Schlüssel nur verschlüsselt gespeichert
    expect(ownRow.private_key_enc.startsWith('v1.')).toBe(true);
    const rot = await a.deps.db.selectFrom('node_key_rotation').selectAll().executeTakeFirstOrThrow();
    expect(rot.old_private_key_enc?.startsWith('v1.')).toBe(true);
    // Aussage beweist Kontinuität (alter Schlüssel) und Besitz (neuer Schlüssel)
    expect(
      checkRotationStatement({
        statement: rot.statement ?? '',
        signatureOld: rot.signature_old ?? '',
        signatureNew: rot.signature_new ?? '',
      }).ok,
    ).toBe(true);

    const audit = await auditEntries(a, 'node.key_rotate');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ mode: 'routine', oldFingerprint: oldFp, peersNotified: 3 });
    const outbox = await a.request<{ items: { kind: string | null; status: string }[] }>(
      'GET',
      '/api/v1/outbox',
      {
        as: await adminNow(a),
      },
    );
    expect(outbox.json.items.filter((m) => m.kind === 'key_rotated')).toHaveLength(3);
  });

  test('Zustellung: erreichbare Partner übernehmen den Schlüssel und bestätigen; beide Seiten protokollieren', async () => {
    expect(await flushOutbox(a.deps)).toEqual({ delivered: 2, failed: 1 });
    for (const n of [b, c]) {
      const row = await peerRow(n, a);
      expect(row.public_key).toBe(newPublicKey);
      expect(row.fingerprint).toBe(fingerprint(newPublicKey));
      expect(row.previous_public_key).toBe(oldKey.publicKey);
      expect(row.previous_key_valid_until?.getTime()).toBeGreaterThan(clock.now().getTime() + 6 * DAY);
      const received = await auditEntries(n, 'peer.key_rotated');
      expect(received).toHaveLength(1);
      expect(received[0]?.details).toMatchObject({
        nodeId: 'osp-a',
        oldFingerprint: fingerprint(oldKey.publicKey),
        newFingerprint: fingerprint(newPublicKey),
      });
      // Partnerliste zeigt den Wechsel
      const list = await n.request<{ items: Peer[] }>('GET', '/api/v1/peers', { as: await adminNow(n) });
      const shown = list.json.items.find((p) => p.nodeId === 'osp-a');
      expect(shown?.fingerprint).toBe(fingerprint(newPublicKey));
      expect(shown?.previousFingerprint).toBe(fingerprint(oldKey.publicKey));
      expect(shown?.keyRotatedAt).not.toBeNull();
    }
    expect(await auditEntries(a, 'node.key_rotation.confirmed')).toHaveLength(2);
    const s = await keyStatus(a);
    const byNode = new Map(s.rotation?.peers.map((p) => [p.nodeId, p]));
    expect(byNode.get('osp-b')?.confirmedAt).not.toBeNull();
    expect(byNode.get('osp-c')?.confirmedAt).not.toBeNull();
    expect(byNode.get('osp-d')).toMatchObject({
      confirmedAt: null,
      deliveryStatus: 'pending',
      lastError: 'peer_unreachable',
    });

    // bestätigte Partner: neuer Schlüssel; nicht bestätigte: bisheriger
    const now = clock.now();
    expect((await a.deps.identity.signerFor(a.deps.db, 'osp-b', now)).publicKey).toBe(newPublicKey);
    expect((await a.deps.identity.signerFor(a.deps.db, 'osp-d', now)).publicKey).toBe(oldKey.publicKey);
  });

  test('Austausch mit bestätigten Partnern in beide Richtungen; Abruf beim rotierten Knoten', async () => {
    expect(await ping(a, b)).toBe('ok');
    expect(await ping(b, a)).toBe('ok');
    releases.set(releaseId, {
      id: releaseId,
      peerId: peersOfA.get('osp-b')!.id,
      purposes: [PURPOSE],
      rows: [{ athleteId: randomUUID(), values: { test_date: '2026-01-10', vo2max: 61.2 } }],
    });
    const steward = await b.user(['data_steward']);
    const pulled = await b.request<{ status: string; rowCount: number }>('POST', '/api/v1/received/pull', {
      as: steward,
      body: { peerId: aOn.get('osp-b')!.id, releaseId, purpose: PURPOSE },
    });
    expect(pulled.status).toBe(200);
    expect(pulled.json.rowCount).toBe(1);
  });

  test('Partner ohne Mitteilung bricht nicht: er erhält weiter mit dem bisherigen Schlüssel Signiertes', async () => {
    online(d);
    expect((await peerRow(d, a)).public_key).toBe(oldKey.publicKey);
    expect(await ping(d, a)).toBe('ok'); // Antwort von a mit dem bisherigen Schlüssel
    expect(await ping(a, d)).toBe('ok'); // Anfrage von a mit dem bisherigen Schlüssel
  });

  test('verlorene Mitteilung wird wiederholt und dann bestätigt', async () => {
    // noch nicht fällig (Wartezeit nach dem Fehlversuch)
    expect(await flushOutbox(a.deps)).toEqual({ delivered: 0, failed: 0 });
    clock.advance(15_000);
    expect(await flushOutbox(a.deps)).toEqual({ delivered: 1, failed: 0 });
    expect((await peerRow(d, a)).public_key).toBe(newPublicKey);
    expect((await a.deps.identity.signerFor(a.deps.db, 'osp-d', clock.now())).publicKey).toBe(newPublicKey);
    expect(await ping(a, d)).toBe('ok');
    expect(await ping(d, a)).toBe('ok');
    const s = await keyStatus(a);
    expect(s.rotation?.peers.every((p) => p.confirmedAt !== null)).toBe(true);
  });

  test('zweiter planmäßiger Wechsel während der Übergangszeit → conflict', async () => {
    const r = await rotate(a, { mode: 'routine', confirm: true });
    expect(r.status).toBe(409);
    expect((r.json as unknown as { error: { reason: string } }).error.reason).toBe(
      'key_rotation_in_progress',
    );
  });

  test('erneute Zustellung (Antwort verloren): Partner bestätigt ohne Änderung', async () => {
    const rot = await a.deps.db.selectFrom('node_key_rotation').selectAll().executeTakeFirstOrThrow();
    const notice = {
      kind: 'key_rotated',
      statement: rot.statement,
      signatureOld: rot.signature_old,
      signatureNew: rot.signature_new,
    };
    const r = await rawSend(b, { from: a, type: 'notice', body: notice, signWith: oldKey });
    expect(r.status).toBe(200);
    expect(r.json.body).toEqual({ ack: true, affectedRows: 0 });
    expect(await auditEntries(b, 'peer.key_rotated')).toHaveLength(1);
  });

  test('Nachrichten mit dem bisherigen Schlüssel: in der Übergangszeit angenommen, danach abgelehnt', async () => {
    const during = await rawSend(b, { from: a, type: 'ping', signWith: oldKey });
    expect(during.status).toBe(200);
    expect(during.signedByTarget).toBe(true);

    clock.advance(7 * DAY + 60_000);
    const after = await rawSend(b, { from: a, type: 'ping', signWith: oldKey });
    expect(after.status).toBe(401);
    expect(after.json.error?.code).toBe('bad_signature');
    // mit dem neuen Schlüssel weiterhin möglich
    expect((await rawSend(b, { from: a, type: 'ping' })).status).toBe(200);

    // Wartung: Übergang beendet, bisheriger privater Schlüssel gelöscht, Partner vergessen den alten Schlüssel
    expect(await runKeyMaintenance(a.deps)).toMatchObject({ finished: 1 });
    const rot = await a.deps.db.selectFrom('node_key_rotation').selectAll().executeTakeFirstOrThrow();
    expect(rot.finished_at).not.toBeNull();
    expect(rot.old_private_key_enc).toBeNull();
    const own = await a.deps.db.selectFrom('node_identity').selectAll().executeTakeFirstOrThrow();
    expect(own.previous_public_key).toBeNull();
    const finished = await auditEntries(a, 'node.key_rotation.finished');
    expect(finished.at(-1)?.outcome).toBe('success');
    expect(finished.at(-1)?.details).toMatchObject({ confirmed: 3, unconfirmedPeers: [] });
    expect((await runKeyMaintenance(b.deps)).peerKeysExpired).toBe(1);
    const bRow = await peerRow(b, a);
    expect(bRow.previous_public_key).toBeNull();
    expect(bRow.previous_key_valid_until).toBeNull();
    clock.reset();
  });
});

describe('Gefälschte, veraltete und wiederholte Rotationsmitteilungen', () => {
  let x: TestNode;
  let y: TestNode;
  let xOnY: Peer;

  beforeAll(async () => {
    x = await mesh.add({ nodeId: 'osp-x', now: clock.now });
    y = await mesh.add({ nodeId: 'osp-y', now: clock.now });
    ({ aOnB: xOnY } = await onboard(x, y));
  });

  async function storedKeyOfX() {
    return (await peerRow(y, x)).public_key;
  }

  test('neuer Schlüssel ohne Besitznachweis (falsche zweite Signatur) → bad_signature, protokolliert', async () => {
    const before = await storedKeyOfX();
    const xKey = await currentKey(x);
    const notice = rotationNotice({
      nodeId: 'osp-x',
      old: xKey,
      next: generateEd25519(),
      signNewWith: generateEd25519().privateKey,
    });
    const r = await rawSend(y, { from: x, type: 'notice', body: notice });
    expect(r.status).toBe(401);
    expect(r.json.error).toEqual({ code: 'bad_signature', reason: 'rotation_proof_invalid' });
    expect(await storedKeyOfX()).toBe(before);
    const rejected = await auditEntries(y, 'peer.key_rotation.rejected');
    expect(rejected.at(-1)).toMatchObject({ outcome: 'denied' });
    expect(rejected.at(-1)?.details).toMatchObject({ reason: 'rotation_proof_invalid', nodeId: 'osp-x' });
  });

  test('Aussage nicht mit dem bisherigen Schlüssel signiert → abgelehnt', async () => {
    const xKey = await currentKey(x);
    const notice = rotationNotice({
      nodeId: 'osp-x',
      old: xKey,
      next: generateEd25519(),
      signOldWith: generateEd25519().privateKey,
    });
    const r = await rawSend(y, { from: x, type: 'notice', body: notice });
    expect(r.json.error?.reason).toBe('rotation_proof_invalid');
  });

  test('Aussage beginnt nicht beim gespeicherten Schlüssel (veraltet) → stale_key', async () => {
    const notice = rotationNotice({ nodeId: 'osp-x', old: generateEd25519(), next: generateEd25519() });
    const r = await rawSend(y, { from: x, type: 'notice', body: notice });
    expect(r.status).toBe(400);
    expect(r.json.error).toEqual({ code: 'bad_request', reason: 'stale_key' });
  });

  test('fremde Knoten-ID in der Aussage → bad_request', async () => {
    const notice = rotationNotice({ nodeId: 'osp-y', old: await currentKey(x), next: generateEd25519() });
    const r = await rawSend(y, { from: x, type: 'notice', body: notice });
    expect(r.json.error).toEqual({ code: 'bad_request', reason: 'wrong_node' });
  });

  test('Angreifer ohne Schlüssel (Umschlag fremd signiert) bzw. unbekannter Knoten → abgewiesen', async () => {
    const attacker = generateEd25519();
    const notice = rotationNotice({ nodeId: 'osp-x', old: attacker, next: generateEd25519() });
    const forged = await rawSend(y, {
      from: x,
      type: 'notice',
      body: notice,
      signWith: { sign: (data) => ed25519Sign(attacker.privateKey, data) },
    });
    expect(forged.status).toBe(401);
    expect(forged.json.error?.code).toBe('bad_signature');
    const unknown = await rawSend(y, { from: a, type: 'notice', body: notice });
    expect(unknown.json.error?.code).toBe('unknown_node');
    expect((await auditEntries(y, 'federation.request.rejected')).length).toBeGreaterThan(0);
  });

  test('gesperrter Partner: Mitteilung wird zugestellt, aber kein neuer Schlüssel übernommen', async () => {
    const before = await storedKeyOfX();
    const s = await y.request<Peer>('POST', `/api/v1/peers/${xOnY.id}/suspend`, { as: await adminOf(y) });
    expect(s.json.status).toBe('suspended');
    const notice = rotationNotice({ nodeId: 'osp-x', old: await currentKey(x), next: generateEd25519() });
    const r = await rawSend(y, { from: x, type: 'notice', body: notice });
    expect(r.status).toBe(401);
    expect(r.json.error).toEqual({ code: 'untrusted', reason: 'peer_not_trusted' });
    expect(await storedKeyOfX()).toBe(before);
    expect((await auditEntries(y, 'peer.key_rotation.rejected')).at(-1)?.details).toMatchObject({
      reason: 'peer_not_trusted',
    });
    const t = await y.request<Peer>('POST', `/api/v1/peers/${xOnY.id}/trust`, {
      as: await adminOf(y),
      body: { fingerprint: xOnY.fingerprint },
    });
    expect(t.json.status).toBe('trusted');
  });

  test('gültige Mitteilung; Wiederholung desselben Umschlags → replay; bisheriger Schlüssel kann nicht weiter rotieren', async () => {
    const oldX = await currentKey(x);
    const next = generateEd25519();
    const notice = rotationNotice({ nodeId: 'osp-x', old: oldX, next });
    const ok = await rawSend(y, { from: x, type: 'notice', body: notice });
    expect(ok.status).toBe(200);
    expect(ok.json.body).toEqual({ ack: true, affectedRows: 1 });
    expect(await storedKeyOfX()).toBe(next.publicKey);

    const replay = await rawSend(y, {
      from: x,
      replay: { raw: ok.raw, signature: ok.signature },
      type: 'notice',
    });
    expect(replay.json.error?.code).toBe('replay');

    // Wer nur den bisherigen Schlüssel hat (in der Übergangszeit noch angenommen), kann keinen eigenen
    // Schlüssel durchsetzen: Aussage muss beim aktuellen Schlüssel beginnen …
    const attacker = generateEd25519();
    const hijack = rotationNotice({ nodeId: 'osp-x', old: oldX, next: attacker });
    const r1 = await rawSend(y, { from: x, type: 'notice', body: hijack, signWith: oldX });
    expect(r1.json.error).toEqual({ code: 'bad_request', reason: 'stale_key' });
    // … und der Umschlag mit dem aktuellen Schlüssel signiert sein
    const viaPrevious = rotationNotice({ nodeId: 'osp-x', old: next, next: attacker });
    const r2 = await rawSend(y, { from: x, type: 'notice', body: viaPrevious, signWith: oldX });
    expect(r2.json.error).toEqual({ code: 'bad_signature', reason: 'previous_key' });
    expect(await storedKeyOfX()).toBe(next.publicKey);
  });

  test('Prüfung von Partnersignaturen: bisheriger Schlüssel nur bis zum Ende der Übergangszeit', () => {
    const cur = generateEd25519();
    const prev = generateEd25519();
    const now = new Date('2026-11-05T10:00:00Z');
    const peer = {
      public_key: cur.publicKey,
      previous_public_key: prev.publicKey,
      previous_key_valid_until: new Date(now.getTime() + 1000),
    };
    expect(verifyPeerSignature(peer, 'm', ed25519Sign(cur.privateKey, 'm'), now)).toBe('current');
    expect(verifyPeerSignature(peer, 'm', ed25519Sign(prev.privateKey, 'm'), now)).toBe('previous');
    expect(
      verifyPeerSignature(peer, 'm', ed25519Sign(prev.privateKey, 'm'), new Date(now.getTime() + 2000)),
    ).toBeNull();
    expect(verifyPeerSignature(peer, 'm', ed25519Sign(generateEd25519().privateKey, 'm'), now)).toBeNull();
  });
});

describe('Ablauf der Übergangszeit ohne Bestätigung', () => {
  let e: TestNode;
  let eOnA: Peer;
  let aOnE: Peer;

  test('Partner offline über die ganze Übergangszeit: Mitteilung verfällt, Abschluss protokolliert', async () => {
    e = await mesh.add({ nodeId: 'osp-e', now: clock.now });
    e.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
    ({ bOnA: eOnA, aOnB: aOnE } = await onboard(a, e));
    offline(e);
    const r = await rotate(a, { mode: 'routine', graceDays: 1, confirm: true });
    expect(r.status).toBe(200);
    const flushed = await flushOutbox(a.deps);
    expect(flushed.failed).toBe(1);

    clock.advance(DAY + 60_000);
    expect((await runKeyMaintenance(a.deps)).finished).toBe(1);
    const finished = await auditEntries(a, 'node.key_rotation.finished');
    expect(finished.at(-1)?.outcome).toBe('error');
    expect(finished.at(-1)?.details).toMatchObject({ unconfirmedPeers: ['osp-e'] });
    const msg = await a.deps.db
      .selectFrom('outbox_message')
      .selectAll()
      .where('peer_id', '=', eOnA.id)
      .where('status', '=', 'failed')
      .executeTakeFirstOrThrow();
    expect(msg.last_error).toBe('key_rotation_expired');
    // erneuter Versuch („Jetzt zustellen“) scheitert sofort: bisheriger Schlüssel ist gelöscht
    await a.deps.db
      .updateTable('outbox_message')
      .set({ status: 'pending', next_attempt_at: clock.now() })
      .where('id', '=', msg.id)
      .execute();
    online(e);
    await flushOutbox(a.deps);
    const again = await a.deps.db
      .selectFrom('outbox_message')
      .selectAll()
      .where('id', '=', msg.id)
      .executeTakeFirstOrThrow();
    expect(again).toMatchObject({ status: 'failed', last_error: 'key_rotation_expired' });

    // a signiert jetzt für e mit dem neuen Schlüssel, den e nicht kennt: Austausch schlägt sicher fehl
    expect(await ping(a, e)).toBe('bad_signature');
    expect(await ping(e, a)).toBe('signature_invalid');
    clock.reset();
  });

  test('manueller Schlüsseltausch beim Partner mit erneutem Fingerprint-Abgleich stellt den Austausch wieder her', async () => {
    const card = await cardOf(a);
    const admin = await adminNow(e);
    // Karte eines anderen Knotens bzw. manipulierter Fingerprint → abgewiesen
    const wrongNode = await e.request('POST', `/api/v1/peers/${aOnE.id}/key`, {
      as: admin,
      body: { card: await cardOf(b) },
    });
    expect(wrongNode.status).toBe(400);
    const tampered = await e.request('POST', `/api/v1/peers/${aOnE.id}/key`, {
      as: admin,
      body: { card: { ...card, fingerprint: fingerprint(generateEd25519().publicKey) } },
    });
    expect(tampered.status).toBe(400);

    const replaced = await e.request<Peer>('POST', `/api/v1/peers/${aOnE.id}/key`, {
      as: admin,
      body: { card },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.json.status).toBe('pending');
    expect(replaced.json.fingerprint).toBe(card.fingerprint);
    // bis zur Bestätigung des Fingerprints nimmt e nichts von a an
    expect(await ping(a, e)).toBe('untrusted');
    const trusted = await e.request<Peer>('POST', `/api/v1/peers/${aOnE.id}/trust`, {
      as: admin,
      body: { fingerprint: card.fingerprint.replace(/ /g, '') },
    });
    expect(trusted.json.status).toBe('trusted');
    expect(await ping(e, a)).toBe('ok');
    expect(await ping(a, e)).toBe('ok');
    const audit = await auditEntries(e, 'peer.key_replace');
    expect(audit.map((x) => x.outcome)).toEqual(['denied', 'denied', 'success']);
    expect(audit.at(-1)?.details).toMatchObject({ newFingerprint: card.fingerprint });
  });
});

describe('Wechsel bei Verdacht auf Kompromittierung', () => {
  test('ohne Mitteilung und ohne Übergangszeit; Partner lehnen ab, bis sie den neuen Schlüssel abgleichen', async () => {
    const before = await a.deps.db.selectFrom('outbox_message').select('id').execute();
    const r = await rotate(a, { mode: 'compromised', confirm: true });
    expect(r.status).toBe(200);
    expect(r.json.rotation).toMatchObject({ mode: 'compromised', running: false, peers: [] });
    const after = await a.deps.db.selectFrom('outbox_message').select('id').execute();
    expect(after.length).toBe(before.length);
    const own = await a.deps.db.selectFrom('node_identity').selectAll().executeTakeFirstOrThrow();
    expect(own.previous_public_key).toBeNull();
    // der bisherige Schlüssel wird nirgends mehr verwendet
    expect((await a.deps.identity.signerFor(a.deps.db, 'osp-b', clock.now())).publicKey).toBe(own.public_key);
    expect(await ping(b, a)).toBe('signature_invalid');
    expect(await ping(a, b)).toBe('bad_signature');
    expect((await auditEntries(a, 'node.key_rotate')).at(-1)?.details).toMatchObject({
      mode: 'compromised',
      peersNotified: 0,
    });

    const card = await cardOf(a);
    const admin = await adminNow(b);
    const peer = aOn.get('osp-b')!;
    expect(
      (await b.request('POST', `/api/v1/peers/${peer.id}/key`, { as: admin, body: { card } })).status,
    ).toBe(200);
    await b.request('POST', `/api/v1/peers/${peer.id}/trust`, {
      as: admin,
      body: { fingerprint: card.fingerprint },
    });
    expect(await ping(b, a)).toBe('ok');
  });
});

describe('Master-Key-Rotation während eines Schlüsselwechsels', () => {
  test('bisheriger Knotenschlüssel der Übergangszeit wird mit neu verschlüsselt und bleibt nutzbar', async () => {
    const m = await mesh.add({ nodeId: 'osp-mk', now: clock.now });
    m.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
    const old = await currentKey(m);
    expect((await rotate(m, { mode: 'routine', confirm: true })).status).toBe(200);
    const rot = await m.deps.db.selectFrom('node_key_rotation').selectAll().executeTakeFirstOrThrow();
    const nextMaster = randomBytes(32).toString('base64');
    const box = new SecretBox(nextMaster, m.deps.config.MESH_MASTER_KEY);
    expect(await NodeIdentity.reseal(m.deps.db, box)).toBe(true);
    const after = await m.deps.db.selectFrom('node_key_rotation').selectAll().executeTakeFirstOrThrow();
    expect(after.old_private_key_enc).not.toBe(rot.old_private_key_enc);
    // nur noch mit dem neuen Master-Key lesbar
    const signer = await NodeIdentity.rotationSigner(m.deps.db, new SecretBox(nextMaster), 'osp-mk', rot.id);
    expect(signer?.publicKey).toBe(old.publicKey);
    expect(signer?.sign('x')).toBe(old.sign('x'));
    const reloaded = await NodeIdentity.ensure(m.deps.db, new SecretBox(nextMaster), m.deps.config);
    expect(reloaded.previousPublicKey).toBe(old.publicKey);
  });
});

describe('Kommandozeile rotate-node-key', () => {
  // eigenes Paar: a hat oben seinen Schlüssel ohne Mitteilung gewechselt
  let c: TestNode;
  let a: TestNode;
  beforeAll(async () => {
    c = await mesh.add({ nodeId: 'osp-cli-c', now: clock.now });
    a = await mesh.add({ nodeId: 'osp-cli-a', now: clock.now });
    await onboard(a, c);
  });

  function envOf(node: TestNode): Record<string, string | undefined> {
    const cfg = node.deps.config;
    return {
      MESH_NODE_ID: cfg.MESH_NODE_ID,
      MESH_NODE_NAME: cfg.MESH_NODE_NAME,
      MESH_PUBLIC_URL: cfg.MESH_PUBLIC_URL,
      MESH_DB_URL: cfg.MESH_DB_URL,
      MESH_MASTER_KEY: cfg.MESH_MASTER_KEY,
      MESH_FEDERATION_ALLOW_HTTP: 'true',
      MESH_COOKIE_SECURE: 'false',
      MESH_LOG_LEVEL: 'error',
      MESH_MASTER_KEY_PREVIOUS: undefined,
    };
  }

  async function cli(args: string[], env: Record<string, string | undefined>) {
    const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    let stdout = '';
    let stderr = '';
    const write = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = ((chunk: string) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      return { code: await runCli(args), stdout, stderr };
    } finally {
      process.stdout.write = write.out;
      process.stderr.write = write.err;
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test('Art muss gewählt werden; --compromised nur mit --yes', async () => {
    expect((await cli(['rotate-node-key'], envOf(c))).code).toBe(2);
    expect((await cli(['rotate-node-key', '--routine', '--compromised'], envOf(c))).code).toBe(2);
    const noYes = await cli(['rotate-node-key', '--compromised'], envOf(c));
    expect(noYes.code).toBe(2);
    expect(noYes.stderr).toContain('--yes');
    expect((await cli(['rotate-node-key', '--routine', '--grace-days', '0'], envOf(c))).code).toBe(2);
  });

  test('planmäßiger Wechsel per CLI; der laufende Knoten übernimmt ihn (refresh) und benachrichtigt die Partner', async () => {
    const before = c.deps.identity.fingerprint;
    const r = await cli(['rotate-node-key', '--routine', '--grace-days', '3'], envOf(c));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(before);
    // laufender Server merkt den Wechsel beim nächsten Durchlauf des Ausgangspostfachs
    expect(c.deps.identity.fingerprint).toBe(before);
    expect(await c.deps.identity.refresh(c.deps.db, c.deps.box)).toBe(true);
    expect(c.deps.identity.fingerprint).not.toBe(before);
    expect(r.stdout).toContain(c.deps.identity.fingerprint);
    expect(await c.deps.identity.refresh(c.deps.db, c.deps.box)).toBe(false);
    // a erhält die Mitteilung und übernimmt den Schlüssel
    expect((await flushOutbox(c.deps)).delivered).toBe(1);
    expect((await peerRow(a, c)).fingerprint).toBe(c.deps.identity.fingerprint);
    expect(await ping(a, c)).toBe('ok');
    expect(await ping(c, a)).toBe('ok');
    expect((await auditEntries(c, 'node.key_rotate')).at(-1)?.actor_label).toBe('cli');
  });
});
