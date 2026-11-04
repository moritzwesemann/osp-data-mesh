/**
 * End-to-End-Demo und Abnahmenachweis (AK1, AK2) von OSP-Data-Mesh: echte Prozesse, echte PostgreSQL-Cluster,
 * echtes HTTP zwischen den Knoten.
 *
 *   bun run demo                      Demo von leerem Stand, danach alles stoppen
 *   bun run demo -- --keep-running    Knoten weiterlaufen lassen (stoppen mit `bun run demo:stop`)
 *
 * Drei Knoten osp-nord/-mitte/-sued (Ports 4401–4403) mit je eigenem Cluster (55431–55433) unter .local/demo
 * und ein Mock-Messsystem (4410). Die Demo spricht mit den Knoten ausschließlich wie ein echter Client:
 * HTTP-API (Anmeldung, Sitzungs-Cookie, X-OSP-CSRF; API-Token für Werkzeuge), Betriebs-CLI (db-bootstrap,
 * gen-key, migrate, create-admin, verify-audit) und – als Nachweis des BI-Zugangs – eine direkte
 * Datenbankverbindung als Rolle mesh_bi. Sie schreibt nie direkt in die Datenbanken der Knoten.
 * Jede Abweichung bricht mit klarer Meldung und Exit-Code 1 ab. Nur synthetische Daten (fixtures/).
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { Subprocess } from 'bun';
import pg from 'pg';
import type { z } from 'zod';
import type {
  AccessGrant,
  AuditEntry,
  AuditVerify,
  BackupRun,
  Connector,
  ConnectorDefinition,
  Consent,
  DataResult,
  Dataset,
  DiscoveryResult,
  ExchangeLogEntry,
  ImportRun,
  ImportRunDetail,
  NodeCard,
  Peer,
  Product,
  ReceivedProduct,
  Release,
  SessionUser,
  User,
} from '../src/shared/contract/index.ts';
import {
  busyDemoPorts,
  DEMO_DIR,
  DEMO_PORTS,
  demoStillRunning,
  ROOT,
  stopDemo,
  writePidRecord,
} from './demo-stop.ts';
import { type DbCredentials, dbUrls, ensureCluster, newCredentials, PG_BIN, pgTool } from './pg-local.ts';

// ---------------------------------------------------------------------------------------------
// Konstanten
// ---------------------------------------------------------------------------------------------

const KEEP_RUNNING = process.argv.slice(2).includes('--keep-running');

/** Passwort aller Demo-Konten nach dem (erzwungenen) Passwortwechsel */
const DEMO_PASSWORD = 'OSP-Demo-2026!';
/** Initialpasswort, das die Administration vergibt (muss bei der ersten Anmeldung geändert werden) */
const INITIAL_PASSWORD = 'Erstpasswort-2026!';
const MOCK_PORT = 4410;
const MOCK_TOKEN = 'demo-messsystem-token';

const STEERING = 'training_steering';
const REPORTING = 'reporting';
const MEDICAL = 'medical_care';

/** Erwartete Bestände (fixtures/README.md, tests/integration/connectors.test.ts) */
const EXPECT = {
  nordAthletes: 40,
  ld: 78,
  injuries: 25,
  jumps: 120,
  mitteAthletes: 25,
  suedAthletes: 20,
} as const;

/** Personen mit Verletzungseinträgen, die einer medizinischen Weitergabe zugestimmt haben */
const MEDICAL_CONSENTS = ['NORD-0007', 'NORD-0016', 'NORD-0025', 'NORD-0029', 'NORD-0030', 'NORD-0040'];
/** Deren Verletzungseinträge in fixtures/osp-nord/verletzungen.csv (1 + 1 + 2 + 2 + 2 + 2) */
const EXPECTED_MEDICAL_ROWS = 10;
/** Person, deren Einwilligung später widerrufen wird */
const WITHDRAWING = 'NORD-0030';

/** Zeilenbeschränkung der Partnerfreigabe an osp-mitte */
const EXCHANGE_SPORT = 'Radsport';

const KADER_BI = ['sport', 'squad_status', 'birth_year', 'sex'];
const KADER_ANALYST = ['last_name', 'first_name', 'sport', 'squad_status'];
const SPRUNG_BI = ['sport', 'squad_status', 'test_type', 'jump_height_cm', 'peak_power_w', 'measured_at'];
const SPRUNG_MITTE = ['sport', 'test_type', 'jump_height_cm', 'peak_power_w', 'measured_at'];
const LD_BI = [
  'sport',
  'squad_status',
  'test_date',
  'protocol',
  'vo2max',
  'lactate_threshold_power',
  'max_heart_rate',
];
const MED_COLUMNS = [
  'last_name',
  'first_name',
  'injury_date',
  'body_region',
  'injury_type',
  'days_absent',
  'status',
];

/** Vertrag der Superset-Dashboards (deploy/superset/README.md): View → Spalte, PostgreSQL-Typ */
const BI_CONTRACT: Record<string, { rows: number; columns: [string, string][] }> = {
  kader_uebersicht: {
    rows: EXPECT.nordAthletes,
    columns: [
      ['sport', 'text'],
      ['squad_status', 'text'],
      ['birth_year', 'bigint'],
      ['sex', 'text'],
    ],
  },
  leistungsdiagnostik: {
    rows: EXPECT.ld,
    columns: [
      ['sport', 'text'],
      ['squad_status', 'text'],
      ['test_date', 'date'],
      ['protocol', 'text'],
      ['vo2max', 'double precision'],
      ['lactate_threshold_power', 'double precision'],
      ['max_heart_rate', 'bigint'],
    ],
  },
  sprungkraft: {
    rows: EXPECT.jumps,
    columns: [
      ['sport', 'text'],
      ['squad_status', 'text'],
      ['test_type', 'text'],
      ['jump_height_cm', 'double precision'],
      ['peak_power_w', 'double precision'],
      ['measured_at', 'timestamp with time zone'],
    ],
  },
};

interface NodeSpec {
  id: 'osp-nord' | 'osp-mitte' | 'osp-sued';
  name: string;
  port: number;
  pgPort: number;
  url: string;
}

const NODE_SPECS: NodeSpec[] = [
  { id: 'osp-nord', name: 'Demo-OSP Nord', port: 4401, pgPort: 55431, url: 'http://127.0.0.1:4401' },
  { id: 'osp-mitte', name: 'Demo-OSP Mitte', port: 4402, pgPort: 55432, url: 'http://127.0.0.1:4402' },
  { id: 'osp-sued', name: 'Demo-OSP Süd', port: 4403, pgPort: 55433, url: 'http://127.0.0.1:4403' },
];

const ROLE_USERS = [
  { key: 'steward', role: 'data_steward', name: 'Demo-Datenverantwortung' },
  { key: 'analyst', role: 'analyst', name: 'Demo-Analyse' },
  { key: 'coach', role: 'coach', name: 'Demo-Trainerin' },
  { key: 'auditor', role: 'auditor', name: 'Demo-Revision' },
] as const;
type UserKey = 'admin' | (typeof ROLE_USERS)[number]['key'];
const USER_KEYS: UserKey[] = ['admin', ...ROLE_USERS.map((u) => u.key)];

function emailOf(node: NodeSpec, key: UserKey): string {
  return `${key}@${node.id}.example`;
}

// ---------------------------------------------------------------------------------------------
// Ausgabe und Prüfungen
// ---------------------------------------------------------------------------------------------

const tty = process.stdout.isTTY === true;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const bold = paint(1);
const dim = paint(2);

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

class CheckFailed extends Error {}

/** Abbruch vor dem Start (z. B. belegte Ports): nichts aufräumen, was nicht von diesem Lauf stammt */
class PreflightError extends Error {}

function ensure(cond: unknown, message: string): asserts cond {
  if (!cond) throw new CheckFailed(message);
}

function ensureEqual(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new CheckFailed(`${what}: erwartet ${e}, erhalten ${a}`);
}

interface StepResult {
  title: string;
  checks: number;
  ms: number;
  ok: boolean;
  error?: string;
}

const results: StepResult[] = [];
let current: StepResult | null = null;
const STEP_COUNT = 14;

function pass(label: string): void {
  if (current) current.checks++;
  say(`  ${green('✓')} ${label}`);
}

function info(label: string): void {
  say(`    ${dim(label)}`);
}

async function step(title: string, fn: () => Promise<void>): Promise<void> {
  const r: StepResult = { title, checks: 0, ms: 0, ok: false };
  results.push(r);
  current = r;
  say('');
  say(bold(`[${results.length}/${STEP_COUNT}] ${title}`));
  const t0 = performance.now();
  try {
    await fn();
    r.ok = true;
  } catch (err) {
    r.error = (err as Error).message;
    say(`  ${red('✗')} ${r.error.split('\n').join('\n    ')}`);
    throw err;
  } finally {
    r.ms = performance.now() - t0;
    current = null;
  }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function eventually<T>(what: string, timeoutMs: number, probe: () => Promise<T | null>): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < until) {
    try {
      const v = await probe();
      if (v !== null) return v;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(250);
  }
  throw new CheckFailed(
    `${what}: nicht erreicht nach ${secs(timeoutMs)}${last ? ` (${(last as Error).message})` : ''}`,
  );
}

// ---------------------------------------------------------------------------------------------
// HTTP-Client (wie ein echter Client: Cookie-Sitzung + CSRF-Header oder API-Token)
// ---------------------------------------------------------------------------------------------

interface HttpResult<T> {
  status: number;
  json: T;
  text: string;
  bytes: Uint8Array;
  headers: Headers;
}

type ApiError = { error?: { code?: string; reason?: string; fields?: Record<string, string> } };

class Client {
  private cookie: string | null = null;

  constructor(
    readonly node: NodeSpec,
    readonly label: string,
    private readonly token: string | null = null,
  ) {}

  async call<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; form?: FormData } = {},
  ): Promise<HttpResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    else {
      if (this.cookie) headers.cookie = `osp_session=${this.cookie}`;
      if (method !== 'GET') headers['x-osp-csrf'] = '1';
    }
    let body: FormData | string | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${this.node.url}${path}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(120_000),
    });
    for (const c of res.headers.getSetCookie()) {
      const m = /^osp_session=([^;]*)/.exec(c);
      if (m) this.cookie = m[1] ? m[1] : null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // BOM nicht entfernen (CSV-Prüfung)
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    let json: unknown = null;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json: json as T, text, bytes, headers: res.headers };
  }

  /** Erwartet HTTP 200 und liefert den JSON-Body */
  async ok<T>(method: string, path: string, opts: { body?: unknown; form?: FormData } = {}): Promise<T> {
    const r = await this.call<T>(method, path, opts);
    if (r.status !== 200) {
      throw new CheckFailed(
        `${this.label}@${this.node.id}: ${method} ${path} → HTTP ${r.status} ${r.text.slice(0, 400)}`,
      );
    }
    return r.json;
  }

  async login(password: string): Promise<SessionUser> {
    const email = emailOf(this.node, this.label as UserKey);
    const r = await this.ok<{ user: SessionUser }>('POST', '/api/v1/auth/login', {
      body: { email, password },
    });
    return r.user;
  }
}

function ensureError(
  r: HttpResult<unknown>,
  status: number,
  code: string,
  reason: string | null,
  what: string,
) {
  const e = (r.json as ApiError | null)?.error;
  ensure(
    r.status === status && e?.code === code && (reason === null || e?.reason === reason),
    `${what}: erwartet HTTP ${status} ${code}${reason ? `/${reason}` : ''}, erhalten HTTP ${r.status} ${r.text.slice(0, 300)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Knoten, Prozesse, CLI
// ---------------------------------------------------------------------------------------------

interface NodeRt {
  spec: NodeSpec;
  dir: string;
  envFile: string;
  ownerEnvFile: string;
  log: string;
  creds: DbCredentials | null;
  urls: { owner: string; app: string; bi: string } | null;
  proc: Subprocess | null;
  users: Record<UserKey, Client>;
  /** nodeId des Partners → Partner-ID auf diesem Knoten */
  peerIds: Map<string, string>;
  fingerprint: string;
}

const nodes: NodeRt[] = NODE_SPECS.map((spec) => {
  const dir = join(DEMO_DIR, spec.id);
  return {
    spec,
    dir,
    envFile: join(dir, 'node.env'),
    ownerEnvFile: join(dir, 'owner.env'),
    log: join(dir, 'server.log'),
    creds: null,
    urls: null,
    proc: null,
    users: Object.fromEntries(USER_KEYS.map((k) => [k, new Client(spec, k)])) as Record<UserKey, Client>,
    peerIds: new Map(),
    fingerprint: '',
  };
});
const [nord, mitte, sued] = nodes as [NodeRt, NodeRt, NodeRt];
let mockProc: Subprocess | null = null;
const MOCK_LOG = join(DEMO_DIR, 'mock-api.log');
/** Hat dieser Lauf schon etwas gestartet/aufgeräumt? (sonst beim Abbruch nichts anfassen) */
let startedAnything = false;

/** Minimale Umgebung für Kindprozesse (keine Geheimnisse der aufrufenden Shell weiterreichen) */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return { ...env, ...extra };
}

function writeEnvFile(path: string, values: Record<string, string>): void {
  const lines = Object.entries(values).map(([k, v]) => {
    if (/[\r\n"$\\]/.test(v)) throw new Error(`unsupported character in ${k}`);
    return /\s/.test(v) ? `${k}="${v}"` : `${k}=${v}`;
  });
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
}

function tail(file: string, lines = 15): string {
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
}

/** Betriebs-CLI des Knotens (wie in docs/installation.md: bun --env-file=… run cli …) */
function cli(n: NodeRt, args: string[], envFiles: string[], extra: Record<string, string> = {}): string {
  const proc = Bun.spawnSync(
    [
      process.execPath,
      ...envFiles.map((f) => `--env-file=${f}`),
      join(ROOT, 'src/server/cli/main.ts'),
      ...args,
    ],
    { cwd: n.dir, env: baseEnv(extra), stdout: 'pipe', stderr: 'pipe' },
  );
  const out = proc.stdout.toString();
  if (proc.exitCode !== 0) {
    throw new CheckFailed(
      `${n.spec.id}: CLI "${args[0]}" fehlgeschlagen (Exit ${proc.exitCode}): ${proc.stderr.toString().trim() || out.trim()}`,
    );
  }
  return out;
}

function spawnDetached(opts: {
  name: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  log: string;
  marker: string;
  port: number;
}): Subprocess {
  const fd = openSync(opts.log, 'a', 0o600);
  try {
    // eigene Sitzung: überlebt das Demo-Skript bei --keep-running, bekommt kein Strg+C des Terminals
    const proc = Bun.spawn(opts.cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
      detached: true,
    });
    proc.unref();
    writePidRecord({ name: opts.name, pid: proc.pid, marker: opts.marker, port: opts.port });
    return proc;
  } finally {
    closeSync(fd);
  }
}

async function waitReady(
  what: string,
  url: string,
  proc: Subprocess,
  log: string,
  check: (j: unknown) => boolean,
) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (proc.exitCode !== null) {
      throw new CheckFailed(`${what}: Prozess beendet (Exit ${proc.exitCode}). Log ${log}:\n${tail(log)}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok && check(await res.json())) return;
    } catch {
      // noch nicht bereit
    }
    await Bun.sleep(200);
  }
  throw new CheckFailed(`${what}: nicht bereit nach 60 s. Log ${log}:\n${tail(log)}`);
}

// ---------------------------------------------------------------------------------------------
// Geteilter Zustand der Szenario-Schritte
// ---------------------------------------------------------------------------------------------

type RunDetail = z.infer<typeof ImportRunDetail>;
type Discovery = z.infer<typeof DiscoveryResult>;
type Verify = z.infer<typeof AuditVerify>;
type TemplateItem = { id: string; name: string; definition: ConnectorDefinition };
type Paged<T> = { items: T[]; total: number };
type ReceivedRows = { columns: { key: string }[]; rows: Record<string, unknown>[]; total: number };
type SystemStatus = {
  node: { nodeId: string; fingerprint: string };
  backups: { last: BackupRun | null; encrypted: boolean };
};

const S = {
  products: new Map<string, Product>(),
  consentIds: new Map<string, string>(),
  analystRelease: '',
  mitteRelease: '',
  mitteExpectedRows: 0,
  mitteReceivedId: '',
  medRelease: '',
  suedReceivedId: '',
  injuriesByAthlete: new Map<string, number>(),
};

function product(slug: string): Product {
  const p = S.products.get(slug);
  ensure(p, `Produkt ${slug} fehlt`);
  return p;
}

function peerId(on: NodeRt, other: NodeRt): string {
  const id = on.peerIds.get(other.spec.id);
  ensure(id, `${other.spec.id} ist auf ${on.spec.id} nicht als Partner aufgenommen`);
  return id;
}

async function auditFind(
  client: Client,
  action: string,
  filter: { outcome?: string; objectId?: string } = {},
): Promise<AuditEntry[]> {
  const q = new URLSearchParams({ action, pageSize: '200' });
  if (filter.outcome) q.set('outcome', filter.outcome);
  if (filter.objectId) q.set('objectId', filter.objectId);
  return (await client.ok<Paged<AuditEntry>>('GET', `/api/v1/audit?${q}`)).items;
}

async function exchangeLog(client: Client, direction: 'incoming' | 'outgoing'): Promise<ExchangeLogEntry[]> {
  return (
    await client.ok<Paged<ExchangeLogEntry>>(
      'GET',
      `/api/v1/exchange-log?direction=${direction}&pageSize=200`,
    )
  ).items;
}

async function athleteId(steward: Client, externalId: string): Promise<string> {
  const r = await steward.ok<Paged<{ id: string }>>('GET', `/api/v1/athletes?q=${externalId}`);
  ensure(r.total === 1 && r.items[0], `Person ${externalId}: ${r.total} Treffer statt 1`);
  return r.items[0].id;
}

function fixtureForm(rel: string): FormData {
  const bytes = new Uint8Array(readFileSync(join(ROOT, 'fixtures', rel)));
  const form = new FormData();
  form.append('file', new File([bytes], basename(rel), { type: 'text/csv' }));
  return form;
}

async function connectorFromTemplate(
  steward: Client,
  templates: TemplateItem[],
  id: string,
  adjust?: (d: ConnectorDefinition) => void,
): Promise<Connector> {
  const t = templates.find((x) => x.id === id);
  ensure(t, `Connector-Vorlage ${id} fehlt`);
  const definition = structuredClone(t.definition);
  adjust?.(definition);
  return steward.ok<Connector>('POST', '/api/v1/connectors/import', {
    body: { definition, createDataset: true },
  });
}

async function previewRun(steward: Client, connectorId: string, form?: FormData): Promise<RunDetail> {
  return steward.ok<RunDetail>('POST', `/api/v1/connectors/${connectorId}/runs`, form ? { form } : {});
}

function ensureRun(run: ImportRun, total: number, valid: number, errors: number, what: string): void {
  ensureEqual(
    { status: run.status, totalRows: run.totalRows, validRows: run.validRows, errorRows: run.errorRows },
    { status: 'previewed', totalRows: total, validRows: valid, errorRows: errors },
    `${what} (Vorschau)`,
  );
}

async function commit(steward: Client, runId: string, inserted: number, what: string): Promise<ImportRun> {
  const run = await steward.ok<ImportRun>('POST', `/api/v1/import-runs/${runId}/commit`);
  ensureEqual(
    { status: run.status, insertedRows: run.insertedRows },
    { status: 'committed', insertedRows: inserted },
    `${what} (Übernahme)`,
  );
  return run;
}

const summaryOf = (d: RunDetail) =>
  d.errorSummary
    .map((e) => `${e.code}:${e.field}`)
    .sort()
    .join(', ');

function injuriesByAthlete(): Map<string, number> {
  const lines = readFileSync(join(ROOT, 'fixtures/osp-nord/verletzungen.csv'), 'utf8')
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .slice(1);
  const m = new Map<string, number>();
  for (const l of lines) {
    const id = l.split(';')[0]?.trim() ?? '';
    m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// 1. Vorbereitung
// ---------------------------------------------------------------------------------------------

function listenerOf(port: number): string {
  let out = '';
  try {
    // nur zur Erklärung (lsof fehlt evtl. auf schlanken Linux-Systemen)
    out = Bun.spawnSync(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      stdout: 'pipe',
      stderr: 'ignore',
    }).stdout.toString();
  } catch {
    return '';
  }
  const line = out.trim().split('\n')[1];
  if (!line) return '';
  const [command, pid] = line.split(/\s+/);
  return command && pid ? ` – ${command} (PID ${pid})` : '';
}

async function preflight(): Promise<void> {
  const busy = await busyDemoPorts();
  if (busy.length > 0) {
    const ours = demoStillRunning();
    const lines = busy.map((p) => `  ${p.port} ${p.label}${listenerOf(p.port)}`);
    throw new PreflightError(
      [
        'Benötigte Ports sind belegt:',
        ...lines,
        ours
          ? 'Eine frühere Demo läuft noch (z. B. mit --keep-running gestartet). Beenden mit: bun run demo:stop'
          : 'Bitte die Prozesse beenden (falls es eine frühere Demo ist: bun run demo:stop) und erneut starten.',
      ].join('\n'),
    );
  }
  pass(`Ports frei: ${DEMO_PORTS.map((p) => p.port).join(', ')}`);

  if (!PG_BIN || !existsSync(pgTool('initdb'))) {
    throw new PreflightError(
      'PostgreSQL-18-Programme (initdb, pg_ctl, psql, pg_dump) nicht gefunden. Installation: brew install postgresql@18 (oder MESH_PG_BIN setzen).',
    );
  }
  const ver = Bun.spawnSync([pgTool('pg_ctl'), '--version'], { stdout: 'pipe' })
    .stdout.toString()
    .trim();
  if (!/\(PostgreSQL\) 18\./.test(ver))
    throw new PreflightError(`PostgreSQL 18 erforderlich, gefunden: ${ver}`);
  pass(`${ver} (${PG_BIN})`);

  const built = () =>
    existsSync(join(ROOT, 'dist/ui/index.html')) && existsSync(join(ROOT, 'dist/docs/index.html'));
  if (!built()) {
    info('dist/ui oder dist/docs fehlt – bun run build …');
    const b = Bun.spawnSync([process.execPath, 'run', 'build'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (b.exitCode !== 0 || !built()) {
      throw new PreflightError(`bun run build fehlgeschlagen:\n${b.stderr.toString().slice(-2000)}`);
    }
    pass('Web-Oberfläche und Hilfe gebaut (bun run build)');
  } else pass('Web-Oberfläche und Hilfe vorhanden (dist/ui, dist/docs)');

  // Ab hier gehört alles unter .local/demo diesem Lauf: eigene Reste stoppen, Verzeichnis leeren
  startedAnything = true;
  const leftovers = await stopDemo();
  rmSync(DEMO_DIR, { recursive: true, force: true });
  mkdirSync(DEMO_DIR, { recursive: true, mode: 0o700 });
  pass(
    `.local/demo geleert${leftovers.length ? ` (Reste gestoppt: ${leftovers.join(', ')})` : ''}; übriges .local unberührt`,
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Knoten aufsetzen
// ---------------------------------------------------------------------------------------------

function setupNode(n: NodeRt): void {
  mkdirSync(join(n.dir, 'backups'), { recursive: true, mode: 0o700 });
  const cluster = ensureCluster(n.spec.id, n.spec.pgPort);
  const creds = newCredentials('mesh');
  const urls = dbUrls(cluster, creds);
  n.creds = creds;
  n.urls = urls;
  // Owner-Zugang nur für Kommandozeilenaufrufe (docs/installation.md, A3)
  writeEnvFile(n.ownerEnvFile, {
    MESH_DB_OWNER_URL: urls.owner,
    MESH_DB_OWNER_PASSWORD: creds.ownerPassword,
    MESH_DB_APP_PASSWORD: creds.appPassword,
    MESH_DB_BI_PASSWORD: creds.biPassword,
    MESH_DB_BI_URL: urls.bi,
  });
  const boot = cli(n, ['db-bootstrap', '--superuser-url', cluster.superuserUrl], [n.ownerEnvFile]);
  ensure(boot.includes('mesh_owner, mesh_app, mesh_bi'), `${n.spec.id}: db-bootstrap ohne Erfolgsmeldung`);

  const masterKey = cli(n, ['gen-key'], []).trim();
  const backupKey = cli(n, ['gen-key'], []).trim();
  for (const k of [masterKey, backupKey]) {
    ensure(Buffer.from(k, 'base64').length === 32, `${n.spec.id}: gen-key lieferte keinen 32-Byte-Schlüssel`);
  }
  writeEnvFile(n.envFile, {
    MESH_NODE_ID: n.spec.id,
    MESH_NODE_NAME: n.spec.name,
    MESH_PUBLIC_URL: n.spec.url,
    MESH_HOST: '127.0.0.1',
    MESH_PORT: String(n.spec.port),
    MESH_DB_URL: urls.app,
    MESH_DB_POOL_MAX: '8',
    MESH_MASTER_KEY: masterKey,
    MESH_BACKUP_KEY: backupKey,
    MESH_BACKUP_DIR: join(n.dir, 'backups'),
    MESH_PG_DUMP: pgTool('pg_dump'),
    MESH_COOKIE_SECURE: 'false',
    MESH_FEDERATION_ALLOW_HTTP: 'true',
    MESH_SOURCE_ALLOWED_HOSTS: `127.0.0.1:${MOCK_PORT}`,
    MESH_TRUST_PROXY: 'false',
    MESH_LOG_LEVEL: 'info',
    MESH_UI_DIR: join(ROOT, 'dist/ui'),
    MESH_DOCS_DIR: join(ROOT, 'dist/docs'),
    MESH_BI_DB_HOST: '127.0.0.1',
    MESH_BI_DB_PORT: String(n.spec.pgPort),
    MESH_BI_DB_NAME: creds.dbName,
    MESH_WORKERS: 'true',
  });
  const serverEnv = readFileSync(n.envFile, 'utf8');
  ensure(
    !serverEnv.includes(creds.ownerPassword) && !serverEnv.includes('mesh_owner'),
    `${n.spec.id}: Server-Konfiguration enthält den Owner-Zugang`,
  );

  const mig = cli(n, ['migrate'], [n.envFile, n.ownerEnvFile]);
  ensure(/angewandt \/ applied: 0001/.test(mig), `${n.spec.id}: migrate hat nichts angewandt:\n${mig}`);
  const admin = cli(
    n,
    ['create-admin', '--email', emailOf(n.spec, 'admin'), '--name', 'Demo-Administration'],
    [n.envFile],
    { MESH_ADMIN_PASSWORD: DEMO_PASSWORD },
  );
  ensure(admin.includes('Administrator angelegt'), `${n.spec.id}: create-admin ohne Erfolgsmeldung`);
  pass(
    `${n.spec.id}: Cluster 127.0.0.1:${n.spec.pgPort}, db-bootstrap, gen-key, migrate (als mesh_owner), create-admin`,
  );
}

function startNode(n: NodeRt): void {
  n.proc = spawnDetached({
    name: n.spec.id,
    // Server erhält nur node.env (Rolle mesh_app), nie den Owner-Zugang
    cmd: [process.execPath, `--env-file=${n.envFile}`, join(ROOT, 'src/server/main.ts')],
    cwd: n.dir,
    env: baseEnv(),
    log: n.log,
    marker: 'src/server/main.ts',
    port: n.spec.port,
  });
}

async function setupNodes(): Promise<void> {
  for (const n of nodes) setupNode(n);
  for (const n of nodes) startNode(n);
  mockProc = spawnDetached({
    name: 'mock-api',
    cmd: [process.execPath, join(ROOT, 'scripts/mock-measurement-api.ts')],
    cwd: DEMO_DIR,
    env: baseEnv({ MOCK_API_PORT: String(MOCK_PORT), MOCK_API_TOKEN: MOCK_TOKEN }),
    log: MOCK_LOG,
    marker: 'mock-measurement-api.ts',
    port: MOCK_PORT,
  });
  const ready = (j: unknown) => {
    const r = j as { status?: string; db?: boolean; schema?: boolean };
    return r.status === 'ok' && r.db === true && r.schema === true;
  };
  await Promise.all([
    ...nodes.map((n) => waitReady(n.spec.id, `${n.spec.url}/readyz`, n.proc!, n.log, ready)),
    waitReady(
      'Mock-Messsystem',
      `http://127.0.0.1:${MOCK_PORT}/v1/health`,
      mockProc,
      MOCK_LOG,
      (j) => (j as { status?: string }).status === 'ok',
    ),
  ]);
  pass(`Knoten bereit: ${nodes.map((n) => `${n.spec.url}/readyz`).join(', ')} → {"status":"ok"}`);
  pass(`Mock-Messsystem bereit: http://127.0.0.1:${MOCK_PORT}/v1/measurements`);

  for (const n of nodes) {
    const ui = await n.users.admin.call('GET', '/');
    const help = await n.users.admin.call('GET', '/hilfe/');
    ensure(
      ui.status === 200 && /<html/i.test(ui.text) && help.status === 200 && /<html/i.test(help.text),
      `${n.spec.id}: Oberfläche (/) oder Hilfe (/hilfe/) nicht ausgeliefert (HTTP ${ui.status}/${help.status})`,
    );
    const me = await n.users.admin.login(DEMO_PASSWORD);
    ensure(
      me.roles.includes('admin') && !me.mustChangePassword,
      `${n.spec.id}: Administration nicht anmeldbar`,
    );
  }
  pass('Oberfläche und /hilfe/ ausgeliefert; Administration (CLI) meldet sich an');
}

// ---------------------------------------------------------------------------------------------
// 3. Benutzer
// ---------------------------------------------------------------------------------------------

async function setupUsers(): Promise<void> {
  for (const n of nodes) {
    for (const u of ROLE_USERS) {
      const created = await n.users.admin.ok<User>('POST', '/api/v1/users', {
        body: {
          email: emailOf(n.spec, u.key),
          displayName: u.name,
          roles: [u.role],
          password: INITIAL_PASSWORD,
          locale: 'de',
        },
      });
      ensure(created.mustChangePassword, `${n.spec.id}/${u.key}: Passwortwechsel nicht erzwungen`);
      const c = n.users[u.key];
      const first = await c.login(INITIAL_PASSWORD);
      ensure(first.mustChangePassword, `${n.spec.id}/${u.key}: Anmeldung ohne Pflicht zum Passwortwechsel`);
      const blocked = await c.call('GET', '/api/v1/purposes');
      ensureError(blocked, 403, 'forbidden', 'password_change_required', `${n.spec.id}/${u.key} vor Wechsel`);
      await c.ok('POST', '/api/v1/auth/password', {
        body: { currentPassword: INITIAL_PASSWORD, newPassword: DEMO_PASSWORD },
      });
      const me = await c.ok<{ user: SessionUser }>('GET', '/api/v1/auth/me');
      ensure(
        !me.user.mustChangePassword && me.user.roles.includes(u.role),
        `${n.spec.id}/${u.key}: Passwortwechsel nicht wirksam`,
      );
    }
    pass(
      `${n.spec.id}: steward, analyst, coach, auditor angelegt; erste Anmeldung → 403 password_change_required → Passwort geändert`,
    );
  }
  const r = await nord.users.admin.call('GET', '/api/v1/athletes');
  ensureError(r, 403, 'forbidden', null, 'Administration auf Fachdaten');
  pass('Administration hat keinen Zugriff auf Fachdaten (403)');
}

// ---------------------------------------------------------------------------------------------
// 4. Vertrauen
// ---------------------------------------------------------------------------------------------

async function addPeer(a: NodeRt, b: NodeRt): Promise<Peer> {
  // Knotenkarte von b (würde per E-Mail übermittelt)
  const card = await b.users.admin.ok<NodeCard>('GET', '/api/v1/node/card');
  ensure(card.nodeId === b.spec.id && card.baseUrl === b.spec.url, `${b.spec.id}: Knotenkarte unerwartet`);
  const peer = await a.users.admin.ok<Peer>('POST', '/api/v1/peers', { body: { card } });
  ensure(peer.status === 'pending', `${a.spec.id}: neuer Partner ${b.spec.id} nicht "pending"`);
  a.peerIds.set(b.spec.id, peer.id);
  return peer;
}

async function trustPeer(a: NodeRt, b: NodeRt, peer: Peer): Promise<void> {
  // zweiter Kanal: Administration von b liest den Fingerprint aus ihrem Systemstatus vor
  const status = await b.users.admin.ok<SystemStatus>('GET', '/api/v1/system/status');
  b.fingerprint = status.node.fingerprint;
  ensure(
    status.node.fingerprint === peer.fingerprint,
    `${a.spec.id}: Fingerprint von ${b.spec.id} weicht ab`,
  );
  const trusted = await a.users.admin.ok<Peer>('POST', `/api/v1/peers/${peer.id}/trust`, {
    body: { fingerprint: status.node.fingerprint },
  });
  ensure(trusted.status === 'trusted', `${a.spec.id}: ${b.spec.id} nicht vertrauenswürdig`);
}

async function ping(a: NodeRt, b: NodeRt) {
  return a.users.admin.ok<{ ok: boolean; latencyMs: number | null; errorCode: string | null }>(
    'POST',
    `/api/v1/peers/${peerId(a, b)}/ping`,
  );
}

async function setupTrust(): Promise<void> {
  const pairs: [NodeRt, NodeRt][] = [
    [nord, mitte],
    [nord, sued],
    [mitte, sued],
  ];
  let first = true;
  for (const [a, b] of pairs) {
    const bOnA = await addPeer(a, b);
    if (first) {
      const wrong = await a.users.admin.call('POST', `/api/v1/peers/${bOnA.id}/trust`, {
        body: { fingerprint: '0000 1111 2222 3333 4444 5555 6666 7777' },
      });
      ensureError(wrong, 400, 'validation_failed', null, 'Vertrauen mit falschem Fingerprint');
    }
    await trustPeer(a, b, bOnA);
    if (first) {
      const one = await ping(a, b);
      ensure(!one.ok, `${a.spec.id} → ${b.spec.id}: Ping vor beidseitigem Vertrauen dürfte nicht gelingen`);
      pass(
        `${a.spec.id} ↔ ${b.spec.id}: falscher Fingerprint abgelehnt; Ping vor beidseitigem Vertrauen abgewiesen (${one.errorCode})`,
      );
    }
    const aOnB = await addPeer(b, a);
    await trustPeer(b, a, aOnB);
    const ab = await ping(a, b);
    const ba = await ping(b, a);
    ensure(
      ab.ok && ba.ok,
      `${a.spec.id} ↔ ${b.spec.id}: signierter Ping fehlgeschlagen (${ab.errorCode}/${ba.errorCode})`,
    );
    pass(
      `${a.spec.id} ↔ ${b.spec.id}: Knotenkarten getauscht, Fingerprint abgeglichen, trusted; signierter Ping beidseitig ok (${ab.latencyMs} / ${ba.latencyMs} ms)`,
    );
    first = false;
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Datenintegration
// ---------------------------------------------------------------------------------------------

async function integrateData(): Promise<void> {
  const st = nord.users.steward;
  const templates = (await st.ok<{ items: TemplateItem[] }>('GET', '/api/v1/connector-templates')).items;
  ensureEqual(
    templates.map((t) => t.id),
    ['athleten-stammdaten-csv', 'leistungsdiagnostik-csv', 'sprungkraft-api', 'verletzungen-csv'],
    'Connector-Vorlagen',
  );

  // CSV 1: Stammdaten
  const athletes = await connectorFromTemplate(st, templates, 'athleten-stammdaten-csv');
  const a = await previewRun(st, athletes.id, fixtureForm('osp-nord/athleten.csv'));
  ensureRun(a.run, 43, 40, 3, 'athleten.csv');
  const errs = await st.ok<Paged<{ rowNumber: number; code: string; rawValue: string | null }>>(
    'GET',
    `/api/v1/import-runs/${a.run.id}/errors?pageSize=100`,
  );
  ensureEqual(
    errs.items.map((e) => [e.rowNumber, e.code]),
    [
      [13, 'invalid_date'],
      [27, 'required'],
      [38, 'invalid_enum'],
    ],
    'Fehlerprotokoll athleten.csv',
  );
  await commit(st, a.run.id, 40, 'athleten.csv');
  pass(
    'osp-nord athleten.csv: 43 Zeilen → 40 gültig, 3 Fehler (Z. 13 invalid_date, 27 required, 38 invalid_enum) → 40 übernommen',
  );

  // CSV 2: Leistungsdiagnostik (Zuordnung über Name + Geburtsdatum)
  const ld = await connectorFromTemplate(st, templates, 'leistungsdiagnostik-csv');
  const l = await previewRun(st, ld.id, fixtureForm('osp-nord/leistungsdiagnostik.csv'));
  ensureRun(l.run, 80, 78, 2, 'leistungsdiagnostik.csv');
  ensureEqual(
    summaryOf(l),
    'future_date:data.test_date, out_of_range:data.vo2max',
    'Fehler leistungsdiagnostik.csv',
  );
  await commit(st, l.run.id, 78, 'leistungsdiagnostik.csv');
  pass(
    'osp-nord leistungsdiagnostik.csv: 80 → 78 gültig, 2 unplausibel (future_date, out_of_range) → 78 übernommen',
  );

  // CSV 3: Verletzungen (Gesundheitsdaten, Art. 9)
  const inj = await connectorFromTemplate(st, templates, 'verletzungen-csv');
  const injDs = await st.ok<Dataset>('GET', `/api/v1/datasets/${inj.targetDatasetId}`);
  ensure(
    injDs.category === 'health' && injDs.specialCategory,
    'Datensatz verletzungen nicht als Art. 9 markiert',
  );
  const v = await previewRun(st, inj.id, fixtureForm('osp-nord/verletzungen.csv'));
  ensureRun(v.run, 25, 25, 0, 'verletzungen.csv');
  await commit(st, v.run.id, 25, 'verletzungen.csv');
  pass('osp-nord verletzungen.csv (Kategorie health, besondere Kategorie): 25 → 25 übernommen');

  // API-Quelle: Sprungkraft-Messsystem
  const api = await connectorFromTemplate(st, templates, 'sprungkraft-api');
  await st.ok('PUT', `/api/v1/connectors/${api.id}/secret`, { body: { secret: MOCK_TOKEN } });
  const apiGet = await st.call<Connector>('GET', `/api/v1/connectors/${api.id}`);
  ensure(
    apiGet.json.hasSecret && !apiGet.text.includes(MOCK_TOKEN),
    'Geheimnis der API-Quelle sichtbar oder fehlt',
  );
  const s = await previewRun(st, api.id);
  ensureRun(s.run, 123, 120, 3, 'Sprungkraft-API');
  ensureEqual(
    summaryOf(s),
    'athlete_not_found:athlete.external_id, invalid_enum:data.test_type, out_of_range:data.jump_height_cm',
    'Fehler Sprungkraft-API',
  );
  await commit(st, s.run.id, 120, 'Sprungkraft-API');
  pass(
    'osp-nord Sprungkraft-API (Mock, 3 Seiten, Bearer-Geheimnis verschlüsselt): 123 → 120 gültig, 3 Fehler → 120 übernommen',
  );

  // osp-mitte: Windows-1252
  const mst = mitte.users.steward;
  const mTemplates = (await mst.ok<{ items: TemplateItem[] }>('GET', '/api/v1/connector-templates')).items;
  const mc = await connectorFromTemplate(mst, mTemplates, 'athleten-stammdaten-csv', (d) => {
    if (d.connector.config.type === 'csv') d.connector.config.encoding = 'windows-1252';
  });
  const m = await previewRun(mst, mc.id, fixtureForm('osp-mitte/athleten.csv'));
  ensureRun(m.run, 25, 25, 0, 'osp-mitte athleten.csv');
  const names = m.preview.rows.map((r) => String(r.mapped['athlete.last_name'])).join(' ');
  ensure(/[äöüß]/.test(names) && !names.includes('\uFFFD'), 'osp-mitte: Umlaute falsch dekodiert');
  await commit(mst, m.run.id, 25, 'osp-mitte athleten.csv');
  pass('osp-mitte athleten.csv (Windows-1252, CRLF): 25 → 25 übernommen, Umlaute korrekt');

  // osp-sued: UTF-8 mit BOM
  const sst = sued.users.steward;
  const sTemplates = (await sst.ok<{ items: TemplateItem[] }>('GET', '/api/v1/connector-templates')).items;
  const sc = await connectorFromTemplate(sst, sTemplates, 'athleten-stammdaten-csv');
  const su = await previewRun(sst, sc.id, fixtureForm('osp-sued/athleten.csv'));
  ensureRun(su.run, 20, 20, 0, 'osp-sued athleten.csv');
  await commit(sst, su.run.id, 20, 'osp-sued athleten.csv');
  pass('osp-sued athleten.csv (UTF-8 mit BOM): 20 → 20 übernommen');

  // Bestände
  const count = async (c: Client) => (await c.ok<Paged<unknown>>('GET', '/api/v1/athletes?pageSize=1')).total;
  const datasets = (await st.ok<{ items: Dataset[] }>('GET', '/api/v1/datasets')).items;
  const rc = (slug: string) => datasets.find((d) => d.slug === slug)?.recordCount;
  ensureEqual(
    {
      nord: await count(st),
      leistungsdiagnostik: rc('leistungsdiagnostik'),
      verletzungen: rc('verletzungen'),
      sprungkraft: rc('sprungkraft'),
      mitte: await count(mst),
      sued: await count(sst),
    },
    {
      nord: EXPECT.nordAthletes,
      leistungsdiagnostik: EXPECT.ld,
      verletzungen: EXPECT.injuries,
      sprungkraft: EXPECT.jumps,
      mitte: EXPECT.mitteAthletes,
      sued: EXPECT.suedAthletes,
    },
    'Bestände nach Import',
  );
  pass(
    `Bestände: osp-nord ${EXPECT.nordAthletes} Personen, Leistungsdiagnostik ${EXPECT.ld}, Verletzungen ${EXPECT.injuries}, Sprungkraft ${EXPECT.jumps}; osp-mitte ${EXPECT.mitteAthletes}; osp-sued ${EXPECT.suedAthletes}`,
  );
}

// ---------------------------------------------------------------------------------------------
// 6. Einwilligungen
// ---------------------------------------------------------------------------------------------

async function recordConsents(): Promise<void> {
  const st = nord.users.steward;
  S.injuriesByAthlete = injuriesByAthlete();
  const rows = MEDICAL_CONSENTS.reduce((sum, id) => sum + (S.injuriesByAthlete.get(id) ?? 0), 0);
  ensureEqual(rows, EXPECTED_MEDICAL_ROWS, 'Verletzungseinträge der einwilligenden Personen (Fixture)');
  for (const ext of MEDICAL_CONSENTS) {
    const id = await athleteId(st, ext);
    const c = await st.ok<Consent>('POST', `/api/v1/athletes/${id}/consents`, {
      body: {
        purpose: MEDICAL,
        dataCategory: 'health',
        validFrom: '2024-01-01',
        evidenceNote: 'Schriftliche Einwilligung, Ablage Sportmedizin (Demo)',
      },
    });
    ensure(c.status === 'granted', `Einwilligung ${ext} nicht erteilt`);
    S.consentIds.set(ext, c.id);
  }
  pass(
    `${MEDICAL_CONSENTS.length} Einwilligungen ${MEDICAL}/health dokumentiert (${MEDICAL_CONSENTS.join(', ')}) – ${EXPECTED_MEDICAL_ROWS} Verletzungseinträge`,
  );
}

// ---------------------------------------------------------------------------------------------
// 7. Datenprodukte und Freigaben
// ---------------------------------------------------------------------------------------------

const col = (key: string, source: string, label: string) => ({ key, source, label });
const NAME_COLUMNS = [
  col('last_name', 'athlete.last_name', 'Nachname'),
  col('first_name', 'athlete.first_name', 'Vorname'),
];
const SQUAD_COLUMNS = [
  col('sport', 'athlete.sport', 'Sportart'),
  col('squad_status', 'athlete.squad_status', 'Kaderstatus'),
];

async function createProductsAndReleases(): Promise<void> {
  const st = nord.users.steward;
  const datasets = (await st.ok<{ items: Dataset[] }>('GET', '/api/v1/datasets')).items;
  const ds = (slug: string) => {
    const d = datasets.find((x) => x.slug === slug);
    ensure(d, `Datensatz ${slug} fehlt`);
    return d.id;
  };
  const defs = [
    {
      slug: 'kader_uebersicht',
      name: 'Kaderübersicht',
      description: 'Athletinnen und Athleten mit Sportart, Kaderstatus, Jahrgang und Geschlecht.',
      sourceType: 'athletes',
      datasetId: null,
      columns: [
        ...NAME_COLUMNS,
        ...SQUAD_COLUMNS,
        col('birth_year', 'athlete.birth_year', 'Geburtsjahr'),
        col('sex', 'athlete.sex', 'Geschlecht'),
        col('club', 'athlete.club', 'Verein'),
      ],
    },
    {
      slug: 'sprungkraft',
      name: 'Sprungkraft',
      description: 'Sprungdiagnostik (CMJ, SJ, DJ) aus dem Messsystem.',
      sourceType: 'dataset',
      datasetId: ds('sprungkraft'),
      columns: [
        ...NAME_COLUMNS,
        ...SQUAD_COLUMNS,
        col('test_type', 'data.test_type', 'Testart'),
        col('jump_height_cm', 'data.jump_height_cm', 'Sprunghöhe'),
        col('peak_power_w', 'data.peak_power_w', 'Spitzenleistung'),
        col('contact_time_ms', 'data.contact_time_ms', 'Bodenkontaktzeit'),
        col('measured_at', 'data.measured_at', 'Messzeitpunkt'),
      ],
    },
    {
      slug: 'leistungsdiagnostik',
      name: 'Leistungsdiagnostik',
      description: 'Stufentests: VO2max, Leistung an der Laktatschwelle, maximale Herzfrequenz.',
      sourceType: 'dataset',
      datasetId: ds('leistungsdiagnostik'),
      columns: [
        ...NAME_COLUMNS,
        ...SQUAD_COLUMNS,
        col('test_date', 'data.test_date', 'Testdatum'),
        col('protocol', 'data.protocol', 'Testprotokoll'),
        col('vo2max', 'data.vo2max', 'VO2max'),
        col('lactate_threshold_power', 'data.lactate_threshold_power', 'Leistung an der Laktatschwelle'),
        col('max_heart_rate', 'data.max_heart_rate', 'Maximale Herzfrequenz'),
      ],
    },
    {
      slug: 'verletzungen_medizin',
      name: 'Verletzungen (Sportmedizin)',
      description: 'Verletzungen und Ausfallzeiten für die medizinische Betreuung (Art. 9 DSGVO).',
      sourceType: 'dataset',
      datasetId: ds('verletzungen'),
      columns: [
        ...NAME_COLUMNS,
        col('injury_date', 'data.injury_date', 'Verletzungsdatum'),
        col('body_region', 'data.body_region', 'Körperregion'),
        col('injury_type', 'data.injury_type', 'Verletzungsart'),
        col('days_absent', 'data.days_absent', 'Ausfalltage'),
        col('status', 'data.status', 'Status'),
      ],
    },
  ];
  for (const d of defs) {
    const p = await st.ok<Product>('POST', '/api/v1/products', {
      body: { ...d, shareability: 'on_request' },
    });
    ensureEqual(
      p.columns.map((c) => c.key),
      d.columns.map((c) => c.key),
      `Spalten von ${d.slug}`,
    );
    S.products.set(d.slug, p);
  }
  const med = product('verletzungen_medizin');
  ensure(med.category === 'health' && med.specialCategory, 'verletzungen_medizin nicht als Art. 9 erkannt');
  ensure(
    product('sprungkraft').columns.find((c) => c.key === 'measured_at')?.type === 'datetime',
    'sprungkraft.measured_at nicht als datetime aufgelöst',
  );
  pass('Produkte kader_uebersicht, sprungkraft, leistungsdiagnostik, verletzungen_medizin (Art. 9) angelegt');

  const release = async (slug: string, role: string, purposes: string[], columns: string[]) => {
    const r = await st.ok<Release>('POST', '/api/v1/releases', {
      body: {
        productId: product(slug).id,
        recipient: { type: 'role', role },
        purposes,
        columns,
        requiresConsent: false,
        legalBasis: 'Demo: Berichtswesen des OSP',
      },
    });
    ensure(r.status === 'active', `Freigabe ${slug} → ${role} nicht aktiv (${r.status})`);
    ensureEqual(r.columns, columns, `Spalten der Freigabe ${slug} → ${role}`);
    return r;
  };
  await release('kader_uebersicht', 'bi', [REPORTING], KADER_BI);
  await release('sprungkraft', 'bi', [REPORTING], SPRUNG_BI);
  await release('leistungsdiagnostik', 'bi', [REPORTING], LD_BI);
  pass(`BI-Freigaben (Rolle bi, Zweck ${REPORTING}) für kader_uebersicht, sprungkraft, leistungsdiagnostik`);
  S.analystRelease = (await release('kader_uebersicht', 'analyst', [STEERING], KADER_ANALYST)).id;
  pass(`kader_uebersicht → Rolle analyst (Zweck ${STEERING}; Spalten ${KADER_ANALYST.join(', ')})`);

  const art9 = await st.call('POST', '/api/v1/releases', {
    body: {
      productId: med.id,
      recipient: { type: 'role', role: 'analyst' },
      purposes: [MEDICAL],
      columns: MED_COLUMNS,
      requiresConsent: false,
    },
  });
  ensureError(art9, 422, 'release_invalid', null, 'Art.-9-Freigabe ohne Einwilligungspflicht');
  ensureEqual(
    (art9.json as ApiError).error?.fields?.['body.requiresConsent'],
    'special_category_requires_consent',
    'Ablehnungsgrund Art.-9-Freigabe',
  );
  pass('Art.-9-Freigabe ohne Einwilligungspflicht abgelehnt (special_category_requires_consent)');
}

// ---------------------------------------------------------------------------------------------
// 8. BI
// ---------------------------------------------------------------------------------------------

async function pgErrorCode(client: pg.Client, sql: string): Promise<string | null> {
  try {
    await client.query(sql);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function checkBi(): Promise<void> {
  const st = nord.users.steward;
  const r = await st.ok<{ refreshed: number; errors: number }>('POST', '/api/v1/bi/refresh');
  ensure(r.refreshed === 3 && r.errors === 0, `bi.refresh: ${JSON.stringify(r)}`);
  const views = await st.ok<{
    items: { viewName: string; status: string; rowCount: number }[];
    connection: { role: string; schema: string; port: number | null };
  }>('GET', '/api/v1/bi/views');
  const ok = views.items.filter((v) => v.status === 'ok').map((v) => `${v.viewName}:${v.rowCount}`);
  ensureEqual(
    ok.sort(),
    Object.entries(BI_CONTRACT)
      .map(([k, v]) => `${k}:${v.rows}`)
      .sort(),
    'BI-Views (bi.views)',
  );
  ensure(
    views.connection.role === 'mesh_bi' && views.connection.port === nord.spec.pgPort,
    'BI-Verbindungsdaten unerwartet',
  );
  pass(`bi.refresh: 3 Views (${ok.join(', ')})`);

  ensure(nord.urls, 'BI-Zugang fehlt');
  const client = new pg.Client({ connectionString: nord.urls.bi, application_name: 'osp-demo-bi' });
  await client.connect();
  try {
    const who = await client.query<{ u: string }>('select current_user as u');
    ensureEqual(who.rows[0]?.u, 'mesh_bi', 'Datenbankrolle');
    const listed = await client.query<{ t: string }>(
      "select table_name as t from information_schema.views where table_schema = 'bi' order by 1",
    );
    ensureEqual(
      listed.rows.map((x) => x.t),
      Object.keys(BI_CONTRACT).sort(),
      'Views im Schema bi',
    );
    for (const [view, spec] of Object.entries(BI_CONTRACT)) {
      const cols = await client.query<{ c: string; t: string }>(
        "select column_name as c, data_type as t from information_schema.columns where table_schema = 'bi' and table_name = $1 order by ordinal_position",
        [view],
      );
      ensureEqual(
        cols.rows.map((x) => [x.c, x.t]),
        spec.columns,
        `Spalten bi.${view} (Superset-Vertrag)`,
      );
      const n = await client.query<{ n: number }>(`select count(*)::int as n from bi.${view}`);
      ensureEqual(n.rows[0]?.n, spec.rows, `Zeilen bi.${view}`);
    }
    const cmj = await client.query<{ n: number }>(
      "select count(*)::int as n from bi.sprungkraft where test_type = 'CMJ' and jump_height_cm > 0",
    );
    ensure((cmj.rows[0]?.n ?? 0) > 0, 'bi.sprungkraft ohne CMJ-Messungen (Dashboard-Filter)');
    pass(
      `als mesh_bi (127.0.0.1:${nord.spec.pgPort}/mesh): bi.kader_uebersicht ${BI_CONTRACT.kader_uebersicht!.rows}, bi.sprungkraft ${BI_CONTRACT.sprungkraft!.rows} (${cmj.rows[0]?.n} CMJ), bi.leistungsdiagnostik ${BI_CONTRACT.leistungsdiagnostik!.rows} Zeilen; Spalten und Typen wie deploy/superset/README.md`,
    );

    const denied = {
      athlete: await pgErrorCode(client, 'select count(*) from public.athlete'),
      audit_log: await pgErrorCode(client, 'select count(*) from public.audit_log'),
      dataset_record: await pgErrorCode(client, 'select count(*) from public.dataset_record'),
    };
    ensureEqual(
      denied,
      { athlete: '42501', audit_log: '42501', dataset_record: '42501' },
      'mesh_bi auf public-Tabellen',
    );
    const visible = await client.query<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_schema in ('public', 'bi_data')",
    );
    ensureEqual(visible.rows[0]?.n, 0, 'für mesh_bi sichtbare Tabellen in public/bi_data');
    const write = await pgErrorCode(client, 'create table bi.demo_write_test (x int)');
    ensure(write === '25006' || write === '42501', `mesh_bi darf schreiben? (${write})`);
    pass(
      `mesh_bi: permission denied (42501) auf public.athlete/audit_log/dataset_record; kein Schreibzugriff (${write})`,
    );
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------------------------
// 9. Offene Schnittstellen
// ---------------------------------------------------------------------------------------------

async function checkOpenInterfaces(): Promise<void> {
  const created = await nord.users.analyst.ok<{ token: string; item: { prefix: string } }>(
    'POST',
    '/api/v1/auth/tokens',
    { body: { name: 'Python/Excel (Demo)', expiresInDays: 30 } },
  );
  ensure(created.token.startsWith('osp_'), 'API-Token unerwartet');
  const tool = new Client(nord.spec, 'analyst-token', created.token);
  pass(`analyst erzeugt API-Token (${created.item.prefix}…, 30 Tage)`);

  const grants = (await tool.ok<{ items: AccessGrant[] }>('GET', '/api/v1/access')).items;
  const grant = grants.find((g) => g.product.slug === 'kader_uebersicht');
  ensure(
    grant && grant.releaseId === S.analystRelease,
    'Freigabe kader_uebersicht für analyst nicht sichtbar',
  );
  ensureEqual(grants.length, 1, 'Freigaben für analyst');
  const base = `/api/v1/access/${grant.releaseId}/data?purpose=${STEERING}`;

  const jsonRes = await tool.call<DataResult>('GET', `${base}&format=json`);
  ensure(jsonRes.status === 200, `JSON: HTTP ${jsonRes.status} ${jsonRes.text.slice(0, 300)}`);
  const json = jsonRes.json;
  ensureEqual(
    json.columns.map((c) => c.key),
    KADER_ANALYST,
    'JSON-Spalten',
  );
  ensureEqual(json.rows.length, EXPECT.nordAthletes, 'JSON-Zeilen');
  ensure(
    json.rows.every((r) => JSON.stringify(Object.keys(r)) === JSON.stringify(KADER_ANALYST)),
    'JSON enthält nicht freigegebene Felder',
  );
  pass(`JSON (Bearer-Token): ${json.rows.length} Zeilen, nur ${KADER_ANALYST.join(', ')}`);

  const csv = await tool.call('GET', `${base}&format=csv`);
  ensure(
    csv.status === 200 && (csv.headers.get('content-type') ?? '').startsWith('text/csv'),
    `CSV: HTTP ${csv.status}`,
  );
  ensure(csv.bytes[0] === 0xef && csv.bytes[1] === 0xbb && csv.bytes[2] === 0xbf, 'CSV ohne UTF-8-BOM');
  const lines = csv.text.slice(1).trimEnd().split('\r\n');
  ensureEqual(lines[0], KADER_ANALYST.join(','), 'CSV-Kopfzeile');
  ensureEqual(lines.length - 1, EXPECT.nordAthletes, 'CSV-Datenzeilen');
  pass(`CSV: UTF-8-BOM, Kopfzeile "${lines[0]}", ${lines.length - 1} Datenzeilen`);

  const xml = await tool.call('GET', `${base}&format=xml`);
  ensure(xml.status === 200 && xml.text.startsWith('<?xml'), `XML: HTTP ${xml.status}`);
  ensureEqual(
    [...xml.text.matchAll(/<column key="([^"]+)"/g)].map((m) => m[1]),
    KADER_ANALYST,
    'XML-Spalten',
  );
  ensureEqual((xml.text.match(/<row>/g) ?? []).length, EXPECT.nordAthletes, 'XML-Zeilen');
  for (const r of [jsonRes.text, csv.text, xml.text]) {
    ensure(!/(club|birth_year|"sex"|<sex)/.test(r), 'Export enthält nicht freigegebene Spalten');
  }
  pass(
    `XML: ${EXPECT.nordAthletes} <row>, Spalten wie freigegeben; Verein/Jahrgang/Geschlecht in keinem Format`,
  );

  ensureError(
    await tool.call('GET', `/api/v1/access/${grant.releaseId}/data?purpose=research`),
    403,
    'access_denied',
    'purpose_not_allowed',
    'Abruf mit nicht freigegebenem Zweck',
  );
  ensureError(
    await nord.users.coach.call('GET', `${base}&format=json`),
    403,
    'access_denied',
    'recipient_mismatch',
    'Abruf durch coach',
  );
  ensureError(
    await new Client(nord.spec, 'anonym').call('GET', `${base}&format=json`),
    401,
    'unauthenticated',
    null,
    'Abruf ohne Anmeldung',
  );
  pass(
    'abgelehnt: falscher Zweck (purpose_not_allowed), Rolle coach (recipient_mismatch), ohne Anmeldung (401)',
  );

  const openapi = await new Client(nord.spec, 'anonym').call<{
    openapi?: string;
    paths?: Record<string, Record<string, unknown>>;
  }>('GET', '/api/v1/openapi.json');
  ensure(
    openapi.status === 200 &&
      openapi.json.openapi?.startsWith('3.') &&
      openapi.json.paths?.['/api/v1/access/{id}/data']?.get,
    `OpenAPI-Dokument unvollständig (HTTP ${openapi.status})`,
  );
  pass(
    `OpenAPI ${openapi.json.openapi} unter /api/v1/openapi.json (${Object.keys(openapi.json.paths ?? {}).length} Pfade, inkl. /api/v1/access/{id}/data)`,
  );
}

// ---------------------------------------------------------------------------------------------
// 10. Austausch zwischen Knoten
// ---------------------------------------------------------------------------------------------

async function pullAt(n: NodeRt, from: NodeRt, releaseId: string, purpose: string) {
  return n.users.steward.call<ReceivedProduct>('POST', '/api/v1/received/pull', {
    body: { peerId: peerId(n, from), releaseId, purpose },
  });
}

async function receivedRows(n: NodeRt, id: string): Promise<ReceivedRows> {
  return n.users.steward.ok<ReceivedRows>('GET', `/api/v1/received/${id}/rows?pageSize=500`);
}

async function exchange(): Promise<void> {
  const st = nord.users.steward;
  const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const draft = {
    productId: product('sprungkraft').id,
    recipient: { type: 'peer', peerId: peerId(nord, mitte) },
    purposes: [STEERING],
    columns: SPRUNG_MITTE,
    rowFilter: [{ column: 'sport', op: 'eq', value: EXCHANGE_SPORT }],
    dataFrom: '2026-01-01',
    dataUntil: '2026-10-31',
    validUntil,
    requiresConsent: false,
    legalBasis: 'Kooperationsvereinbarung osp-nord/osp-mitte (Demo)',
    note: 'Trainingssteuerung Radsport',
  };
  const preview = await st.ok<{
    decision: { allowed: boolean; reason: string | null };
    stats: { total: number; returned: number; excludedByFilter: number; excludedByTime: number };
  }>('POST', '/api/v1/releases/preview', { body: { release: draft, purpose: STEERING } });
  ensure(preview.decision.allowed, `Vorschau abgelehnt: ${preview.decision.reason}`);
  S.mitteExpectedRows = preview.stats.returned;
  ensure(
    S.mitteExpectedRows > 0 && S.mitteExpectedRows < EXPECT.jumps && preview.stats.excludedByFilter > 0,
    `Vorschau unplausibel: ${JSON.stringify(preview.stats)}`,
  );
  const rel = await st.ok<Release>('POST', '/api/v1/releases', { body: draft });
  ensure(rel.status === 'active' && rel.recipient.type === 'peer', 'Partnerfreigabe nicht aktiv');
  S.mitteRelease = rel.id;
  pass(
    `osp-nord: sprungkraft → osp-mitte (Spalten ohne Namen, sport = ${EXCHANGE_SPORT}, Daten 2026-01-01…2026-10-31, gültig 30 Tage, Zweck ${STEERING}); Vorschau ${S.mitteExpectedRows} von ${preview.stats.total} Zeilen`,
  );

  // Discovery ohne zentrale Stelle
  const disc = await mitte.users.steward.ok<Discovery>('GET', '/api/v1/discovery');
  const fromNord = disc.results.find((x) => x.peer.nodeId === nord.spec.id);
  const fromSued = disc.results.find((x) => x.peer.nodeId === sued.spec.id);
  ensure(
    fromNord?.status === 'ok' && fromSued?.status === 'ok',
    `Discovery: ${JSON.stringify(disc.results.map((x) => [x.peer.nodeId, x.status, x.errorCode]))}`,
  );
  const offer = fromNord.offers.find((o) => o.slug === 'sprungkraft');
  const offered = offer?.releases.find((x) => x.releaseId === rel.id);
  ensure(offered, 'Discovery: Freigabe an osp-mitte nicht im Angebot von osp-nord');
  ensureEqual(offered.columns, SPRUNG_MITTE, 'angebotene Spalten');
  ensure(
    fromNord.offers.every((o) => o.slug === 'sprungkraft' || o.releases.length === 0),
    'osp-mitte sieht Freigaben, die nicht für osp-mitte sind',
  );
  pass(
    `osp-mitte Discovery: osp-nord ok (${fromNord.offers.length} Angebote, nur Metadaten, Freigabe sichtbar), osp-sued ok (${fromSued.offers.length} Angebote)`,
  );

  // Abruf
  const pulled = await pullAt(mitte, nord, rel.id, STEERING);
  ensure(pulled.status === 200, `Abruf osp-mitte: HTTP ${pulled.status} ${pulled.text.slice(0, 300)}`);
  S.mitteReceivedId = pulled.json.id;
  ensureEqual(pulled.json.rowCount, S.mitteExpectedRows, 'empfangene Zeilen (= Vorschau osp-nord)');
  ensureEqual(
    pulled.json.columns.map((c) => c.key),
    SPRUNG_MITTE,
    'empfangene Spalten',
  );
  const rows = await receivedRows(mitte, S.mitteReceivedId);
  ensureEqual(
    rows.columns.map((c) => c.key),
    ['subject', ...SPRUNG_MITTE],
    'Spalten der Kopie',
  );
  ensureEqual(rows.total, S.mitteExpectedRows, 'Zeilen der Kopie');
  const windowStart = Date.parse('2025-12-31T23:00:00Z'); // 2026-01-01 00:00 Europe/Berlin
  ensure(
    rows.rows.every(
      (r) =>
        r.sport === EXCHANGE_SPORT &&
        Date.parse(String(r.measured_at)) >= windowStart &&
        !('last_name' in r) &&
        /^[A-Za-z0-9_-]{8,64}$/.test(String(r.subject)),
    ),
    'Kopie verletzt Zeilen-, Zeit- oder Spaltenbeschränkung',
  );
  const detail = await mitte.users.steward.ok<
    ReceivedProduct & {
      provenance: { sourceNodeId: string; sourceFingerprint: string; responseSignature: string | null };
    }
  >('GET', `/api/v1/received/${S.mitteReceivedId}`);
  ensure(
    detail.provenance.sourceNodeId === nord.spec.id &&
      detail.provenance.sourceFingerprint === nord.fingerprint &&
      !!detail.provenance.responseSignature,
    'Herkunftsnachweis unvollständig',
  );
  pass(
    `osp-mitte Pull: ${rows.total} Zeilen = Vorschau, Spalten genau ${SPRUNG_MITTE.join(', ')}, Pseudonyme, nur ${EXCHANGE_SPORT}; signierter Herkunftsnachweis`,
  );

  // Abruf mit nicht freigegebenem Zweck
  ensureError(
    await pullAt(mitte, nord, rel.id, 'research'),
    502,
    'peer_rejected',
    'purpose_not_allowed',
    'Abruf mit Zweck research',
  );
  const inLog = await exchangeLog(mitte.users.auditor, 'incoming');
  ensure(
    inLog.some(
      (e) => e.remoteReleaseId === rel.id && e.outcome === 'denied' && e.denyReason === 'purpose_not_allowed',
    ),
    'osp-mitte: Austauschprotokoll ohne Ablehnung',
  );
  const outLog = await exchangeLog(nord.users.auditor, 'outgoing');
  ensure(
    outLog.some(
      (e) =>
        e.releaseId === rel.id &&
        e.peerNodeId === mitte.spec.id &&
        e.outcome === 'denied' &&
        e.denyReason === 'purpose_not_allowed',
    ),
    'osp-nord: Austauschprotokoll ohne Ablehnung',
  );
  ensure(
    outLog.some(
      (e) => e.releaseId === rel.id && e.outcome === 'delivered' && e.rowCount === S.mitteExpectedRows,
    ),
    'osp-nord: Lieferung nicht protokolliert',
  );
  const nordDenied = await auditFind(nord.users.auditor, 'exchange.pull.denied', {
    outcome: 'denied',
    objectId: rel.id,
  });
  ensure(
    nordDenied.some((e) => e.details.reason === 'purpose_not_allowed'),
    'osp-nord: Audit ohne exchange.pull.denied',
  );
  const mitteDenied = await auditFind(mitte.users.auditor, 'exchange.pull.received', { outcome: 'denied' });
  ensure(
    mitteDenied.some((e) => e.details.reason === 'purpose_not_allowed' && e.details.releaseId === rel.id),
    'osp-mitte: Audit ohne abgelehnten Abruf',
  );
  pass(
    'Pull mit Zweck research → peer_rejected/purpose_not_allowed; denied in exchange.log und Audit auf beiden Seiten',
  );

  // Gesundheitsdaten an osp-sued (nur mit Einwilligung)
  const medDraft = {
    productId: product('verletzungen_medizin').id,
    recipient: { type: 'peer', peerId: peerId(nord, sued) },
    purposes: [MEDICAL],
    columns: MED_COLUMNS,
    requiresConsent: true,
    legalBasis: 'Art. 9 Abs. 2 lit. a DSGVO (ausdrückliche Einwilligung)',
    note: 'Mitbetreuung durch die Sportmedizin osp-sued',
  };
  const medPreview = await st.ok<{ stats: { returned: number; excludedByConsent: number } }>(
    'POST',
    '/api/v1/releases/preview',
    { body: { release: medDraft, purpose: MEDICAL } },
  );
  ensureEqual(
    [medPreview.stats.returned, medPreview.stats.excludedByConsent],
    [EXPECTED_MEDICAL_ROWS, EXPECT.injuries - EXPECTED_MEDICAL_ROWS],
    'Vorschau verletzungen_medizin (zurückgegeben, ohne Einwilligung)',
  );
  const med = await st.ok<Release>('POST', '/api/v1/releases', { body: medDraft });
  S.medRelease = med.id;
  const medPulled = await pullAt(sued, nord, med.id, MEDICAL);
  ensure(
    medPulled.status === 200,
    `Abruf osp-sued: HTTP ${medPulled.status} ${medPulled.text.slice(0, 300)}`,
  );
  S.suedReceivedId = medPulled.json.id;
  ensureEqual(medPulled.json.rowCount, EXPECTED_MEDICAL_ROWS, 'osp-sued: empfangene Verletzungseinträge');
  ensure(medPulled.json.specialCategory, 'osp-sued: Kopie nicht als besondere Kategorie markiert');
  pass(
    `osp-nord: verletzungen_medizin → osp-sued (Zweck ${MEDICAL}, Einwilligungspflicht); osp-sued Pull: ${EXPECTED_MEDICAL_ROWS} Zeilen (nur ${MEDICAL_CONSENTS.length} Einwilligende, ${EXPECT.injuries - EXPECTED_MEDICAL_ROWS} ausgeschlossen)`,
  );

  // fremde Freigabe-ID
  ensureError(
    await pullAt(sued, nord, rel.id, STEERING),
    502,
    'peer_rejected',
    'not_found',
    'osp-sued ruft Freigabe von osp-mitte ab',
  );
  const hidden = await auditFind(nord.users.auditor, 'exchange.pull.denied', { objectId: rel.id });
  ensure(
    hidden.some((e) => e.details.reason === 'recipient_mismatch' && e.actorId === sued.spec.id),
    'osp-nord: Versuch von osp-sued nicht protokolliert',
  );
  pass('osp-sued mit Freigabe-ID von osp-mitte → not_found (osp-nord protokolliert recipient_mismatch)');
}

// ---------------------------------------------------------------------------------------------
// 11. Widerruf einer Einwilligung
// ---------------------------------------------------------------------------------------------

async function flush(n: NodeRt): Promise<{ delivered: number; failed: number }> {
  const r = await n.users.steward.ok<{ delivered: number; failed: number }>('POST', '/api/v1/outbox/flush');
  ensure(r.failed === 0, `${n.spec.id}: Zustellung fehlgeschlagen (${JSON.stringify(r)})`);
  return r;
}

async function withdrawConsent(): Promise<void> {
  const consentId = S.consentIds.get(WITHDRAWING);
  ensure(consentId, `Einwilligung von ${WITHDRAWING} fehlt`);
  const removed = S.injuriesByAthlete.get(WITHDRAWING) ?? 0;
  ensure(removed > 0, `${WITHDRAWING} hat keine Verletzungseinträge`);
  const c = await nord.users.steward.ok<Consent>('POST', `/api/v1/consents/${consentId}/withdraw`, {
    body: { note: 'Widerruf per E-Mail (Demo)' },
  });
  ensure(c.status === 'withdrawn' && c.withdrawnAt, 'Einwilligung nicht widerrufen');
  const f = await flush(nord);
  const expected = EXPECTED_MEDICAL_ROWS - removed;
  const after = await eventually('osp-sued: Zeilen der Person entfernt', 20_000, async () => {
    const p = await sued.users.steward.ok<ReceivedProduct>('GET', `/api/v1/received/${S.suedReceivedId}`);
    return p.rowCount === expected ? p : null;
  });
  ensureEqual((await receivedRows(sued, S.suedReceivedId)).total, expected, 'osp-sued: Zeilen der Kopie');
  ensure(after.status === 'active', 'osp-sued: Kopie sollte aktiv bleiben');
  pass(
    `${WITHDRAWING} widerruft ${MEDICAL}/health → outbox.flush (${f.delivered} zugestellt) → osp-sued: ${EXPECTED_MEDICAL_ROWS} → ${expected} Zeilen (−${removed})`,
  );

  const withdrawn = await auditFind(nord.users.auditor, 'consent.withdraw', { objectId: consentId });
  const sent = await auditFind(nord.users.auditor, 'exchange.notice.sent');
  const received = await auditFind(sued.users.auditor, 'exchange.notice.received');
  ensure(withdrawn.length === 1, 'osp-nord: Audit consent.withdraw fehlt');
  ensure(
    sent.some((e) => e.details.kind === 'subjects_withdrawn' && e.details.releaseId === S.medRelease),
    'osp-nord: Audit exchange.notice.sent (subjects_withdrawn) fehlt',
  );
  ensure(
    received.some(
      (e) =>
        e.details.kind === 'subjects_withdrawn' &&
        e.details.releaseId === S.medRelease &&
        e.details.affectedRows === removed,
    ),
    'osp-sued: Audit exchange.notice.received (subjects_withdrawn) fehlt',
  );
  const again = await pullAt(sued, nord, S.medRelease, MEDICAL);
  ensure(
    again.status === 200 && again.json.rowCount === expected,
    'erneuter Abruf liefert widerrufene Person',
  );
  pass(
    `Audit: consent.withdraw + exchange.notice.sent (osp-nord), exchange.notice.received (osp-sued); erneuter Pull: ${expected} Zeilen`,
  );
}

// ---------------------------------------------------------------------------------------------
// 12. Widerruf einer Freigabe
// ---------------------------------------------------------------------------------------------

async function revokeRelease(): Promise<void> {
  const r = await nord.users.steward.ok<Release>('POST', `/api/v1/releases/${S.mitteRelease}/revoke`, {
    body: { reason: 'Kooperation beendet (Demo)' },
  });
  ensure(r.status === 'revoked' && r.revokedAt, 'Freigabe nicht widerrufen');
  const f = await flush(nord);
  const copy = await eventually('osp-mitte: Kopie widerrufen', 20_000, async () => {
    const p = await mitte.users.steward.ok<ReceivedProduct>('GET', `/api/v1/received/${S.mitteReceivedId}`);
    return p.status === 'revoked' && p.rowCount === 0 ? p : null;
  });
  ensureEqual((await receivedRows(mitte, S.mitteReceivedId)).total, 0, 'osp-mitte: Zeilen nach Widerruf');
  pass(
    `osp-nord widerruft sprungkraft → osp-mitte → outbox.flush (${f.delivered} zugestellt) → osp-mitte: Kopie ${copy.status}, 0 Zeilen`,
  );
  ensureError(
    await pullAt(mitte, nord, S.mitteRelease, STEERING),
    502,
    'peer_rejected',
    'revoked',
    'Abruf nach Widerruf',
  );
  pass('erneuter Pull → peer_rejected/revoked');

  const revoked = await auditFind(nord.users.auditor, 'release.revoke', { objectId: S.mitteRelease });
  const sent = await auditFind(nord.users.auditor, 'exchange.notice.sent');
  const received = await auditFind(mitte.users.auditor, 'exchange.notice.received');
  ensure(revoked.length === 1, 'osp-nord: Audit release.revoke fehlt');
  ensure(
    sent.some((e) => e.details.kind === 'release_revoked' && e.details.releaseId === S.mitteRelease),
    'osp-nord: Audit exchange.notice.sent (release_revoked) fehlt',
  );
  ensure(
    received.some(
      (e) =>
        e.details.kind === 'release_revoked' &&
        e.details.releaseId === S.mitteRelease &&
        e.details.affectedRows === S.mitteExpectedRows,
    ),
    'osp-mitte: Audit exchange.notice.received (release_revoked) fehlt',
  );
  pass(
    `Audit: release.revoke + exchange.notice.sent (osp-nord), exchange.notice.received mit ${S.mitteExpectedRows} gelöschten Zeilen (osp-mitte)`,
  );
}

// ---------------------------------------------------------------------------------------------
// 13. Audit
// ---------------------------------------------------------------------------------------------

const KEY_ACTIONS: Record<string, string[]> = {
  'osp-nord': [
    'user.create',
    'auth.password_change',
    'peer.trust',
    'import.commit',
    'connector.secret_set',
    'consent.create',
    'consent.withdraw',
    'product.create',
    'release.create',
    'release.revoke',
    'bi.refresh',
    'access.data',
    'exchange.pull.served',
    'exchange.pull.denied',
    'exchange.notice.sent',
  ],
  'osp-mitte': [
    'peer.trust',
    'import.commit',
    'discovery.search',
    'exchange.pull.received',
    'exchange.notice.received',
  ],
  'osp-sued': ['peer.trust', 'import.commit', 'exchange.pull.received', 'exchange.notice.received'],
};

async function checkAudit(): Promise<void> {
  for (const n of nodes) {
    const v = await n.users.auditor.ok<Verify>('GET', '/api/v1/audit/verify');
    ensure(
      v.ok && v.firstBrokenSeq === null && v.checked > 0,
      `${n.spec.id}: Audit-Kette ${JSON.stringify(v)}`,
    );
    const out = cli(n, ['verify-audit'], [n.envFile]);
    ensure(out.includes('Audit-Kette ok'), `${n.spec.id}: CLI verify-audit: ${out}`);
    const missing: string[] = [];
    for (const action of KEY_ACTIONS[n.spec.id] ?? []) {
      if ((await auditFind(n.users.auditor, action)).length === 0) missing.push(action);
    }
    ensure(missing.length === 0, `${n.spec.id}: Audit-Einträge fehlen: ${missing.join(', ')}`);
    pass(
      `${n.spec.id}: Hash-Kette ok (${v.checked} Einträge; API und CLI verify-audit); ${KEY_ACTIONS[n.spec.id]?.length} Schlüsselaktionen vorhanden`,
    );
  }
  const denied = {
    'access.data': (await auditFind(nord.users.auditor, 'access.data', { outcome: 'denied' })).length,
    'exchange.pull.denied': (
      await auditFind(nord.users.auditor, 'exchange.pull.denied', { outcome: 'denied' })
    ).length,
    'exchange.pull.received': (
      await auditFind(mitte.users.auditor, 'exchange.pull.received', { outcome: 'denied' })
    ).length,
  };
  ensure(
    Object.values(denied).every((x) => x > 0),
    `abgelehnte Zugriffe nicht protokolliert: ${JSON.stringify(denied)}`,
  );
  pass(
    `abgelehnte Zugriffe protokolliert: access.data ${denied['access.data']}×, exchange.pull.denied ${denied['exchange.pull.denied']}× (osp-nord), exchange.pull.received/denied ${denied['exchange.pull.received']}× (osp-mitte)`,
  );
}

// ---------------------------------------------------------------------------------------------
// 14. Sicherungen
// ---------------------------------------------------------------------------------------------

async function backupNow(n: NodeRt): Promise<BackupRun> {
  for (let i = 0; i < 60; i++) {
    const r = await n.users.admin.call<BackupRun & ApiError>('POST', '/api/v1/system/backups');
    if (r.status === 200) return r.json;
    // eine geplante Sicherung läuft gerade (erster Lauf 60 s nach dem Start): kurz warten
    if (r.status === 409 && r.json?.error?.reason === 'backup_running') {
      await Bun.sleep(1000);
      continue;
    }
    throw new CheckFailed(`${n.spec.id}: Sicherung → HTTP ${r.status} ${r.text.slice(0, 300)}`);
  }
  throw new CheckFailed(`${n.spec.id}: Sicherung blockiert (backup_running)`);
}

async function checkBackups(): Promise<void> {
  for (const n of nodes) {
    const run = await backupNow(n);
    ensure(
      run.status === 'ok' && run.fileName && run.sha256,
      `${n.spec.id}: Sicherung ${JSON.stringify(run)}`,
    );
    const file = join(n.dir, 'backups', run.fileName);
    ensure(existsSync(file) && existsSync(`${file}.json`), `${n.spec.id}: Sicherungsdatei fehlt (${file})`);
    const bytes = readFileSync(file);
    const mode = statSync(file).mode & 0o777;
    ensure(bytes.subarray(0, 7).toString('ascii') === 'OSPMBK1', `${n.spec.id}: kein OSPMBK1-Format`);
    const headerLen = bytes.readUInt16BE(7);
    const header = JSON.parse(bytes.subarray(9, 9 + headerLen).toString('utf8')) as {
      nodeId: string;
      cipher: string;
    };
    ensureEqual(
      [header.nodeId, header.cipher],
      [n.spec.id, 'aes-256-gcm'],
      `${n.spec.id}: Kopf der Sicherung`,
    );
    ensure(
      !bytes.includes('PGDMP') && !bytes.includes('athlete_identifier') && !bytes.includes('Lorenz'),
      `${n.spec.id}: Sicherung enthält Klartext`,
    );
    const sha = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    ensureEqual(sha, run.sha256, `${n.spec.id}: SHA-256 der Sicherung`);
    ensureEqual(mode, 0o600, `${n.spec.id}: Dateirechte der Sicherung`);
    const status = await n.users.admin.ok<SystemStatus>('GET', '/api/v1/system/status');
    ensure(
      status.backups.encrypted && status.backups.last?.status === 'ok',
      `${n.spec.id}: Systemstatus Sicherung`,
    );
    pass(
      `${n.spec.id}: ${run.fileName} (${Math.round(bytes.length / 1024)} KiB, AES-256-GCM, 0600, SHA-256 ok, kein Klartext)`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Zusammenfassung, Aufräumen, Ablauf
// ---------------------------------------------------------------------------------------------

function relPath(p: string): string {
  return p.startsWith(`${ROOT}/`) ? p.slice(ROOT.length + 1) : p;
}

function printSummary(totalMs: number, failure: Error | null): void {
  say('');
  say(bold('Zusammenfassung'));
  const w = Math.max(...results.map((r) => r.title.length));
  for (const [i, r] of results.entries()) {
    const mark = r.ok ? green('✓') : red('✗');
    say(
      `  ${String(i + 1).padStart(2)}  ${mark} ${r.title.padEnd(w)}  ${String(r.checks).padStart(3)} Prüfungen  ${secs(r.ms).padStart(7)}`,
    );
  }
  for (let i = results.length; i < STEP_COUNT; i++)
    say(`  ${String(i + 1).padStart(2)}  ${dim('– nicht ausgeführt')}`);
  const checks = results.reduce((s, r) => s + r.checks, 0);
  say(
    failure
      ? red(
          `  FEHLGESCHLAGEN nach ${checks} bestandenen Prüfungen (${secs(totalMs)}): ${failure.message.split('\n')[0]}`,
        )
      : green(`  Alle ${checks} Prüfungen in ${STEP_COUNT} Schritten bestanden (${secs(totalMs)}).`),
  );
  say('');
  say(bold('Knoten'));
  for (const n of nodes)
    say(`  ${n.spec.id.padEnd(10)} ${n.spec.name.padEnd(15)} ${n.spec.url}   Hilfe: ${n.spec.url}/hilfe/`);
  say(`  Mock-Messsystem      http://127.0.0.1:${MOCK_PORT}/v1/measurements (Bearer ${MOCK_TOKEN})`);
  say(bold(`Anmeldungen (Passwort jeweils ${DEMO_PASSWORD})`));
  for (const n of nodes) {
    say(
      `  ${n.spec.id.padEnd(10)} ${(['admin', 'steward', 'analyst'] as UserKey[]).map((k) => emailOf(n.spec, k)).join('  ')}`,
    );
  }
  say(dim(`  außerdem coach@… und auditor@… je Knoten`));
  say(bold('Logs und Zugangsdaten'));
  say(`  Knoten:      ${relPath(DEMO_DIR)}/<knoten>/server.log`);
  say(`  Mock:        ${relPath(MOCK_LOG)}`);
  say(`  PostgreSQL:  ${relPath(DEMO_DIR)}/pg/<knoten>/server.log`);
  say(
    `  Konfiguration: ${relPath(DEMO_DIR)}/<knoten>/node.env (Server), owner.env (nur CLI, inkl. mesh_bi-Zugang)`,
  );
  say(`  Sicherungen: ${relPath(DEMO_DIR)}/<knoten>/backups/`);
}

async function teardown(): Promise<void> {
  say('');
  say(bold('Aufräumen'));
  const stopped = await stopDemo((m) => say(`  ${green('✓')} ${m}`));
  if (stopped.length === 0) say('  nichts zu stoppen');
  const busy = await busyDemoPorts();
  if (busy.length > 0)
    throw new CheckFailed(`Ports nach dem Stoppen noch belegt: ${busy.map((p) => p.port).join(', ')}`);
  say(`  ${green('✓')} alle Demo-Ports wieder frei`);
}

let aborting = false;
async function abort(signal: string): Promise<void> {
  if (aborting) return;
  aborting = true;
  say('');
  say(yellow(`Abbruch (${signal}) – stoppe die Demo …`));
  if (startedAnything) await stopDemo((m) => say(`  ${m}`));
  process.exit(130);
}
process.on('SIGINT', () => void abort('SIGINT'));
process.on('SIGTERM', () => void abort('SIGTERM'));

async function main(): Promise<number> {
  const t0 = performance.now();
  say(bold('OSP-Data-Mesh – End-to-End-Demo'));
  say(dim(`drei Knoten, echte PostgreSQL-Cluster, echtes HTTP · Zustand unter ${relPath(DEMO_DIR)}/`));
  let failure: Error | null = null;
  try {
    await step('Vorbereitung: Ports, PostgreSQL, Build, leerer Stand', preflight);
    await step('Drei Knoten: Cluster, db-bootstrap, migrate, create-admin, Start', setupNodes);
    await step('Benutzer und Rollen, erzwungener Passwortwechsel', setupUsers);
    await step('Vertrauen: Knotenkarten, Fingerprint, signierter Ping', setupTrust);
    await step('Datenintegration: 3 CSV-Dateien + 1 API-Quelle (AK1)', integrateData);
    await step('Einwilligungen (osp-nord)', recordConsents);
    await step('Datenprodukte und Freigaben (osp-nord)', createProductsAndReleases);
    await step('BI-Zugang: Schema bi, Rolle mesh_bi (B3)', checkBi);
    await step('Offene Schnittstellen: API-Token, JSON/CSV/XML (D8/D9)', checkOpenInterfaces);
    await step('Austausch: Discovery, Pull, Ablehnungen (A1–A3)', exchange);
    await step('Widerruf einer Einwilligung', withdrawConsent);
    await step('Widerruf einer Freigabe', revokeRelease);
    await step('Audit-Integrität', checkAudit);
    await step('Verschlüsselte Sicherungen', checkBackups);
  } catch (err) {
    failure = err as Error;
    if (!(err instanceof CheckFailed) && !(err instanceof PreflightError)) {
      say(red(`  Unerwarteter Fehler: ${(err as Error).stack ?? err}`));
    }
  }
  if (failure instanceof PreflightError) {
    say('');
    say(red('Demo nicht gestartet.'));
    return 1;
  }
  printSummary(performance.now() - t0, failure);

  if (failure) {
    if (KEEP_RUNNING) {
      say('');
      say(yellow('Knoten laufen zur Fehlersuche weiter. Stoppen mit: bun run demo:stop'));
    } else if (startedAnything) {
      await teardown().catch((e) => say(red(`  ${(e as Error).message}`)));
    }
    return 1;
  }
  if (KEEP_RUNNING) {
    say('');
    say(green('Knoten, Cluster und Mock-Messsystem laufen weiter (--keep-running).'));
    say(`Stoppen mit: ${bold('bun run demo:stop')}`);
    return 0;
  }
  await teardown();
  return 0;
}

const code = await main().catch((err) => {
  say(red(`Unerwarteter Fehler: ${(err as Error).stack ?? err}`));
  return 1;
});
process.exit(code);
