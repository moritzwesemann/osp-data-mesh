/**
 * Regressionstests zu den Prüfbefunden H1/H2 der externen Verankerung (ADR 0014, Nachtrag):
 *  - H1: Der Datenbank-Eigentümer ändert Inhalte des Audit-Logs, lässt die Spalte hash stehen und ersetzt
 *    audit_verify() – der Abgleich meldete „ok“. Jetzt wird die Kette im Programm neu berechnet.
 *  - H2: Partnerliste, Partnerschlüssel/-adressen und frühere eigene Schlüssel stammen aus derselben
 *    Datenbank. Gesperrte Partner machten aus „Manipulation“ ein „nicht verankert“; eine auf einen eigenen
 *    Dienst umgestellte Partneradresse plus eigener „früherer Knotenschlüssel“ ergab „ok“. Mit Anker-Profil
 *    (außerhalb der Datenbank) erkennt die Prüfung beides; ohne Profil ist sie ausdrücklich nicht unabhängig.
 *  - Profil: Normalfall, fehlender/nicht erreichbarer Partner (Abbruch, außer begründet entschuldigt),
 *    Mindestzahl, veraltetes Profil nach Schlüsselwechsel, Export und Prüfung über die Kommandozeile.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/server/cli/main.ts';
import { ed25519Sign, fingerprint, generateEd25519 } from '../../src/server/core/crypto.ts';
import { recomputeAuditChain } from '../../src/server/modules/audit/chain.ts';
import { verifyAuditChain } from '../../src/server/modules/audit/index.ts';
import {
  buildAnchorProfile,
  type LoadedProfile,
  loadAnchorProfile,
} from '../../src/server/modules/federation/anchor-profile.ts';
import {
  type AnchorVerification,
  buildCheckpointStatement,
  createCheckpoint,
  currentEpoch,
  verifyAnchors,
} from '../../src/server/modules/federation/anchors.ts';
import { flushOutbox } from '../../src/server/modules/federation/outbox.ts';
import { signResponse } from '../../src/server/modules/federation/protocol.ts';
import { queryAs } from '../helpers/db.ts';
import { auditEntries, onboard, TestClock } from '../helpers/federation.ts';
import { TestMesh, type TestNode } from '../helpers/node.ts';

const mesh = new TestMesh();
const clock = new TestClock();
const ACTOR = { type: 'system' as const, id: null, label: 'poc' };
const tmp = mkdtempSync(join(tmpdir(), 'osp-anchor-bypass-'));
let b: TestNode;
let c: TestNode;

function offline(node: TestNode) {
  mesh.nodes.delete(node.nodeId);
}
function online(node: TestNode) {
  mesh.nodes.set(node.nodeId, node);
}

/** Neuer Knoten mit den Partnern b und c und einem bei beiden zugestellten Prüfpunkt */
async function victim(nodeId: string) {
  const t = await mesh.add({ nodeId, now: clock.now });
  for (const w of [b, c]) await onboard(t, w);
  t.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
  await t.deps.audit.record({ actor: ACTOR, action: 'test.activity' });
  const cp = await createCheckpoint(t.deps, 'manual', { actor: ACTOR });
  expect((await flushOutbox(t.deps)).delivered).toBe(2);
  return { t, cp: cp.checkpoint };
}

async function exportProfile(t: TestNode, minPartners?: number, name = randomUUID()): Promise<LoadedProfile> {
  const profile = await buildAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now(), minPartners });
  const file = join(tmp, `${name}.json`);
  writeFileSync(file, JSON.stringify(profile, null, 2));
  return loadAnchorProfile(file);
}

async function verify(t: TestNode, opts: Parameters<typeof verifyAnchors>[2] = {}) {
  return verifyAnchors(t.deps, { actor: ACTOR }, opts);
}

const byNode = (r: AnchorVerification, nodeId: string) => r.partners.find((p) => p.nodeId === nodeId);
const codes = (r: AnchorVerification) => r.findings.map((f) => `${f.code}:${f.nodeId ?? ''}`);

beforeAll(async () => {
  b = await mesh.add({ nodeId: 'poc-b', now: clock.now });
  c = await mesh.add({ nodeId: 'poc-c', now: clock.now });
  for (const n of [b, c])
    n.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
});
afterAll(async () => {
  await mesh.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('H1: Inhalt geändert, Hash stehen gelassen, audit_verify() ersetzt', () => {
  test('Proof of Concept des Prüfers: jetzt „Manipulation“ (ohne und mit Profil)', async () => {
    const { t, cp } = await victim('poc-a');
    expect((await verify(t)).result).toBe('ok');
    const profile = await exportProfile(t);
    const target = cp.seq - 1;
    await queryAs(
      t.testDb.urls.owner,
      `begin;
       alter table audit_log disable trigger audit_log_no_update;
       update audit_log set details = '{"tampered": true}'::jsonb, actor_label = 'someone-else' where seq = ${target};
       alter table audit_log enable trigger audit_log_no_update;
       create or replace function audit_verify(out checked bigint, out first_broken_seq bigint) language sql stable as
         $$ select count(*)::bigint, null::bigint from audit_log $$;
       commit;`,
    );
    // die Datenbank selbst meldet „intakt“
    expect((await verifyAuditChain(t.deps.db)).ok).toBe(true);
    for (const r of [await verify(t), await verify(t, { profile })]) {
      expect(r.result).toBe('manipulated');
      expect(r.local).toMatchObject({ ok: false, firstBrokenSeq: target, breakKind: 'hash_mismatch' });
      // der verwahrte Prüfpunkt wird mit dem neu berechneten Hash verglichen, nicht mit der Spalte hash
      expect(byNode(r, 'poc-b')).toMatchObject({
        status: 'mismatch',
        firstProblem: { seq: cp.seq, kind: 'hash_mismatch' },
      });
    }
    const audit = (await auditEntries(t, 'audit.anchor.verify')).at(-1);
    expect(audit).toMatchObject({ outcome: 'error' });
    expect(audit?.details).toMatchObject({
      result: 'manipulated',
      chainOk: false,
      breakKind: 'hash_mismatch',
    });
  });
});

describe('H2: Partnerliste und Schlüssel aus der Datenbank', () => {
  test('Proof of Concept des Prüfers: Partner gesperrt + Kette abgeschnitten → weiterhin „Manipulation“', async () => {
    const { t, cp } = await victim('poc-susp');
    const profile = await exportProfile(t);
    await queryAs(
      t.testDb.urls.owner,
      `begin;
       alter table audit_log disable trigger audit_log_no_update;
       delete from audit_log where seq >= ${cp.seq - 1};
       alter table audit_log enable trigger audit_log_no_update;
       update peer set status = 'suspended';
       commit;`,
    );
    expect((await recomputeAuditChain(t.deps.db)).ok).toBe(true); // Abschneiden allein bricht die Kette nicht
    // ohne Profil: gesperrte Partner werden mit abgefragt (sie können Prüfpunkte nur zurückgeben, nicht fälschen)
    const db = await verify(t);
    expect(db.result).toBe('manipulated');
    expect(db.independent).toBe(false);
    expect(byNode(db, 'poc-b')?.firstProblem).toEqual({ seq: cp.seq, kind: 'missing' });
    // mit Profil: Partner nur aus dem Profil; die gesperrten Zeilen sind als Hinweis sichtbar
    const pr = await verify(t, { profile });
    expect(pr).toMatchObject({ result: 'manipulated', independent: true, source: 'profile' });
    expect(codes(pr)).toEqual(
      expect.arrayContaining([
        'partner_not_trusted_in_database:poc-b',
        'partner_not_trusted_in_database:poc-c',
      ]),
    );
  });

  test('Partner auf „ausstehend“ gesetzt (ohne Profil nicht mehr abgefragt): mit Profil „Manipulation“', async () => {
    const { t, cp } = await victim('poc-pend');
    const profile = await exportProfile(t);
    await queryAs(
      t.testDb.urls.owner,
      `begin;
       alter table audit_log disable trigger audit_log_no_update;
       delete from audit_log where seq >= ${cp.seq};
       alter table audit_log enable trigger audit_log_no_update;
       update peer set status = 'pending';
       commit;`,
    );
    // ohne Profil nicht unabhängig: kein Partner mehr → nur „nicht verankert“
    expect(await verify(t)).toMatchObject({ result: 'unanchored', independent: false });
    const pr = await verify(t, { profile });
    expect(pr.result).toBe('manipulated');
    // (der Abgleich ohne Profil hat inzwischen selbst einen Eintrag mit dieser Laufnummer angehängt)
    expect(byNode(pr, 'poc-c')).toMatchObject({ status: 'mismatch', firstProblem: { seq: cp.seq } });
  });

  test('Adresse und Schlüssel der Partner auf eigenen Dienst umgestellt, eigener „früherer Schlüssel“ eingetragen (mesh_app genügt)', async () => {
    const { t, cp } = await victim('poc-redir');
    const profile = await exportProfile(t);
    // Eigentümer schneidet ab ...
    await queryAs(
      t.testDb.urls.owner,
      `begin;
       alter table audit_log disable trigger audit_log_no_update;
       delete from audit_log where seq >= ${cp.seq - 1};
       alter table audit_log enable trigger audit_log_no_update;
       commit;`,
    );
    const chain = await recomputeAuditChain(t.deps.db);
    const attacker = generateEd25519();
    const epoch = await currentEpoch(t.deps.db);
    const fake = buildCheckpointStatement({
      nodeId: t.nodeId,
      epoch,
      seq: chain.headSeq!,
      hash: chain.headHash!,
      at: clock.now().toISOString(),
    });
    const fakeSignature = ed25519Sign(attacker.privateKey, fake);
    // ... eigener Dienst antwortet im Namen der echten Partner mit dem Schlüssel des Angreifers
    const evil = 'http://evil.mesh.test';
    const evilHandler = async (req: Request) => {
      const env = JSON.parse(await req.text()) as { id: string; from: string; to: string };
      const signed = signResponse(
        { nodeId: env.to, sign: (d) => ed25519Sign(attacker.privateKey, d) },
        env.from,
        env.id,
        { ok: true, body: { checkpoints: [{ statement: fake, signature: fakeSignature }], more: false } },
        clock.now(),
      );
      return new Response(signed.raw, {
        headers: {
          'content-type': 'application/json',
          'x-mesh-node': env.to,
          'x-mesh-signature': signed.signature,
        },
      });
    };
    mesh.routes.set(evil, evilHandler);
    // ... und mesh_app (nicht nur der Eigentümer) stellt Partner und Schlüsselverlauf um
    const now = clock.now();
    await queryAs(t.testDb.urls.app, `update peer set base_url = $1, public_key = $2, fingerprint = $3`, [
      evil,
      attacker.publicKey,
      fingerprint(attacker.publicKey),
    ]);
    await queryAs(
      t.testDb.urls.app,
      `insert into node_key_rotation (id, mode, old_public_key, new_public_key, statement, signature_old,
         signature_new, rotated_at, grace_until, finished_at)
       values ($1, 'routine', $2, $3, '{}', 'x', 'x', $4, $5, $5)`,
      [
        randomUUID(),
        attacker.publicKey,
        generateEd25519().publicKey,
        new Date(now.getTime() - 86_400_000),
        new Date(now.getTime() + 86_400_000),
      ],
    );
    // ohne Profil: der eigene Dienst bestätigt die abgeschnittene Kette – deshalb ausdrücklich „nicht unabhängig“
    const db = await verify(t);
    expect(db).toMatchObject({ result: 'ok', independent: false, source: 'database' });
    // mit Profil: echte Partner unter der Adresse und mit dem Schlüssel aus dem Profil
    const pr = await verify(t, { profile });
    expect(pr.result).toBe('manipulated');
    for (const id of ['poc-b', 'poc-c']) {
      expect(byNode(pr, id)).toMatchObject({
        status: 'mismatch',
        fingerprint: profile.profile.partners.find((p) => p.nodeId === id)?.fingerprint,
      });
    }
    expect(codes(pr)).toEqual(
      expect.arrayContaining(['partner_differs_from_database:poc-b', 'partner_differs_from_database:poc-c']),
    );
    expect(
      pr.findings.filter((f) => f.code === 'partner_differs_from_database').map((f) => f.detail),
    ).toEqual(expect.arrayContaining(['public_key', 'base_url']));
    // auch wenn der Angreifer zusätzlich das Netz umleitet (alle Adressen → eigener Dienst): Antworten müssen mit
    // dem Partnerschlüssel aus dem Profil signiert sein
    const hijacked: typeof t.deps.fetch = async (input, init) =>
      evilHandler(input instanceof Request ? input : new Request(String(input), init));
    const alone = await verifyAnchors({ ...t.deps, fetch: hijacked }, { actor: ACTOR }, { profile });
    expect(alone.result).toBe('unanchored');
    expect(alone.partners.map((p) => [p.status, p.errorCode])).toEqual([
      ['error', 'signature_invalid'],
      ['error', 'signature_invalid'],
    ]);
    mesh.routes.delete(evil);
  });

  test('Oberfläche (Server): Abgleich ausdrücklich nicht unabhängig', async () => {
    const { t } = await victim('poc-ui');
    const r = await t.request<AnchorVerification>('POST', '/api/v1/audit/anchors/verify', {
      as: await t.user(['auditor']),
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ result: 'ok', independent: false, source: 'database', profile: null });
    expect(r.json.partners.every((p) => typeof p.fingerprint === 'string')).toBe(true);
  });
});

describe('Anker-Profil', () => {
  test('Normalfall; Partner fehlt → Abbruch, außer begründet entschuldigt; Mindestzahl', async () => {
    const { t } = await victim('poc-prof');
    const both = await exportProfile(t, 2);
    expect(both.profile.partners.map((p) => p.nodeId)).toEqual(['poc-b', 'poc-c']);
    expect(both.profile.partners[0]?.fingerprint).toBe(b.deps.identity.fingerprint);
    expect(both.profile.keys.map((k) => k.fingerprint)).toEqual([t.deps.identity.fingerprint]);
    expect(both.profile.epochs).toHaveLength(1);

    const ok = await verify(t, { profile: both });
    expect(ok).toMatchObject({ result: 'ok', independent: true, requiredPartners: 2, anchoredPartners: 2 });
    expect(ok.profile).toEqual({ sha256: both.sha256, createdAt: both.profile.createdAt, minPartners: 2 });

    offline(c);
    try {
      const missing = await verify(t, { profile: both });
      expect(missing.result).toBe('unanchored');
      expect(byNode(missing, 'poc-c')?.status).toBe('unreachable');
      expect(codes(missing)).toEqual(
        expect.arrayContaining(['partner_missing:poc-c', 'insufficient_partners:']),
      );
      // entschuldigt, aber Mindestzahl 2 nicht erreicht
      const excused = await verify(t, { profile: both, excuse: { nodeIds: ['poc-c'], reason: 'Wartung' } });
      expect(excused.result).toBe('unanchored');
      expect(codes(excused)).toEqual(
        expect.arrayContaining(['partner_excused:poc-c', 'insufficient_partners:']),
      );
      expect(codes(excused)).not.toContain('partner_missing:poc-c');

      const one = await exportProfile(t, 1);
      // auch bei Mindestzahl 1: jeder Partner des Profils muss bestätigen oder entschuldigt sein
      expect((await verify(t, { profile: one })).result).toBe('unanchored');
      const fine = await verify(t, {
        profile: one,
        excuse: { nodeIds: ['poc-c'], reason: 'Wartung bis Freitag' },
      });
      expect(fine.result).toBe('ok');
      expect(byNode(fine, 'poc-c')?.excused).toBe(true);
      const audit = (await auditEntries(t, 'audit.anchor.verify')).at(-1);
      expect(audit?.details).toMatchObject({ source: 'profile', excuseReason: 'Wartung bis Freitag' });
      // ohne Profil wird ein nicht erreichbarer Partner wie bisher hingenommen
      expect((await verify(t)).result).toBe('ok');
    } finally {
      online(c);
    }
    await expect(verify(t, { profile: both, excuse: { nodeIds: ['poc-x'], reason: 'x' } })).rejects.toThrow(
      /excused_not_in_profile/,
    );
    const other = { ...both, profile: { ...both.profile, nodeId: 'poc-other' } };
    await expect(verify(t, { profile: other })).rejects.toThrow(/profile_other_node/);
  });

  test('nach eigenem Schlüsselwechsel: altes Profil kennt den neuen Schlüssel nicht (Abbruch), neues mit --previous schon', async () => {
    const { t } = await victim('poc-rot');
    const before = await exportProfile(t);
    const rot = await t.request('POST', '/api/v1/node/key/rotate', {
      as: await t.user(['admin']),
      body: { mode: 'routine', graceDays: 7, confirm: true },
    });
    expect(rot.status).toBe(200);
    expect((await flushOutbox(t.deps)).delivered).toBe(2);
    await t.deps.audit.record({ actor: ACTOR, action: 'test.activity' });
    await createCheckpoint(t.deps, 'manual', { actor: ACTOR });
    expect((await flushOutbox(t.deps)).delivered).toBe(2);

    const stale = await verify(t, { profile: before });
    expect(stale.result).toBe('unanchored');
    expect(byNode(stale, 'poc-b')).toMatchObject({ status: 'error', invalidSignatures: 1 });

    // neuer Schlüssel und geänderter Zeitraum des alten: nur ausdrücklich angenommen (Nachtrag 2)
    await expect(
      buildAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now(), previous: before.profile }),
    ).rejects.toThrow(/previous_changes_not_accepted/);
    const after = await buildAnchorProfile(t.deps.db, {
      nodeId: t.nodeId,
      now: clock.now(),
      previous: before.profile,
      accept: { keys: true },
    });
    expect(after.keys.map((k) => k.retired)).toEqual(['routine', null]);
    expect(after.keys[0]?.validUntil).not.toBeNull();
    const file = join(tmp, 'after-rotation.json');
    writeFileSync(file, JSON.stringify(after));
    expect((await verify(t, { profile: loadAnchorProfile(file) })).result).toBe('ok');
  });
});

describe('Kommandozeile: Profil exportieren, Prüfpunkt mit Profil prüfen, Aufrufe', () => {
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

  test('audit-anchor-profile schreibt das Profil, zeigt Fingerprints und Prüfsumme, protokolliert', async () => {
    const { t, cp } = await victim('poc-cli');
    const file = join(tmp, 'cli-profile.json');
    const r = await cli(['audit-anchor-profile', '--out', file, '--min-partners', '2'], envOf(t));
    expect(r.code).toBe(0);
    const loaded = loadAnchorProfile(file);
    expect(loaded.profile).toMatchObject({ nodeId: 'poc-cli', minPartners: 2 });
    expect(r.stdout).toContain(loaded.sha256);
    expect(r.stdout).toContain(b.deps.identity.fingerprint);
    expect(r.stdout).toContain(c.deps.identity.fingerprint);
    expect((await auditEntries(t, 'audit.anchor_profile.export')).at(-1)?.details).toMatchObject({
      sha256: loaded.sha256,
      minPartners: 2,
    });
    expect((await cli(['audit-anchor-profile', '--out', file, '--min-partners', '3'], envOf(t))).code).toBe(
      2,
    );

    // Prüfpunkt-Export mit Profil prüfen; Abweichung nach Umschreiben
    const exp = await t.request('GET', '/api/v1/audit/anchors/latest', { as: await t.user(['auditor']) });
    const expFile = join(tmp, 'cli-checkpoint.json');
    writeFileSync(expFile, JSON.stringify(exp.json));
    const good = await cli(['verify-audit', '--checkpoint', expFile, '--profile', file], envOf(t));
    expect(good.code).toBe(0);
    expect(good.stdout).toContain('laut Profil');
    await queryAs(
      t.testDb.urls.owner,
      `begin; alter table audit_log disable trigger audit_log_no_update;
       update audit_log set actor_label = 'x' where seq = ${cp.seq - 1};
       alter table audit_log enable trigger audit_log_no_update; commit;`,
    );
    const bad = await cli(['verify-audit', '--checkpoint', expFile, '--profile', file], envOf(t));
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('GEBROCHEN');
    // einfache Prüfung rechnet ebenfalls im Programm nach
    const plain = await cli(['verify-audit'], envOf(t));
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain(`seq ${cp.seq - 1}`);
  });

  test('Aufrufe: --excuse nur mit --profile und --reason; unbrauchbares Profil', async () => {
    const env = envOf(b);
    expect((await cli(['verify-audit', '--with-partners', '--excuse', 'poc-c'], env)).code).toBe(2);
    const file = join(tmp, 'broken-profile.json');
    writeFileSync(file, '{"format":"osp-data-mesh/audit-anchor-profile@1"}');
    const broken = await cli(['verify-audit', '--with-partners', '--profile', file], env);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('invalid_profile');
    const valid = await buildAnchorProfile(b.deps.db, { nodeId: 'poc-b', now: clock.now() });
    // Fingerprint im Profil verändert → abgelehnt
    const forged = { ...valid, partners: valid.partners.map((p) => ({ ...p, fingerprint: '0000 0000' })) };
    writeFileSync(file, JSON.stringify(forged));
    const r = await cli(['verify-audit', '--with-partners', '--profile', file], env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('fingerprint_mismatch');
    writeFileSync(file, JSON.stringify(valid));
    const noReason = await cli(
      ['verify-audit', '--with-partners', '--profile', file, '--excuse', 'poc-x'],
      env,
    );
    expect(noReason.code).toBe(2);
    expect(noReason.stderr).toContain('--reason');
    expect(readFileSync(file, 'utf8')).toContain('audit-anchor-profile@1');
  });
});
