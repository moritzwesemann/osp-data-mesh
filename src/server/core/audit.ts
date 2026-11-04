/**
 * Schreibender Zugriff auf das Audit-Log. Die Datenbank erzwingt "nur anhängen" und die Hash-Kette.
 *
 * Konvention für action: "<bereich>.<vorgang>", z. B. "release.create", "exchange.pull.served",
 * "auth.login". outcome: success | denied | error. details: keine Rohdaten mit Personenbezug,
 * nur IDs, Zähler, Codes.
 *
 * Der Audit-Trigger serialisiert alle Einträge über eine knotenweite Sperre (Hash-Kette). Innerhalb von
 * writeTx (core/tx.ts) werden Einträge daher gesammelt und erst unmittelbar vor dem Commit geschrieben
 * (Sperrreihenfolge, core/locks.ts).
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

async function insertEntry(db: DbOrTx, entry: AuditEntryInput): Promise<void> {
  await db
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

export class AuditWriter {
  /** Gesammelte Einträge je Transaktion (writeTx), in Reihenfolge der Aufrufe */
  private readonly pending = new WeakMap<object, AuditEntryInput[]>();

  constructor(private readonly db: DbOrTx) {}

  /**
   * Schreibt einen Eintrag. Mit trx innerhalb der fachlichen Transaktion (atomar mit der Änderung); läuft
   * die Transaktion unter writeTx, wird der Eintrag erst unmittelbar vor dem Commit geschrieben.
   */
  async record(entry: AuditEntryInput, trx?: DbOrTx): Promise<void> {
    const queue = trx ? this.pending.get(trx) : undefined;
    if (queue) {
      queue.push(entry);
      return;
    }
    await insertEntry(trx ?? this.db, entry);
  }

  /** Ab jetzt Einträge dieser Transaktion sammeln (writeTx). */
  collect(trx: DbOrTx): void {
    this.pending.set(trx, []);
  }

  /** Gesammelte Einträge in Aufrufreihenfolge schreiben; danach wird wieder sofort geschrieben. */
  async flush(trx: DbOrTx): Promise<void> {
    const queue = this.pending.get(trx) ?? [];
    this.pending.delete(trx);
    for (const entry of queue) await insertEntry(trx, entry);
  }

  /** Gesammelte Einträge verwerfen (Transaktion wird zurückgerollt). */
  discard(trx: DbOrTx): void {
    this.pending.delete(trx);
  }
}
