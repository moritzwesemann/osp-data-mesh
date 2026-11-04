import { z } from 'zod';
import { IsoDateTime, Pagination, paginated, Uuid } from './common.ts';
import { route } from './route.ts';

export const AuditEntry = z.object({
  id: z.number().int(),
  seq: z.number().int(),
  at: IsoDateTime,
  actorType: z.enum(['user', 'peer', 'system', 'anonymous']),
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  action: z.string(),
  objectType: z.string().nullable(),
  objectId: z.string().nullable(),
  outcome: z.enum(['success', 'denied', 'error']),
  details: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditVerify = z.object({
  ok: z.boolean(),
  checked: z.number().int(),
  firstBrokenSeq: z.number().int().nullable(),
});

export const BackupRun = z.object({
  id: Uuid,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  status: z.enum(['running', 'ok', 'failed']),
  fileName: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  sha256: z.string().nullable(),
  trigger: z.enum(['manual', 'schedule', 'cli']),
  errorCode: z.string().nullable(),
});
export type BackupRun = z.infer<typeof BackupRun>;

export const AppError = z.object({
  id: z.number().int(),
  at: IsoDateTime,
  requestId: z.string().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  status: z.number().int(),
  code: z.string(),
});

export const BiView = z.object({
  releaseId: Uuid,
  productName: z.string(),
  viewName: z.string(),
  status: z.enum(['ok', 'error', 'dropped']),
  rowCount: z.number().int(),
  refreshedAt: IsoDateTime,
  errorCode: z.string().nullable(),
});

export const auditQuery = Pagination.extend({
  action: z.string().max(100).optional(),
  actorId: z.string().max(100).optional(),
  objectType: z.string().max(100).optional(),
  objectId: z.string().max(100).optional(),
  outcome: z.enum(['success', 'denied', 'error']).optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
});

export const systemRoutes = {
  'health.live': route({
    method: 'GET',
    path: '/healthz',
    auth: 'public',
    summary: 'Lebenszeichen (ohne Datenbank)',
    tag: 'Betrieb',
    response: z.object({ status: z.literal('ok') }),
  }),
  'health.ready': route({
    method: 'GET',
    path: '/readyz',
    auth: 'public',
    summary: 'Bereitschaft (Datenbank erreichbar, Schema aktuell)',
    tag: 'Betrieb',
    response: z.object({ status: z.enum(['ok', 'degraded']), db: z.boolean(), schema: z.boolean() }),
  }),
  'audit.list': route({
    method: 'GET',
    path: '/api/v1/audit',
    auth: ['auditor', 'admin'],
    summary: 'Audit-Log durchsuchen',
    tag: 'Audit',
    query: auditQuery,
    response: paginated(AuditEntry),
  }),
  'audit.verify': route({
    method: 'GET',
    path: '/api/v1/audit/verify',
    auth: ['auditor', 'admin'],
    summary: 'Integrität der Hash-Kette prüfen',
    tag: 'Audit',
    response: AuditVerify,
  }),
  'audit.export': route({
    method: 'GET',
    path: '/api/v1/audit/export',
    auth: ['auditor'],
    summary: 'Audit-Log exportieren (CSV oder JSON)',
    tag: 'Audit',
    query: z.object({
      format: z.enum(['csv', 'json']).default('csv'),
      from: IsoDateTime.optional(),
      to: IsoDateTime.optional(),
    }),
    response: z.object({ items: z.array(AuditEntry) }),
    download: true,
  }),
  'system.status': route({
    method: 'GET',
    path: '/api/v1/system/status',
    auth: ['admin'],
    summary: 'Systemstatus: Version, Datenbank, Audit-Kette, Sicherungen, Ausgangspostfach, BI',
    tag: 'Betrieb',
    response: z.object({
      version: z.string(),
      node: z.object({
        nodeId: z.string(),
        displayName: z.string(),
        fingerprint: z.string(),
        baseUrl: z.string(),
      }),
      db: z.object({ ok: z.boolean(), latestMigration: z.string().nullable(), migrations: z.number().int() }),
      audit: AuditVerify,
      backups: z.object({ last: BackupRun.nullable(), intervalHours: z.number(), encrypted: z.boolean() }),
      outbox: z.object({ pending: z.number().int(), failed: z.number().int() }),
      bi: z.object({ views: z.number().int(), errors: z.number().int() }),
      errors24h: z.number().int(),
      uptimeSeconds: z.number(),
      time: IsoDateTime,
    }),
  }),
  'system.errors': route({
    method: 'GET',
    path: '/api/v1/system/errors',
    auth: ['admin'],
    summary: 'Protokollierte Fehler',
    tag: 'Betrieb',
    query: Pagination,
    response: paginated(AppError),
  }),
  'system.backups': route({
    method: 'GET',
    path: '/api/v1/system/backups',
    auth: ['admin'],
    summary: 'Sicherungen',
    tag: 'Betrieb',
    response: z.object({ items: z.array(BackupRun) }),
  }),
  'system.backupNow': route({
    method: 'POST',
    path: '/api/v1/system/backups',
    auth: ['admin'],
    summary: 'Verschlüsselte Sicherung jetzt erstellen',
    tag: 'Betrieb',
    response: BackupRun,
  }),
  'bi.views': route({
    method: 'GET',
    path: '/api/v1/bi/views',
    auth: ['admin', 'data_steward'],
    summary: 'BI-Views (Schema "bi") und Verbindungsdaten für BI-Werkzeuge',
    tag: 'BI',
    response: z.object({
      items: z.array(BiView),
      connection: z.object({
        schema: z.string(),
        role: z.string(),
        database: z.string().nullable(),
        host: z.string().nullable(),
        port: z.number().nullable(),
      }),
    }),
  }),
  'bi.refresh': route({
    method: 'POST',
    path: '/api/v1/bi/refresh',
    auth: ['admin', 'data_steward'],
    summary: 'BI-Views neu aufbauen',
    tag: 'BI',
    response: z.object({ refreshed: z.number().int(), errors: z.number().int() }),
  }),
} as const;
