/**
 * Befehle der Betriebs-CLI (siehe main.ts).
 */
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { z } from 'zod';
import { buildDeps } from '../app.ts';
import { loadConfig } from '../config.ts';
import type { Actor } from '../core/audit.ts';
import { AuditWriter } from '../core/audit.ts';
import { randomToken, SecretBox } from '../core/crypto.ts';
import { createDb, type Db, pgCode } from '../core/db.ts';
import { migrate } from '../core/migrate.ts';
import { NodeIdentity } from '../core/node-identity.ts';
import { passwordPolicyViolation } from '../modules/auth/policy.ts';
import { hashPassword } from '../modules/auth/sessions.ts';
import { BackupManager } from '../modules/system/backup.ts';
import { BackupFileError } from '../modules/system/backup-file.ts';
import { resolvePsql, sanitizeToolOutput, splitDbUrl, toolEnv } from '../modules/system/pg-tools.ts';
import { restoreBackup } from '../modules/system/restore.ts';

export class UsageError extends Error {}

export type Command = (args: string[]) => Promise<number>;

const CLI_ACTOR: Actor = { type: 'system', id: null, label: 'cli' };
const ROOT = resolve(import.meta.dir, '../../..');

interface Parsed {
  flags: Record<string, string | true>;
  positionals: string[];
}

export function parseArgs(args: string[], booleans: readonly string[] = []): Parsed {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) flags[key] = a.slice(eq + 1);
    else if (booleans.includes(key)) flags[key] = true;
    else {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--'))
        throw new UsageError(`--${key} braucht einen Wert / needs a value`);
      flags[key] = v;
      i++;
    }
  }
  return { flags, positionals };
}

function flag(p: Parsed, name: string, required: true): string;
function flag(p: Parsed, name: string, required?: false): string | undefined;
function flag(p: Parsed, name: string, required = false): string | undefined {
  const v = p.flags[name];
  if (v === true) throw new UsageError(`--${name} braucht einen Wert / needs a value`);
  if (v === undefined && required) throw new UsageError(`--${name} fehlt / is required`);
  return v;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt / environment variable ${name} is not set`);
  return v;
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

async function withDb<T>(url: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = createDb(url, 2);
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

async function verifyAudit(db: Db) {
  const r = await sql<{
    checked: number | string;
    first_broken_seq: number | string | null;
  }>`select * from audit_verify()`.execute(db);
  const row = r.rows[0];
  const firstBrokenSeq = row?.first_broken_seq == null ? null : Number(row.first_broken_seq);
  return { ok: firstBrokenSeq === null, checked: Number(row?.checked ?? 0), firstBrokenSeq };
}

/** Wert für psql "\set name '…'" (einfache Anführungszeichen, Backslash-Escapes) */
function psqlQuote(v: string): string {
  if (/[\r\n\0]/.test(v)) throw new Error('value must not contain line breaks');
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export const commands: Record<string, Command> = {
  async migrate() {
    const url = env('MESH_DB_OWNER_URL');
    const r = await migrate(url, { log: (m) => out(m) });
    out(`angewandt / applied: ${r.applied.length ? r.applied.join(', ') : '–'}`);
    out(`bereits vorhanden / skipped: ${r.skipped.length}`);
    return 0;
  },

  async 'db-bootstrap'(args) {
    const p = parseArgs(args);
    const superuserUrl = flag(p, 'superuser-url', true);
    const dbName = flag(p, 'db') ?? 'mesh';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName))
      throw new UsageError('--db: nur a-z, 0-9, _ / only a-z, 0-9, _');
    const missing = ['MESH_DB_OWNER_PASSWORD', 'MESH_DB_APP_PASSWORD', 'MESH_DB_BI_PASSWORD'].filter(
      (k) => !process.env[k],
    );
    if (missing.length)
      throw new Error(`Umgebungsvariablen fehlen / missing environment: ${missing.join(', ')}`);
    // Passwörter über stdin (nicht als Argumente, sonst in der Prozessliste sichtbar)
    const script = [
      `\\set db_name ${psqlQuote(dbName)}`,
      `\\set owner_password ${psqlQuote(env('MESH_DB_OWNER_PASSWORD'))}`,
      `\\set app_password ${psqlQuote(env('MESH_DB_APP_PASSWORD'))}`,
      `\\set bi_password ${psqlQuote(env('MESH_DB_BI_PASSWORD'))}`,
      `\\i ${psqlQuote(resolve(ROOT, 'deploy/postgres/bootstrap.sql'))}`,
      '',
    ].join('\n');
    const { url, env: pgEnv } = splitDbUrl(superuserUrl);
    const proc = Bun.spawn(
      [resolvePsql(), '-q', '-X', '-v', 'ON_ERROR_STOP=1', `--dbname=${url}`, '-f', '-'],
      {
        stdin: Buffer.from(script),
        stdout: 'pipe',
        stderr: 'pipe',
        env: toolEnv(pgEnv),
      },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`psql failed (exit ${code}): ${sanitizeToolOutput(stderr)}`);
    out(`Datenbank "${dbName}" und Rollen mesh_owner, mesh_app, mesh_bi eingerichtet / bootstrapped.`);
    out('Weiter / next: bun run migrate (MESH_DB_OWNER_URL)');
    return 0;
  },

  async 'gen-key'() {
    out(randomBytes(32).toString('base64'));
    return 0;
  },

  async 'create-admin'(args) {
    const p = parseArgs(args);
    const emailRaw = flag(p, 'email', true);
    const name = flag(p, 'name', true).trim();
    const email = z.email().max(254).safeParse(emailRaw.trim().toLowerCase());
    if (!email.success)
      throw new UsageError('--email ist keine gültige E-Mail-Adresse / is not a valid email');
    if (!name || name.length > 200) throw new UsageError('--name: 1–200 Zeichen / characters');
    const dbUrl = env('MESH_DB_URL');
    const provided = process.env.MESH_ADMIN_PASSWORD;
    const password = provided ?? randomToken(18);
    if (provided) {
      const violation = passwordPolicyViolation(provided, { email: email.data });
      if (violation)
        throw new Error(`MESH_ADMIN_PASSWORD erfüllt die Passwortregeln nicht / too weak (${violation})`);
    }
    const hash = await hashPassword(password);
    const id = await withDb(dbUrl, async (db) => {
      try {
        return await db.transaction().execute(async (trx) => {
          const row = await trx
            .insertInto('app_user')
            .values({
              email: email.data,
              display_name: name,
              password_hash: hash,
              roles: ['admin'],
              must_change_password: !provided,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await new AuditWriter(trx).record({
            actor: CLI_ACTOR,
            action: 'user.create',
            objectType: 'user',
            objectId: row.id,
            details: { roles: ['admin'], via: 'cli' },
          });
          return row.id;
        });
      } catch (err) {
        if (pgCode(err) === '23505')
          throw new Error(`E-Mail existiert bereits / email already exists: ${email.data}`);
        throw err;
      }
    });
    out(`Administrator angelegt / admin created: ${email.data} (${id})`);
    if (!provided) {
      out(`Initialpasswort (nur jetzt sichtbar) / initial password (shown once): ${password}`);
      out('Das Passwort muss bei der ersten Anmeldung geändert werden / must be changed at first login.');
    }
    return 0;
  },

  async backup() {
    const config = loadConfig();
    const deps = await buildDeps({ config });
    try {
      const run = await new BackupManager(deps).runBackup('cli', null);
      out(`Sicherung erstellt / backup created: ${resolve(config.MESH_BACKUP_DIR, run.fileName ?? '')}`);
      out(`  Größe / size: ${run.sizeBytes} bytes, sha256: ${run.sha256}`);
      return 0;
    } catch (err) {
      const reason = (err as { reason?: string }).reason;
      throw new Error(`Sicherung fehlgeschlagen / backup failed${reason ? ` (${reason})` : ''}`);
    } finally {
      await deps.db.destroy();
    }
  },

  async restore(args) {
    const p = parseArgs(args, ['yes', 'allow-other-node']);
    const file = flag(p, 'file', true);
    if (p.flags.yes !== true) {
      throw new UsageError(
        'restore überschreibt die Datenbank; Knoten stoppen und mit --yes bestätigen / overwrites the database; stop the node and confirm with --yes',
      );
    }
    const ownerUrl = env('MESH_DB_OWNER_URL');
    const backupKey = env('MESH_BACKUP_KEY');
    const nodeId = env('MESH_NODE_ID');
    try {
      const r = await restoreBackup({
        file: resolve(file),
        ownerUrl,
        backupKey,
        expectedNodeId: nodeId,
        allowOtherNode: p.flags['allow-other-node'] === true,
        log: (m) => out(`  ${m}`),
      });
      out(`Wiederhergestellt / restored: ${r.fileName}`);
      out(
        `  Knoten / node: ${r.nodeId}, erstellt / created: ${r.createdAt}, Schema: ${r.schemaVersion ?? '?'}`,
      );
      out(`  Manifest geprüft / verified: ${r.manifestVerified ? 'ja/yes' : 'nein/no (keine Begleitdatei)'}`);
      out(`  Sitzungen beendet / sessions ended: ${r.sessionsEnded}`);
      out(
        `  Audit-Kette / audit chain: ${r.audit.ok ? 'ok' : `GEBROCHEN bei / BROKEN at seq ${r.audit.firstBrokenSeq}`} (${r.audit.checked} geprüft / checked)`,
      );
      out(
        'Weiter / next: bun run migrate, Knoten starten / start node, BI-Views neu aufbauen / refresh BI views.',
      );
      return r.audit.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof BackupFileError) throw new Error(`${err.code}: ${err.message}`);
      throw err;
    }
  },

  async 'verify-audit'() {
    const url = process.env.MESH_DB_URL ?? env('MESH_DB_OWNER_URL');
    const r = await withDb(url, verifyAudit);
    if (r.ok) out(`Audit-Kette ok / audit chain ok (${r.checked} Einträge / entries)`);
    else
      out(
        `Audit-Kette GEBROCHEN bei seq ${r.firstBrokenSeq} / audit chain BROKEN (${r.checked} ok davor / before)`,
      );
    return r.ok ? 0 : 1;
  },

  async 'rotate-master-key'() {
    const next = env('MESH_MASTER_KEY');
    const previous = env('MESH_MASTER_KEY_PREVIOUS');
    const url = process.env.MESH_DB_URL ?? env('MESH_DB_OWNER_URL');
    const box = new SecretBox(next, previous);
    const r = await withDb(url, (db) =>
      db.transaction().execute(async (trx) => {
        const identity = await NodeIdentity.reseal(trx, box);
        const rows = await trx
          .selectFrom('connector')
          .select(['id', 'secret_enc'])
          .where('secret_enc', 'is not', null)
          .forUpdate()
          .execute();
        let connectors = 0;
        for (const row of rows) {
          if (!row.secret_enc || !box.needsReseal(row.secret_enc)) continue;
          const aad = `connector.secret:${row.id}`;
          await trx
            .updateTable('connector')
            .set({ secret_enc: box.seal(box.openBytes(row.secret_enc, aad), aad) })
            .where('id', '=', row.id)
            .execute();
          connectors++;
        }
        await new AuditWriter(trx).record({
          actor: CLI_ACTOR,
          action: 'system.master_key_rotated',
          objectType: 'master_key',
          objectId: box.currentKeyId,
          details: {
            identityResealed: identity,
            connectorsResealed: connectors,
            connectorsTotal: rows.length,
          },
        });
        return { identity, connectors, total: rows.length };
      }),
    );
    out(`Master-Key rotiert / rotated (neue Schlüssel-ID / new key id ${box.currentKeyId})`);
    out(
      `  Knotenidentität / node identity: ${r.identity ? 'neu verschlüsselt / resealed' : 'bereits aktuell / up to date'}`,
    );
    out(
      `  Connector-Geheimnisse / connector secrets: ${r.connectors} von / of ${r.total} neu verschlüsselt / resealed`,
    );
    out('MESH_MASTER_KEY_PREVIOUS kann jetzt entfernt werden / can now be removed.');
    return 0;
  },

  async 'node-card'() {
    const config = loadConfig();
    const deps = await buildDeps({ config });
    try {
      out(JSON.stringify(deps.identity.card(), null, 2));
      return 0;
    } finally {
      await deps.db.destroy();
    }
  },
};
