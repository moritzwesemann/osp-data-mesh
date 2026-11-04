/**
 * Regression (Abnahme einer Neuinstallation), Betriebs-CLI:
 *  - db-bootstrap liest die Superuser-URL aus MESH_DB_SUPERUSER_URL (Passwort nicht auf der Kommandozeile)
 *    und verweigert einen zweiten Knoten im selben Cluster (Rollen gelten clusterweit), außer mit --force;
 *  - restore verweigert die Wiederherstellung, solange der Server mit der Datenbank verbunden ist
 *    (application_name osp-data-mesh), außer mit --force;
 *  - beide nennen danach den dokumentierten Aufruf der Migrationen.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { MIGRATE_COMMAND, otherNodeDatabases } from '../../src/server/cli/commands.ts';
import { runCli } from '../../src/server/cli/main.ts';
import { BackupManager } from '../../src/server/modules/system/backup.ts';
import { createTestDb, queryAs, type TestDb, testClusterAccess } from '../helpers/db.ts';
import { createTestNode, type TestNode } from '../helpers/node.ts';

const DOCUMENTED_MIGRATE = 'bun --env-file=.env --env-file=.env.owner run cli migrate';

let spare: TestDb;
const nodes: TestNode[] = [];

beforeAll(async () => {
  // eine weitere Datenbank von mesh_owner im Testcluster (wie ein zweiter Knoten)
  spare = await createTestDb('cli');
});
afterAll(async () => {
  for (const n of nodes) await n.close();
  await spare?.drop();
});

/** Führt die CLI aus und sammelt Ausgabe, Fehlerausgabe und Exit-Code; env wird danach zurückgesetzt. */
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
    const code = await runCli(args);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function bootstrapEnv(superuserUrl: string | undefined) {
  const { passwords } = testClusterAccess();
  return {
    MESH_DB_SUPERUSER_URL: superuserUrl,
    MESH_DB_OWNER_PASSWORD: passwords.ownerPassword,
    MESH_DB_APP_PASSWORD: passwords.appPassword,
    MESH_DB_BI_PASSWORD: passwords.biPassword,
  };
}

async function databaseExists(name: string): Promise<boolean> {
  const r = await queryAs<{ n: string }>(
    testClusterAccess().superuserUrl,
    'select count(*) as n from pg_database where datname = $1',
    [name],
  );
  return Number(r.rows[0]!.n) > 0;
}

describe('db-bootstrap', () => {
  test('dokumentierter migrate-Aufruf', () => {
    expect(MIGRATE_COMMAND).toBe(DOCUMENTED_MIGRATE);
  });

  test('Superuser-URL aus MESH_DB_SUPERUSER_URL; weiterer Knoten im selben Cluster wird verweigert', async () => {
    const { superuserUrl } = testClusterAccess();
    const name = `mesh_cli_new_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const r = await cli(['db-bootstrap', '--db', name], bootstrapEnv(superuserUrl));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('one PostgreSQL cluster per node');
    expect(r.stderr).toContain(spare.dbName);
    expect(r.stderr).not.toContain(superuserUrl);
    expect(await databaseExists(name)).toBe(false);

    // ohne URL (weder Umgebung noch Option): Aufruffehler
    const missing = await cli(['db-bootstrap', '--db', name], bootstrapEnv(undefined));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('MESH_DB_SUPERUSER_URL');
  });

  test('die Zieldatenbank selbst zählt nicht als anderer Knoten', async () => {
    const others = await otherNodeDatabases(testClusterAccess().superuserUrl, spare.dbName);
    expect(others).not.toContain(spare.dbName);
    const node = await createTestNode();
    nodes.push(node);
    expect(await otherNodeDatabases(testClusterAccess().superuserUrl, node.testDb.dbName)).toContain(
      spare.dbName,
    );
  });

  test('erneuter Aufruf für dieselbe Datenbank (mit --force wegen der übrigen Testdatenbanken): idempotent', async () => {
    const r = await cli(
      ['db-bootstrap', '--db', spare.dbName, '--force'],
      bootstrapEnv(testClusterAccess().superuserUrl),
    );
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Weiter / next: ${DOCUMENTED_MIGRATE}`);
    expect(r.stdout).not.toContain('bun run migrate');
    // Rollen und Rechte unverändert nutzbar
    const ok = await sql<{ n: number }>`select count(*)::int as n from athlete`.execute(spare.db);
    expect(ok.rows[0]!.n).toBe(0);
  });
});

describe('restore', () => {
  test('verweigert, solange der Server verbunden ist; --force übergeht die Prüfung', async () => {
    const node = await createTestNode();
    nodes.push(node);
    await sql`select 1`.execute(node.deps.db); // Pool des "laufenden Knotens" verbunden
    const env = {
      MESH_DB_OWNER_URL: node.testDb.urls.owner,
      MESH_BACKUP_KEY: node.deps.config.MESH_BACKUP_KEY,
      MESH_NODE_ID: node.nodeId,
    };
    const missingFile = join(resolve(node.deps.config.MESH_BACKUP_DIR), 'fehlt.mbk');
    const refused = await cli(['restore', '--file', missingFile, '--yes'], env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('the node is still running');

    const forced = await cli(['restore', '--file', missingFile, '--yes', '--force'], env);
    expect(forced.code).toBe(1);
    expect(forced.stderr).not.toContain('running');
  });

  test('nach dem Stopp des Knotens: Wiederherstellung und Hinweis auf den dokumentierten migrate-Aufruf', async () => {
    const node = await createTestNode();
    nodes.push(node);
    const backupDir = resolve(node.deps.config.MESH_BACKUP_DIR);
    try {
      const run = await new BackupManager(node.deps).runBackup('cli', null);
      await node.deps.db.destroy(); // Knoten gestoppt
      const r = await cli(['restore', '--file', join(backupDir, run.fileName!), '--yes'], {
        MESH_DB_OWNER_URL: node.testDb.urls.owner,
        MESH_BACKUP_KEY: node.deps.config.MESH_BACKUP_KEY,
        MESH_NODE_ID: node.nodeId,
      });
      expect(r.stderr).toBe('');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Weiter / next: ${DOCUMENTED_MIGRATE}`);
      expect(r.stdout).not.toContain('bun run migrate');
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
    }
  });
});
