/**
 * Automatisierte Oberflächen-Ablauftests (E2E) von OSP-Data-Mesh: echter Browser (Chromium über
 * playwright-core) gegen echte Knotenprozesse mit eigener PostgreSQL-Umgebung.
 *
 *   bun run test:e2e                     alle Abläufe (tests/e2e/*.e2e.ts)
 *   bun run test:e2e partner             nur Dateien, deren Name "partner" enthält
 *   bun run test:e2e -- -t "Abrufen"     weitere Optionen gehen an `bun test`
 *   bun run test:e2e --keep              Umgebung nach den Tests offen lassen (Strg+C beendet)
 *
 * Einmalig vorher: `bun x playwright-core install chromium`. Läuft bewusst NICHT mit `bun test`:
 * die Dateien heißen *.e2e.ts (nicht *.test.ts) und brauchen die von diesem Starter aufgebaute Umgebung
 * (MESH_E2E_ENV). Ablauf: tests/e2e/harness/setup.ts; Fehlerbilder: .local/e2e/artefakte/.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { ROOT } from './harness/api.ts';
import { ARTIFACTS_DIR, type Environment, startEnvironment } from './harness/setup.ts';

const argv = process.argv.slice(2);
let keep = false;
const filters: string[] = [];
const passThrough: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--keep') keep = true;
  else if (a === '--') continue;
  else if (a.startsWith('-')) {
    passThrough.push(a);
    // Optionen mit Wert (z. B. -t "Muster") vollständig weiterreichen
    if (['-t', '--test-name-pattern', '--timeout'].includes(a) && argv[i + 1] !== undefined) {
      passThrough.push(argv[++i]!);
    }
  } else filters.push(a);
}

const dir = join(ROOT, 'tests/e2e');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.e2e.ts'))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort()
  .map((f) => `./${join('tests/e2e', f)}`);
if (files.length === 0) {
  console.error(`Keine E2E-Datei passt zu: ${filters.join(', ')}`);
  process.exit(2);
}

const started = Date.now();
let environment: Environment | null = null;
let child: Subprocess | null = null;
let exiting = false;
/** Ergebnis von bun test (für --keep: nach Strg+C trotzdem das Testergebnis melden) */
let testsCode: number | null = null;

async function finish(code: number): Promise<never> {
  // zweiter Aufruf (Testprozess endet nach dem Signal, erneutes Strg+C): das laufende Aufräumen abwarten
  if (exiting) return new Promise<never>(() => {});
  exiting = true;
  if (child) {
    // erst den Testprozess beenden (bun test reagiert nicht immer auf SIGTERM), dann die Umgebung
    const running = child;
    running.kill('SIGTERM');
    const done = await Promise.race([running.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    if (!done) {
      running.kill('SIGKILL');
      await running.exited;
    }
  }
  if (environment) {
    if (code !== 0) environment.saveLogs();
    await environment.stop();
  }
  const total = ((Date.now() - started) / 1000).toFixed(1);
  const result = code === 0 ? 'bestanden' : `FEHLGESCHLAGEN (Exit ${code})`;
  const cleanup = environment ? 'Umgebung gestoppt und gelöscht' : 'keine Umgebung übrig';
  console.log(`[e2e] ${result} – Gesamtlaufzeit ${total} s; ${cleanup}`);
  if (code !== 0 && environment) console.log(`[e2e] Bildschirmfotos und Server-Logs: ${ARTIFACTS_DIR}`);
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    console.log(`\n[e2e] ${sig} – räume auf …`);
    void finish(testsCode === null ? 130 : testsCode === 0 ? 0 : 1);
  });
}

try {
  environment = await startEnvironment();
} catch (err) {
  console.error(`[e2e] Aufbau fehlgeschlagen: ${(err as Error).message}`);
  await finish(1);
}

const env = environment!;
child = Bun.spawn([process.execPath, 'test', '--timeout', '60000', ...passThrough, ...files], {
  cwd: ROOT,
  env: { ...process.env, MESH_E2E_ENV: env.envFile },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
env.recordTestProcess(child.pid);
testsCode = await child.exited;
child = null;

if (keep && !exiting) {
  console.log('[e2e] --keep: Umgebung läuft weiter (Strg+C beendet und räumt auf)');
  for (const n of Object.values(env.env.nodes)) {
    console.log(`  ${n.id}: ${n.url}  ${Object.values(n.users).join(', ')}  Passwort ${env.env.password}`);
  }
  await new Promise(() => {});
}
await finish(testsCode === 0 ? 0 : 1);
