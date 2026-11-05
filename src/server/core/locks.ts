/**
 * Prozessübergreifende Sperren (PostgreSQL Advisory Locks, transaktionsgebunden) und die globale
 * Sperrreihenfolge.
 * Schlüssel: 7212001 Audit-Kette (Trigger auf audit_log), 7212002 Migrationen (nur CLI), 7212003 Knotensperre
 *   (sitzungsgebunden, core/node-lock.ts),
 * 7212101 Datenlieferungen (DELIVERY_LOCK), 7212102 empfangene Kopien (federation/store.ts).
 *
 * GLOBALE SPERRREIHENFOLGE – verbindlich für jede schreibende Transaktion. Eine Transaktion nimmt
 * Sperren nur in dieser Reihenfolge und kehrt nie zu einer früheren Stufe zurück; so kann keine
 * Verklemmung entstehen, und keine Transaktion hält eine knotenweite Sperre, während sie wartet.
 *
 *  1. Liefersperre (DELIVERY_LOCK) – als Erstes, vor jeder Zeilensperre und jedem Audit-Eintrag.
 *     - exklusiv: Einwilligungswiderruf (consents.withdraw), Löschung einer Person (athletes.delete),
 *       Stilllegung eines Produkts (products.retire), Änderung der Einstufung eines Datensatzes
 *       (datasets.update mit category, specialCategory oder shareability). Genommen von der Route bzw.
 *       dem Dienst selbst als erste Anweisung der Transaktion (lockDeliveries), nie erst in einem
 *       Ereignis-Handler. Handler, die bereinigen oder widerrufen (bi, federation, releases), prüfen nur,
 *       dass sie gehalten wird (assertDeliveryLock), und brechen sonst ab.
 *     - geteilt: jede Lieferung (Partner-Pull, BI-Materialisierung) vom PEP-Aufruf bis zum Speichern bzw.
 *       Protokollieren. Der PEP läuft auf derselben Transaktion (ServeRequest.db), braucht also keine zweite
 *       Pool-Verbindung. Wer sie geteilt hält, schreibt in dieser Transaktion kein Audit.
 *  2. Zeilensperren in fester Reihenfolge der Tabellen:
 *        dataset → data_product → data_release
 *        athlete → import_run
 *     mehrere Zeilen derselben Tabelle in fester Ordnung (nach id bzw. created_at). Empfangene Kopien:
 *     erst RECEIVED_COPY_LOCK (je Partner und entfernter Freigabe), dann received_product.
 *  3. Audit-Einträge zuletzt. Der Audit-Trigger nimmt die knotenweite Audit-Sperre (7212001) bis zum
 *     Commit. writeTx (core/tx.ts) sammelt alle mit der Transaktion protokollierten Einträge
 *     (deps.audit.record(entry, trx)) und schreibt sie unmittelbar vor dem Commit. Die Audit-Sperre ist damit
 *     immer die letzte Sperre einer Transaktion: wer sie hält, wartet auf nichts anderes mehr.
 */
import { sql } from 'kysely';
import type { Tx } from './db.ts';

export const DELIVERY_LOCK = 7212101;

type DeliveryMode = 'shared' | 'exclusive';

/** Liefersperre, die eine Transaktion hält (in-process; die Sperre selbst hält PostgreSQL) */
const held = new WeakMap<Tx, DeliveryMode>();

/**
 * Serialisiert Datenlieferungen gegen Widerrufe/Löschungen.
 *  - shared: jede Auslieferung (Partner-Pull, BI-Materialisierung) vom PEP-Aufruf bis zum Speichern/Protokollieren
 *  - exclusive: Einwilligungswiderruf, Löschung einer Person (Suche nach gelieferten Personen, Bereinigung,
 *    auch der BI-Tabellen), Stilllegung und Neueinstufung (Widerruf der Freigaben)
 * So sieht jede spätere Lieferung den Widerruf, und jede frühere Lieferung ist abgeschlossen, bevor bereinigt wird.
 *
 * Als erste Anweisung der Transaktion aufrufen (Sperrreihenfolge oben). Erneuter Aufruf ist wirkungslos;
 * eine geteilt gehaltene Sperre lässt sich nicht nachträglich in eine exklusive umwandeln.
 */
export async function lockDeliveries(trx: Tx, mode: DeliveryMode): Promise<void> {
  const current = held.get(trx);
  if (current === 'exclusive' || current === mode) return;
  if (current === 'shared') {
    throw new Error('lock order violated: a shared delivery lock cannot be upgraded to exclusive');
  }
  const fn = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await sql`select ${sql.raw(fn)}(${sql.lit(DELIVERY_LOCK)}::bigint)`.execute(trx);
  held.set(trx, mode);
}

/**
 * Prüft, dass die Transaktion die Liefersperre bereits hält (Ereignis-Handler, die bereinigen oder
 * widerrufen). Nimmt sie bewusst nicht selbst: zu diesem Zeitpunkt hält die Transaktion schon
 * Zeilensperren, die Sperre käme also in falscher Reihenfolge.
 */
export function assertDeliveryLock(trx: Tx, mode: DeliveryMode = 'exclusive'): void {
  const current = held.get(trx);
  if (current === 'exclusive' || (mode === 'shared' && current === 'shared')) return;
  throw new Error(
    `lock order violated: the transaction must take the ${mode} delivery lock first (core/locks.ts)`,
  );
}
