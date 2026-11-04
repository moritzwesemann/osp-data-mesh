/**
 * Modul "audit": Audit-Log durchsuchen, Hash-Kette prüfen, exportieren.
 * Geschrieben wird das Audit-Log von allen Modulen über deps.audit (nur anhängen, DB-Trigger).
 */
import { type ExpressionBuilder, sql } from 'kysely';
import type { AuditEntry } from '../../../shared/contract/system.ts';
import { type Db, type DbOrTx, isoReq } from '../../core/db.ts';
import type { DB, Row } from '../../core/db-types.ts';
import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

export interface AuditFilter {
  action?: string;
  actorId?: string;
  objectType?: string;
  objectId?: string;
  outcome?: 'success' | 'denied' | 'error';
  from?: string;
  to?: string;
}

export function toAuditEntry(r: Row<'audit_log'>): AuditEntry {
  return {
    id: Number(r.id),
    seq: Number(r.seq),
    at: isoReq(r.at),
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorLabel: r.actor_label,
    action: r.action,
    objectType: r.object_type,
    objectId: r.object_id,
    outcome: r.outcome,
    details: r.details && typeof r.details === 'object' ? (r.details as Record<string, unknown>) : {},
    ip: r.ip,
    requestId: r.request_id,
    hash: r.hash,
  };
}

/** Filterbedingungen; action mit "*" am Ende sucht nach Präfix (z. B. "auth.*") */
function where(f: AuditFilter) {
  return (eb: ExpressionBuilder<DB, 'audit_log'>) => {
    const c = [];
    if (f.action) {
      if (f.action.endsWith('*')) {
        const prefix = f.action.slice(0, -1).replace(/[\\%_]/g, (m) => `\\${m}`);
        c.push(eb('action', 'like', `${prefix}%`));
      } else c.push(eb('action', '=', f.action));
    }
    if (f.actorId) c.push(eb('actor_id', '=', f.actorId));
    if (f.objectType) c.push(eb('object_type', '=', f.objectType));
    if (f.objectId) c.push(eb('object_id', '=', f.objectId));
    if (f.outcome) c.push(eb('outcome', '=', f.outcome));
    if (f.from) c.push(eb('at', '>=', new Date(f.from)));
    if (f.to) c.push(eb('at', '<=', new Date(f.to)));
    return eb.and(c);
  };
}

export async function verifyAuditChain(
  db: DbOrTx,
): Promise<{ ok: boolean; checked: number; firstBrokenSeq: number | null }> {
  const r = await sql<{
    checked: number | string;
    first_broken_seq: number | string | null;
  }>`select * from audit_verify()`.execute(db);
  const row = r.rows[0];
  const firstBrokenSeq = row?.first_broken_seq == null ? null : Number(row.first_broken_seq);
  return { ok: firstBrokenSeq === null, checked: Number(row?.checked ?? 0), firstBrokenSeq };
}

const EXPORT_COLUMNS = [
  'id',
  'seq',
  'at',
  'actorType',
  'actorId',
  'actorLabel',
  'action',
  'objectType',
  'objectId',
  'outcome',
  'details',
  'ip',
  'requestId',
  'hash',
] as const;

/** CSV-Zelle (RFC 4180) mit Schutz vor Formel-Injection in Tabellenkalkulationen */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const EXPORT_BATCH = 2000;

/**
 * Streamt den Export seitenweise (Schlüssel: seq), damit auch große Protokolle nicht vollständig im
 * Speicher liegen. Obergrenze ist die höchste seq beim Start (konsistenter Endpunkt).
 */
function exportStream(db: Db, filter: AuditFilter, format: 'csv' | 'json', maxSeq: number) {
  const enc = new TextEncoder();
  let lastSeq = 0;
  let first = true;
  let done = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      try {
        if (first && format === 'csv') controller.enqueue(enc.encode(`﻿${EXPORT_COLUMNS.join(',')}\r\n`));
        if (first && format === 'json') controller.enqueue(enc.encode('{"items":['));
        const rows = await db
          .selectFrom('audit_log')
          .selectAll()
          .where(where(filter))
          .where('seq', '>', lastSeq)
          .where('seq', '<=', maxSeq)
          .orderBy('seq')
          .limit(EXPORT_BATCH)
          .execute();
        const parts: string[] = [];
        for (const r of rows) {
          const e = toAuditEntry(r);
          if (format === 'csv') parts.push(`${EXPORT_COLUMNS.map((k) => csvCell(e[k])).join(',')}\r\n`);
          else parts.push(`${first && parts.length === 0 ? '' : ','}\n${JSON.stringify(e)}`);
          lastSeq = e.seq;
        }
        first = false;
        if (parts.length) controller.enqueue(enc.encode(parts.join('')));
        if (rows.length < EXPORT_BATCH) {
          if (format === 'json') controller.enqueue(enc.encode('\n]}\n'));
          done = true;
          controller.close();
        }
      } catch (err) {
        done = true;
        controller.error(err);
      }
    },
  });
}

export const auditModule: Module = {
  name: 'audit',
  routes(app, deps) {
    registerRoutes(app, deps, {
      'audit.list': async ({ query }) => {
        const filter = where(query);
        const [rows, count] = await Promise.all([
          deps.db
            .selectFrom('audit_log')
            .selectAll()
            .where(filter)
            .orderBy('seq', 'desc')
            .limit(query.pageSize)
            .offset((query.page - 1) * query.pageSize)
            .execute(),
          deps.db
            .selectFrom('audit_log')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where(filter)
            .executeTakeFirstOrThrow(),
        ]);
        return {
          items: rows.map(toAuditEntry),
          total: Number(count.n),
          page: query.page,
          pageSize: query.pageSize,
        };
      },

      'audit.verify': async () => verifyAuditChain(deps.db),

      'audit.export': async ({ query, actor, ip, requestId }) => {
        const max = await deps.db
          .selectFrom('audit_log')
          .select((eb) => eb.fn.max('seq').as('m'))
          .executeTakeFirst();
        const maxSeq = Number(max?.m ?? 0);
        await deps.audit.record({
          actor,
          action: 'audit.export',
          objectType: 'audit_log',
          details: { format: query.format, from: query.from ?? null, to: query.to ?? null, maxSeq },
          ip,
          requestId,
        });
        const stamp = deps.now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
        const name = `audit-${deps.identity.nodeId}-${stamp}.${query.format}`;
        return new Response(exportStream(deps.db, query, query.format, maxSeq), {
          headers: {
            'content-type':
              query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${name}"`,
            'cache-control': 'no-store',
          },
        });
      },
    });
  },
};
