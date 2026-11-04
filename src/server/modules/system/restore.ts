/**
 * Wiederherstellung einer verschlüsselten Sicherung (CLI: `bun run cli restore --file … --yes`).
 *
 * WICHTIG: Der Knoten (Server-Prozess) muss während der Wiederherstellung gestoppt sein. Die
 * Wiederherstellung läuft als mesh_owner in EINER Transaktion (psql --single-transaction):
 * schlägt sie fehl, bleibt die Datenbank unverändert.
 *
 * Schritte:
 *  1. Kopf lesen; Manifest (falls vorhanden) gegen SHA-256 der Datei prüfen
 *  2. Knoten-ID prüfen (andere Knoten nur mit allowOtherNode), Schemaversion nicht neuer als dieser Code
 *  3. entschlüsseln in ein temporäres Verzeichnis (0700; GCM-Tag wird vor der Verwendung geprüft)
 *  4. pg_restore --clean --if-exists --no-owner --no-privileges erzeugt daraus ein SQL-Skript
 *  5. psql --single-transaction: BI-Views/-Tabellen entfernen (abgeleitete Daten; die Views hängen an
 *     public.data_release und würden das Neuanlegen blockieren), Skript, Rechte (migrations/grants.sql),
 *     alle Sitzungen beenden (erneute Anmeldung nötig), Audit-Eintrag "backup.restore" mit Kettenprüfung
 *  6. temporäre Dateien löschen, Audit-Kette erneut prüfen
 *
 * Danach: `bun run migrate` (falls die Sicherung ein älteres Schema hat), Knoten starten; die BI-Views
 * werden beim Start (Hintergrundaufgaben) bzw. mit "BI-Views neu aufbauen" aus dem wiederhergestellten
 * Freigabestand neu erzeugt. Ist der Master-Key seit der Sicherung rotiert worden, muss
 * MESH_MASTER_KEY_PREVIOUS gesetzt sein.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import pg from 'pg';
import { listMigrations, MIGRATIONS_DIR } from '../../core/migrate.ts';
import {
  BackupFileError,
  type BackupManifest,
  decryptBackupToFile,
  manifestPath,
  readBackupHeader,
  sha256File,
} from './backup-file.ts';
import { resolvePgRestore, resolvePsql, sanitizeToolOutput, splitDbUrl, toolEnv } from './pg-tools.ts';

export interface RestoreOptions {
  /** Pfad zur .mbk-Datei */
  file: string;
  /** Verbindung als mesh_owner */
  ownerUrl: string;
  /** MESH_BACKUP_KEY (base64) */
  backupKey: string;
  /** MESH_NODE_ID dieses Knotens */
  expectedNodeId: string;
  /** Sicherung eines anderen Knotens zulassen (z. B. Umzug) */
  allowOtherNode?: boolean;
  /** Pfad zu pg_restore (sonst automatisch ermittelt) */
  pgRestore?: string;
  /** Pfad zu psql (sonst automatisch ermittelt) */
  psql?: string;
  migrationsDir?: string;
  /** Verzeichnis für die temporäre Klartextdatei (Standard: Systemtemp) */
  tmpDir?: string;
  log?: (msg: string) => void;
}

export interface RestoreResult {
  fileName: string;
  nodeId: string;
  createdAt: string;
  schemaVersion: string | null;
  sha256: string;
  manifestVerified: boolean;
  sessionsEnded: number;
  audit: { ok: boolean; checked: number; firstBrokenSeq: number | null };
}

export { BackupFileError };

/**
 * Entfernt die abgeleiteten BI-Objekte (Views in "bi", Tabellen in "bi_data"). mesh_owner besitzt beide
 * Schemata und darf deshalb auch Objekte anderer Rollen darin löschen.
 */
const DROP_BI_OBJECTS = `do $$
declare r record;
begin
  -- pg_class statt information_schema: dort fehlen Objekte, auf die mesh_owner keine Rechte hat
  for r in
    select n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('bi', 'bi_data') and c.relkind in ('v', 'm', 'r', 'p')
    order by case c.relkind when 'v' then 0 when 'm' then 1 else 2 end
  loop
    execute format('drop %s if exists %I.%I cascade',
      case r.relkind when 'v' then 'view' when 'm' then 'materialized view' else 'table' end,
      r.nspname, r.relname);
  end loop;
end $$`;

/** SQL-Zeichenkettenliteral (standard_conforming_strings = on) */
function sqlLiteral(s: string): string {
  if (s.includes('\0')) throw new Error('NUL in SQL literal');
  return `'${s.replace(/'/g, "''")}'`;
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreResult> {
  const log = opts.log ?? (() => {});
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const { header } = await readBackupHeader(opts.file);
  const sha256 = await sha256File(opts.file);

  // 1. Manifest
  const mPath = manifestPath(opts.file);
  let manifestVerified = false;
  if (existsSync(mPath)) {
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(readFileSync(mPath, 'utf8')) as BackupManifest;
    } catch {
      throw new BackupFileError('manifest_mismatch', 'manifest is not valid JSON');
    }
    if (manifest.sha256 !== sha256) {
      throw new BackupFileError(
        'manifest_mismatch',
        'SHA-256 of the backup file does not match its manifest',
      );
    }
    if (manifest.nodeId !== header.nodeId) {
      throw new BackupFileError('manifest_mismatch', 'node id in manifest and backup header differ');
    }
    manifestVerified = true;
    log('manifest ok (sha256 matches)');
  } else {
    log('no manifest found; relying on the authentication tag only');
  }

  // 2. Knoten und Schema
  if (header.nodeId !== opts.expectedNodeId && !opts.allowOtherNode) {
    throw new BackupFileError(
      'other_node',
      `backup belongs to node "${header.nodeId}", this node is "${opts.expectedNodeId}" (use --allow-other-node)`,
    );
  }
  const latestLocal = listMigrations(dir).at(-1)?.version ?? null;
  if (header.schemaVersion && latestLocal && header.schemaVersion > latestLocal) {
    throw new BackupFileError(
      'schema_newer',
      `backup schema ${header.schemaVersion} is newer than this software (${latestLocal}); update first`,
    );
  }

  // 3. Entschlüsseln (temporäres Verzeichnis nur für diesen Prozess, 0700)
  const tmp = await mkdtemp(join(opts.tmpDir ?? tmpdir(), 'osp-restore-'));
  const fileName = basename(opts.file);
  try {
    const plain = join(tmp, 'restore.dump');
    await decryptBackupToFile(opts.file, opts.backupKey, plain);
    log('decrypted and authenticated');

    // 4. pg_restore erzeugt das SQL-Skript (keine DB-Verbindung)
    const script = join(tmp, 'restore.sql');
    const dump = Bun.spawn(
      [
        opts.pgRestore ?? resolvePgRestore(),
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
        `--file=${script}`,
        plain,
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: toolEnv({}) },
    );
    const [dumpErr, dumpCode] = await Promise.all([new Response(dump.stderr).text(), dump.exited]);
    if (dumpCode !== 0)
      throw new Error(`pg_restore failed (exit ${dumpCode}): ${sanitizeToolOutput(dumpErr)}`);

    // 5. alles in EINER Transaktion als mesh_owner: BI-Objekte entfernen, Schema + Daten, Rechte,
    //    Sitzungen beenden, Audit-Eintrag (inkl. Prüfung der Kette)
    const epilogue = join(tmp, 'epilogue.sql');
    const details = JSON.stringify({
      sha256,
      sourceNodeId: header.nodeId,
      createdAt: header.createdAt,
      schemaVersion: header.schemaVersion,
      manifestVerified,
    });
    await writeFile(
      epilogue,
      `with s as (delete from user_session returning 1),
     v as (select checked, first_broken_seq from audit_verify())
insert into audit_log (actor_type, actor_id, actor_label, action, outcome, object_type, object_id, details)
select 'system', null, 'cli', 'backup.restore', 'success', 'backup', ${sqlLiteral(fileName)},
  ${sqlLiteral(details)}::jsonb || jsonb_build_object(
    'sessionsEnded', (select count(*) from s),
    'auditOk', (select first_broken_seq is null from v),
    'auditChecked', (select checked from v));
`,
      { mode: 0o600 },
    );
    const { url, env } = splitDbUrl(opts.ownerUrl);
    const psql = Bun.spawn(
      [
        opts.psql ?? resolvePsql(),
        '-X',
        '-q',
        '-v',
        'ON_ERROR_STOP=1',
        '--single-transaction',
        `--dbname=${url}`,
        '-c',
        DROP_BI_OBJECTS,
        '-f',
        script,
        '-c',
        'reset search_path',
        '-f',
        join(dir, 'grants.sql'),
        '-f',
        epilogue,
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: toolEnv(env) },
    );
    const [psqlErr, psqlCode] = await Promise.all([new Response(psql.stderr).text(), psql.exited]);
    if (psqlCode !== 0) {
      throw new Error(
        `restore failed, database unchanged (psql exit ${psqlCode}): ${sanitizeToolOutput(psqlErr)}`,
      );
    }
    log('restored (single transaction: schema, data, grants, sessions, audit entry)');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // 6. Ergebnis lesen
  const client = new pg.Client({
    connectionString: opts.ownerUrl,
    application_name: 'osp-data-mesh-restore',
  });
  await client.connect();
  try {
    const entry = await client.query<{ details: { sessionsEnded?: number } }>(
      "select details from audit_log where action = 'backup.restore' order by seq desc limit 1",
    );
    const v = await client.query<{ checked: string | number; first_broken_seq: string | number | null }>(
      'select * from audit_verify()',
    );
    const row = v.rows[0];
    const firstBrokenSeq = row?.first_broken_seq == null ? null : Number(row.first_broken_seq);
    const audit = { ok: firstBrokenSeq === null, checked: Number(row?.checked ?? 0), firstBrokenSeq };
    const sessionsEnded = Number(entry.rows[0]?.details.sessionsEnded ?? 0);
    log(`${sessionsEnded} sessions ended, audit chain ${audit.ok ? 'ok' : 'BROKEN'}`);
    return {
      fileName,
      nodeId: header.nodeId,
      createdAt: header.createdAt,
      schemaVersion: header.schemaVersion,
      sha256,
      manifestVerified,
      sessionsEnded,
      audit,
    };
  } finally {
    await client.end();
  }
}
