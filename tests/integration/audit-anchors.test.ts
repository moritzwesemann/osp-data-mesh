/**
 * Externe Verankerung der Audit-Hash-Kette (R5/S11 „Hash-Kette ohne externen Anker“, ADR 0014):
 *  - signierte Prüfpunkte {nodeId, seq, hash, at} gehen über das Ausgangspostfach an alle vertrauenswürdigen
 *    Partner; diese verwahren sie (ohne Personenbezug), protokollieren den Empfang und geben sie signiert zurück
 *  - Abgleich erkennt Abschneiden und konsistentes Umschreiben der Kette durch den Datenbank-Eigentümer
 *    (audit_verify allein bleibt dabei „intakt“)
 *  - gesperrte, gefälschte und widersprüchliche Prüfpunkte werden abgelehnt und protokolliert
 *  - Rechte: mesh_app nur lesen/anhängen, mesh_bi nichts; Export und CLI verify-audit --with-partners
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/server/cli/main.ts';
import { ed25519Sign, generateEd25519 } from '../../src/server/core/crypto.ts';
import { verifyAuditChain } from '../../src/server/modules/audit/index.ts';
import {
  buildCheckpointStatement,
  compareCheckpoints,
  createCheckpoint,
  scheduledCheckpoint,
  verifyAnchors,
} from '../../src/server/modules/federation/anchors.ts';
import { flushOutbox } from '../../src/server/modules/federation/outbox.ts';
import type { Peer } from '../../src/shared/contract/federation.ts';
import { queryAs } from '../helpers/db.ts';
import { adminOf, auditEntries, onboard, peerRow, rawSend, TestClock } from '../helpers/federation.ts';
import { TestMesh, type TestNode, type TestUser } from '../helpers/node.ts';

const mesh = new TestMesh();
const clock = new TestClock();
const CLI_ACTOR = { type: 'system' as const, id: null, label: 'test' };
let a: TestNode;
let b: TestNode;
let c: TestNode;
let aOnB: Peer;
let auditorA: TestUser;
const tmp = mkdtempSync(join(tmpdir(), 'osp-anchor-'));

interface Verification {
  result: 'ok' | 'manipulated' | 'unanchored';
  local: { ok: boolean; headSeq: number | null };
  partners: {
    nodeId: string;
    status: string;
    checkpoints: number;
    latestSeq: number | null;
    invalidSignatures: number;
    firstProblem: { seq: number; kind: string } | null;
  }[];
}

function offline(node: TestNode) {
  mesh.nodes.delete(node.nodeId);
}
function online(node: TestNode) {
  mesh.nodes.set(node.nodeId, node);
}

async function checkpointNow(node: TestNode) {
  return createCheckpoint(node.deps, 'manual', { actor: CLI_ACTOR });
}

async function verify(node: TestNode): Promise<Verification> {
  return (await verifyAnchors(node.deps, { actor: CLI_ACTOR })) as Verification;
}

async function held(holder: TestNode, of: TestNode) {
  const peer = await peerRow(holder, of);
  return holder.deps.db
    .selectFrom('peer_audit_checkpoint')
    .selectAll()
    .where('peer_id', '=', peer.id)
    .orderBy('seq')
    .execute();
}

/** SQL als Eigentümer der Datenbank (mesh_owner): kann Trigger abschalten, wie ein Angreifer mit Owner-Rechten */
async function asOwner(node: TestNode, statements: string) {
  await queryAs(node.testDb.urls.owner, statements);
}

async function truncateTail(node: TestNode, fromSeq: number) {
  await asOwner(
    node,
    `begin;
     alter table audit_log disable trigger audit_log_no_update;
     delete from audit_log where seq >= ${fromSeq};
     alter table audit_log enable trigger audit_log_no_update;
     commit;`,
  );
}

/** Ändert einen Eintrag und berechnet die Kette ab dort konsistent neu (audit_verify bleibt „intakt“) */
async function rewriteFrom(node: TestNode, seq: number) {
  await asOwner(
    node,
    `begin;
     alter table audit_log disable trigger audit_log_no_update;
     update audit_log set details = '{"rewritten": true}'::jsonb where seq = ${seq};
     do $$
     declare r audit_log; prev text;
     begin
       select coalesce((select hash from audit_log where seq = ${seq - 1}), repeat('0', 64)) into prev;
       for r in select * from audit_log where seq >= ${seq} order by seq loop
         r.prev_hash := prev;
         r.hash := encode(sha256(convert_to(audit_digest_input(r), 'UTF8')), 'hex');
         update audit_log set prev_hash = r.prev_hash, hash = r.hash where id = r.id;
         prev := r.hash;
       end loop;
     end $$;
     alter table audit_log enable trigger audit_log_no_update;
     commit;`,
  );
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

beforeAll(async () => {
  a = await mesh.add({ nodeId: 'anchor-a', now: clock.now });
  b = await mesh.add({ nodeId: 'anchor-b', now: clock.now });
  c = await mesh.add({ nodeId: 'anchor-c', now: clock.now });
  ({ aOnB } = await onboard(a, b));
  await onboard(a, c);
  for (const n of [a, b, c])
    n.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
  auditorA = await a.user(['auditor']);
});
afterAll(async () => {
  await mesh.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('Prüfpunkte erstellen, senden und verwahren', () => {
  test('Rollen: Revision und Administration; andere Rollen nicht', async () => {
    const steward = await a.user(['data_steward']);
    expect((await a.request('POST', '/api/v1/audit/anchors', { as: steward })).status).toBe(403);
    expect((await a.request('POST', '/api/v1/audit/anchors/verify', { as: steward })).status).toBe(403);
    expect((await a.request('GET', '/api/v1/audit/anchors/latest', { as: steward })).status).toBe(403);
    expect((await a.request('GET', '/api/v1/audit/anchors', { as: auditorA })).status).toBe(200);
  });

  test('signierter Prüfpunkt des Kettenkopfs geht an alle Partner; diese verwahren und protokollieren ihn', async () => {
    const r = await a.request<{
      checkpoint: { seq: number; hash: string; epoch: string; peers: number };
      created: boolean;
    }>('POST', '/api/v1/audit/anchors', { as: auditorA });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(true);
    expect(r.json.checkpoint.peers).toBe(2);
    const head = await a.deps.db
      .selectFrom('audit_log')
      .select(['seq', 'hash'])
      .where('seq', '=', r.json.checkpoint.seq)
      .executeTakeFirstOrThrow();
    expect(head.hash).toBe(r.json.checkpoint.hash);
    expect((await auditEntries(a, 'audit.checkpoint.create')).at(-1)?.details).toMatchObject({
      seq: r.json.checkpoint.seq,
      trigger: 'manual',
      peers: 2,
    });

    expect(await flushOutbox(a.deps)).toEqual({ delivered: 2, failed: 0 });
    for (const n of [b, c]) {
      const rows = await held(n, a);
      expect(rows.map((x) => [x.seq, x.hash])).toEqual([[r.json.checkpoint.seq, r.json.checkpoint.hash]]);
      // keine Personendaten: nur Laufnummer, Hash, Zeit, Signatur und Schlüssel
      expect(JSON.parse(rows[0]!.statement)).toEqual({
        format: 'osp-data-mesh/audit-checkpoint@1',
        nodeId: 'anchor-a',
        // Epoche der Kette (neu nach jeder Wiederherstellung, Migration 0610)
        epoch: r.json.checkpoint.epoch,
        seq: r.json.checkpoint.seq,
        hash: r.json.checkpoint.hash,
        at: expect.any(String),
      });
      const received = await auditEntries(n, 'audit.checkpoint.received');
      expect(received.at(-1)?.details).toMatchObject({ nodeId: 'anchor-a', seq: r.json.checkpoint.seq });
    }
    const status = await b.request<{ heldForPartners: { nodeId: string; count: number }[] }>(
      'GET',
      '/api/v1/audit/anchors',
      { as: await b.user(['auditor']) },
    );
    expect(status.json.heldForPartners).toEqual([
      expect.objectContaining({ nodeId: 'anchor-a', count: 1, latestSeq: r.json.checkpoint.seq }),
    ]);
  });

  test('Abgleich bei intakter Kette: verankert und intakt; Abfrage beim Partner protokolliert', async () => {
    const r = await a.request<Verification>('POST', '/api/v1/audit/anchors/verify', { as: auditorA });
    expect(r.status).toBe(200);
    expect(r.json.result).toBe('ok');
    expect(r.json.local.ok).toBe(true);
    expect(r.json.partners.map((p) => [p.nodeId, p.status, p.checkpoints])).toEqual(
      [
        ['anchor-b', 'ok', 1],
        ['anchor-c', 'ok', 1],
      ].sort(),
    );
    expect((await auditEntries(a, 'audit.anchor.verify')).at(-1)).toMatchObject({ outcome: 'success' });
    expect((await auditEntries(b, 'audit.checkpoint.served')).length).toBeGreaterThan(0);
  });

  test('Partner nicht erreichbar: übrige genügen; keiner erreichbar → nicht verankert (protokolliert)', async () => {
    offline(b);
    let r = await verify(a);
    expect(r.result).toBe('ok');
    expect(r.partners.find((p) => p.nodeId === 'anchor-b')?.status).toBe('unreachable');
    offline(c);
    r = await verify(a);
    expect(r.result).toBe('unanchored');
    expect((await auditEntries(a, 'audit.anchor.verify')).at(-1)).toMatchObject({ outcome: 'error' });
    online(b);
    online(c);
  });

  test('verlorene Mitteilung wird wiederholt; ältere unzugestellte Prüfpunkte entfallen (neuerer schließt sie ein)', async () => {
    offline(b);
    const first = await checkpointNow(a);
    expect(await flushOutbox(a.deps)).toEqual({ delivered: 1, failed: 1 });
    const second = await checkpointNow(a);
    expect(second.checkpoint.seq).toBeGreaterThan(first.checkpoint.seq);
    const pendingForB = await a.deps.db
      .selectFrom('outbox_message')
      .select('body')
      .where('peer_id', '=', (await peerRow(a, b)).id)
      .where('status', '=', 'pending')
      .execute();
    expect(pendingForB).toHaveLength(1);
    online(b);
    expect(await flushOutbox(a.deps)).toEqual({ delivered: 2, failed: 0 });
    expect((await held(b, a)).map((x) => x.seq)).toContain(second.checkpoint.seq);
    expect((await held(c, a)).map((x) => x.seq)).toEqual(
      expect.arrayContaining([first.checkpoint.seq, second.checkpoint.seq]),
    );
  });

  test('Planer: fällig nach dem Intervall und nur, wenn die Kette gewachsen ist', async () => {
    expect(a.deps.config.MESH_AUDIT_CHECKPOINT_HOURS).toBe(1);
    const activity = () => a.deps.audit.record({ actor: CLI_ACTOR, action: 'test.activity' });
    try {
      await activity();
      expect(await scheduledCheckpoint(a.deps)).toBe(false); // gerade erst erstellt
      clock.advance(61 * 60_000);
      expect(await scheduledCheckpoint(a.deps)).toBe(true);
      expect((await auditEntries(a, 'audit.checkpoint.create')).at(-1)?.details).toMatchObject({
        trigger: 'schedule',
      });
      clock.advance(61 * 60_000);
      // seit dem letzten Prüfpunkt nur dessen eigener Eintrag hinzugekommen
      expect(await scheduledCheckpoint(a.deps)).toBe(false);
      await activity();
      expect(await scheduledCheckpoint(a.deps)).toBe(true);
    } finally {
      clock.reset();
    }
    await flushOutbox(a.deps);
  });
});

describe('Ablehnung gesperrter, gefälschter und widersprüchlicher Prüfpunkte', () => {
  test('Prüfpunkt eines gesperrten Partners wird nicht verwahrt (protokolliert)', async () => {
    const before = (await held(b, a)).length;
    await b.request('POST', `/api/v1/peers/${aOnB.id}/suspend`, { as: await adminOf(b) });
    await checkpointNow(a);
    const r = await flushOutbox(a.deps);
    expect(r.failed).toBe(1);
    expect((await held(b, a)).length).toBe(before);
    expect((await auditEntries(b, 'audit.checkpoint.rejected')).at(-1)?.details).toMatchObject({
      code: 'untrusted',
      reason: 'peer_not_trusted',
    });
    await b.request('POST', `/api/v1/peers/${aOnB.id}/trust`, {
      as: await adminOf(b),
      body: { fingerprint: aOnB.fingerprint },
    });
  });

  test('fremd signierter Prüfpunkt → bad_signature; fremde Knoten-ID → bad_request', async () => {
    const statement = buildCheckpointStatement({
      nodeId: 'anchor-a',
      seq: 1,
      hash: 'a'.repeat(64),
      at: clock.now().toISOString(),
    });
    const forged = await rawSend(b, {
      from: a,
      type: 'notice',
      body: {
        kind: 'audit_checkpoint',
        statement,
        signature: ed25519Sign(generateEd25519().privateKey, statement),
      },
    });
    expect(forged.status).toBe(401);
    expect(forged.json.error).toEqual({ code: 'bad_signature', reason: 'checkpoint_signature_invalid' });
    const other = buildCheckpointStatement({
      nodeId: 'anchor-c',
      seq: 1,
      hash: 'a'.repeat(64),
      at: clock.now().toISOString(),
    });
    const wrong = await rawSend(b, {
      from: a,
      type: 'notice',
      body: { kind: 'audit_checkpoint', statement: other, signature: a.deps.identity.sign(other) },
    });
    expect(wrong.json.error).toEqual({ code: 'bad_request', reason: 'wrong_node' });
  });

  test('widersprüchlicher Prüfpunkt (gleiche Laufnummer, anderer Hash) → abgelehnt, Original bleibt, protokolliert', async () => {
    const kept = (await held(b, a)).at(-1)!;
    const contradicting = buildCheckpointStatement({
      nodeId: 'anchor-a',
      // Widerspruch innerhalb derselben Epoche (je Epoche eindeutig, Migration 0610)
      epoch: JSON.parse(kept.statement).epoch,
      seq: kept.seq,
      hash: 'b'.repeat(64),
      at: clock.now().toISOString(),
    });
    const r = await rawSend(b, {
      from: a,
      type: 'notice',
      body: {
        kind: 'audit_checkpoint',
        statement: contradicting,
        signature: a.deps.identity.sign(contradicting),
      },
    });
    expect(r.json.error).toEqual({ code: 'bad_request', reason: 'checkpoint_conflict' });
    expect((await held(b, a)).at(-1)?.hash).toBe(kept.hash);
    const conflict = (await auditEntries(b, 'audit.checkpoint.conflict')).at(-1);
    expect(conflict?.outcome).toBe('denied');
    expect(conflict?.details).toMatchObject({
      seq: kept.seq,
      heldHash: kept.hash,
      receivedHash: 'b'.repeat(64),
    });
    // derselbe Prüfpunkt erneut (Wiederholung des Ausgangspostfachs): bestätigt, nicht doppelt
    const dup = await rawSend(b, {
      from: a,
      type: 'notice',
      body: { kind: 'audit_checkpoint', statement: kept.statement, signature: kept.signature },
    });
    expect(dup.json.body).toEqual({ ack: true, affectedRows: 0 });
  });

  test('Abfrage verwahrter Prüfpunkte: nur die eigenen, seitenweise; unbekannte Knoten abgewiesen', async () => {
    const ofA = await held(b, a);
    const page = await rawSend(b, { from: a, type: 'checkpoints', body: { afterSeq: 0, limit: 1 } });
    expect(page.status).toBe(200);
    const body = page.json.body as { checkpoints: { statement: string }[]; more: boolean };
    expect(body.checkpoints).toHaveLength(1);
    expect(body.more).toBe(ofA.length > 1);
    expect(JSON.parse(body.checkpoints[0]!.statement).seq).toBe(ofA[0]!.seq);
    // c hat b keine Prüfpunkte gesendet: leer (nicht die von a)
    const { aOnB: cOnB } = await onboard(c, b);
    expect(cOnB.status).toBe('trusted');
    const fromC = await rawSend(b, { from: c, type: 'checkpoints', body: { afterSeq: 0, limit: 1000 } });
    expect(fromC.json.body).toEqual({ checkpoints: [], more: false });
    const bad = await rawSend(b, { from: a, type: 'checkpoints', body: { afterSeq: -1, limit: 5000 } });
    expect(bad.json.error?.code).toBe('bad_request');
    const stranger = await mesh.add({ nodeId: 'anchor-x', now: clock.now });
    const unknown = await rawSend(b, {
      from: stranger,
      type: 'checkpoints',
      body: { afterSeq: 0, limit: 10 },
    });
    expect(unknown.json.error?.code).toBe('unknown_node');
  });
});

describe('Erkennen von Manipulationen durch den Datenbank-Eigentümer', () => {
  let t: TestNode;
  let w: TestNode;
  let exportFile: string;

  beforeAll(async () => {
    t = await mesh.add({ nodeId: 'anchor-t', now: clock.now });
    w = await mesh.add({ nodeId: 'anchor-w', now: clock.now });
    for (const n of [t, w]) {
      await onboard(n, b);
      n.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
    }
  });

  test('abgeschnittene Kette: lokal „intakt“, Abgleich mit Partnern erkennt das fehlende Ende', async () => {
    const cp = await checkpointNow(t);
    expect((await flushOutbox(t.deps)).delivered).toBe(1);
    expect((await verify(t)).result).toBe('ok');

    await truncateTail(t, cp.checkpoint.seq - 1);
    const local = await verifyAuditChain(t.deps.db);
    expect(local.ok).toBe(true); // die Hash-Kette allein bemerkt das Abschneiden nicht
    const r = await verify(t);
    expect(r.result).toBe('manipulated');
    const fromB = r.partners.find((p) => p.nodeId === 'anchor-b');
    expect(fromB?.status).toBe('mismatch');
    expect(fromB?.firstProblem).toEqual({ seq: cp.checkpoint.seq, kind: 'missing' });
    const audit = (await auditEntries(t, 'audit.anchor.verify')).at(-1);
    expect(audit).toMatchObject({ outcome: 'error' });
    expect(audit?.details).toMatchObject({ result: 'manipulated', chainOk: true });
  });

  test('konsistent umgeschriebene Kette: lokal „intakt“, Abgleich erkennt den abweichenden Hash; Export-Datei ebenso', async () => {
    const cp = await checkpointNow(w);
    expect((await flushOutbox(w.deps)).delivered).toBe(1);
    // Prüfpunkt als Datei exportieren (Verankerung außerhalb des Netzes)
    const exp = await w.request<{ seq: number; statement: string; fingerprint: string }>(
      'GET',
      '/api/v1/audit/anchors/latest',
      { as: await w.user(['auditor']) },
    );
    expect(exp.status).toBe(200);
    expect(exp.json.seq).toBe(cp.checkpoint.seq);
    expect(exp.json.fingerprint).toBe(w.deps.identity.fingerprint);
    exportFile = join(tmp, 'checkpoint-w.json');
    writeFileSync(exportFile, JSON.stringify(exp.json));
    const before = await cli(['verify-audit', '--checkpoint', exportFile], envOf(w));
    expect(before.code).toBe(0);

    await rewriteFrom(w, Math.max(1, cp.checkpoint.seq - 2));
    expect((await verifyAuditChain(w.deps.db)).ok).toBe(true);
    const r = await verify(w);
    expect(r.result).toBe('manipulated');
    const fromB = r.partners.find((p) => p.nodeId === 'anchor-b');
    expect(fromB).toMatchObject({
      status: 'mismatch',
      firstProblem: { seq: cp.checkpoint.seq, kind: 'hash_mismatch' },
    });

    const after = await cli(['verify-audit', '--checkpoint', exportFile], envOf(w));
    expect(after.code).toBe(1);
    expect(after.stdout).toContain('HASH ABWEICHEND');
  });

  test('vom Partner verfälschter Prüfpunkt zählt nicht als Beleg gegen die eigene Kette', async () => {
    // b (bzw. dessen Datenbank) liefert einen Prüfpunkt mit ungültiger Signatur
    const peer = await peerRow(b, a);
    const statement = buildCheckpointStatement({
      nodeId: 'anchor-a',
      seq: 999_999,
      hash: 'c'.repeat(64),
      at: clock.now().toISOString(),
    });
    await b.deps.db
      .insertInto('peer_audit_checkpoint')
      .values({
        peer_id: peer.id,
        seq: 999_999,
        hash: 'c'.repeat(64),
        checkpoint_at: clock.now(),
        statement,
        signature: ed25519Sign(generateEd25519().privateKey, statement),
        public_key: peer.public_key,
      })
      .execute();
    const r = await verify(a);
    const fromB = r.partners.find((p) => p.nodeId === 'anchor-b');
    expect(fromB).toMatchObject({ status: 'error', invalidSignatures: 1, firstProblem: null });
    expect(r.result).toBe('ok'); // c bestätigt
  });
});

describe('Rechte der Datenbankrollen', () => {
  test('mesh_app: Prüfpunkte nur lesen und anhängen, Schlüsselverlauf nicht löschen; mesh_bi: kein Zugriff', async () => {
    const app = b.testDb.urls.app;
    for (const stmt of [
      `update peer_audit_checkpoint set hash = 'x'`,
      'delete from peer_audit_checkpoint',
      `update audit_checkpoint set hash = 'x'`,
      'delete from audit_checkpoint',
      'truncate peer_audit_checkpoint',
      'delete from node_key_rotation',
      'delete from node_key_rotation_peer',
    ]) {
      await expect(queryAs(app, stmt)).rejects.toThrow(/permission denied/);
    }
    expect((await queryAs(app, 'select count(*) from peer_audit_checkpoint')).rows).toHaveLength(1);
    for (const table of [
      'audit_checkpoint',
      'peer_audit_checkpoint',
      'node_key_rotation',
      'node_key_rotation_peer',
    ]) {
      // mesh_bi sieht das Schema public gar nicht (kein USAGE) bzw. hat kein Leserecht
      await expect(queryAs(b.testDb.urls.bi, `select * from public.${table}`)).rejects.toThrow(
        /permission denied|does not exist/,
      );
    }
  });
});

describe('Prüfpunkte nach einem Schlüsselwechsel', () => {
  test('ältere (alter Schlüssel) und neuere (neuer Schlüssel) Prüfpunkte bleiben prüfbar', async () => {
    const admin = await a.user(['admin']);
    const rot = await a.request('POST', '/api/v1/node/key/rotate', {
      as: admin,
      body: { mode: 'routine', graceDays: 7, confirm: true },
    });
    expect(rot.status).toBe(200);
    await flushOutbox(a.deps);
    await checkpointNow(a);
    expect((await flushOutbox(a.deps)).failed).toBe(0);
    const r = await verify(a);
    const fromC = r.partners.find((p) => p.nodeId === 'anchor-c');
    expect(fromC?.status).toBe('ok');
    expect(fromC?.checkpoints).toBeGreaterThan(3);
    expect(fromC?.invalidSignatures).toBe(0);
  });
});

describe('Kommandozeile', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let p: TestNode;
  let q: TestNode;

  beforeAll(async () => {
    p = await mesh.add({ nodeId: 'anchor-p', now: clock.now });
    q = await mesh.add({ nodeId: 'anchor-q', now: clock.now });
    await onboard(p, q);
    // q als echter HTTP-Server (die CLI ruft über das Netz auf), Port aus dem zugewiesenen Bereich
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 4461,
      fetch: (req, srv) => q.app.fetch(req, { server: srv }),
    });
    // derselbe Knoten auch für die In-Process-Zustellung des Ausgangspostfachs von p
    mesh.routes.set('http://127.0.0.1:4461', (req) => q.app.fetch(req));
    await p.deps.db
      .updateTable('peer')
      .set({ base_url: 'http://127.0.0.1:4461' })
      .where('node_id', '=', 'anchor-q')
      .execute();
  });
  afterAll(() => {
    server?.stop(true);
  });

  test('audit-checkpoint erstellt, exportiert in eine Datei; verify-audit --with-partners gleicht über HTTP ab', async () => {
    const out = join(tmp, 'checkpoint-p.json');
    const made = await cli(['audit-checkpoint', '--out', out], envOf(p));
    expect(made.code).toBe(0);
    const file = JSON.parse(readFileSync(out, 'utf8'));
    expect(file).toMatchObject({ format: 'osp-data-mesh/audit-checkpoint-export@1', nodeId: 'anchor-p' });
    expect((await flushOutbox(p.deps)).delivered).toBe(1);

    const ok = await cli(['verify-audit', '--with-partners'], envOf(p));
    expect(ok.stdout).toContain('VERANKERT UND INTAKT');
    expect(ok.code).toBe(0);
    // ohne Profil ausdrücklich nicht unabhängig von der Datenbank
    expect(ok.stdout).toContain('NICHT UNABHÄNGIG');

    // Anker-Profil exportieren und unabhängig prüfen (Partner, Adresse, Schlüssel nur aus dem Profil)
    const profileFile = join(tmp, 'profile-p.json');
    const exported = await cli(['audit-anchor-profile', '--out', profileFile], envOf(p));
    expect(exported.code).toBe(0);
    const withProfile = await cli(['verify-audit', '--with-partners', '--profile', profileFile], envOf(p));
    expect(withProfile.code).toBe(0);
    expect(withProfile.stdout).toContain('Anker-Profil');
    expect(withProfile.stdout).toContain(`Fingerprint ${q.deps.identity.fingerprint}`);
    expect(withProfile.stdout).not.toContain('NICHT UNABHÄNGIG');

    await truncateTail(p, file.seq);
    const badProfile = await cli(['verify-audit', '--with-partners', '--profile', profileFile], envOf(p));
    expect(badProfile.code).toBe(1);
    expect(badProfile.stdout).toContain('MANIPULATION ERKANNT');
    const bad = await cli(['verify-audit', '--with-partners'], envOf(p));
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('MANIPULATION ERKANNT');
    expect(bad.stdout).toContain(`seq ${file.seq}`);
    // ohne Partner: lokal „ok“, mit Hinweis
    const plain = await cli(['verify-audit'], envOf(p));
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('--with-partners');
  });

  test('nicht verankert (Partner nicht erreichbar) → Exit 3', async () => {
    server?.stop(true);
    server = null;
    const r = await cli(['verify-audit', '--with-partners'], envOf(q));
    // q hat keine Prüfpunkte bei p hinterlegt
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('NICHT VERANKERT');
  });
});

describe('Vergleich (reine Funktion)', () => {
  test('fehlende und abweichende Einträge, sortiert nach Laufnummer', () => {
    const local = new Map([
      [1, 'h1'],
      [2, 'h2'],
    ]);
    expect(
      compareCheckpoints(local, [
        { seq: 3, hash: 'h3' },
        { seq: 2, hash: 'x' },
        { seq: 1, hash: 'h1' },
      ]).problems,
    ).toEqual([
      { seq: 2, kind: 'hash_mismatch' },
      { seq: 3, kind: 'missing' },
    ]);
    expect(compareCheckpoints(local, []).problems).toEqual([]);
  });
});
