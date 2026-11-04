/** Gemeinsame Schreiboperationen des Föderationsmoduls (empfangene Kopien, Austauschprotokoll, Sperren). */
import { sql } from 'kysely';
import type { Actor } from '../../core/audit.ts';
import type { DbOrTx, Tx } from '../../core/db.ts';
import type { NewRow } from '../../core/db-types.ts';

/** Advisory-Lock-Schlüssel (7212001 Audit-Kette, 7212002 Migrationen) */
const DELIVERY_LOCK = 7212101;
const RECEIVED_COPY_LOCK = 7212102;

/**
 * Serialisiert Datenlieferungen (shared: Pull vom PEP-Aufruf bis zum Protokolleintrag) gegen die Suche nach
 * gelieferten Personen (exclusive: Einwilligungswiderruf, Löschung, Stilllegung). So findet die Suche jede
 * Lieferung, deren PEP-Prüfung vor dem Widerruf lag, und jede spätere Lieferung sieht den Widerruf bereits.
 */
export async function lockDeliveries(trx: Tx, mode: 'shared' | 'exclusive'): Promise<void> {
  const fn = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await sql`select ${sql.raw(fn)}(${sql.lit(DELIVERY_LOCK)}::bigint)`.execute(trx);
}

/** Serialisiert Speichern eines Abrufs und Verarbeiten von Mitteilungen je (Partner, entfernte Freigabe). */
export async function lockReceivedCopy(trx: Tx, peerId: string, remoteReleaseId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(${sql.lit(RECEIVED_COPY_LOCK)}, hashtext(${`${peerId}:${remoteReleaseId}`}))`.execute(
    trx,
  );
}

/** Kennzeichnung von Mitteilungen im Austauschprotokoll (product_ref) */
export const NOTICE_REF = {
  release_revoked: 'notice:release_revoked',
  subjects_withdrawn: 'notice:subjects_withdrawn',
} as const;

export type ReceivedStatus = 'active' | 'revoked' | 'expired' | 'deleted';

/** Akteur für Audit-Einträge, die ein Partnerknoten auslöst (id = nodeId laut Header bzw. Peer). */
export function peerActor(nodeId: string, label?: string | null): Actor {
  return { type: 'peer', id: nodeId.slice(0, 100), label: label ?? null };
}

/**
 * Löscht alle Zeilen der angegebenen empfangenen Produkte und setzt deren Status.
 * Liefert die Anzahl gelöschter Zeilen.
 */
export async function clearReceivedCopies(
  trx: DbOrTx,
  productIds: readonly string[],
  status: Exclude<ReceivedStatus, 'active'>,
  reason: string | null,
  now: Date,
): Promise<number> {
  if (productIds.length === 0) return 0;
  const del = await trx
    .deleteFrom('received_row')
    .where('received_product_id', 'in', [...productIds])
    .executeTakeFirst();
  await trx
    .updateTable('received_product')
    .set({ status, status_changed_at: now, status_reason: reason, row_count: 0 })
    .where('id', 'in', [...productIds])
    .execute();
  return Number(del.numDeletedRows);
}

export async function logExchange(trx: DbOrTx, entry: NewRow<'exchange_log'>): Promise<string> {
  const row = await trx.insertInto('exchange_log').values(entry).returning('id').executeTakeFirstOrThrow();
  return row.id;
}
