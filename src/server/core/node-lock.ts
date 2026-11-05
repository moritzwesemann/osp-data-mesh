/**
 * Knotensperre: Ein laufender Server hält für seine gesamte Laufzeit eine sitzungsgebundene Advisory-Sperre
 * auf einer eigenen Verbindung. Ein zweiter Server auf derselben Datenbank startet dann nicht, und eine
 * Wiederherstellung (CLI restore) erkennt einen laufenden Knoten zuverlässig – unabhängig von
 * application_name oder geschlossenen Leerlauf-Verbindungen des Pools.
 * Schlüssel: siehe core/locks.ts (7212003). Advisory-Sperren gelten je Datenbank.
 */
import pg from 'pg';

export const NODE_LOCK = 7212003;

export interface NodeLock {
  release(): Promise<void>;
}

/** Versucht die Knotensperre zu nehmen. null, wenn ein anderer Prozess sie hält. */
export async function tryAcquireNodeLock(
  connectionString: string,
  applicationName: string,
  onLost?: (err: Error) => void,
): Promise<NodeLock | null> {
  const client = new pg.Client({ connectionString, application_name: applicationName });
  await client.connect();
  const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1::bigint) as ok', [NODE_LOCK]);
  if (!r.rows[0]?.ok) {
    await client.end();
    return null;
  }
  // Bricht die Verbindung ab, ist die Sperre weg; der Aufrufer wird informiert.
  client.on('error', (err) => onLost?.(err));
  return {
    async release() {
      await client.query('select pg_advisory_unlock($1::bigint)', [NODE_LOCK]).catch(() => {});
      await client.end().catch(() => {});
    },
  };
}
