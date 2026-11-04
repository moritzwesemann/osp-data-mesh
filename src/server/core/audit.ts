/**
 * Schreibender Zugriff auf das Audit-Log. Die Datenbank erzwingt "nur anhängen" und die Hash-Kette.
 *
 * Konvention für action: "<bereich>.<vorgang>", z. B. "release.create", "exchange.pull.served",
 * "auth.login". outcome: success | denied | error. details: keine Rohdaten mit Personenbezug,
 * nur IDs, Zähler, Codes.
 */
import type { DbOrTx } from './db.ts';

export interface Actor {
  type: 'user' | 'peer' | 'system' | 'anonymous';
  id?: string | null;
  label?: string | null;
}

export interface AuditEntryInput {
  actor: Actor;
  action: string;
  outcome?: 'success' | 'denied' | 'error';
  objectType?: string | null;
  objectId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  requestId?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, label: 'system' };

export class AuditWriter {
  constructor(private readonly db: DbOrTx) {}

  /** Schreibt einen Eintrag. Mit trx innerhalb der fachlichen Transaktion (atomar mit der Änderung). */
  async record(entry: AuditEntryInput, trx?: DbOrTx): Promise<void> {
    await (trx ?? this.db)
      .insertInto('audit_log')
      .values({
        actor_type: entry.actor.type,
        actor_id: entry.actor.id ?? null,
        actor_label: entry.actor.label ?? null,
        action: entry.action,
        outcome: entry.outcome ?? 'success',
        object_type: entry.objectType ?? null,
        object_id: entry.objectId ?? null,
        details: JSON.stringify(entry.details ?? {}),
        ip: entry.ip ?? null,
        request_id: entry.requestId ?? null,
      })
      .execute();
  }
}
