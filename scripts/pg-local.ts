/**
 * Projektlokale PostgreSQL-Cluster für Entwicklung, Tests und Demo.
 *
 * Nutzt die lokal installierten PostgreSQL-Binaries (initdb, pg_ctl, psql). Jeder Cluster liegt unter
 * `.local/pg/<name>`, lauscht nur auf 127.0.0.1 und verwendet SCRAM-Passwort-Authentifizierung.
 *
 *   bun scripts/pg-local.ts init <name> <port>     Cluster anlegen (falls nötig) und starten
 *   bun scripts/pg-local.ts stop <name>            Cluster stoppen
 *   bun scripts/pg-local.ts stop-all               alle Cluster unter .local/pg stoppen
 *   bun scripts/pg-local.ts status                 Status aller Cluster
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

export const PG_BIN = process.env.MESH_PG_BIN ?? findPgBin();

function findPgBin(): string {
  for (const candidate of [
    '/opt/homebrew/opt/postgresql@18/bin',
    '/opt/homebrew/bin',
    '/usr/local/opt/postgresql@18/bin',
    '/usr/lib/postgresql/18/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]) {
    if (existsSync(join(candidate, 'pg_ctl'))) return candidate;
  }
  return '';
}

export function pgTool(name: string): string {
  return PG_BIN ? join(PG_BIN, name) : name;
}

export interface ClusterInfo {
  name: string;
  port: number;
  dir: string;
  superuserPassword: string;
  superuserUrl: string;
}

export function localRoot(baseDir = ROOT): string {
  return process.env.MESH_LOCAL_DIR ? resolve(process.env.MESH_LOCAL_DIR) : join(baseDir, '.local');
}

function run(cmd: string[], opts: { allowFail?: boolean; env?: Record<string, string> } = {}) {
  const proc = Bun.spawnSync(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...opts.env },
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (proc.exitCode !== 0 && !opts.allowFail) {
    throw new Error(`Command failed (${proc.exitCode}): ${cmd.join(' ')}\n${stderr || stdout}`);
  }
  return { code: proc.exitCode, stdout, stderr };
}

export function clusterDir(name: string): string {
  return join(localRoot(), 'pg', name);
}

export function readClusterInfo(name: string): ClusterInfo | null {
  const dir = clusterDir(name);
  const metaPath = join(dir, 'cluster.json');
  if (!existsSync(metaPath)) return null;
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { port: number; superuserPassword: string };
  return {
    name,
    port: meta.port,
    dir,
    superuserPassword: meta.superuserPassword,
    superuserUrl: `postgres://postgres:${encodeURIComponent(meta.superuserPassword)}@127.0.0.1:${meta.port}/postgres`,
  };
}

export function isRunning(name: string): boolean {
  const dir = join(clusterDir(name), 'data');
  if (!existsSync(dir)) return false;
  return run([pgTool('pg_ctl'), '-D', dir, 'status'], { allowFail: true }).code === 0;
}

/** Legt den Cluster an (falls nötig) und startet ihn. Idempotent. */
export function ensureCluster(name: string, port: number): ClusterInfo {
  const dir = clusterDir(name);
  const dataDir = join(dir, 'data');
  mkdirSync(dir, { recursive: true });
  let info = readClusterInfo(name);
  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    const superuserPassword = randomBytes(18).toString('base64url');
    const pwFile = join(dir, '.pwfile');
    writeFileSync(pwFile, superuserPassword, { mode: 0o600 });
    run([
      pgTool('initdb'),
      '-D',
      dataDir,
      '-U',
      'postgres',
      '--auth-local=scram-sha-256',
      '--auth-host=scram-sha-256',
      `--pwfile=${pwFile}`,
      '-E',
      'UTF8',
      '--locale=C',
    ]);
    Bun.spawnSync(['rm', '-f', pwFile]);
    const conf = [
      '',
      '# osp-data-mesh local settings',
      "listen_addresses = '127.0.0.1'",
      `port = ${port}`,
      "unix_socket_directories = ''",
      'shared_buffers = 32MB',
      'max_connections = 60',
      "password_encryption = 'scram-sha-256'",
      "timezone = 'UTC'",
      'fsync = on',
    ].join('\n');
    writeFileSync(
      join(dataDir, 'postgresql.conf'),
      readFileSync(join(dataDir, 'postgresql.conf'), 'utf8') + conf,
    );
    writeFileSync(join(dir, 'cluster.json'), JSON.stringify({ port, superuserPassword }, null, 2), {
      mode: 0o600,
    });
    info = readClusterInfo(name);
  }
  if (!info) throw new Error(`cluster metadata missing for ${name}`);
  if (info.port !== port)
    throw new Error(`cluster ${name} was initialised with port ${info.port}, not ${port}`);
  if (!isRunning(name)) {
    run([pgTool('pg_ctl'), '-D', dataDir, '-l', join(dir, 'server.log'), '-w', '-t', '30', 'start']);
  }
  return info;
}

export function stopCluster(name: string): void {
  const dataDir = join(clusterDir(name), 'data');
  if (isRunning(name)) run([pgTool('pg_ctl'), '-D', dataDir, '-m', 'fast', '-w', 'stop']);
}

export function listClusters(): string[] {
  const dir = join(localRoot(), 'pg');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => existsSync(join(dir, n, 'cluster.json')));
}

export interface DbCredentials {
  dbName: string;
  ownerPassword: string;
  appPassword: string;
  biPassword: string;
}

export function newCredentials(dbName: string): DbCredentials {
  return {
    dbName,
    ownerPassword: randomBytes(18).toString('base64url'),
    appPassword: randomBytes(18).toString('base64url'),
    biPassword: randomBytes(18).toString('base64url'),
  };
}

/** Führt deploy/postgres/bootstrap.sql aus (Rollen + Datenbank). Idempotent. */
export function bootstrapDatabase(cluster: ClusterInfo, creds: DbCredentials): void {
  run([
    pgTool('psql'),
    cluster.superuserUrl,
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    `db_name=${creds.dbName}`,
    '-v',
    `owner_password=${creds.ownerPassword}`,
    '-v',
    `app_password=${creds.appPassword}`,
    '-v',
    `bi_password=${creds.biPassword}`,
    '-f',
    join(ROOT, 'deploy/postgres/bootstrap.sql'),
  ]);
}

export function dbUrls(cluster: ClusterInfo, creds: DbCredentials) {
  const base = `127.0.0.1:${cluster.port}/${creds.dbName}`;
  return {
    owner: `postgres://mesh_owner:${encodeURIComponent(creds.ownerPassword)}@${base}`,
    app: `postgres://mesh_app:${encodeURIComponent(creds.appPassword)}@${base}`,
    bi: `postgres://mesh_bi:${encodeURIComponent(creds.biPassword)}@${base}`,
  };
}

if (import.meta.main) {
  const [cmd, name, port] = process.argv.slice(2);
  if (cmd === 'init' && name && port) {
    const info = ensureCluster(name, Number(port));
    console.log(`cluster ${name} running on 127.0.0.1:${info.port} (${info.dir})`);
  } else if (cmd === 'stop' && name) {
    stopCluster(name);
    console.log(`cluster ${name} stopped`);
  } else if (cmd === 'stop-all') {
    for (const n of listClusters()) {
      stopCluster(n);
      console.log(`cluster ${n} stopped`);
    }
  } else if (cmd === 'status') {
    for (const n of listClusters()) {
      const info = readClusterInfo(n);
      console.log(`${n}\tport=${info?.port}\t${isRunning(n) ? 'running' : 'stopped'}`);
    }
  } else {
    console.error('usage: bun scripts/pg-local.ts init <name> <port> | stop <name> | stop-all | status');
    process.exit(2);
  }
}
