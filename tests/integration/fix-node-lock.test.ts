/**
 * Regression (Review Runde 3):
 *  - Ein laufender Server hält die Knotensperre; restore erkennt ihn auch ohne Pool-Verbindungen bzw. mit
 *    abweichendem application_name, und ein zweiter Server startet nicht auf derselben Datenbank.
 *  - db-bootstrap ändert Passwörter bestehender Rollen nur mit --rotate-passwords.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { tryAcquireNodeLock } from '../../src/server/core/node-lock.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

const ROOT = resolve(import.meta.dir, '../..');
let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb('nl');
});
afterAll(async () => {
  await tdb?.drop();
});

async function cli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(['bun', join(ROOT, 'src/server/cli/main.ts'), ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('Knotensperre', () => {
  test('nur ein Halter je Datenbank; Freigabe macht sie wieder verfügbar', async () => {
    const first = await tryAcquireNodeLock(tdb.urls.app, 'osp-data-mesh-lock');
    expect(first).not.toBeNull();
    const second = await tryAcquireNodeLock(tdb.urls.app, 'osp-data-mesh-lock');
    expect(second).toBeNull();
    await first!.release();
    const third = await tryAcquireNodeLock(tdb.urls.app, 'osp-data-mesh-lock');
    expect(third).not.toBeNull();
    await third!.release();
  });

  test('restore verweigert, solange ein Server die Sperre hält – auch ohne weitere Verbindungen', async () => {
    // Server-Sperre mit abweichendem application_name (wie bei einer URL mit application_name=…)
    const lock = await tryAcquireNodeLock(`${tdb.urls.app}?application_name=custom`, 'custom');
    expect(lock).not.toBeNull();
    try {
      const r = await cli(['restore', '--file', '/nonexistent.mbk', '--yes'], {
        MESH_DB_OWNER_URL: tdb.urls.owner,
        MESH_BACKUP_KEY: Buffer.alloc(32, 1).toString('base64'),
        MESH_NODE_ID: 'osp-test',
      });
      expect(r.code).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/Knotensperre|node lock/);
    } finally {
      await lock!.release();
    }
  });
});

describe('db-bootstrap ohne --rotate-passwords', () => {
  test('ändert Passwörter bestehender Rollen nicht', async () => {
    const superDb = tdb.superuserUrl;
    const r = await cli(['db-bootstrap', '--db', tdb.dbName, '--force'], {
      MESH_DB_SUPERUSER_URL: superDb,
      MESH_DB_OWNER_PASSWORD: 'anderes-passwort-owner-123',
      MESH_DB_APP_PASSWORD: 'anderes-passwort-app-123',
      MESH_DB_BI_PASSWORD: 'anderes-passwort-bi-123',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/NICHT geändert|NOT changed/);
    // die bisherigen Zugangsdaten funktionieren weiterhin
    const c = new pg.Client({ connectionString: tdb.urls.app });
    await c.connect();
    const q = await c.query('select 1 as ok');
    expect(q.rows[0].ok).toBe(1);
    await c.end();
  });
});
