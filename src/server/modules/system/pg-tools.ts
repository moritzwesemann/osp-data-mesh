/**
 * Aufruf der PostgreSQL-Werkzeuge (pg_dump, pg_restore, psql).
 * Passwörter werden nie auf der Kommandozeile übergeben (sichtbar in `ps`), sondern über PGPASSWORD.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HOMEBREW_BIN = '/opt/homebrew/bin';

function which(name: string): string | null {
  return Bun.which(name) ?? null;
}

/** pg_dump: MESH_PG_DUMP; beim Standardwert "pg_dump" ohne Treffer im PATH Rückfall auf Homebrew. */
export function resolvePgDump(configured = 'pg_dump'): string {
  if (configured !== 'pg_dump') return configured;
  const found = which('pg_dump');
  if (found) return found;
  const brew = join(HOMEBREW_BIN, 'pg_dump');
  return existsSync(brew) ? brew : configured;
}

/** pg_restore: MESH_PG_RESTORE, sonst neben pg_dump, sonst PATH, sonst Homebrew. */
export function resolvePgRestore(pgDump = 'pg_dump', env: Record<string, string | undefined> = process.env) {
  if (env.MESH_PG_RESTORE) return env.MESH_PG_RESTORE;
  const dump = resolvePgDump(pgDump);
  if (dump.includes('/')) {
    const sibling = join(dirname(dump), 'pg_restore');
    if (existsSync(sibling)) return sibling;
  }
  const found = which('pg_restore');
  if (found) return found;
  const brew = join(HOMEBREW_BIN, 'pg_restore');
  return existsSync(brew) ? brew : 'pg_restore';
}

/** psql: MESH_PSQL, sonst neben pg_dump, sonst PATH, sonst Homebrew. */
export function resolvePsql(pgDump = 'pg_dump', env: Record<string, string | undefined> = process.env) {
  if (env.MESH_PSQL) return env.MESH_PSQL;
  const dump = resolvePgDump(env.MESH_PG_DUMP ?? pgDump);
  if (dump.includes('/')) {
    const sibling = join(dirname(dump), 'psql');
    if (existsSync(sibling)) return sibling;
  }
  const found = which('psql');
  if (found) return found;
  const brew = join(HOMEBREW_BIN, 'psql');
  return existsSync(brew) ? brew : 'psql';
}

/**
 * Trennt das Passwort von einer Verbindungs-URL: { url ohne Passwort, env mit PGPASSWORD }.
 * libpq liest PGPASSWORD, wenn die URL selbst kein Passwort enthält.
 */
export function splitDbUrl(dbUrl: string): { url: string; env: Record<string, string> } {
  const u = new URL(dbUrl);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { url: u.toString(), env: password ? { PGPASSWORD: password } : {} };
}

/** Umgebung für Kindprozesse: nur, was die Werkzeuge brauchen (keine Server-Geheimnisse weitergeben). */
export function toolEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [
    'PATH',
    'HOME',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMPDIR',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'PGCONNECT_TIMEOUT',
  ]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

/** Letzte Zeilen einer Fehlerausgabe, ohne Verbindungs-URLs (könnten Zugangsdaten enthalten). */
export function sanitizeToolOutput(text: string, maxLines = 8): string {
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/g, 'postgres://…')
    .trim()
    .split('\n')
    .slice(-maxLines)
    .join('\n');
}
