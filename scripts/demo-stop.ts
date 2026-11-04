/**
 * Stoppt alles, was `bun run demo` unter `.local/demo` gestartet hat: Knotenprozesse, Mock-Messsystem und die
 * PostgreSQL-Cluster der Demo. Andere Inhalte von `.local` (z. B. der Testcluster auf Port 55434) bleiben
 * unberührt.
 *
 *   bun run demo:stop
 *
 * Wird auch von scripts/demo.ts genutzt (Aufräumen vor dem Start und nach dem Lauf).
 * Prozesse werden nur gestoppt, wenn ihre Kommandozeile noch zum gespeicherten Eintrag passt (keine fremden
 * Prozesse mit wiederverwendeter PID).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { isRunning, listClusters, stopCluster } from './pg-local.ts';

export const ROOT = resolve(import.meta.dir, '..');
export const DEMO_DIR = join(ROOT, '.local', 'demo');
/** PID-Dateien der gestarteten Prozesse */
export const RUN_DIR = join(DEMO_DIR, 'run');

// Die Demo-Cluster liegen unter .local/demo/pg (pg-local.ts wertet MESH_LOCAL_DIR bei jedem Aufruf aus).
process.env.MESH_LOCAL_DIR = DEMO_DIR;

export const DEMO_PORTS: readonly { port: number; label: string }[] = [
  { port: 55431, label: 'PostgreSQL osp-nord' },
  { port: 55432, label: 'PostgreSQL osp-mitte' },
  { port: 55433, label: 'PostgreSQL osp-sued' },
  { port: 4401, label: 'Knoten osp-nord' },
  { port: 4402, label: 'Knoten osp-mitte' },
  { port: 4403, label: 'Knoten osp-sued' },
  { port: 4410, label: 'Mock-Messsystem' },
];

export interface PidRecord {
  name: string;
  pid: number;
  /** Teil der Kommandozeile, an dem der Prozess wiedererkannt wird */
  marker: string;
  port: number;
}

export function writePidRecord(rec: PidRecord): void {
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(RUN_DIR, `${rec.name}.pid.json`), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
}

function readPidRecords(): { file: string; rec: PidRecord }[] {
  if (!existsSync(RUN_DIR)) return [];
  const out: { file: string; rec: PidRecord }[] = [];
  for (const f of readdirSync(RUN_DIR)) {
    if (!f.endsWith('.pid.json')) continue;
    const file = join(RUN_DIR, f);
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8')) as PidRecord;
      if (Number.isInteger(rec.pid) && rec.pid > 1 && typeof rec.marker === 'string' && rec.marker) {
        out.push({ file, rec });
      }
    } catch {
      // unlesbare Datei: ignorieren
    }
  }
  return out;
}

function processInfo(pid: number): { stat: string; command: string } | null {
  const r = Bun.spawnSync(['ps', '-o', 'stat=', '-o', 'command=', '-p', String(pid)], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (r.exitCode !== 0) return null;
  const m = /^(\S+)\s+(.*)$/.exec(r.stdout.toString().trim());
  return m ? { stat: m[1]!, command: m[2]! } : null;
}

/** Läuft der Prozess noch (kein Zombie) und ist es noch derselbe (Kommandozeile)? */
export function isAlive(rec: PidRecord): boolean {
  const info = processInfo(rec.pid);
  return !!info && !info.stat.startsWith('Z') && info.command.includes(rec.marker);
}

async function waitGone(rec: PidRecord, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!isAlive(rec)) return true;
    await Bun.sleep(100);
  }
  return !isAlive(rec);
}

async function stopProcess(rec: PidRecord): Promise<boolean> {
  if (!isAlive(rec)) return false;
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch {
    return false;
  }
  if (await waitGone(rec, 10_000)) return true;
  try {
    process.kill(rec.pid, 'SIGKILL');
  } catch {
    // bereits beendet
  }
  await waitGone(rec, 3_000);
  return true;
}

/**
 * Stoppt Knoten und Mock-Messsystem (laut PID-Dateien) und danach alle Cluster unter .local/demo/pg.
 * Liefert die Namen der gestoppten Komponenten.
 */
export async function stopDemo(log: (msg: string) => void = () => {}): Promise<string[]> {
  const stopped: string[] = [];
  const records = readPidRecords();
  // zuerst die Knoten (schließen ihre Datenbankverbindungen sauber), parallel
  const order = (r: PidRecord) => (r.name.startsWith('osp-') ? 0 : 1);
  for (const group of [0, 1]) {
    const batch = records.filter((x) => order(x.rec) === group);
    const results = await Promise.all(batch.map((x) => stopProcess(x.rec)));
    batch.forEach((x, i) => {
      if (results[i]) {
        stopped.push(x.rec.name);
        log(`${x.rec.name} gestoppt (PID ${x.rec.pid})`);
      }
      rmSync(x.file, { force: true });
    });
  }
  for (const name of listClusters()) {
    if (!isRunning(name)) continue;
    stopCluster(name);
    stopped.push(`pg/${name}`);
    log(`PostgreSQL-Cluster ${name} gestoppt`);
  }
  return stopped;
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => {
      socket.destroy();
      resolvePromise(v);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = net.createServer();
    srv.once('error', () => resolvePromise(false));
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolvePromise(true)));
  });
}

/** Port belegt: Verbindung möglich oder eigener Listener nicht möglich */
export async function portInUse(port: number): Promise<boolean> {
  if (await canConnect(port)) return true;
  return !(await canListen(port));
}

export async function busyDemoPorts(): Promise<{ port: number; label: string }[]> {
  const flags = await Promise.all(DEMO_PORTS.map((p) => portInUse(p.port)));
  return DEMO_PORTS.filter((_, i) => flags[i]);
}

/** Laufen noch Prozesse oder Cluster einer früheren Demo (z. B. --keep-running)? */
export function demoStillRunning(): boolean {
  return readPidRecords().some((x) => isAlive(x.rec)) || listClusters().some((n) => isRunning(n));
}

if (import.meta.main) {
  if (!existsSync(DEMO_DIR)) {
    console.log('Keine Demo unter .local/demo gefunden – nichts zu stoppen.');
  } else {
    const stopped = await stopDemo((m) => console.log(`  ✓ ${m}`));
    if (stopped.length === 0) console.log('Nichts zu stoppen – keine laufende Demo.');
  }
  const busy = await busyDemoPorts();
  if (busy.length > 0) {
    console.error(
      `Noch belegt (nicht von der Demo gestartet?): ${busy.map((p) => `${p.port} (${p.label})`).join(', ')}`,
    );
    process.exit(1);
  }
  console.log(`Alle Demo-Ports frei (${DEMO_PORTS.map((p) => p.port).join(', ')}).`);
}
