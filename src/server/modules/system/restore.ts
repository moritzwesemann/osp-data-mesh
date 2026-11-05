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
 *  5. Kopf der Audit-Kette der bisherigen Datenbank festhalten (Epoche, Laufnummer, gespeicherter Hash;
 *     ADR 0014, Nachtrag 2), dann psql --single-transaction: BI-Views/-Tabellen entfernen (abgeleitete
 *     Daten; die Views hängen an public.data_release und würden das Neuanlegen blockieren), Skript, Rechte
 *     (migrations/grants.sql), alle Sitzungen beenden (erneute Anmeldung nötig), neue Epoche der Audit-Kette
 *     (audit_chain_epoch: vorige Epoche, höchste übernommene Laufnummer, Prüfsumme und Zeitpunkt der
 *     Sicherung, Kopf davor), Audit-Eintrag "backup.restore" mit Kettenprüfung und Epoche
 *  6. temporäre Dateien löschen, Audit-Kette im Programm neu berechnen (modules/audit/chain.ts – nicht nur
 *     audit_verify() der Datenbank, deren Funktion aus der Sicherung stammt) und beide Ergebnisse melden
 *
 * Die CLI prüft vorher, dass der Knoten nicht läuft (runningNodeConnections; --force übergeht das).
 *
 * Danach: `bun --env-file=.env --env-file=.env.owner run cli migrate` (falls die Sicherung ein älteres
 * Schema hat), Knoten starten; die BI-Views
 * werden beim Start (Hintergrundaufgaben) bzw. mit "BI-Views neu aufbauen" aus dem wiederhergestellten
 * Freigabestand neu erzeugt. Ist der Master-Key seit der Sicherung rotiert worden, muss
 * MESH_MASTER_KEY_PREVIOUS gesetzt sein.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import pg from 'pg';
import { createDb, SERVER_APPLICATION_NAME } from '../../core/db.ts';
import { listMigrations, MIGRATIONS_DIR } from '../../core/migrate.ts';
import { type ChainBreak, recomputeAuditChain } from '../audit/chain.ts';
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
  /**
   * Prüfung der Kette nach der Wiederherstellung: im Programm neu berechnet (maßgeblich); `database` =
   * audit_verify() der wiederhergestellten Datenbank zum Vergleich
   */
  audit: {
    ok: boolean;
    checked: number;
    firstBrokenSeq: number | null;
    breakKind: ChainBreak | null;
    database: { ok: boolean; checked: number; firstBrokenSeq: number | null };
  };
  /** neue Epoche der Audit-Kette (null bei Sicherungen vor Migration 0610) */
  epoch: { epoch: string; previousEpoch: string | null; restoredSeq: number } | null;
  /** Kopf der Kette der bisherigen Datenbank unmittelbar vor der Wiederherstellung (null = leer/unbekannt) */
  preRestore: { epoch: string | null; seq: number; hash: string } | null;
}

export { BackupFileError };

/**
 * Verbindungen eines laufenden Knotens zur Datenbank von ownerUrl (application_name des Server-Pools,
 * core/db.ts). Die Wiederherstellung ersetzt die ganze Datenbank; ein laufender Knoten schriebe danach mit
 * veraltetem Stand weiter (Sitzungen, Ausgangspostfach, BI) oder blockierte sie.
 */
export async function runningNodeConnections(ownerUrl: string): Promise<number> {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'osp-data-mesh-restore' });
  await client.connect();
  try {
    const r = await client.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and application_name = $1 and pid <> pg_backend_pid()`,
      [SERVER_APPLICATION_NAME],
    );
    return r.rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

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

/**
 * Kopf der Audit-Kette und aktuelle Epoche der Datenbank, die ersetzt wird (gespeicherter Hash: den haben
 * Partner in ihren Prüfpunkten). null, wenn die Datenbank (noch) kein Audit-Log hat.
 */
async function preRestoreHead(ownerUrl: string): Promise<RestoreResult['preRestore']> {
  const client = new pg.Client({ connectionString: ownerUrl, application_name: 'osp-data-mesh-restore' });
  await client.connect();
  try {
    const has = await client.query<{ log: boolean; epoch: boolean }>(
      `select to_regclass('public.audit_log') is not null as log,
              to_regclass('public.audit_chain_epoch') is not null as epoch`,
    );
    if (!has.rows[0]?.log) return null;
    const head = await client.query<{ seq: string; hash: string }>(
      // nach der Spalte ordnen (nicht nach dem Textalias)
      'select a.seq::text as seq, a.hash from public.audit_log a where a.seq is not null order by a.seq desc limit 1',
    );
    const h = head.rows[0];
    if (!h) return null;
    let epoch: string | null = null;
    if (has.rows[0]?.epoch) {
      const e = await client.query<{ epoch: string }>(
        'select epoch::text as epoch from public.audit_chain_epoch order by n desc limit 1',
      );
      epoch = e.rows[0]?.epoch ?? null;
    }
    return { epoch, seq: Number(h.seq), hash: h.hash };
  } finally {
    await client.end();
  }
}

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
  let preRestore: RestoreResult['preRestore'] = null;
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

    // 5. Kopf der bisherigen Kette festhalten (der Knoten ist gestoppt, Knotensperre: CLI), dann alles in
    //    EINER Transaktion als mesh_owner: BI-Objekte entfernen, Schema + Daten, Rechte, Sitzungen beenden,
    //    Audit-Eintrag (inkl. Prüfung der Kette)
    preRestore = await preRestoreHead(opts.ownerUrl);
    const epilogue = join(tmp, 'epilogue.sql');
    const details = JSON.stringify({
      sha256,
      sourceNodeId: header.nodeId,
      createdAt: header.createdAt,
      schemaVersion: header.schemaVersion,
      manifestVerified,
      preRestore,
    });
    const pre = preRestore;
    const preEpoch = pre?.epoch ? `${sqlLiteral(pre.epoch)}::uuid` : 'null';
    const preSeq = pre ? `${pre.seq}::bigint` : 'null';
    const preHash = pre ? sqlLiteral(pre.hash) : 'null';
    await writeFile(
      epilogue,
      // Neue Epoche der Audit-Kette (ADR 0014): die Sicherung bringt den Epochenverlauf ihres Stands mit; die
      // Einträge 1..restored_seq stammen aus deren aktueller Epoche, alles danach ist neu. Partner verwahren
      // Prüfpunkte je Epoche, sodass die neu vergebenen Laufnummern nicht als Widerspruch gelten.
      // Datenbanken vor Migration 0610 haben keine Epochen: dann ohne (die Migration legt die erste an).
      `do $restore$
declare
  d jsonb := ${sqlLiteral(details)}::jsonb;
  ended bigint;
  v record;
  e jsonb;
begin
  delete from user_session;
  get diagnostics ended = row_count;
  select checked, first_broken_seq into v from audit_verify();
  if to_regclass('public.audit_chain_epoch') is not null then
    if exists (select 1 from pg_attribute where attrelid = 'public.audit_chain_epoch'::regclass
                and attname = 'pre_restore_seq' and not attisdropped) then
      -- Migration 0630: Kopf der bisherigen Kette mit festhalten
      insert into audit_chain_epoch (n, epoch, started_at, reason, previous_epoch, restored_seq,
                                     backup_sha256, backup_created_at,
                                     pre_restore_epoch, pre_restore_seq, pre_restore_hash)
      select coalesce(max(n), 0) + 1, gen_random_uuid(), clock_timestamp(), 'restore',
             (select epoch from audit_chain_epoch order by n desc limit 1),
             (select coalesce(max(seq), 0) from audit_log),
             ${sqlLiteral(sha256)}, ${sqlLiteral(header.createdAt)}::timestamptz,
             ${preEpoch}, ${preSeq}, ${preHash}
        from audit_chain_epoch
      returning jsonb_build_object('epoch', epoch, 'previousEpoch', previous_epoch, 'restoredSeq', restored_seq)
        into e;
    else
      insert into audit_chain_epoch (n, epoch, started_at, reason, previous_epoch, restored_seq,
                                     backup_sha256, backup_created_at)
      select coalesce(max(n), 0) + 1, gen_random_uuid(), clock_timestamp(), 'restore',
             (select epoch from audit_chain_epoch order by n desc limit 1),
             (select coalesce(max(seq), 0) from audit_log),
             ${sqlLiteral(sha256)}, ${sqlLiteral(header.createdAt)}::timestamptz
        from audit_chain_epoch
      returning jsonb_build_object('epoch', epoch, 'previousEpoch', previous_epoch, 'restoredSeq', restored_seq)
        into e;
    end if;
    d := d || e;
  end if;
  insert into audit_log (actor_type, actor_id, actor_label, action, outcome, object_type, object_id, details)
  values ('system', null, 'cli', 'backup.restore', 'success', 'backup', ${sqlLiteral(fileName)},
          d || jsonb_build_object('sessionsEnded', ended, 'auditOk', v.first_broken_seq is null,
                                  'auditChecked', v.checked));
end $restore$;
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
    const entry = await client.query<{
      details: {
        sessionsEnded?: number;
        epoch?: string;
        previousEpoch?: string | null;
        restoredSeq?: number;
      };
    }>("select details from audit_log where action = 'backup.restore' order by seq desc limit 1");
    const v = await client.query<{ checked: string | number; first_broken_seq: string | number | null }>(
      'select * from audit_verify()',
    );
    const row = v.rows[0];
    const dbBroken = row?.first_broken_seq == null ? null : Number(row.first_broken_seq);
    const database = { ok: dbBroken === null, checked: Number(row?.checked ?? 0), firstBrokenSeq: dbBroken };
    // maßgeblich: im Programm neu berechnet (audit_verify() stammt aus der wiederhergestellten Datenbank)
    const db = createDb(opts.ownerUrl, 1);
    let chain: Awaited<ReturnType<typeof recomputeAuditChain>>;
    try {
      chain = await recomputeAuditChain(db);
    } finally {
      await db.destroy();
    }
    const audit: RestoreResult['audit'] = {
      ok: chain.ok && database.ok,
      checked: chain.checked,
      firstBrokenSeq: chain.firstBrokenSeq ?? database.firstBrokenSeq,
      breakKind: chain.breakKind,
      database,
    };
    const d = entry.rows[0]?.details;
    const sessionsEnded = Number(d?.sessionsEnded ?? 0);
    const epoch =
      d?.epoch !== undefined
        ? { epoch: d.epoch, previousEpoch: d.previousEpoch ?? null, restoredSeq: Number(d.restoredSeq ?? 0) }
        : null;
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
      epoch,
      preRestore,
    };
  } finally {
    await client.end();
  }
}
