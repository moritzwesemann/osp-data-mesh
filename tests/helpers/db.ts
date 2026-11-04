/**
 * Testdatenbanken: eigener lokaler Cluster "test" (Port 55434, .local/pg/test), je Testdatei eine frische
 * Datenbank mit allen Migrationen. Rollen-Passwörter sind clusterweit und werden einmalig festgelegt.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  bootstrapDatabase,
  type ClusterInfo,
  type DbCredentials,
  dbUrls,
  ensureCluster,
  isRunning,
  newCredentials,
  readClusterInfo,
} from '../../scripts/pg-local.ts';
import { createDb, type Db } from '../../src/server/core/db.ts';
import { migrate } from '../../src/server/core/migrate.ts';

export const TEST_PG_PORT = Number(process.env.MESH_TEST_PG_PORT ?? 55434);

function testCluster(): ClusterInfo {
  try {
    return ensureCluster('test', TEST_PG_PORT);
  } catch (err) {
    // parallele Testläufe: anderer Prozess hat den Cluster eben gestartet
    const info = readClusterInfo('test');
    if (info && isRunning('test')) return info;
    throw err;
  }
}

function testCredentials(cluster: ClusterInfo, dbName: string): DbCredentials {
  const file = join(cluster.dir, 'test-credentials.json');
  if (!existsSync(file)) {
    const c = newCredentials('x');
    writeFileSync(
      file,
      JSON.stringify({
        ownerPassword: c.ownerPassword,
        appPassword: c.appPassword,
        biPassword: c.biPassword,
      }),
      {
        mode: 0o600,
      },
    );
  }
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Omit<DbCredentials, 'dbName'>;
  return { ...saved, dbName };
}

/** Superuser-Zugang und Rollen-Passwörter des Testclusters (z. B. für Tests der CLI db-bootstrap) */
export function testClusterAccess(): { superuserUrl: string; passwords: Omit<DbCredentials, 'dbName'> } {
  const cluster = testCluster();
  const { dbName: _unused, ...passwords } = testCredentials(cluster, 'x');
  return { superuserUrl: cluster.superuserUrl, passwords };
}

export interface TestDb {
  dbName: string;
  urls: { owner: string; app: string; bi: string };
  superuserUrl: string;
  /** Verbindung als mesh_app (wie der Server) */
  db: Db;
  drop(): Promise<void>;
}

/** migrationsDir: nur die Migrationen dieses Verzeichnisses anwenden (Test einer späteren Migration) */
export async function createTestDb(prefix = 't', opts: { migrationsDir?: string } = {}): Promise<TestDb> {
  const cluster = testCluster();
  const dbName = `mesh_${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const creds = testCredentials(cluster, dbName);
  bootstrapDatabase(cluster, creds);
  const urls = dbUrls(cluster, creds);
  await migrate(urls.owner, { dir: opts.migrationsDir });
  const db = createDb(urls.app, 5);
  return {
    dbName,
    urls,
    superuserUrl: cluster.superuserUrl,
    db,
    async drop() {
      await db.destroy();
      const client = new pg.Client({ connectionString: cluster.superuserUrl });
      await client.connect();
      try {
        await client.query(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
          [dbName],
        );
        await client.query(`drop database if exists "${dbName}"`);
      } finally {
        await client.end();
      }
    },
  };
}

/** Führt SQL als bestimmte Rolle aus (z. B. mesh_bi) */
export async function queryAs<T extends pg.QueryResultRow = Record<string, unknown>>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
}
