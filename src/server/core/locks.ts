/**
 * Prozessübergreifende Sperren (PostgreSQL Advisory Locks, transaktionsgebunden).
 * Schlüssel: 7212001 Audit-Kette, 7212002 Migrationen, 7212101 Datenlieferungen, 7212102 empfangene Kopien.
 */
import { sql } from 'kysely';
import type { Tx } from './db.ts';

export const DELIVERY_LOCK = 7212101;

/**
 * Serialisiert Datenlieferungen gegen Widerrufe/Löschungen.
 *  - shared: jede Auslieferung (Partner-Pull, BI-Materialisierung) vom PEP-Aufruf bis zum Speichern/Protokollieren
 *  - exclusive: Einwilligungswiderruf, Löschung einer Person (Suche nach gelieferten Personen, Bereinigung,
 *    auch der BI-Tabellen), Stilllegung und Hochstufung (Widerruf der Freigaben)
 * So sieht jede spätere Lieferung den Widerruf, und jede frühere Lieferung ist abgeschlossen, bevor bereinigt wird.
 *
 * Reihenfolge, um Verklemmungen zu vermeiden: zuerst diese Sperre, danach Zeilensperren auf data_release.
 * Wer sie geteilt hält, schreibt in dieser Transaktion kein Audit (die Audit-Kette sperrt global, und
 * Widerrufe halten die Audit-Sperre unter Umständen schon, bevor sie hier warten).
 */
export async function lockDeliveries(trx: Tx, mode: 'shared' | 'exclusive'): Promise<void> {
  const fn = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await sql`select ${sql.raw(fn)}(${sql.lit(DELIVERY_LOCK)}::bigint)`.execute(trx);
}
