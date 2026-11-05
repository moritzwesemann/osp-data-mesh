/**
 * Epochen der Audit-Kette, Schlüsselzeiträume und Grenzen beim Partner (ADR 0014, Nachtrag; Prüfbefunde
 * M2, L2, L3):
 *  - M2: Eine Wiederherstellung beginnt eine neue Epoche (restore). Prüfpunkte früherer Epochen müssen bis
 *    zur übernommenen Laufnummer weiter passen (sonst Manipulation), spätere sind „durch Wiederherstellung
 *    verloren“ (Klärung nötig, Exit 4, nie still „ok“). Partner nehmen Prüfpunkte der neuen Epoche an
 *    (protokolliert). Eine vom Datenbank-Eigentümer vorgetäuschte Epoche ist nie „ok“; mit Profil als nicht
 *    dokumentiert markiert. mesh_app kann den Epochenverlauf nicht ändern.
 *  - L2: Abweichungen, signiert mit einem als kompromittiert abgelösten Schlüssel, sind kein Beweis;
 *    Signaturen außerhalb des Gültigkeitszeitraums eines Schlüssels zählen nicht.
 *  - L3: je Partner und Epoche nur steigende Laufnummern (Wiederholung bestätigt), höchstens
 *    MESH_AUDIT_CHECKPOINT_MAX_PER_DAY je 24 Stunden; Ablehnungen zusammengefasst protokolliert.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from '../../src/server/cli/main.ts';
import { ed25519Sign } from '../../src/server/core/crypto.ts';
import {
  buildAnchorProfile,
  type LoadedProfile,
} from '../../src/server/modules/federation/anchor-profile.ts';
import {
  type AnchorVerification,
  buildCheckpointStatement,
  createCheckpoint,
  currentEpoch,
  loadEpochs,
  verifyAnchors,
} from '../../src/server/modules/federation/anchors.ts';
import { rotateNodeKey } from '../../src/server/modules/federation/keys.ts';
import { flushOutbox } from '../../src/server/modules/federation/outbox.ts';
import { restoreBackup } from '../../src/server/modules/system/restore.ts';
import { queryAs } from '../helpers/db.ts';
import {
  adminOf,
  auditEntries,
  cardOf,
  onboard,
  peerRow,
  rawSend,
  TestClock,
} from '../helpers/federation.ts';
import { TestMesh, type TestNode } from '../helpers/node.ts';

const mesh = new TestMesh();
const clock = new TestClock();
const ACTOR = { type: 'system' as const, id: null, label: 'test' };
const tmp = mkdtempSync(join(tmpdir(), 'osp-anchor-epochs-'));
const backupDirs: string[] = [];
let b: TestNode;

const noFlush = (n: TestNode) => {
  n.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
};

async function node(nodeId: string, config?: Record<string, string>) {
  const n = await mesh.add({ nodeId, now: clock.now, config });
  noFlush(n);
  backupDirs.push(resolve(n.deps.config.MESH_BACKUP_DIR));
  return n;
}

async function activity(n: TestNode, count = 1) {
  for (let i = 0; i < count; i++) await n.deps.audit.record({ actor: ACTOR, action: 'test.activity' });
}

async function checkpoint(n: TestNode) {
  await activity(n);
  const r = await createCheckpoint(n.deps, 'manual', { actor: ACTOR });
  expect((await flushOutbox(n.deps)).failed).toBe(0);
  return r.checkpoint;
}

function loaded(profile: Awaited<ReturnType<typeof buildAnchorProfile>>): LoadedProfile {
  return { profile, sha256: 'test' };
}

async function verify(n: TestNode, profile?: LoadedProfile) {
  return verifyAnchors(n.deps, { actor: ACTOR }, { profile });
}

const partnerB = (r: AnchorVerification) => r.partners.find((p) => p.nodeId === 'ep-b')!;
const finding = (r: AnchorVerification, code: string) => r.findings.filter((f) => f.code === code);

/** Kette ab seq konsistent neu berechnen (wie ein Eigentümer, der Inhalte umschreibt) */
async function rewriteFrom(n: TestNode, seq: number, extra = '') {
  await queryAs(
    n.testDb.urls.owner,
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
     ${extra}
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
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await runCli(args), stdout };
  } finally {
    process.stdout.write = write;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

beforeAll(async () => {
  b = await node('ep-b');
});
afterAll(async () => {
  await mesh.close();
  rmSync(tmp, { recursive: true, force: true });
  for (const d of backupDirs) rmSync(d, { recursive: true, force: true });
});

describe('M2: Wiederherstellung beginnt eine neue Epoche', () => {
  let a: TestNode;
  let cp1: Awaited<ReturnType<typeof checkpoint>>;
  let cp2: Awaited<ReturnType<typeof checkpoint>>;
  let e1: string;
  let restoredSeq: number;
  let profileBefore: LoadedProfile;
  let exportCp2: string;

  beforeAll(async () => {
    a = await node('ep-a');
    await onboard(a, b);
  });

  test('restore: neue Epoche mit vorheriger Epoche und übernommener Laufnummer, protokolliert; mesh_app ändert nichts', async () => {
    e1 = await currentEpoch(a.deps.db);
    cp1 = await checkpoint(a);
    expect(cp1.epoch).toBe(e1);
    const run = await a.deps.services.backup.runBackup('cli', null);
    await activity(a, 12);
    cp2 = await checkpoint(a);
    profileBefore = loaded(await buildAnchorProfile(a.deps.db, { nodeId: a.nodeId, now: clock.now() }));
    const exp = await a.request('GET', '/api/v1/audit/anchors/latest', { as: await a.user(['auditor']) });
    exportCp2 = join(tmp, 'cp2.json');
    writeFileSync(exportCp2, JSON.stringify(exp.json));

    const r = await restoreBackup({
      file: join(resolve(a.deps.config.MESH_BACKUP_DIR), run.fileName!),
      ownerUrl: a.testDb.urls.owner,
      backupKey: a.deps.config.MESH_BACKUP_KEY!,
      expectedNodeId: a.nodeId,
    });
    expect(r.audit.ok).toBe(true);
    expect(r.epoch).not.toBeNull();
    restoredSeq = r.epoch!.restoredSeq;
    expect(r.epoch!.previousEpoch).toBe(e1);
    expect(restoredSeq).toBeGreaterThan(cp1.seq);
    expect(restoredSeq).toBeLessThan(cp2.seq);
    const epochs = await loadEpochs(a.deps.db);
    expect(epochs.map((e) => [e.n, e.reason, e.previousEpoch, e.restoredSeq])).toEqual([
      [1, 'initial', null, null],
      [2, 'restore', e1, restoredSeq],
    ]);
    expect(await currentEpoch(a.deps.db)).toBe(r.epoch!.epoch);
    const entry = (await auditEntries(a, 'backup.restore')).at(-1);
    expect(entry?.seq).toBe(restoredSeq + 1);
    expect(entry?.details).toMatchObject({ epoch: r.epoch!.epoch, previousEpoch: e1, restoredSeq });

    // Rechte: mesh_app liest den Verlauf nur, mesh_bi gar nicht
    for (const stmt of [
      `insert into audit_chain_epoch (n, epoch, reason, previous_epoch, restored_seq)
         values (9, gen_random_uuid(), 'restore', '${e1}', 1)`,
      'update audit_chain_epoch set restored_seq = 0',
      'delete from audit_chain_epoch',
      'truncate audit_chain_epoch',
      'delete from peer_audit_checkpoint',
    ]) {
      await expect(queryAs(a.testDb.urls.app, stmt)).rejects.toThrow(/permission denied/);
    }
    expect(
      (await queryAs(a.testDb.urls.app, 'select count(*)::int as n from audit_chain_epoch')).rows,
    ).toEqual([{ n: 2 }]);
    await expect(queryAs(a.testDb.urls.bi, 'select * from public.audit_chain_epoch')).rejects.toThrow(
      /permission denied|does not exist/,
    );
  });

  test('Abgleich: Prüfpunkt bis zur übernommenen Laufnummer passt, späterer „durch Wiederherstellung verloren“ (Klärung nötig)', async () => {
    const r = await verify(a);
    expect(r.result).toBe('needs_review');
    expect(r.local.ok).toBe(true);
    expect(partnerB(r)).toMatchObject({ status: 'needs_review', matched: 1, lostByRestore: 1, problems: 0 });
    expect(finding(r, 'lost_by_restore')).toEqual([
      { code: 'lost_by_restore', severity: 'review', nodeId: 'ep-b', count: 1 },
    ]);
    expect(finding(r, 'restore_epoch')[0]).toMatchObject({ severity: 'info', seq: restoredSeq });
    expect((await auditEntries(a, 'audit.anchor.verify')).at(-1)).toMatchObject({ outcome: 'error' });
    // Profil von vor der Wiederherstellung: neue Epoche nicht dokumentiert → der Verlust ist nicht erklärt
    // und gilt als Abschneiden, bis das Profil mit --accept-epochs neu exportiert ist (Nachtrag 2)
    const old = await verify(a, profileBefore);
    expect(old.result).toBe('manipulated');
    expect(finding(old, 'epoch_not_in_profile')).toHaveLength(1);
    expect(finding(old, 'lost_by_restore')[0]?.severity).toBe('fail');
    expect(partnerB(old)).toMatchObject({ status: 'mismatch', firstProblem: { kind: 'lost_by_restore' } });
    // exportierter Prüfpunkt der früheren Epoche: Exit 4 (Klärung nötig)
    const cfg = a.deps.config;
    const exitCode = await cli(['verify-audit', '--checkpoint', exportCp2], {
      MESH_NODE_ID: cfg.MESH_NODE_ID,
      MESH_DB_URL: cfg.MESH_DB_URL,
    });
    expect(exitCode.code).toBe(4);
    expect(exitCode.stdout).toContain('Wiederherstellung verloren');
  });

  test('neue Epoche: Partner nimmt niedrigere Laufnummern an und protokolliert den Wechsel; dokumentiertes Profil → ok', async () => {
    const cp3 = await checkpoint(a);
    expect(cp3.epoch).not.toBe(e1);
    expect(cp3.seq).toBeLessThan(cp2.seq);
    const changed = (await auditEntries(b, 'audit.checkpoint.epoch_changed')).at(-1);
    expect(changed?.details).toMatchObject({
      nodeId: 'ep-a',
      epoch: cp3.epoch,
      previousEpochs: [e1],
      seq: cp3.seq,
    });
    const peer = await peerRow(b, a);
    const held = await b.deps.db
      .selectFrom('peer_audit_checkpoint')
      .select(['seq', 'epoch'])
      .where('peer_id', '=', peer.id)
      .orderBy('received_at')
      .execute();
    expect(held).toEqual([
      { seq: cp1.seq, epoch: e1 },
      { seq: cp2.seq, epoch: e1 },
      { seq: cp3.seq, epoch: cp3.epoch },
    ]);

    // ohne Profil bleibt der Verlust sichtbar
    const db = await verify(a);
    expect(db.result).toBe('needs_review');
    expect(partnerB(db)).toMatchObject({ matched: 2, lostByRestore: 1 });
    // Profil nach der Wiederherstellung (dokumentiert beide Epochen): erklärt, Hinweis bleibt
    // die neue Epoche muss ausdrücklich angenommen werden (Nachtrag 2)
    await expect(
      buildAnchorProfile(a.deps.db, { nodeId: a.nodeId, now: clock.now(), previous: profileBefore.profile }),
    ).rejects.toThrow(/previous_changes_not_accepted/);
    const after = loaded(
      await buildAnchorProfile(a.deps.db, {
        nodeId: a.nodeId,
        now: clock.now(),
        previous: profileBefore.profile,
        accept: { epochs: true },
      }),
    );
    expect(after.profile.epochs.map((e) => e.reason)).toEqual(['initial', 'restore']);
    // Sicherung und Kopf vor der Wiederherstellung stehen im Profil (Abgleich mit dem Protokoll)
    const restoreEpoch = { ...after.profile.epochs[1]! };
    expect(restoreEpoch.backupSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof restoreEpoch.backupCreatedAt).toBe('string');
    expect(restoreEpoch.preRestoreEpoch).toBe(e1);
    expect(restoreEpoch.preRestoreHash).toMatch(/^[0-9a-f]{64}$/);
    // Kopf unmittelbar vor der Wiederherstellung: hinter dem letzten Prüfpunkt der vorigen Epoche
    expect(restoreEpoch.preRestoreSeq ?? 0).toBeGreaterThan(cp2.seq);
    const ok = await verify(a, after);
    expect(ok.result).toBe('ok');
    expect(finding(ok, 'lost_by_restore')).toEqual([
      { code: 'lost_by_restore', severity: 'info', nodeId: 'ep-b', count: 1 },
    ]);
  });

  test('Umschreiben im übernommenen Teil (Laufnummer ≤ restoredSeq) bleibt Manipulation', async () => {
    await rewriteFrom(a, cp1.seq - 1);
    const r = await verify(a);
    expect(r.result).toBe('manipulated');
    expect(partnerB(r).firstProblem).toMatchObject({ seq: cp1.seq, kind: 'hash_mismatch', epoch: e1 });
  });
});

describe('M2: vom Datenbank-Eigentümer vorgetäuschte Epoche', () => {
  test('Umschreiben + erfundene Wiederherstellung: nie „ok“; mit Profil nicht dokumentiert', async () => {
    const f = await node('ep-fake');
    await onboard(f, b);
    const early = await checkpoint(f);
    await activity(f, 5);
    const cp = await checkpoint(f);
    const profile = loaded(await buildAnchorProfile(f.deps.db, { nodeId: f.nodeId, now: clock.now() }));
    const e1 = await currentEpoch(f.deps.db);
    const from = cp.seq - 2;
    // mesh_app kann keine Epoche eintragen
    await expect(
      queryAs(
        f.testDb.urls.app,
        `insert into audit_chain_epoch (n, epoch, reason, previous_epoch, restored_seq)
         values (2, gen_random_uuid(), 'restore', '${e1}', ${from - 1})`,
      ),
    ).rejects.toThrow(/permission denied/);
    await rewriteFrom(
      f,
      from,
      `insert into audit_chain_epoch (n, epoch, reason, previous_epoch, restored_seq)
         values (2, gen_random_uuid(), 'restore', '${e1}', ${from - 1});`,
    );
    expect(from - 1).toBeGreaterThanOrEqual(early.seq);
    const db = await verify(f);
    // der frühere Prüfpunkt passt weiter, der spätere gilt als „verloren“: Klärung nötig statt „ok“
    expect(db.result).toBe('needs_review');
    expect(partnerB(db)).toMatchObject({ matched: 1, lostByRestore: 1 });
    expect(finding(db, 'lost_by_restore')).toHaveLength(1);
    // mit Profil: nicht dokumentierte Epoche + verlorene Prüfpunkte = Manipulation (Nachtrag 2)
    const pr = await verify(f, profile);
    expect(pr.result).toBe('manipulated');
    expect(finding(pr, 'epoch_not_in_profile')[0]).toMatchObject({ severity: 'review', seq: from - 1 });
    expect(finding(pr, 'lost_by_restore')[0]).toMatchObject({ severity: 'fail', count: 1 });
  });
});

describe('L3: Grenzen für verwahrte Prüfpunkte', () => {
  function statement(n: TestNode, seq: number, epoch: string | undefined, hash = 'a'.repeat(64)) {
    const s = buildCheckpointStatement({ nodeId: n.nodeId, epoch, seq, hash, at: clock.now().toISOString() });
    return { kind: 'audit_checkpoint' as const, statement: s, signature: n.deps.identity.sign(s) };
  }
  async function send(to: TestNode, from: TestNode, body: ReturnType<typeof statement>) {
    return rawSend(to, { from, type: 'notice', body });
  }
  const rejectedWith = async (n: TestNode, reason: string) =>
    (await auditEntries(n, 'audit.checkpoint.rejected')).filter((e) => e.details.reason === reason);

  test('nur steigend je Partner und Epoche; Wiederholung bestätigt; neue Epoche angenommen; ohne Epoche abgelehnt', async () => {
    const s = await node('ep-s');
    const r = await node('ep-r');
    await onboard(s, r);
    const e = randomUUID();
    try {
      expect((await send(r, s, statement(s, 10, e))).json.body).toEqual({ ack: true, affectedRows: 1 });
      expect((await send(r, s, statement(s, 10, e))).json.body).toEqual({ ack: true, affectedRows: 0 });
      const lower = await send(r, s, statement(s, 5, e, 'b'.repeat(64)));
      expect(lower.json.error).toEqual({ code: 'bad_request', reason: 'checkpoint_not_increasing' });
      expect((await rejectedWith(r, 'checkpoint_not_increasing')).map((x) => x.details)).toEqual([
        expect.objectContaining({ seq: 5, heldMaxSeq: 10, epoch: e }),
      ]);
      // weitere im selben Zeitfenster: abgelehnt, nur im Betriebslog
      expect((await send(r, s, statement(s, 6, e))).json.error?.reason).toBe('checkpoint_not_increasing');
      expect(await rejectedWith(r, 'checkpoint_not_increasing')).toHaveLength(1);
      clock.advance(6 * 60_000);
      expect((await send(r, s, statement(s, 7, e))).json.error?.reason).toBe('checkpoint_not_increasing');
      const agg = await rejectedWith(r, 'checkpoint_not_increasing');
      expect(agg).toHaveLength(2);
      expect(agg[1]?.details).toMatchObject({ seq: 7, suppressed: 1 });

      // neue Epoche (nach Wiederherstellung des Absenders): niedrigere Laufnummer angenommen, protokolliert
      const e2 = randomUUID();
      expect((await send(r, s, statement(s, 3, e2))).json.body).toEqual({ ack: true, affectedRows: 1 });
      expect((await auditEntries(r, 'audit.checkpoint.epoch_changed')).at(-1)?.details).toMatchObject({
        epoch: e2,
        previousEpochs: [e],
        seq: 3,
      });
      // ohne Epoche (Aussage eines Knotens vor Migration 0610), nachdem Epochen gesendet wurden
      const legacy = await send(r, s, statement(s, 50, undefined));
      expect(legacy.json.error).toEqual({ code: 'bad_request', reason: 'checkpoint_epoch_required' });
    } finally {
      clock.reset();
    }
  });

  test('höchstens MESH_AUDIT_CHECKPOINT_MAX_PER_DAY je Partner in 24 Stunden (zusammengefasst protokolliert)', async () => {
    const s = await node('ep-s2');
    const r = await node('ep-r2', { MESH_AUDIT_CHECKPOINT_MAX_PER_DAY: '3' });
    await onboard(s, r);
    const e = randomUUID();
    try {
      for (const seq of [1, 2, 3]) {
        expect((await send(r, s, statement(s, seq, e))).json.body).toEqual({ ack: true, affectedRows: 1 });
      }
      const over = await send(r, s, statement(s, 4, e));
      expect(over.json.error).toEqual({ code: 'bad_request', reason: 'checkpoint_rate_limited' });
      expect((await send(r, s, statement(s, 5, e))).json.error?.reason).toBe('checkpoint_rate_limited');
      // Wiederholung eines verwahrten zählt nicht und wird weiter bestätigt
      expect((await send(r, s, statement(s, 3, e))).json.body).toEqual({ ack: true, affectedRows: 0 });
      const audited = await rejectedWith(r, 'checkpoint_rate_limited');
      expect(audited.map((x) => x.details)).toEqual([expect.objectContaining({ seq: 4, limitPerDay: 3 })]);
      const peer = await peerRow(r, s);
      const count = await r.deps.db
        .selectFrom('peer_audit_checkpoint')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('peer_id', '=', peer.id)
        .executeTakeFirstOrThrow();
      expect(Number(count.n)).toBe(3);
      clock.advance(24 * 60 * 60_000 + 60_000);
      expect((await send(r, s, statement(s, 6, e))).json.body).toEqual({ ack: true, affectedRows: 1 });
    } finally {
      clock.reset();
    }
  });
});

describe('L2: Gültigkeitszeiträume der eigenen Schlüssel', () => {
  test('Abweichung mit kompromittiertem Schlüssel: nicht beweiskräftig; Signatur außerhalb des Zeitraums zählt nicht', async () => {
    const k = await node('ep-k');
    const { aOnB: kOnB } = await onboard(k, b);
    const cp = await checkpoint(k);
    await rotateNodeKey(k.deps, { mode: 'routine', actor: ACTOR });
    await flushOutbox(k.deps);
    // privater Schlüssel nach dem planmäßigen Wechsel (K1), dann Wechsel wegen Kompromittierung (K1 → K2)
    const row = await k.deps.db
      .selectFrom('node_identity')
      .select('private_key_enc')
      .executeTakeFirstOrThrow();
    const k1 = k.deps.box.open(row.private_key_enc, 'node_identity.private_key');
    const rotatedAt = clock.now();
    clock.advance(60_000);
    await rotateNodeKey(k.deps, { mode: 'compromised', actor: ACTOR });
    // b gleicht den neuen Schlüssel ab (Vorgehen bei Kompromittierung)
    const admin = await adminOf(b);
    expect(
      (
        await b.request('POST', `/api/v1/peers/${kOnB.id}/key`, {
          as: admin,
          body: { card: await cardOf(k) },
        })
      ).status,
    ).toBe(200);
    await b.request('POST', `/api/v1/peers/${kOnB.id}/trust`, {
      as: admin,
      body: { fingerprint: k.deps.identity.fingerprint },
    });
    expect((await verify(k)).result).toBe('ok');

    // Angreifer mit K1 hinterlegt einen widersprechenden Prüfpunkt (Zeitpunkt im Zeitraum von K1)
    const epoch = await currentEpoch(k.deps.db);
    const plant = async (privateKey: string, seq: number, at: Date) => {
      const statement = buildCheckpointStatement({
        nodeId: k.nodeId,
        epoch,
        seq,
        hash: 'd'.repeat(64),
        at: at.toISOString(),
      });
      await b.deps.db
        .insertInto('peer_audit_checkpoint')
        .values({
          peer_id: kOnB.id,
          seq,
          hash: 'd'.repeat(64),
          epoch,
          checkpoint_at: at,
          statement,
          signature: ed25519Sign(privateKey, statement),
          public_key: 'x',
        })
        .execute();
    };
    await plant(k1, cp.seq - 1, new Date(rotatedAt.getTime() + 1000));
    const r = await verify(k);
    expect(r.result).toBe('needs_review');
    expect(r.partners[0]).toMatchObject({ status: 'needs_review', inconclusive: 1, problems: 0 });
    expect(finding(r, 'inconclusive')).toEqual([
      { code: 'inconclusive', severity: 'review', nodeId: 'ep-b', count: 1 },
    ]);

    // mit K1 nach dessen Ablösung signiert: kein Beleg (weder Abweichung noch Bestätigung)
    await plant(k1, cp.seq + 100, new Date(clock.now().getTime() + 3_600_000));
    const late = await verify(k);
    expect(late.partners[0]).toMatchObject({ status: 'error', invalidSignatures: 1, problems: 0 });
    expect(late.result).not.toBe('manipulated');
    clock.reset();
  });
});
