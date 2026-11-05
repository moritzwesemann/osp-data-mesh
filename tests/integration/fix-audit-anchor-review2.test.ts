/**
 * Zweite Prüfrunde der Verankerung der Audit-Kette (ADR 0014 Nachtrag 2, ADR 0006 Nachtrag): die
 * Proof-of-Concepts des Prüfers als Regressionstests – jeder Angriff wird jetzt erkannt.
 *  1. mesh_app kann keinen Prüfpunkt (etwa mit created_at in ferner Zukunft) mehr eintragen; der Planer zählt
 *     nur gültig signierte eigene Prüfpunkte, die nicht aus der Zukunft stammen; verifyAnchors meldet einen
 *     veralteten Anker (Klärung nötig) und immer die Zahl der nicht verankerten Einträge.
 *  2. audit-anchor-profile --previous übernimmt Änderungen der Datenbank nicht still: Mindestzahl bleibt,
 *     Abweichungen je Kategorie nur ausdrücklich (sonst Abbruch, Exit 4); mesh_app ändert den
 *     Schlüsselverlauf nicht (nur Ende der Übergangszeit/Neuverschlüsselung).
 *  3. Hash-Eingabe Version 2 eindeutig (Längenangaben, null ≠ ''), Version gebunden; Aufbau und Werte der
 *     Tabelle geprüft; TS und SQL Byte für Byte gleich; Migration auf bestehender Kette.
 *  4. erfundene Epoche: mit Profil Manipulation; Profil enthält Sicherung und Kopf vor der Wiederherstellung;
 *     Prüfpunkt hinter diesem Kopf = Manipulation.
 *  5. gestohlener, später ersetzter Schlüssel blockiert mit Laufnummer nahe 2^53 nicht die neuen Prüfpunkte.
 *  6. gleichzeitige Zustellungen unterlaufen die Ratenbegrenzung nicht; restore prüft die Kette im Programm.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { runCli } from '../../src/server/cli/main.ts';
import { AuditWriter } from '../../src/server/core/audit.ts';
import { MIGRATIONS_DIR, migrate } from '../../src/server/core/migrate.ts';
import {
  auditDigestInput,
  digestFieldV2,
  GENESIS_HASH,
  readAuditDigestRows,
  recomputeAuditChain,
} from '../../src/server/modules/audit/chain.ts';
import { verifyAuditChain } from '../../src/server/modules/audit/index.ts';
import {
  buildAnchorProfile,
  type LoadedProfile,
  loadAnchorProfile,
  ProfileChangesError,
  planAnchorProfile,
} from '../../src/server/modules/federation/anchor-profile.ts';
import {
  type AnchorVerification,
  buildCheckpointStatement,
  createCheckpoint,
  currentEpoch,
  scheduledCheckpoint,
  verifyAnchors,
} from '../../src/server/modules/federation/anchors.ts';
import { rotateNodeKey } from '../../src/server/modules/federation/keys.ts';
import { flushOutbox } from '../../src/server/modules/federation/outbox.ts';
import { restoreBackup } from '../../src/server/modules/system/restore.ts';
import { createTestDb, queryAs, type TestDb } from '../helpers/db.ts';
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
const tmp = mkdtempSync(join(tmpdir(), 'osp-anchor-review2-'));
const dirs: string[] = [];
const dbs: TestDb[] = [];
let b: TestNode;
let c: TestNode;

async function node(nodeId: string, config?: Record<string, string>) {
  const n = await mesh.add({ nodeId, now: clock.now, config });
  n.deps.services.federation = { flushOutbox: async () => ({ delivered: 0, failed: 0 }) };
  dirs.push(resolve(n.deps.config.MESH_BACKUP_DIR));
  return n;
}

/** Knoten mit den Partnern b und c, ein zugestellter Prüfpunkt */
async function victim(nodeId: string) {
  const t = await node(nodeId);
  await onboard(t, b);
  await onboard(t, c);
  const cp = await checkpoint(t);
  return { t, cp };
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

const loaded = (profile: Awaited<ReturnType<typeof buildAnchorProfile>>): LoadedProfile => ({
  profile,
  sha256: 'test',
});

async function verify(n: TestNode, profile?: LoadedProfile) {
  return verifyAnchors(n.deps, { actor: ACTOR }, { profile });
}

const finding = (r: AnchorVerification, code: string) => r.findings.filter((f) => f.code === code);

async function asOwner(n: { testDb: TestDb } | TestDb, statements: string) {
  const urls = 'testDb' in n ? n.testDb.urls : n.urls;
  return queryAs(urls.owner, statements);
}

async function ownerUpdate(n: { testDb: TestDb } | TestDb, set: string, where: string) {
  await asOwner(
    n,
    `begin; alter table audit_log disable trigger audit_log_no_update;
     update audit_log set ${set} where ${where};
     alter table audit_log enable trigger audit_log_no_update; commit;`,
  );
}

async function headSeq(n: TestNode): Promise<number> {
  const r = await n.deps.db
    .selectFrom('audit_log')
    .select('seq')
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  return Number(r.seq);
}

async function cli(args: string[], n: TestNode) {
  const cfg = n.deps.config;
  const env: Record<string, string | undefined> = {
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

beforeAll(async () => {
  b = await node('r2-b');
  c = await node('r2-c');
});
afterAll(async () => {
  await mesh.close();
  for (const d of dbs) await d.drop();
  rmSync(tmp, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Befund 3: Feldgrenzen der Hash-Eingabe
// ---------------------------------------------------------------------------------------------

describe('Befund 3: eindeutige Hash-Eingabe (Version 2)', () => {
  test('PoC-1: Text über „|“ ins Nachbarfeld verschoben, Hash stehen gelassen → Manipulation erkannt', async () => {
    const { t } = await victim('r2-pipe');
    await t.deps.audit.record({
      actor: { type: 'user', id: 'u-123', label: 'Eve|Admin' },
      action: 'person.delete',
      objectType: 'person',
      objectId: 'p-9',
    });
    const seq = await headSeq(t);
    await t.deps.audit.record({ actor: ACTOR, action: 'test.null_object' });
    const nullSeq = await headSeq(t);
    await checkpoint(t);
    const profile = loaded(await buildAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now() }));
    expect((await verify(t, profile)).result).toBe('ok');

    // Verschieben zwischen actor_id und actor_label (in Version 1 hash-gleich)
    await ownerUpdate(t, `actor_id = 'u-123|Eve', actor_label = 'Admin'`, `seq = ${seq}`);
    expect(await recomputeAuditChain(t.deps.db)).toMatchObject({
      ok: false,
      firstBrokenSeq: seq,
      breakKind: 'hash_mismatch',
    });
    const r = await verify(t, profile);
    expect(r.result).toBe('manipulated');
    expect(r.local).toMatchObject({ ok: false, firstBrokenSeq: seq });
    await ownerUpdate(t, `actor_id = 'u-123', actor_label = 'Eve|Admin'`, `seq = ${seq}`);
    expect((await recomputeAuditChain(t.deps.db)).ok).toBe(true);

    // null und '' sind unterscheidbar (in Version 1 nicht)
    await ownerUpdate(t, `object_type = ''`, `seq = ${nullSeq}`);
    expect(await recomputeAuditChain(t.deps.db)).toMatchObject({
      firstBrokenSeq: nullSeq,
      breakKind: 'hash_mismatch',
    });
    await ownerUpdate(t, 'object_type = null', `seq = ${nullSeq}`);
    expect((await verify(t, profile)).result).toBe('ok');
  });

  test('TS und SQL Byte für Byte gleich: Unicode, NULL/leer, Trennzeichen, Ziffern und Doppelpunkte, JSON', async () => {
    const db = await createTestDb('r2digest');
    dbs.push(db);
    const w = new AuditWriter(db.db);
    const cases: { id: string | null; label: string | null; obj: string | null; details: unknown }[] = [
      { id: null, label: '', obj: null, details: {} },
      { id: '', label: null, obj: '', details: { a: null } },
      { id: 'u|1', label: 'ä|~', obj: '0:', details: { pipe: 'x|y', tilde: '~', colon: '3:abc' } },
      {
        id: '12:34',
        label: '~|~',
        obj: '|',
        details: { emoji: '🏃‍♀️', cjk: '漢字', nested: { z: [1, 'é'] } },
      },
      {
        id: '🚣🏽',
        label: 'Müller-Lüdenscheidt\n\t"x"',
        obj: '\\',
        details: { esc: '\u0001\u001f', n: 1.5e-7 },
      },
    ];
    for (const [i, x] of cases.entries()) {
      await w.record({
        actor: { type: 'user', id: x.id, label: x.label },
        action: `test.v2.${i}`,
        objectType: x.obj,
        objectId: x.obj === null ? null : `${x.obj}|${i}`,
        details: x.details as Record<string, unknown>,
        ip: i % 2 ? '' : null,
        requestId: i % 2 ? null : '|',
      });
    }
    const sqlRows = await sql<{ input: string; hash: string; v: number }>`
      select audit_digest_input(a) as input, a.hash, a.digest_version::int as v from audit_log a order by a.seq`.execute(
      db.db,
    );
    const rows = await readAuditDigestRows(db.db, 0, 1000);
    expect(rows).toHaveLength(cases.length);
    let prev = GENESIS_HASH;
    rows.forEach((r, i) => {
      const expected = sqlRows.rows[i]!;
      expect(expected.v).toBe(2);
      expect(r.digest_version).toBe(2);
      const input = auditDigestInput(r, prev);
      expect(input.startsWith('osp-audit-digest@2|')).toBe(true);
      expect(Buffer.from(input, 'utf8').equals(Buffer.from(expected.input, 'utf8'))).toBe(true);
      prev = expected.hash;
    });
    // Feldkodierung: null → '~', sonst UTF-8-Byte-Länge ':' Wert – identisch zu audit_digest_field()
    const samples = [null, '', '|', '~', '0:', 'ä|~', '🏃‍♀️', '漢字', 'a\nb'];
    for (const v of samples) {
      const r = await sql<{ f: string }>`select audit_digest_field(${v}::text) as f`.execute(db.db);
      expect(r.rows[0]!.f).toBe(digestFieldV2(v));
    }
    expect(digestFieldV2(null)).toBe('~');
    expect(digestFieldV2('')).toBe('0:');
    expect(digestFieldV2('ä|~')).toBe('4:ä|~');
    expect(digestFieldV2('🏃')).toBe('4:🏃');
    // null und '' im selben Feld ergeben verschiedene Eingaben
    expect(auditDigestInput({ ...rows[0]!, actor_id: null }, prev)).not.toBe(
      auditDigestInput({ ...rows[0]!, actor_id: '' }, prev),
    );
    expect(await recomputeAuditChain(db.db)).toMatchObject({ ok: true, digest: { v1: 0, v2: cases.length } });
  });

  test('Version gebunden: Rückstufung auf Version 1 bricht die Kette, auch konsistent neu berechnet', async () => {
    const db = await createTestDb('r2version');
    dbs.push(db);
    const w = new AuditWriter(db.db);
    for (let i = 0; i < 5; i++) await w.record({ actor: { type: 'system' }, action: 'test.version' });
    // unbekannte Version (Prüfregel vom Eigentümer entfernt)
    await asOwner(db, 'alter table audit_log drop constraint audit_log_digest_version_check');
    await ownerUpdate(db, 'digest_version = 7', 'seq = 5');
    expect(await recomputeAuditChain(db.db)).toMatchObject({
      firstBrokenSeq: 5,
      breakKind: 'digest_version',
    });
    await ownerUpdate(db, 'digest_version = 2', 'seq = 5');
    expect((await recomputeAuditChain(db.db)).ok).toBe(true);
    // Version umgestellt, Hash stehen gelassen: Eingabe anders → Hash passt nicht (erster Eintrag, also
    // kein Rückfall gegenüber einem Vorgänger)
    await ownerUpdate(db, 'digest_version = 1', 'seq = 1');
    expect(await recomputeAuditChain(db.db)).toMatchObject({ firstBrokenSeq: 1, breakKind: 'hash_mismatch' });
    await ownerUpdate(db, 'digest_version = 2', 'seq = 1');
    // mitten in der Kette: Rückfall auf Version 1
    await ownerUpdate(db, 'digest_version = 1', 'seq = 3');
    expect(await recomputeAuditChain(db.db)).toMatchObject({
      firstBrokenSeq: 3,
      breakKind: 'digest_version',
    });
    // konsistent neu berechnet (wie ein Eigentümer mit audit_digest_input): Rückfall der Version erkannt,
    // in der Datenbank wie im Programm
    await asOwner(
      db,
      `begin; alter table audit_log disable trigger audit_log_no_update;
       do $$ declare r audit_log; prev text;
       begin
         select hash into prev from audit_log where seq = 2;
         for r in select * from audit_log where seq >= 3 order by seq loop
           r.prev_hash := prev;
           r.hash := encode(sha256(convert_to(audit_digest_input(r), 'UTF8')), 'hex');
           update audit_log set prev_hash = r.prev_hash, hash = r.hash where id = r.id;
           prev := r.hash;
         end loop;
       end $$;
       alter table audit_log enable trigger audit_log_no_update; commit;`,
    );
    expect(await recomputeAuditChain(db.db)).toMatchObject({
      firstBrokenSeq: 3,
      breakKind: 'digest_version',
    });
    expect((await verifyAuditChain(db.db)).firstBrokenSeq).toBe(3);
  });

  test('Aufbau (pg_attribute) und erlaubte Werte geprüft', async () => {
    const db = await createTestDb('r2shape');
    dbs.push(db);
    const w = new AuditWriter(db.db);
    for (let i = 0; i < 3; i++) await w.record({ actor: { type: 'system' }, action: 'test.shape' });
    expect((await recomputeAuditChain(db.db)).ok).toBe(true);
    // NOT NULL entfernt (concat_ws der Version 1 überspränge eine NULL)
    await asOwner(db, 'alter table audit_log alter column actor_type drop not null');
    expect(await recomputeAuditChain(db.db)).toMatchObject({ ok: false, breakKind: 'column_changed' });
    await asOwner(db, 'alter table audit_log alter column actor_type set not null');
    // anderer Spaltentyp (jsonb → text: Textform nicht mehr normalisiert)
    await asOwner(
      db,
      `alter table audit_log alter column details drop default;
       alter table audit_log alter column details type text using details::text`,
    );
    expect(await recomputeAuditChain(db.db)).toMatchObject({ ok: false, breakKind: 'column_changed' });
    await asOwner(
      db,
      `alter table audit_log alter column details type jsonb using details::jsonb;
       alter table audit_log alter column details set default '{}'`,
    );
    expect((await recomputeAuditChain(db.db)).ok).toBe(true);
    // Prüfregel entfernt, unzulässiger Wert
    await asOwner(db, 'alter table audit_log drop constraint audit_log_outcome_check');
    await ownerUpdate(db, `outcome = 'success|x'`, 'seq = 2');
    expect(await recomputeAuditChain(db.db)).toMatchObject({ firstBrokenSeq: 2, breakKind: 'invalid_value' });
  });

  test('Migration 0620 auf bestehender Kette: alte Einträge Version 1, neue Version 2, beide Prüfungen ok', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osp-migrations-0620-'));
    try {
      for (const f of readdirSync(MIGRATIONS_DIR)) {
        if (f === 'grants.sql' || (/^\d{4}_/.test(f) && f.slice(0, 4) < '0620')) {
          copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
        }
      }
      const db = await createTestDb('r2mig', { migrationsDir: dir });
      dbs.push(db);
      const w = new AuditWriter(db.db);
      await w.record({ actor: { type: 'user', id: 'u-1', label: 'Eve|Admin' }, action: 'test.before' });
      for (let i = 0; i < 3; i++) await w.record({ actor: { type: 'system' }, action: 'test.before' });
      // grants.sql läuft auch auf dem älteren Stand (bedingte Blöcke)
      await migrate(db.urls.owner);
      for (let i = 0; i < 3; i++) await w.record({ actor: { type: 'system' }, action: 'test.after' });
      const versions = await sql<{
        v: number;
      }>`select digest_version::int as v from audit_log order by seq`.execute(db.db);
      expect(versions.rows.map((r) => r.v)).toEqual([1, 1, 1, 1, 2, 2, 2]);
      const chain = await recomputeAuditChain(db.db);
      expect(chain).toMatchObject({ ok: true, checked: 7, digest: { v1: 4, v2: 3, ambiguousV1: 1 } });
      expect((await verifyAuditChain(db.db)).ok).toBe(true);
      // Restrisiko Version 1 (dokumentiert): Verschieben über „|“ bei alten Einträgen bleibt unerkannt,
      // wird aber als mehrdeutig gezählt
      await ownerUpdate(db, `actor_id = 'u-1|Eve', actor_label = 'Admin'`, 'seq = 1');
      expect((await recomputeAuditChain(db.db)).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Befund 1: Planer und veralteter Anker
// ---------------------------------------------------------------------------------------------

describe('Befund 1: Planer lässt sich nicht anhalten, veralteter Anker wird gemeldet', () => {
  test('PoC-3: mesh_app trägt keinen Prüfpunkt mehr ein; vorweggenommener Platz wird erkannt und übersprungen', async () => {
    const { t } = await victim('r2-sched');
    const epoch = await currentEpoch(t.deps.db);
    // genau die Anweisung des Proof of Concept
    await expect(
      queryAs(
        t.testDb.urls.app,
        `insert into audit_checkpoint (seq, hash, epoch, at, statement, signature, public_key, trigger, peers, created_at)
         values (999999, repeat('0',64), '${epoch}', now(), 'x', 'x', 'x', 'schedule', 0, '9999-01-01')`,
      ),
    ).rejects.toThrow(/permission denied/);
    // über die Funktion: nur aktuelle Epoche und ein vorhandener Eintrag mit seinem Hash
    const call = (e: string, seq: number | string, hash: string) =>
      queryAs(
        t.testDb.urls.app,
        `select seq, created_at from audit_checkpoint_append('${e}', ${seq}, '${hash}', '9999-01-01', 'x', 'x', 'x', 'schedule', 0)`,
      );
    await expect(call(randomUUID(), 1, 'x')).rejects.toThrow(/not the current epoch/);
    await expect(call(epoch, 999_999, '0'.repeat(64))).rejects.toThrow(/not in audit_log/);
    await expect(call(epoch, 1, '0'.repeat(64))).rejects.toThrow(/not in audit_log/);
    // Platz des aktuellen Kopfs mit Unsinn belegt: created_at setzt die Datenbank (nicht 9999)
    const head = await t.deps.db
      .selectFrom('audit_log')
      .select(['seq', 'hash'])
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirstOrThrow();
    const occupied = await call(epoch, Number(head.seq), head.hash);
    expect(new Date(occupied.rows[0]!.created_at as string).getFullYear()).toBeLessThan(9999);
    const r = await createCheckpoint(t.deps, 'manual', { actor: ACTOR });
    expect(r.created).toBe(true);
    expect(r.checkpoint.seq).toBeGreaterThan(Number(head.seq));
    expect((await auditEntries(t, 'audit.checkpoint.invalid_row')).at(-1)).toMatchObject({
      outcome: 'error',
      details: expect.objectContaining({ seq: Number(head.seq), epoch }),
    });
    expect((await flushOutbox(t.deps)).failed).toBe(0);
    expect((await verify(t)).result).toBe('ok');
    // der Export liefert den gültigen, nicht die vorweggenommene Zeile
    const exp = await t.request<{ seq: number }>('GET', '/api/v1/audit/anchors/latest', {
      as: await t.user(['auditor']),
    });
    expect(exp.json.seq).toBe(r.checkpoint.seq);
  });

  test('gefälschte Zeile aus der Zukunft (Eigentümer) und gültig signierte aus der Zukunft: Planer läuft weiter', async () => {
    const { t } = await victim('r2-future');
    const epoch = await currentEpoch(t.deps.db);
    try {
      // Zeile mit created_at/at in ferner Zukunft, ungültige Signatur (wie der PoC, als Eigentümer)
      await asOwner(
        t,
        `insert into audit_checkpoint (seq, hash, epoch, at, statement, signature, public_key, trigger, peers, created_at)
         values (999999, repeat('0',64), '${epoch}', '9999-01-01', 'x', 'x', 'x', 'schedule', 0, '9999-01-01')`,
      );
      // gültig signiert, aber Zeitpunkt zehn Jahre voraus (falsche Uhr): zählt für den Planer nicht
      const first = await t.deps.db
        .selectFrom('audit_log')
        .select(['seq', 'hash'])
        .where('seq', '=', 1)
        .executeTakeFirstOrThrow();
      const at = new Date(clock.now().getTime() + 10 * 365 * 86_400_000);
      const statement = buildCheckpointStatement({
        nodeId: t.nodeId,
        epoch,
        seq: 1,
        hash: first.hash,
        at: at.toISOString(),
      });
      await asOwner(
        t,
        `insert into audit_checkpoint (seq, hash, epoch, at, statement, signature, public_key, trigger, peers)
         values (1, '${first.hash}', '${epoch}', '${at.toISOString()}', '${statement}',
                 '${t.deps.identity.sign(statement)}', '${t.deps.identity.publicKey}', 'schedule', 0)`,
      );
      await activity(t);
      expect(await scheduledCheckpoint(t.deps)).toBe(false); // gerade erst ein gültiger
      clock.advance(61 * 60_000);
      expect(await scheduledCheckpoint(t.deps)).toBe(true);
      expect((await auditEntries(t, 'audit.checkpoint.create')).at(-1)?.details).toMatchObject({
        trigger: 'schedule',
      });
      // Lebenszeichen: ohne neue Einträge erst nach zwei Intervallen
      clock.advance(61 * 60_000);
      expect(await scheduledCheckpoint(t.deps)).toBe(false);
      clock.advance(60 * 60_000);
      expect(await scheduledCheckpoint(t.deps)).toBe(true);
    } finally {
      clock.reset();
    }
  });

  test('PoC-3 Fortsetzung: Planer angehalten, unverankertes Ende abgeschnitten → Klärung nötig statt „ok“', async () => {
    const { t, cp } = await victim('r2-stale');
    const profile = loaded(
      await buildAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now(), minPartners: 2 }),
    );
    const fresh = await verify(t, profile);
    expect(fresh.result).toBe('ok');
    expect(fresh.anchoring).toMatchObject({
      lastAnchoredSeq: cp.seq,
      lastAnchoredAt: cp.at,
      staleAfterHours: 3,
    });
    expect(fresh.anchoring.unanchoredEntries).toBe((fresh.local.headSeq ?? 0) - cp.seq);
    try {
      await activity(t, 20);
      clock.advance(48 * 3600_000);
      const head = await headSeq(t);
      await asOwner(
        t,
        `begin; alter table audit_log disable trigger audit_log_no_update;
         delete from audit_log where seq > ${head - 10};
         alter table audit_log enable trigger audit_log_no_update; commit;`,
      );
      const r = await verify(t, profile);
      expect(r.result).toBe('needs_review');
      expect(r.local.ok).toBe(true);
      const unanchored = (r.local.headSeq ?? 0) - cp.seq;
      expect(r.anchoring).toMatchObject({ lastAnchoredSeq: cp.seq, unanchoredEntries: unanchored });
      expect(unanchored).toBeGreaterThan(10);
      expect(finding(r, 'anchor_stale')).toEqual([
        { code: 'anchor_stale', severity: 'review', seq: cp.seq, count: unanchored, detail: cp.at },
      ]);
      expect((await auditEntries(t, 'audit.anchor.verify')).at(-1)?.details).toMatchObject({
        result: 'needs_review',
        lastAnchoredSeq: cp.seq,
        unanchoredEntries: unanchored,
      });
      // ein neuer Prüfpunkt verankert wieder (der abgeschnittene Teil ist nicht mehr nachweisbar)
      await checkpoint(t);
      expect((await verify(t, profile)).result).toBe('ok');
    } finally {
      clock.reset();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Befund 2: --previous
// ---------------------------------------------------------------------------------------------

describe('Befund 2: Neuexport mit --previous übernimmt nichts still', () => {
  test('PoC-2: gesperrter Partner verschwindet nicht, Mindestzahl bleibt; nur ausdrücklich angenommen', async () => {
    const { t } = await victim('r2-prev');
    const p1 = await buildAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now(), minPartners: 2 });
    expect(p1.partners.map((x) => x.nodeId)).toEqual(['r2-b', 'r2-c']);
    // mesh_app (Stufe Server-Kompromittierung) sperrt den Partner c
    await queryAs(t.testDb.urls.app, `update peer set status = 'suspended' where node_id = 'r2-c'`);
    let err: unknown;
    try {
      await buildAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now(), previous: p1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProfileChangesError);
    const plan = (err as ProfileChangesError).plan;
    expect(plan.unaccepted).toEqual(['partners']);
    expect(plan.diff?.partners.removed).toEqual([
      expect.objectContaining({ nodeId: 'r2-c', dbStatus: 'suspended' }),
    ]);
    // altes Profil gilt, solange nicht angenommen; Mindestzahl bleibt 2
    expect(plan.profile.partners.map((x) => x.nodeId)).toEqual(['r2-b', 'r2-c']);
    expect(plan.profile.minPartners).toBe(2);
    // angenommen, aber Mindestzahl 2 nicht mehr erreichbar: ausdrücklich festlegen
    await expect(
      buildAnchorProfile(t.deps.db, {
        nodeId: t.nodeId,
        now: clock.now(),
        previous: p1,
        accept: { partners: true },
      }),
    ).rejects.toThrow(/min_partners_out_of_range/);
    const p2 = await buildAnchorProfile(t.deps.db, {
      nodeId: t.nodeId,
      now: clock.now(),
      previous: p1,
      accept: { partners: true },
      minPartners: 1,
    });
    expect(p2.partners.map((x) => x.nodeId)).toEqual(['r2-b']);
    expect(p2.minPartners).toBe(1);
    // ohne Änderung: Mindestzahl des alten Profils bleibt (früher: 1)
    await queryAs(t.testDb.urls.app, `update peer set status = 'trusted' where node_id = 'r2-c'`);
    const same = await buildAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now(), previous: p1 });
    expect(same.minPartners).toBe(2);
    expect(same.partners.map((x) => x.nodeId)).toEqual(['r2-b', 'r2-c']);
    // geänderte Adresse eines Partners (mesh_app): ebenfalls nur ausdrücklich, das alte Profil gewinnt
    await queryAs(
      t.testDb.urls.app,
      `update peer set base_url = 'https://evil.example' where node_id = 'r2-b'`,
    );
    const moved = await planAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now(), previous: p1 });
    expect(moved.unaccepted).toEqual(['partners']);
    expect(moved.diff?.partners.changed).toEqual([
      expect.objectContaining({ nodeId: 'r2-b', fields: ['baseUrl'] }),
    ]);
    expect(moved.profile.partners.find((x) => x.nodeId === 'r2-b')?.baseUrl).toBe(p1.partners[0]!.baseUrl);
    await queryAs(
      t.testDb.urls.app,
      `update peer set base_url = '${p1.partners[0]!.baseUrl}' where node_id = 'r2-b'`,
    );
  });

  test('Schlüsselverlauf: mesh_app ändert keine Zeiträume; Änderungen nur ausdrücklich, sonst gilt das alte Profil', async () => {
    const { t } = await victim('r2-keys');
    const before = await buildAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now() });
    await rotateNodeKey(t.deps, { mode: 'routine', actor: ACTOR });
    const app = t.testDb.urls.app;
    for (const stmt of [
      `update node_key_rotation set grace_until = grace_until + interval '1 year'`,
      `update node_key_rotation set mode = 'routine'`,
      `update node_key_rotation set rotated_at = now() - interval '1 year'`,
      `update node_key_rotation set old_public_key = 'x'`,
    ]) {
      await expect(queryAs(app, stmt)).rejects.toThrow(/permission denied/);
    }
    // neuer Schlüssel und geänderter Zeitraum des alten: nur mit --accept-key-changes
    const plan = await planAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now(), previous: before });
    expect(plan.unaccepted).toEqual(['keys']);
    expect(plan.diff?.keys.added).toHaveLength(1);
    expect(plan.diff?.keys.changed).toHaveLength(1);
    const after = await buildAnchorProfile(t.deps.db, {
      nodeId: t.nodeId,
      now: clock.now(),
      previous: before,
      accept: { keys: true },
    });
    // legitimer Weg (Ende der Übergangszeit) bleibt möglich, ein beendeter Wechsel aber endgültig
    await queryAs(app, 'update node_key_rotation set finished_at = now(), old_private_key_enc = null');
    await expect(queryAs(app, 'update node_key_rotation set finished_at = null')).rejects.toThrow(
      /finished_at is final/,
    );
    await expect(queryAs(app, `update node_key_rotation set old_private_key_enc = 'x'`)).rejects.toThrow(
      /discarded key cannot return/,
    );
    // der Eigentümer verlängert den Zeitraum: Neuexport bricht ab, das alte Profil gewinnt
    await asOwner(
      t,
      `alter table node_key_rotation disable trigger node_key_rotation_guard;
       update node_key_rotation set grace_until = grace_until + interval '1 year',
                                    finished_at = grace_until + interval '1 year';
       alter table node_key_rotation enable trigger node_key_rotation_guard;`,
    );
    const widened = await planAnchorProfile(t.deps.db, {
      nodeId: t.nodeId,
      now: clock.now(),
      previous: after,
    });
    expect(widened.unaccepted).toEqual(['keys']);
    expect(widened.profile.keys).toEqual(after.keys);
  });

  test('CLI: Abweichungen angezeigt, ohne Annahme Exit 4 und keine Datei; mit Annahme exportiert', async () => {
    const { t } = await victim('r2-cli');
    const f1 = join(tmp, 'cli-p1.json');
    const f2 = join(tmp, 'cli-p2.json');
    expect((await cli(['audit-anchor-profile', '--out', f1, '--min-partners', '2'], t)).code).toBe(0);
    expect((await cli(['audit-anchor-profile', '--out', f2, '--accept-epochs'], t)).code).toBe(2);
    await queryAs(t.testDb.urls.app, `update peer set status = 'suspended' where node_id = 'r2-c'`);
    const refused = await cli(['audit-anchor-profile', '--out', f2, '--previous', f1], t);
    expect(refused.code).toBe(4);
    expect(refused.stdout).toContain('NICHT EXPORTIERT');
    expect(refused.stdout).toContain('entfernt / removed: r2-c');
    expect(refused.stdout).toContain('suspended');
    expect(refused.stdout).toContain('--accept-partner-changes');
    expect(refused.stdout).toContain('Mindestzahl bleibt / minimum kept: 2');
    expect(existsSync(f2)).toBe(false);
    expect((await auditEntries(t, 'audit.anchor_profile.export')).at(-1)).toMatchObject({
      outcome: 'denied',
      details: expect.objectContaining({ unaccepted: ['partners'] }),
    });
    // angenommen, aber Mindestzahl unerreichbar → Aufruf falsch (Exit 2)
    const min = await cli(
      ['audit-anchor-profile', '--out', f2, '--previous', f1, '--accept-partner-changes'],
      t,
    );
    expect(min.code).toBe(2);
    expect(min.stderr).toContain('--min-partners');
    const ok = await cli(
      [
        'audit-anchor-profile',
        '--out',
        f2,
        '--previous',
        f1,
        '--accept-partner-changes',
        '--min-partners',
        '1',
      ],
      t,
    );
    expect(ok.code).toBe(0);
    expect(loadAnchorProfile(f2).profile).toMatchObject({ minPartners: 1, partners: [{ nodeId: 'r2-b' }] });
    expect((await auditEntries(t, 'audit.anchor_profile.export')).at(-1)?.details).toMatchObject({
      accepted: ['partners'],
      changes: expect.objectContaining({ partnersRemoved: ['r2-c'] }),
    });
    await queryAs(t.testDb.urls.app, `update peer set status = 'trusted' where node_id = 'r2-c'`);
  });
});

// ---------------------------------------------------------------------------------------------
// Befund 4: erfundene Epoche
// ---------------------------------------------------------------------------------------------

describe('Befund 4: erfundene Wiederherstellung', () => {
  test('nicht im Profil dokumentiert + verlorene Prüfpunkte → Manipulation; Neuexport verlangt --accept-epochs', async () => {
    const { t, cp: early } = await victim('r2-epoch');
    await activity(t, 5);
    const cp = await checkpoint(t);
    const p1 = await buildAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now() });
    const e1 = await currentEpoch(t.deps.db);
    // Eigentümer trägt eine „Wiederherstellung“ ein (Kette ab early.seq umgeschrieben wäre damit erklärt)
    await asOwner(
      t,
      `insert into audit_chain_epoch (n, epoch, reason, previous_epoch, restored_seq)
       values (2, gen_random_uuid(), 'restore', '${e1}', ${early.seq})`,
    );
    const withProfile = await verify(t, loaded(p1));
    expect(withProfile.result).toBe('manipulated');
    expect(finding(withProfile, 'lost_by_restore')[0]).toMatchObject({ severity: 'fail', count: 1 });
    expect(withProfile.partners.every((p) => p.status === 'mismatch')).toBe(true);
    // ohne Profil (nicht unabhängig) bleibt es bei Klärung nötig
    expect((await verify(t)).result).toBe('needs_review');
    // ein Routine-Neuexport übernimmt die Epoche nicht still
    const plan = await planAnchorProfile(t.deps.db, { nodeId: t.nodeId, now: clock.now(), previous: p1 });
    expect(plan.unaccepted).toEqual(['epochs']);
    expect(plan.diff?.epochs.added).toEqual([
      expect.objectContaining({
        reason: 'restore',
        restoredSeq: early.seq,
        backupSha256: null,
        preRestoreSeq: null,
      }),
    ]);
    expect(plan.profile.epochs).toEqual(p1.epochs);
    expect(cp.seq).toBeGreaterThan(early.seq);
  });

  test('Prüfpunkt hinter dem vor der Wiederherstellung festgehaltenen Kopf → Manipulation, auch ohne Profil', async () => {
    const { t, cp: early } = await victim('r2-prehead');
    await activity(t, 3);
    const cp = await checkpoint(t);
    const e1 = await currentEpoch(t.deps.db);
    await asOwner(
      t,
      `insert into audit_chain_epoch (n, epoch, reason, previous_epoch, restored_seq,
                                      pre_restore_epoch, pre_restore_seq, pre_restore_hash)
       values (2, gen_random_uuid(), 'restore', '${e1}', ${early.seq}, '${e1}', ${cp.seq - 1}, repeat('0', 64))`,
    );
    const r = await verify(t);
    expect(r.result).toBe('manipulated');
    expect(r.partners[0]?.firstProblem).toMatchObject({ seq: cp.seq, kind: 'beyond_pre_restore', epoch: e1 });
  });
});

// ---------------------------------------------------------------------------------------------
// Befund 5 und 6: beim Partner
// ---------------------------------------------------------------------------------------------

describe('Befund 5/6: Prüfpunkte beim Partner', () => {
  function notice(
    n: TestNode,
    seq: number,
    epoch: string,
    sign: (s: string) => string,
    hash = 'a'.repeat(64),
  ) {
    const s = buildCheckpointStatement({ nodeId: n.nodeId, epoch, seq, hash, at: clock.now().toISOString() });
    return { kind: 'audit_checkpoint' as const, statement: s, signature: sign(s) };
  }
  const send = (to: TestNode, from: TestNode, body: ReturnType<typeof notice>) =>
    rawSend(to, { from, type: 'notice', body });

  test('gestohlener, später ersetzter Schlüssel: Laufnummer nahe 2^53 blockiert die Prüfpunkte des neuen nicht', async () => {
    const s = await node('r2-s');
    const r = await node('r2-r');
    const { aOnB: sOnR } = await onboard(s, r);
    const epoch = await currentEpoch(s.deps.db);
    const row = await s.deps.db
      .selectFrom('node_identity')
      .select('private_key_enc')
      .executeTakeFirstOrThrow();
    const k1 = s.deps.box.open(row.private_key_enc, 'node_identity.private_key');
    const { ed25519Sign } = await import('../../src/server/core/crypto.ts');
    const withK1 = (x: string) => ed25519Sign(k1, x);
    // Angreifer mit K1
    expect((await send(r, s, notice(s, Number.MAX_SAFE_INTEGER, epoch, withK1))).json.body).toEqual({
      ack: true,
      affectedRows: 1,
    });
    // ehrlicher Prüfpunkt mit K1: nicht steigend (je Schlüssel weiter durchgesetzt)
    expect((await send(r, s, notice(s, 10, epoch, withK1))).json.error?.reason).toBe(
      'checkpoint_not_increasing',
    );
    // Wechsel wegen Kompromittierung, Partner gleicht den neuen Schlüssel ab
    await rotateNodeKey(s.deps, { mode: 'compromised', actor: ACTOR });
    const admin = await adminOf(r);
    expect(
      (
        await r.request('POST', `/api/v1/peers/${sOnR.id}/key`, {
          as: admin,
          body: { card: await cardOf(s) },
        })
      ).status,
    ).toBe(200);
    await r.request('POST', `/api/v1/peers/${sOnR.id}/trust`, {
      as: admin,
      body: { fingerprint: s.deps.identity.fingerprint },
    });
    const withK2 = (x: string) => s.deps.identity.sign(x);
    expect((await send(r, s, notice(s, 10, epoch, withK2))).json.body).toEqual({
      ack: true,
      affectedRows: 1,
    });
    expect((await send(r, s, notice(s, 5, epoch, withK2))).json.error?.reason).toBe(
      'checkpoint_not_increasing',
    );
    expect((await send(r, s, notice(s, 11, epoch, withK2))).json.body).toEqual({
      ack: true,
      affectedRows: 1,
    });
    // K1 gilt beim Partner nicht mehr
    expect((await send(r, s, notice(s, 12, epoch, withK1))).json.error).toEqual({
      code: 'bad_signature',
      reason: 'checkpoint_signature_invalid',
    });
    const held = await r.deps.db
      .selectFrom('peer_audit_checkpoint')
      .select(['seq', 'public_key'])
      .where('peer_id', '=', (await peerRow(r, s)).id)
      .orderBy('seq')
      .execute();
    expect(held.map((h) => h.seq)).toEqual([10, 11, Number.MAX_SAFE_INTEGER]);
    expect(new Set(held.map((h) => h.public_key)).size).toBe(2);
  });

  test('gleichzeitige Zustellungen: Ratenbegrenzung und Eindeutigkeit halten (Prüfung in der Transaktion)', async () => {
    const s = await node('r2-s2');
    const r = await node('r2-r2', { MESH_AUDIT_CHECKPOINT_MAX_PER_DAY: '3' });
    await onboard(s, r);
    const sign = (x: string) => s.deps.identity.sign(x);
    // je eine eigene Epoche: die Reihenfolge je Epoche spielt keine Rolle, nur die Ratenbegrenzung
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => send(r, s, notice(s, seq, randomUUID(), sign))),
    );
    const stored = results.filter((x) => (x.json.body as { affectedRows?: number })?.affectedRows === 1);
    expect(stored).toHaveLength(3);
    expect(results.filter((x) => x.json.error?.reason === 'checkpoint_rate_limited')).toHaveLength(5);
    const peer = await peerRow(r, s);
    const count = await r.deps.db
      .selectFrom('peer_audit_checkpoint')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('peer_id', '=', peer.id)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(3);

    // gleiche Laufnummer, verschiedene Hashes, gleichzeitig: genau einer verwahrt, der andere Widerspruch
    const r3 = await node('r2-r3');
    await onboard(s, r3);
    const e3 = randomUUID();
    const pair = await Promise.all([
      send(r3, s, notice(s, 7, e3, sign, 'b'.repeat(64))),
      send(r3, s, notice(s, 7, e3, sign, 'c'.repeat(64))),
    ]);
    expect(pair.filter((x) => (x.json.body as { affectedRows?: number })?.affectedRows === 1)).toHaveLength(
      1,
    );
    expect(pair.filter((x) => x.json.error?.reason === 'checkpoint_conflict')).toHaveLength(1);
  });
});

describe('Befund 6: Wiederherstellung prüft im Programm', () => {
  test('ersetzte audit_verify() aus der Sicherung täuscht die Prüfung nach restore nicht', async () => {
    const x = await node('r2-restore');
    await activity(x, 4);
    // Eigentümer ändert einen Eintrag (Hash bleibt) und ersetzt audit_verify() – beides gelangt in die Sicherung
    await ownerUpdate(x, `details = '{"tampered": true}'::jsonb`, 'seq = 2');
    await asOwner(
      x,
      `create or replace function audit_verify(out checked bigint, out first_broken_seq bigint)
         language sql stable as $$ select count(*)::bigint, null::bigint from audit_log $$`,
    );
    const run = await x.deps.services.backup.runBackup('cli', null);
    expect(run.fileName).toBeTruthy();
    const head = await headSeq(x);
    const r = await restoreBackup({
      file: join(resolve(x.deps.config.MESH_BACKUP_DIR), run.fileName!),
      ownerUrl: x.testDb.urls.owner,
      backupKey: x.deps.config.MESH_BACKUP_KEY!,
      expectedNodeId: x.nodeId,
    });
    expect(r.audit.database.ok).toBe(true); // die Funktion aus der Sicherung meldet „intakt“
    expect(r.audit).toMatchObject({ ok: false, firstBrokenSeq: 2, breakKind: 'hash_mismatch' });
    expect(r.preRestore).toMatchObject({ seq: head, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
