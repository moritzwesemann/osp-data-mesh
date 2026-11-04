/**
 * Modul "system": Health-Checks, Systemstatus, Fehlerprotokoll, Sicherungen (services.backup),
 * OpenAPI-Dokument unter GET /api/v1/openapi.json.
 */
import { sql } from 'kysely';
import { APP_VERSION } from '../../config.ts';
import { isoReq } from '../../core/db.ts';
import type { Deps, Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';
import { listMigrations } from '../../core/migrate.ts';
import { BackupManager, toBackupRun } from './backup.ts';
import { buildOpenApiDocument } from './openapi.ts';

function latestMigrationFile(): string | null {
  try {
    return listMigrations().at(-1)?.version ?? null;
  } catch {
    return null;
  }
}

async function count(q: Promise<{ n: string | number | bigint } | undefined>): Promise<number> {
  const r = await q;
  return Number(r?.n ?? 0);
}

/** Prüft die Hash-Kette des Audit-Logs (Funktion audit_verify() in der Datenbank) */
async function verifyAuditChain(db: Deps['db']) {
  const r = await sql<{
    checked: number | string;
    first_broken_seq: number | string | null;
  }>`select * from audit_verify()`.execute(db);
  const row = r.rows[0];
  const firstBrokenSeq = row?.first_broken_seq == null ? null : Number(row.first_broken_seq);
  return { ok: firstBrokenSeq === null, checked: Number(row?.checked ?? 0), firstBrokenSeq };
}

/** Prüfintervall des Sicherungsplaners */
const SCHEDULER_TICK_MS = 10 * 60_000;
/** nach einer fehlgeschlagenen geplanten Sicherung frühestens nach dieser Zeit erneut versuchen */
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let firstTick: ReturnType<typeof setTimeout> | null = null;

/** Ist eine geplante Sicherung fällig? (berücksichtigt auch Sicherungen über CLI/Oberfläche) */
async function backupDue(deps: Deps): Promise<boolean> {
  const intervalMs = deps.config.MESH_BACKUP_INTERVAL_HOURS * 3600_000;
  const now = deps.now().getTime();
  const lastOk = await deps.db
    .selectFrom('backup_run')
    .select('started_at')
    .where('status', 'in', ['ok', 'running'])
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (lastOk && now - lastOk.started_at.getTime() < intervalMs) return false;
  const lastAttempt = await deps.db
    .selectFrom('backup_run')
    .select('started_at')
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return (
    !lastAttempt || now - lastAttempt.started_at.getTime() >= Math.min(intervalMs, RETRY_AFTER_FAILURE_MS)
  );
}

async function scheduledBackup(deps: Deps): Promise<void> {
  try {
    if (await backupDue(deps)) await deps.services.backup.runBackup('schedule', null);
  } catch (err) {
    // Fehlschläge stehen in backup_run/Audit; hier nur loggen
    deps.log.warn('scheduled backup did not complete', { error: (err as Error).message });
  }
}

export const systemModule: Module = {
  name: 'system',

  init(deps) {
    deps.services.backup = new BackupManager(deps);
  },

  routes(app, deps) {
    let openapi: Record<string, unknown> | null = null;
    app.get('/api/v1/openapi.json', (c) => {
      openapi ??= buildOpenApiDocument();
      return c.json(openapi);
    });

    const expectedMigration = latestMigrationFile();

    registerRoutes(app, deps, {
      'health.live': async () => ({ status: 'ok' as const }),

      'health.ready': async ({ c }) => {
        let db = false;
        let schema = false;
        try {
          await sql`select 1`.execute(deps.db);
          db = true;
          const r = await deps.db
            .selectFrom('schema_migration')
            .select((eb) => eb.fn.max('version').as('v'))
            .executeTakeFirst();
          schema = !!expectedMigration && r?.v === expectedMigration;
        } catch {
          // nicht bereit
        }
        const body = { status: db && schema ? ('ok' as const) : ('degraded' as const), db, schema };
        // 503, damit Orchestrierung/Proxy den Knoten als nicht bereit erkennt
        return body.status === 'ok' ? body : c.json(body, 503);
      },

      'system.status': async () => {
        const now = deps.now();
        const [migrations, audit, lastBackup, outboxPending, outboxFailed, biViews, biErrors, errors24h] =
          await Promise.all([
            deps.db
              .selectFrom('schema_migration')
              .select(['version', 'name'])
              .orderBy('version', 'desc')
              .execute()
              .catch(() => null),
            verifyAuditChain(deps.db),
            deps.db
              .selectFrom('backup_run')
              .selectAll()
              .orderBy('started_at', 'desc')
              .limit(1)
              .executeTakeFirst(),
            count(
              deps.db
                .selectFrom('outbox_message')
                .select((eb) => eb.fn.countAll<string>().as('n'))
                .where('status', '=', 'pending')
                .executeTakeFirst(),
            ),
            count(
              deps.db
                .selectFrom('outbox_message')
                .select((eb) => eb.fn.countAll<string>().as('n'))
                .where('status', '=', 'failed')
                .executeTakeFirst(),
            ),
            count(
              deps.db
                .selectFrom('bi_view')
                .select((eb) => eb.fn.countAll<string>().as('n'))
                .where('status', '<>', 'dropped')
                .executeTakeFirst(),
            ),
            count(
              deps.db
                .selectFrom('bi_view')
                .select((eb) => eb.fn.countAll<string>().as('n'))
                .where('status', '=', 'error')
                .executeTakeFirst(),
            ),
            count(
              deps.db
                .selectFrom('app_error')
                .select((eb) => eb.fn.countAll<string>().as('n'))
                .where('at', '>', new Date(now.getTime() - 24 * 3600_000))
                .executeTakeFirst(),
            ),
          ]);
        return {
          version: APP_VERSION,
          node: {
            nodeId: deps.identity.nodeId,
            displayName: deps.identity.displayName,
            fingerprint: deps.identity.fingerprint,
            baseUrl: deps.identity.baseUrl,
          },
          db: {
            ok: migrations !== null,
            latestMigration: migrations?.[0]?.name ?? null,
            migrations: migrations?.length ?? 0,
          },
          audit,
          backups: {
            last: lastBackup ? toBackupRun(lastBackup) : null,
            intervalHours: deps.config.MESH_BACKUP_INTERVAL_HOURS,
            encrypted: !!deps.config.MESH_BACKUP_KEY,
          },
          outbox: { pending: outboxPending, failed: outboxFailed },
          bi: { views: biViews, errors: biErrors },
          errors24h,
          uptimeSeconds: Math.max(0, Math.round((now.getTime() - deps.startedAt.getTime()) / 1000)),
          time: now.toISOString(),
        };
      },

      'system.errors': async ({ query }) => {
        const [rows, total] = await Promise.all([
          deps.db
            .selectFrom('app_error')
            .select(['id', 'at', 'request_id', 'method', 'path', 'status', 'code'])
            .orderBy('id', 'desc')
            .limit(query.pageSize)
            .offset((query.page - 1) * query.pageSize)
            .execute(),
          count(
            deps.db
              .selectFrom('app_error')
              .select((eb) => eb.fn.countAll<string>().as('n'))
              .executeTakeFirst(),
          ),
        ]);
        return {
          items: rows.map((r) => ({
            id: Number(r.id),
            at: isoReq(r.at),
            requestId: r.request_id,
            method: r.method,
            path: r.path,
            status: r.status,
            code: r.code,
          })),
          total,
          page: query.page,
          pageSize: query.pageSize,
        };
      },

      'system.backups': async () => {
        const rows = await deps.db
          .selectFrom('backup_run')
          .selectAll()
          .orderBy('started_at', 'desc')
          .limit(200)
          .execute();
        return { items: rows.map(toBackupRun) };
      },

      'system.backupNow': async ({ user }) => deps.services.backup.runBackup('manual', user.id),
    });
  },

  start(deps) {
    if (deps.config.MESH_BACKUP_INTERVAL_HOURS <= 0) return;
    if (!deps.config.MESH_BACKUP_KEY) {
      deps.log.warn('scheduled backups disabled: MESH_BACKUP_KEY is not set');
      return;
    }
    const tick = Math.min(SCHEDULER_TICK_MS, deps.config.MESH_BACKUP_INTERVAL_HOURS * 3600_000);
    firstTick = setTimeout(() => void scheduledBackup(deps), 60_000);
    schedulerTimer = setInterval(() => void scheduledBackup(deps), tick);
    firstTick.unref?.();
    schedulerTimer.unref?.();
  },

  stop() {
    if (firstTick) clearTimeout(firstTick);
    if (schedulerTimer) clearInterval(schedulerTimer);
    firstTick = null;
    schedulerTimer = null;
  },
};
