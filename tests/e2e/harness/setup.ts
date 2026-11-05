/**
 * Aufbau und Abbau der E2E-Umgebung: eigener PostgreSQL-Cluster in einem temporären Verzeichnis (Port
 * MESH_E2E_PG_PORT, Standard 55471), je Knoten eine frische Datenbank (tests/helpers/db.ts), Oberfläche
 * einmal in das temporäre Verzeichnis gebaut (MESH_UI_DIR), zwei echte Knotenprozesse (src/server/main.ts)
 * auf 4451/4452, Administration über die Betriebs-CLI (create-admin), alles Weitere über die HTTP-API.
 *
 * Aufräumen: Knotenprozesse (per PID), Cluster (pg_ctl stop) und temporäres Verzeichnis – auch bei
 * Fehlschlag oder Abbruch. Reste eines hart abgebrochenen Laufs (kill -9) räumt der nächste Lauf anhand
 * von .local/e2e/state.json auf – nur dort vermerkte PIDs, und nur wenn die Kommandozeile passt (Knoten
 * tragen das Kennzeichen --mesh-e2e=<temporäres Verzeichnis>, die Demo-Knoten also nie).
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { clusterDir, pgTool } from '../../../scripts/pg-local.ts';
import { ApiClient, fixtureForm, ROOT } from './api.ts';
import { E2E_PASSWORD, type E2eEnv, type NodeEnv, type NodeKey, type UserKey } from './env.ts';

export const PG_PORT = Number(process.env.MESH_E2E_PG_PORT ?? 55471);
/** Knotenports (nur 4451–4459) */
const NODE_SPECS: Record<NodeKey, { id: string; name: string; port: number }> = {
  nord: { id: 'osp-nord', name: 'Test-OSP Nord', port: 4451 },
  mitte: { id: 'osp-mitte', name: 'Test-OSP Mitte', port: 4452 },
};
export const STATE_DIR = join(ROOT, '.local/e2e');
export const ARTIFACTS_DIR = join(STATE_DIR, 'artefakte');
const STATE_FILE = join(STATE_DIR, 'state.json');
const SERVER_MAIN = join(ROOT, 'src/server/main.ts');
const INITIAL_PASSWORD = 'E2E-Erstpasswort-2026!';
const STEERING = 'training_steering';

const ROLE_OF: Record<Exclude<UserKey, 'admin'>, string> = {
  steward: 'data_steward',
  analyst: 'analyst',
  coach: 'coach',
  auditor: 'auditor',
};
/** Personen je Knoten (osp-mitte braucht nur Administration und Datenverantwortung) */
const USERS: Record<NodeKey, Exclude<UserKey, 'admin'>[]> = {
  nord: ['steward', 'analyst', 'coach', 'auditor'],
  mitte: ['steward'],
};

const log = (line: string) => process.stdout.write(`[e2e] ${line}\n`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

interface State {
  /** Starter (tests/e2e/run.ts) dieses Laufs */
  runnerPid: number;
  tmpDir: string;
  pgDataDir: string;
  /** Knotenprozesse */
  pids: number[];
  /** Testprozess (bun test) */
  testPids?: number[];
}

interface RunningNode {
  key: NodeKey;
  env: NodeEnv;
  proc: Subprocess;
  logFile: string;
}

export interface Environment {
  env: E2eEnv;
  envFile: string;
  /** Server-Logs nach .local/e2e/artefakte kopieren (bei Fehlschlag) */
  saveLogs(): void;
  /** Testprozess vermerken (Aufräumen nach hartem Abbruch des Starters) */
  recordTestProcess(pid: number): void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Prozesse, Ports, Reste
// ---------------------------------------------------------------------------------------------

/** Minimale Umgebung für Kindprozesse (keine Geheimnisse der aufrufenden Shell weiterreichen) */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'MESH_PG_BIN']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return { ...env, ...extra };
}

function stopCluster(dataDir: string): void {
  if (!existsSync(join(dataDir, 'PG_VERSION'))) return;
  Bun.spawnSync([pgTool('pg_ctl'), '-D', dataDir, '-m', 'fast', '-w', 'stop'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

/** Kennzeichen auf der Kommandozeile der E2E-Knoten (main.ts wertet keine Argumente aus) */
function serverMarker(tmpDir: string): string {
  return `--mesh-e2e=${tmpDir}`;
}

/** Nur Knoten dieses E2E-Laufs (nie z. B. die Demo, die dieselbe main.ts startet) */
function isOurServer(pid: number, tmpDir: string): boolean {
  const ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  const cmd = ps.stdout.toString();
  return ps.exitCode === 0 && cmd.includes(SERVER_MAIN) && cmd.includes(serverMarker(tmpDir));
}

function isAlive(pid: number, commandPart: string): boolean {
  const ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  return ps.exitCode === 0 && ps.stdout.toString().includes(commandPart);
}

/** bun test mit E2E-Dateien (nur aus der eigenen Zustandsdatei, per PID) */
function isOurTestRun(pid: number): boolean {
  const ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  const cmd = ps.stdout.toString();
  return ps.exitCode === 0 && / test /.test(cmd) && cmd.includes('.e2e.ts');
}

function writeState(state: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Reste eines hart abgebrochenen Laufs aufräumen (nur eigene Prozesse, per PID) */
async function cleanupLeftovers(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  let state: State;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  } catch {
    rmSync(STATE_FILE, { force: true });
    return;
  }
  if (state.runnerPid !== process.pid && isAlive(state.runnerPid, 'tests/e2e/run.ts')) {
    throw new Error(
      `Ein anderer E2E-Lauf läuft noch (PID ${state.runnerPid}); nacheinander starten (gleiche Ports).`,
    );
  }
  const killed: number[] = [];
  for (const pid of state.pids) {
    if (isOurServer(pid, state.tmpDir)) {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    }
  }
  for (const pid of state.testPids ?? []) {
    if (isOurTestRun(pid)) {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    }
  }
  stopCluster(state.pgDataDir);
  if (state.tmpDir.includes('osp-e2e-')) rmSync(state.tmpDir, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });
  log(`Reste eines abgebrochenen Laufs aufgeräumt${killed.length ? ` (Prozesse ${killed.join(', ')})` : ''}`);
}

async function portFree(port: number): Promise<boolean> {
  try {
    const l = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    l.stop(true);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(proc: Subprocess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
  if (!exited) {
    proc.kill('SIGKILL');
    await proc.exited;
  }
}

function tail(file: string, lines = 20): string {
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
}

async function run(cmd: string[], opts: { env?: Record<string, string>; what: string }): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: opts.env ?? baseEnv(), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${opts.what} fehlgeschlagen (Exit ${code}):\n${err.trim() || out.trim()}`);
  return out;
}

async function waitReady(n: RunningNode): Promise<void> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (n.proc.exitCode !== null) {
      throw new Error(`${n.env.id}: Prozess beendet (Exit ${n.proc.exitCode}). Log:\n${tail(n.logFile)}`);
    }
    try {
      const res = await fetch(`${n.env.url}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok && ((await res.json()) as { status?: string }).status === 'ok') return;
    } catch {
      // noch nicht bereit
    }
    await Bun.sleep(100);
  }
  throw new Error(`${n.env.id}: nicht bereit nach 30 s. Log:\n${tail(n.logFile)}`);
}

// ---------------------------------------------------------------------------------------------
// Vorbedingungen
// ---------------------------------------------------------------------------------------------

/** Chromium für playwright-core vorhanden? (einmalig: bun x playwright-core install chromium) */
async function checkChromium(): Promise<void> {
  const { chromium } = await import('playwright-core');
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
  } catch (err) {
    throw new Error(
      `Chromium für Playwright fehlt oder startet nicht. Einmalig installieren:\n  bun x playwright-core install chromium\n(${(err as Error).message.split('\n')[0]})`,
    );
  }
}

async function buildUi(outDir: string): Promise<void> {
  await run(
    [process.execPath, 'x', 'vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'],
    {
      what: 'Oberfläche bauen (vite build)',
      env: { ...baseEnv(), NODE_ENV: 'production' },
    },
  );
  if (!existsSync(join(outDir, 'index.html'))) throw new Error(`vite build: ${outDir}/index.html fehlt`);
}

// ---------------------------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------------------------

export async function startEnvironment(): Promise<Environment> {
  const t0 = Date.now();
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  await cleanupLeftovers();
  rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const busy: number[] = [];
  for (const p of [PG_PORT, ...Object.values(NODE_SPECS).map((s) => s.port)])
    if (!(await portFree(p))) busy.push(p);
  if (busy.length) {
    throw new Error(
      `Port(s) ${busy.join(', ')} belegt. Die E2E-Tests brauchen 127.0.0.1:${PG_PORT} (PostgreSQL, MESH_E2E_PG_PORT) und 4451–4452 (Knoten).`,
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'osp-e2e-'));
  // tests/helpers/db.ts: Cluster "test" unter MESH_LOCAL_DIR auf MESH_TEST_PG_PORT
  process.env.MESH_LOCAL_DIR = tmpDir;
  process.env.MESH_TEST_PG_PORT = String(PG_PORT);
  const pgDataDir = join(clusterDir('test'), 'data');
  const state: State = { runnerPid: process.pid, tmpDir, pgDataDir, pids: [] };
  writeState(state);
  const running: RunningNode[] = [];
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await Promise.all(running.map((n) => stopProcess(n.proc)));
    stopCluster(pgDataDir);
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(STATE_FILE, { force: true });
  };
  const saveLogs = () => {
    for (const n of running)
      if (existsSync(n.logFile)) cpSync(n.logFile, join(ARTIFACTS_DIR, `${n.env.id}.log`));
  };

  try {
    // Oberfläche (einmal, in das temporäre Verzeichnis), Chromium-Prüfung und Datenbanken parallel
    const uiDir = join(tmpDir, 'ui');
    const docsDir = join(tmpDir, 'docs');
    mkdirSync(docsDir);
    const uiReady = buildUi(uiDir);
    const chromiumReady = checkChromium();

    // dynamisch: db.ts liest MESH_TEST_PG_PORT beim Laden
    const { createTestDb } = await import('../../helpers/db.ts');
    const dbs = await Promise.all(
      (Object.keys(NODE_SPECS) as NodeKey[]).map(async (key) => {
        const db = await createTestDb(`e2e_${key}`);
        await db.db.destroy();
        return { key, db };
      }),
    );
    log(
      `PostgreSQL-Cluster 127.0.0.1:${PG_PORT}, ${dbs.length} Datenbanken migriert (${secs(Date.now() - t0)})`,
    );

    const nodeEnvs = new Map<NodeKey, { env: NodeEnv; serverEnv: Record<string, string> }>();
    for (const { key, db } of dbs) {
      const spec = NODE_SPECS[key];
      const dir = join(tmpDir, spec.id);
      mkdirSync(join(dir, 'backups'), { recursive: true, mode: 0o700 });
      const url = `http://127.0.0.1:${spec.port}`;
      const serverEnv = baseEnv({
        MESH_NODE_ID: spec.id,
        MESH_NODE_NAME: spec.name,
        MESH_PUBLIC_URL: url,
        MESH_HOST: '127.0.0.1',
        MESH_PORT: String(spec.port),
        MESH_DB_URL: db.urls.app,
        MESH_DB_POOL_MAX: '5',
        MESH_MASTER_KEY: randomBytes(32).toString('base64'),
        MESH_BACKUP_KEY: randomBytes(32).toString('base64'),
        MESH_BACKUP_DIR: join(dir, 'backups'),
        MESH_BACKUP_INTERVAL_HOURS: '0',
        MESH_COOKIE_SECURE: 'false',
        MESH_FEDERATION_ALLOW_HTTP: 'true',
        MESH_TRUST_PROXY: 'false',
        MESH_LOG_LEVEL: 'info',
        MESH_UI_DIR: uiDir,
        MESH_DOCS_DIR: docsDir,
        MESH_WORKERS: 'true',
      });
      const users: NodeEnv['users'] = { admin: `admin@${spec.id}.example` };
      for (const u of USERS[key]) users[u] = `${u}@${spec.id}.example`;
      nodeEnvs.set(key, { env: { id: spec.id, name: spec.name, url, port: spec.port, users }, serverEnv });
    }

    // Administration über die Betriebs-CLI
    await Promise.all(
      [...nodeEnvs.values()].map(({ env, serverEnv }) =>
        run(
          [
            process.execPath,
            join(ROOT, 'src/server/cli/main.ts'),
            'create-admin',
            '--email',
            env.users.admin!,
            '--name',
            'E2E-Administration',
          ],
          { what: `${env.id}: create-admin`, env: { ...serverEnv, MESH_ADMIN_PASSWORD: E2E_PASSWORD } },
        ),
      ),
    );

    await uiReady;
    for (const [key, { env, serverEnv }] of nodeEnvs) {
      const logFile = join(tmpDir, `${env.id}.log`);
      const fd = openSync(logFile, 'a', 0o600);
      try {
        const proc = Bun.spawn([process.execPath, SERVER_MAIN, serverMarker(tmpDir)], {
          cwd: join(tmpDir, env.id),
          env: serverEnv,
          stdin: 'ignore',
          stdout: fd,
          stderr: fd,
        });
        running.push({ key, env, proc, logFile });
        state.pids.push(proc.pid);
        writeState(state);
      } finally {
        closeSync(fd);
      }
    }
    await Promise.all(running.map(waitReady));
    await chromiumReady;
    log(
      `Oberfläche gebaut, Knoten bereit: ${running.map((n) => n.env.url).join(', ')} (${secs(Date.now() - t0)})`,
    );

    const nodes = Object.fromEntries([...nodeEnvs].map(([k, v]) => [k, v.env])) as Record<NodeKey, NodeEnv>;
    const seed = await seedData(nodes);
    log(
      `Personen, Vertrauen, Stammdaten, Produkt und Freigaben über die API angelegt (${secs(Date.now() - t0)})`,
    );

    const env: E2eEnv = { password: E2E_PASSWORD, artifactsDir: ARTIFACTS_DIR, nodes, seed };
    const envFile = join(tmpDir, 'env.json');
    writeFileSync(envFile, JSON.stringify(env, null, 2), { mode: 0o600 });
    const recordTestProcess = (pid: number) => {
      state.testPids = [...(state.testPids ?? []), pid];
      writeState(state);
    };
    return { env, envFile, saveLogs, recordTestProcess, stop };
  } catch (err) {
    saveLogs();
    await stop();
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Daten über die API
// ---------------------------------------------------------------------------------------------

type Peer = { id: string; status: string; fingerprint: string };
type Paged<T> = { items: T[]; total: number };

async function seedData(nodes: Record<NodeKey, NodeEnv>): Promise<E2eEnv['seed']> {
  const clients = new Map<string, ApiClient>();
  const as = (key: NodeKey, user: UserKey) => clients.get(`${key}/${user}`)!;

  // Personen: Administration legt an, erste Anmeldung erzwingt den Passwortwechsel (über die API)
  await Promise.all(
    (Object.keys(nodes) as NodeKey[]).map(async (key) => {
      const n = nodes[key];
      const admin = new ApiClient(n.url, `${n.id}/admin`);
      await admin.login(n.users.admin!, E2E_PASSWORD);
      clients.set(`${key}/admin`, admin);
      for (const u of USERS[key]) {
        await admin.ok('POST', '/api/v1/users', {
          body: {
            email: n.users[u],
            displayName: `E2E ${u}`,
            roles: [ROLE_OF[u]],
            password: INITIAL_PASSWORD,
            locale: 'de',
          },
        });
        const c = new ApiClient(n.url, `${n.id}/${u}`);
        const me = await c.login(n.users[u]!, INITIAL_PASSWORD);
        if (!me.mustChangePassword) throw new Error(`${n.id}/${u}: Passwortwechsel nicht erzwungen`);
        await c.ok('POST', '/api/v1/auth/password', {
          body: { currentPassword: INITIAL_PASSWORD, newPassword: E2E_PASSWORD },
        });
        clients.set(`${key}/${u}`, c);
      }
    }),
  );

  // Vertrauen osp-nord ↔ osp-mitte (Knotenkarte + Fingerprint aus dem Systemstatus der Gegenseite)
  const peerIds = new Map<string, string>();
  for (const [a, b] of [
    ['nord', 'mitte'],
    ['mitte', 'nord'],
  ] as [NodeKey, NodeKey][]) {
    const card = await as(b, 'admin').ok('GET', '/api/v1/node/card');
    const peer = await as(a, 'admin').ok<Peer>('POST', '/api/v1/peers', { body: { card } });
    const status = await as(b, 'admin').ok<{ node: { fingerprint: string } }>('GET', '/api/v1/system/status');
    const trusted = await as(a, 'admin').ok<Peer>('POST', `/api/v1/peers/${peer.id}/trust`, {
      body: { fingerprint: status.node.fingerprint },
    });
    if (trusted.status !== 'trusted') throw new Error(`${a} → ${b}: Partner nicht vertrauenswürdig`);
    peerIds.set(`${a}->${b}`, peer.id);
  }
  const ping = await as('mitte', 'admin').ok<{ ok: boolean; errorCode: string | null }>(
    'POST',
    `/api/v1/peers/${peerIds.get('mitte->nord')}/ping`,
  );
  if (!ping.ok) throw new Error(`Ping osp-mitte → osp-nord fehlgeschlagen (${ping.errorCode})`);

  // Stammdaten osp-nord aus fixtures/osp-nord/athleten.csv (Vorlage, Vorschau, Übernahme)
  const st = as('nord', 'steward');
  const templates = await st.ok<{ items: { id: string; definition: unknown }[] }>(
    'GET',
    '/api/v1/connector-templates',
  );
  const tpl = templates.items.find((t) => t.id === 'athleten-stammdaten-csv');
  if (!tpl) throw new Error('Vorlage athleten-stammdaten-csv fehlt');
  const connector = await st.ok<{ id: string }>('POST', '/api/v1/connectors/import', {
    body: { definition: tpl.definition, createDataset: true },
  });
  const run = await st.ok<{ run: { id: string; validRows: number } }>(
    'POST',
    `/api/v1/connectors/${connector.id}/runs`,
    {
      form: fixtureForm('osp-nord/athleten.csv'),
    },
  );
  const committed = await st.ok<{ status: string; insertedRows: number }>(
    'POST',
    `/api/v1/import-runs/${run.run.id}/commit`,
  );
  if (committed.status !== 'committed' || committed.insertedRows !== run.run.validRows) {
    throw new Error(`Stammdaten-Import: ${JSON.stringify(committed)}`);
  }
  const nordAthletes = (await st.ok<Paged<unknown>>('GET', '/api/v1/athletes?pageSize=1')).total;

  // Datenprodukt und Freigaben
  const col = (key: string, label: string) => ({ key, source: `athlete.${key}`, label });
  const kaderProductName = 'Kaderübersicht';
  const product = await st.ok<{ id: string }>('POST', '/api/v1/products', {
    body: {
      slug: 'kader_uebersicht',
      name: kaderProductName,
      description: 'Athletinnen und Athleten mit Sportart, Kaderstatus und Jahrgang.',
      sourceType: 'athletes',
      datasetId: null,
      columns: [
        col('last_name', 'Nachname'),
        col('first_name', 'Vorname'),
        col('sport', 'Sportart'),
        col('squad_status', 'Kaderstatus'),
        col('birth_year', 'Geburtsjahr'),
        col('club', 'Verein'),
      ],
      shareability: 'on_request',
    },
  });
  const analystColumns = ['last_name', 'first_name', 'sport', 'squad_status'];
  const analyst = await st.ok<{ id: string }>('POST', '/api/v1/releases', {
    body: {
      productId: product.id,
      recipient: { type: 'role', role: 'analyst' },
      purposes: [STEERING],
      columns: analystColumns,
      requiresConsent: false,
      legalBasis: 'E2E: Trainingssteuerung',
    },
  });
  const partnerColumns = ['sport', 'squad_status', 'birth_year'];
  const partner = await st.ok<{ id: string }>('POST', '/api/v1/releases', {
    body: {
      productId: product.id,
      recipient: { type: 'peer', peerId: peerIds.get('nord->mitte') },
      purposes: [STEERING],
      columns: partnerColumns,
      validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      requiresConsent: false,
      legalBasis: 'E2E: Kooperationsvereinbarung osp-nord/osp-mitte',
    },
  });

  return {
    kaderProductId: product.id,
    kaderProductName,
    analystReleaseId: analyst.id,
    analystColumns,
    partnerReleaseId: partner.id,
    partnerColumns,
    nordAthletes,
  };
}
