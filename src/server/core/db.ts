import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './db-types.ts';

// date → 'YYYY-MM-DD' (keine Zeitzonenverschiebung), int8 → number
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v: string) => Number.parseFloat(v));

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;
/** Funktionen, die sowohl mit der Verbindung als auch innerhalb einer Transaktion arbeiten */
export type DbOrTx = Kysely<DB> | Transaction<DB>;

/** application_name der Server-Verbindungen (die CLI erkennt daran einen laufenden Knoten, siehe restore) */
export const SERVER_APPLICATION_NAME = 'osp-data-mesh';

export function createDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    application_name: SERVER_APPLICATION_NAME,
  });
  pool.on('error', (err) => {
    // Verbindungsabbrüche im Leerlauf nicht als unbehandelten Fehler eskalieren
    console.error(
      JSON.stringify({ level: 'error', msg: 'pg pool error', code: (err as { code?: string }).code }),
    );
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/** ISO-String für timestamptz-Werte (oder null) */
export function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

export function isoReq(d: Date | string): string {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

/** Postgres-Fehlercode (z. B. 23505 unique_violation) */
export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}
