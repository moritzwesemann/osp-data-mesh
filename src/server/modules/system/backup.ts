/**
 * Verschlüsselte Sicherungen (deps.services.backup).
 *
 * Ablauf: pg_dump (Custom-Format, Rolle mesh_app, ohne die BI-Schemata, ohne Eigentümer/Rechte) →
 * streamend AES-256-GCM (siehe backup-file.ts) → <MESH_BACKUP_DIR>/<nodeId>-<UTC-Zeit>.mbk (0600)
 * + Manifest <datei>.mbk.json → backup_run, Audit "backup.create" → Aufbewahrung (älteste löschen).
 *
 * Die BI-Schemata (bi, bi_data) sind abgeleitete Daten und werden nach einer Wiederherstellung neu aufgebaut.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BackupRun } from '../../../shared/contract/system.ts';
import { type Actor, SYSTEM_ACTOR } from '../../core/audit.ts';
import { iso, isoReq } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import type { BackupService, Deps } from '../../core/deps.ts';
import { AppError } from '../../core/errors.ts';
import { BACKUP_FORMAT, type BackupManifest, encryptStreamToFile, manifestPath } from './backup-file.ts';
import { resolvePgDump, sanitizeToolOutput, splitDbUrl, toolEnv } from './pg-tools.ts';

export type BackupTrigger = 'manual' | 'schedule' | 'cli';
type BackupDeps = Pick<Deps, 'config' | 'db' | 'audit' | 'log' | 'now' | 'identity'>;

export function toBackupRun(r: Row<'backup_run'>): BackupRun {
  return {
    id: r.id,
    startedAt: isoReq(r.started_at),
    finishedAt: iso(r.finished_at),
    status: r.status,
    fileName: r.file_name,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    sha256: r.sha256,
    trigger: r.trigger,
    errorCode: r.error_code,
  };
}

/** Dateiname-taugliche UTC-Zeit: 20261104T153012.123Z */
export function backupStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '');
}

class BackupFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class BackupManager implements BackupService {
  private running = false;

  constructor(private readonly deps: BackupDeps) {}

  async runBackup(trigger: BackupTrigger, userId: string | null): Promise<BackupRun> {
    if (this.running) throw new AppError('conflict', { reason: 'backup_running' });
    this.running = true;
    try {
      return await this.run(trigger, userId);
    } finally {
      this.running = false;
    }
  }

  private async actorFor(trigger: BackupTrigger, userId: string | null): Promise<Actor> {
    if (userId) {
      const u = await this.deps.db
        .selectFrom('app_user')
        .select('email')
        .where('id', '=', userId)
        .executeTakeFirst();
      return { type: 'user', id: userId, label: u?.email ?? null };
    }
    return trigger === 'cli' ? { type: 'system', id: null, label: 'cli' } : SYSTEM_ACTOR;
  }

  private async run(trigger: BackupTrigger, userId: string | null): Promise<BackupRun> {
    const { config, db, log } = this.deps;
    const startedAt = this.deps.now();
    const actor = await this.actorFor(trigger, userId);
    const run = await db
      .insertInto('backup_run')
      .values({ status: 'running', trigger, created_by: userId, started_at: startedAt })
      .returningAll()
      .executeTakeFirstOrThrow();

    let path: string | null = null;
    try {
      const key = config.MESH_BACKUP_KEY;
      if (!key) throw new BackupFailure('backup_key_missing', 'MESH_BACKUP_KEY is not set');

      const dir = resolve(config.MESH_BACKUP_DIR);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (err) {
        throw new BackupFailure('backup_dir_unavailable', (err as Error).message);
      }
      const nodeId = this.deps.identity.nodeId;
      const fileName = `${nodeId}-${backupStamp(startedAt)}.mbk`;
      path = join(dir, fileName);

      const latest = await db
        .selectFrom('schema_migration')
        .select((eb) => eb.fn.max('version').as('v'))
        .executeTakeFirst();
      const schemaVersion = latest?.v ?? null;

      const { url, env } = splitDbUrl(config.MESH_DB_URL);
      const pgDump = resolvePgDump(config.MESH_PG_DUMP);
      let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>;
      try {
        proc = Bun.spawn(
          [
            pgDump,
            '--format=custom',
            '--exclude-schema=bi',
            '--exclude-schema=bi_data',
            '--no-owner',
            '--no-privileges',
            `--dbname=${url}`,
          ],
          { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: toolEnv(env) },
        );
      } catch (err) {
        throw new BackupFailure('pg_dump_unavailable', (err as Error).message);
      }
      const stderr = new Response(proc.stderr).text();
      let written: Awaited<ReturnType<typeof encryptStreamToFile>>;
      try {
        written = await encryptStreamToFile(
          proc.stdout,
          key,
          { nodeId, createdAt: startedAt.toISOString(), schemaVersion },
          path,
        );
      } catch (err) {
        proc.kill();
        await proc.exited;
        throw new BackupFailure('backup_write_failed', (err as Error).message);
      }
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new BackupFailure(
          'pg_dump_failed',
          `pg_dump exited with ${exitCode}: ${sanitizeToolOutput(await stderr)}`,
        );
      }

      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        fileName,
        nodeId,
        createdAt: startedAt.toISOString(),
        schemaVersion,
        sha256: written.sha256,
        sizeBytes: written.sizeBytes,
        keyId: written.header.keyId,
        cipher: 'aes-256-gcm',
      };
      writeFileSync(manifestPath(path), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      const removed = this.applyRetention(dir, nodeId, fileName);
      const done = await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('backup_run')
          .set({
            status: 'ok',
            finished_at: this.deps.now(),
            file_name: fileName,
            size_bytes: written.sizeBytes,
            sha256: written.sha256,
          })
          .where('id', '=', run.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.deps.audit.record(
          {
            actor,
            action: 'backup.create',
            objectType: 'backup_run',
            objectId: run.id,
            details: {
              trigger,
              fileName,
              sizeBytes: written.sizeBytes,
              sha256: written.sha256,
              removedOld: removed,
            },
          },
          trx,
        );
        return updated;
      });
      log.info('backup created', { runId: run.id, fileName, sizeBytes: written.sizeBytes, trigger });
      return toBackupRun(done);
    } catch (err) {
      const code = err instanceof BackupFailure ? err.code : 'backup_failed';
      if (path) {
        rmSync(path, { force: true });
        rmSync(manifestPath(path), { force: true });
      }
      log.error('backup failed', { runId: run.id, code, error: (err as Error).message, trigger });
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('backup_run')
          .set({ status: 'failed', finished_at: this.deps.now(), error_code: code })
          .where('id', '=', run.id)
          .execute();
        await this.deps.audit.record(
          {
            actor,
            action: 'backup.create',
            outcome: 'error',
            objectType: 'backup_run',
            objectId: run.id,
            details: { trigger, errorCode: code },
          },
          trx,
        );
      });
      throw new AppError('backup_failed', { reason: code, cause: err });
    }
  }

  /** Behält die neuesten MESH_BACKUP_RETENTION Sicherungen dieses Knotens; löscht ältere samt Manifest. */
  private applyRetention(dir: string, nodeId: string, keep: string): number {
    // nur Dateien genau dieses Knotens (Knoten-IDs enthalten nur [a-z0-9-], keine Regex-Sonderzeichen)
    const pattern = new RegExp(`^${nodeId}-\\d{8}T\\d{6}(\\.\\d{3})?Z\\.mbk$`);
    const files = readdirSync(dir)
      .filter((f) => pattern.test(f))
      .sort()
      .reverse();
    let removed = 0;
    for (const f of files.slice(this.deps.config.MESH_BACKUP_RETENTION)) {
      if (f === keep) continue;
      rmSync(join(dir, f), { force: true });
      rmSync(manifestPath(join(dir, f)), { force: true });
      removed++;
    }
    return removed;
  }
}
