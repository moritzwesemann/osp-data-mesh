import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { queryAs } from '../helpers/db.ts';
import { createTestNode, type TestNode } from '../helpers/node.ts';

let node: TestNode;

beforeAll(async () => {
  node = await createTestNode();
});
afterAll(async () => {
  await node?.close();
});

describe('Kern: Schema, Rechte, Audit-Log', () => {
  test('Knotenidentität wird beim ersten Start erzeugt, privater Schlüssel verschlüsselt', async () => {
    const row = await node.deps.db.selectFrom('node_identity').selectAll().executeTakeFirstOrThrow();
    expect(row.node_id).toBe(node.nodeId);
    expect(row.private_key_enc.startsWith('v1.')).toBe(true);
    expect(row.private_key_enc).not.toContain(row.public_key);
    expect(node.deps.identity.fingerprint).toMatch(/^([0-9A-F]{4} ){9}[0-9A-F]{4}$/);
  });

  test('Audit-Log: Hash-Kette über mehrere Einträge ist gültig', async () => {
    for (let i = 0; i < 5; i++) {
      await node.deps.audit.record({ actor: { type: 'system' }, action: 'test.entry', details: { i } });
    }
    const r = await sql<{
      checked: number;
      first_broken_seq: number | null;
    }>`select * from audit_verify()`.execute(node.deps.db);
    expect(r.rows[0]!.first_broken_seq).toBeNull();
    expect(r.rows[0]!.checked).toBeGreaterThanOrEqual(5);
  });

  test('Audit-Log: Ändern und Löschen sind für die App-Rolle gesperrt', async () => {
    await expect(sql`update audit_log set action = 'x'`.execute(node.deps.db)).rejects.toThrow();
    await expect(sql`delete from audit_log`.execute(node.deps.db)).rejects.toThrow();
    await expect(sql`truncate audit_log`.execute(node.deps.db)).rejects.toThrow();
  });

  test('Audit-Log: auch der Schema-Eigentümer kann nicht ändern (Trigger)', async () => {
    await expect(queryAs(node.testDb.urls.owner, "update audit_log set action = 'x'")).rejects.toThrow(
      /append-only/,
    );
    await expect(queryAs(node.testDb.urls.owner, 'delete from audit_log')).rejects.toThrow(/append-only/);
  });

  test('Audit-Log: Manipulation wird durch die Hash-Kette erkannt', async () => {
    // Superuser umgeht den Trigger (Simulation eines Angriffs mit vollem DB-Zugriff)
    await queryAs(
      node.testDb.superuserUrl.replace(/\/postgres$/, `/${node.testDb.dbName}`),
      'begin; alter table audit_log disable trigger audit_log_no_update; update audit_log set details = \'{"i":99}\' where seq = 2; alter table audit_log enable trigger audit_log_no_update; commit;',
    );
    const r = await sql<{ first_broken_seq: number | null }>`select * from audit_verify()`.execute(
      node.deps.db,
    );
    expect(r.rows[0]!.first_broken_seq).toBe(2);
  });

  test('BI-Rolle sieht keine Kerntabellen', async () => {
    await expect(queryAs(node.testDb.urls.bi, 'select * from athlete')).rejects.toThrow(
      /permission denied|does not exist/,
    );
    await expect(queryAs(node.testDb.urls.bi, 'select * from public.audit_log')).rejects.toThrow(
      /permission denied/,
    );
  });

  test('App-Rolle kann Migrationshistorie nicht ändern', async () => {
    await expect(sql`delete from schema_migration`.execute(node.deps.db)).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('Kern: HTTP', () => {
  test('unbekannte API-Route liefert 404 mit Fehlercode und Request-ID', async () => {
    const r = await node.request<{ error: { code: string; requestId: string } }>(
      'GET',
      '/api/v1/does-not-exist',
    );
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
    expect(r.headers.get('x-request-id')).toBeTruthy();
  });

  test('Sicherheits-Header sind gesetzt', async () => {
    const r = await node.request('GET', '/api/v1/does-not-exist');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(r.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
