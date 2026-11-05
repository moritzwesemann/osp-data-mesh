/**
 * Unabhängige Neuberechnung der Audit-Hash-Kette im Programm (ADR 0014, Nachtrag; Prüfbefund H1):
 *  - die Eingabe des Hashes stimmt Byte für Byte mit audit_digest_input() der Datenbank überein, auch bei
 *    Umlauten, Emoji, Steuerzeichen, Trennzeichen „|“, verschachteltem JSON, Zahlenformen und NULL-Spalten
 *  - erkannt werden: geänderter Inhalt bei stehen gelassenem Hash (auch wenn audit_verify() ersetzt wurde),
 *    falscher Vorgängerverweis, Lücke, Einträge ohne Laufnummer, View statt Tabelle, Zeilensicherheit
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { AuditWriter } from '../../src/server/core/audit.ts';
import {
  auditDigestInput,
  auditRowHash,
  GENESIS_HASH,
  readAuditDigestRows,
  recomputeAuditChain,
} from '../../src/server/modules/audit/chain.ts';
import { verifyAuditChain } from '../../src/server/modules/audit/index.ts';
import { createTestDb, queryAs, type TestDb } from '../helpers/db.ts';

let tdb: TestDb;

async function asOwner(statements: string) {
  await queryAs(tdb.urls.owner, statements);
}

/** Datenbank-Eigentümer ändert Zeilen unter Umgehung des Triggers */
async function ownerUpdate(set: string, where: string) {
  await asOwner(`begin;
    alter table audit_log disable trigger audit_log_no_update;
    update audit_log set ${set} where ${where};
    alter table audit_log enable trigger audit_log_no_update;
    commit;`);
}

const TRICKY_DETAILS: Record<string, unknown>[] = [
  {},
  { name: 'Müller-Lüdenscheidt', city: 'Köln', ß: 'Straße' },
  { emoji: '🏃‍♀️🚣🏽', cjk: '漢字かなカナ', rtl: 'مرحبا', combining: 'é' },
  { pipe: 'a|b||c', quote: 'sie sagte "hallo"', backslash: 'C:\\pfad\\datei', apostrophe: "l'été" },
  { control: 'zeile1\nzeile2\tTab\r\u0001\u001f', slash: '</script>' },
  { nested: { arr: [1, 2, { deep: [true, false, null] }], obj: { b: 2, a: 1, aa: 0 } } },
  { numbers: [0, -0, 1.5, -2.25, 1e21, 123456789012345, 0.1, 2.5e-7] },
  { long: 'x'.repeat(5000) },
  { keys: { z: 1, a: 2, mm: 3, b: 4, '': 5 } },
];

beforeAll(async () => {
  tdb = await createTestDb('chain');
  const w = new AuditWriter(tdb.db);
  for (const [i, details] of TRICKY_DETAILS.entries()) {
    await w.record({
      actor: i % 2 ? { type: 'user', id: `u-${i}`, label: `Ärztin №${i} | ✓` } : { type: 'system' },
      action: `test.recompute.${i}`,
      outcome: (['success', 'denied', 'error'] as const)[i % 3],
      objectType: i % 3 ? 'athlete' : null,
      objectId: i % 3 ? `obj|${i}` : null,
      details,
      ip: i % 2 ? '2001:db8::1' : null,
      requestId: i % 4 ? `req-${i}` : null,
    });
  }
  // Zahlenformen, die nur jsonb selbst normalisiert (1.0, 1e2, sehr lange Dezimalzahlen), und Escapes
  await queryAs(
    tdb.urls.app,
    `insert into audit_log (actor_type, actor_id, actor_label, action, outcome, details, ip, request_id)
     values ('anonymous', '', '', 'test.recompute.raw', 'success',
             '{"n": 1.0, "e": 1e2, "big": 123456789012345678901234567890.1234567890, "esc": "\\u00e9\\u2603", "neg": -0.0}'::jsonb,
             '', '')`,
  );
  for (let i = 0; i < 40; i++) {
    await w.record({ actor: { type: 'system' }, action: 'test.recompute.bulk', details: { i, s: `#${i}` } });
  }
});
afterAll(async () => {
  await tdb?.drop();
});

describe('Neuberechnung stimmt mit der Datenbank überein', () => {
  test('Eingabe Byte für Byte wie audit_digest_input(), Hash wie der Trigger, für jede Zeile', async () => {
    const sqlRows = await sql<{ seq: string; input: string; hash: string }>`
      select a.seq::text as seq, audit_digest_input(a) as input, a.hash from audit_log a order by a.seq`.execute(
      tdb.db,
    );
    const rows = await readAuditDigestRows(tdb.db, 0, 10_000);
    expect(rows.length).toBe(sqlRows.rows.length);
    expect(rows.length).toBeGreaterThan(45);
    let prev = GENESIS_HASH;
    rows.forEach((r, i) => {
      const expected = sqlRows.rows[i]!;
      expect(r.seq).toBe(expected.seq);
      const input = auditDigestInput(r, prev);
      expect(input).toBe(expected.input);
      expect(Buffer.from(input, 'utf8').equals(Buffer.from(expected.input, 'utf8'))).toBe(true);
      expect(auditRowHash(r, prev)).toBe(expected.hash);
      prev = expected.hash;
    });
    // Stichprobe: Sonderfälle sind wirklich enthalten
    const all = rows.map((r) => r.details).join('\n');
    for (const fragment of ['🏃', 'Müller', 'a|b||c', '\\n', '1.0', '100']) {
      expect(all).toContain(fragment);
    }
    const chain = await recomputeAuditChain(tdb.db, [1, rows.length]);
    expect(chain).toMatchObject({ ok: true, checked: rows.length, firstBrokenSeq: null, breakKind: null });
    expect(chain.headSeq).toBe(rows.length);
    expect(chain.hashes.get(rows.length)).toBe(sqlRows.rows.at(-1)!.hash);
  });
});

describe('Manipulationen durch den Datenbank-Eigentümer', () => {
  test('Inhalt geändert, Hash stehen gelassen, audit_verify() ersetzt: Datenbank „intakt“, Neuberechnung nicht', async () => {
    await ownerUpdate(`details = '{"tampered": true}'::jsonb, actor_label = 'jemand anderes'`, 'seq = 5');
    await asOwner(`create or replace function audit_verify(out checked bigint, out first_broken_seq bigint)
      language sql stable as $$ select count(*)::bigint, null::bigint from audit_log $$`);
    expect((await verifyAuditChain(tdb.db)).ok).toBe(true);
    const chain = await recomputeAuditChain(tdb.db);
    expect(chain).toMatchObject({ ok: false, firstBrokenSeq: 5, breakKind: 'hash_mismatch', checked: 4 });
    // auch eine ersetzte audit_digest_input() ändert nichts an der Neuberechnung
    await asOwner(`create or replace function audit_digest_input(r audit_log) returns text language sql stable
      as $$ select 'x' $$`);
    expect((await recomputeAuditChain(tdb.db)).firstBrokenSeq).toBe(5);
  });

  test('Vorgängerverweis, Lücke und Einträge ohne Laufnummer', async () => {
    await ownerUpdate(`prev_hash = repeat('a', 64)`, 'seq = 3');
    expect(await recomputeAuditChain(tdb.db)).toMatchObject({
      firstBrokenSeq: 3,
      breakKind: 'prev_hash_mismatch',
    });

    const gap = await createTestDb('chaingap');
    try {
      const w = new AuditWriter(gap.db);
      for (let i = 0; i < 4; i++) await w.record({ actor: { type: 'system' }, action: 'test.gap' });
      await queryAs(
        gap.urls.owner,
        `begin; alter table audit_log disable trigger audit_log_no_update;
         delete from audit_log where seq = 3;
         alter table audit_log enable trigger audit_log_no_update; commit;`,
      );
      expect(await recomputeAuditChain(gap.db)).toMatchObject({ firstBrokenSeq: 4, breakKind: 'seq_gap' });
      const stray = await createTestDb('chainstray');
      try {
        const w2 = new AuditWriter(stray.db);
        for (let i = 0; i < 2; i++) await w2.record({ actor: { type: 'system' }, action: 'test.stray' });
        await queryAs(
          stray.urls.owner,
          `begin; alter table audit_log disable trigger audit_log_chain;
           insert into audit_log (seq, actor_type, action, outcome, prev_hash, hash)
             values (null, 'system', 'test.stray', 'success', '', '');
           alter table audit_log enable trigger audit_log_chain; commit;`,
        );
        expect(await recomputeAuditChain(stray.db)).toMatchObject({ ok: false, breakKind: 'unsequenced' });
      } finally {
        await stray.drop();
      }
    } finally {
      await gap.drop();
    }
  });

  test('View statt Tabelle bzw. Zeilensicherheit: keine Prüfung möglich, gilt als gebrochen', async () => {
    const v = await createTestDb('chainview');
    try {
      await new AuditWriter(v.db).record({ actor: { type: 'system' }, action: 'test.view' });
      await queryAs(v.urls.owner, 'alter table audit_log enable row level security');
      expect(await recomputeAuditChain(v.db)).toMatchObject({ ok: false, breakKind: 'not_a_table' });
      await queryAs(
        v.urls.owner,
        `alter table audit_log disable row level security;
         alter table audit_log rename to audit_log_real;
         create view audit_log as select * from audit_log_real;
         grant select on audit_log to mesh_app;`,
      );
      expect(await recomputeAuditChain(v.db)).toMatchObject({ ok: false, breakKind: 'not_a_table' });
    } finally {
      await v.drop();
    }
  });
});
