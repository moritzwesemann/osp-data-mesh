/**
 * Schreibende Transaktionen nach der globalen Sperrreihenfolge (core/locks.ts).
 */
import type { AuditWriter } from './audit.ts';
import type { Db, Tx } from './db.ts';

/**
 * Führt fn in einer Transaktion aus. Audit-Einträge, die mit dieser Transaktion protokolliert werden
 * (deps.audit.record(entry, trx), auch in Ereignis-Handlern), werden gesammelt und unmittelbar vor dem
 * Commit geschrieben – nach allen Liefer- und Zeilensperren. Die knotenweite Audit-Sperre (Trigger der
 * Hash-Kette) ist so immer die letzte Sperre der Transaktion und wird nie gehalten, während die
 * Transaktion auf etwas anderes wartet. Schlägt fn fehl, wird nichts geschrieben (Rollback).
 */
export function writeTx<T>(deps: { db: Db; audit: AuditWriter }, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return deps.db.transaction().execute(async (trx) => {
    deps.audit.collect(trx);
    try {
      const result = await fn(trx);
      await deps.audit.flush(trx);
      return result;
    } finally {
      deps.audit.discard(trx);
    }
  });
}
