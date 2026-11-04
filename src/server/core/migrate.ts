/**
 * Migrationen: einfache, versionierte SQL-Dateien in migrations/NNNN_name.sql, ausgeführt als mesh_owner.
 * Jede Datei läuft in einer eigenen Transaktion; Prüfsummen bereits angewandter Dateien werden verglichen.
 * Danach wird migrations/grants.sql (idempotent) ausgeführt.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

export const MIGRATIONS_DIR = resolve(import.meta.dir, '../../../migrations');

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  sha256: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return {
        version: f.slice(0, 4),
        name: f.replace(/\.sql$/, ''),
        sql,
        sha256: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  ownerUrl: string,
  opts: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrateResult> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => {});
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'osp-data-mesh-migrate' });
  await client.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query('select pg_advisory_lock(7212002)');
    await client.query(`create table if not exists schema_migration (
      version text primary key,
      name text not null,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )`);
    const { rows } = await client.query<{ version: string; sha256: string }>(
      'select version, sha256 from schema_migration',
    );
    const applied = new Map(rows.map((r) => [r.version, r.sha256]));
    for (const m of listMigrations(dir)) {
      const known = applied.get(m.version);
      if (known) {
        if (known !== m.sha256) {
          throw new Error(`migration ${m.name} was modified after it was applied (checksum mismatch)`);
        }
        result.skipped.push(m.name);
        continue;
      }
      log(`applying ${m.name}`);
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query('insert into schema_migration (version, name, sha256) values ($1, $2, $3)', [
          m.version,
          m.name,
          m.sha256,
        ]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
      }
      result.applied.push(m.name);
    }
    await applyGrants(client, dir);
  } finally {
    await client.query('select pg_advisory_unlock(7212002)').catch(() => {});
    await client.end();
  }
  return result;
}

export async function applyGrants(client: pg.Client, dir = MIGRATIONS_DIR): Promise<void> {
  const grants = readFileSync(join(dir, 'grants.sql'), 'utf8');
  await client.query(grants);
}
