/**
 * Abbildung zwischen Datenbankzeilen (data_release, consent_record) und den Typen der Engine.
 */
import { sql } from 'kysely';
import type { Condition, RecipientRole } from '../../../shared/contract/common.ts';
import type { DbOrTx } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import { type ConsentFact, type ReleaseRule, releaseStatus } from './engine.ts';

export type ReleaseRow = Row<'data_release'>;
export type ReleaseStatusValue = ReturnType<typeof releaseStatus>;

export function toRule(r: ReleaseRow): ReleaseRule {
  return {
    id: r.id,
    productId: r.product_id,
    productVersion: r.product_version,
    recipient:
      r.recipient_type === 'peer'
        ? { type: 'peer', peerId: r.recipient_peer_id ?? '' }
        : { type: 'role', role: r.recipient_role as RecipientRole },
    purposes: r.purposes,
    columns: r.columns,
    rowFilter: (Array.isArray(r.row_filter) ? r.row_filter : []) as Condition[],
    dataFrom: r.data_from,
    dataUntil: r.data_until,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    requiresConsent: r.requires_consent,
    revokedAt: r.revoked_at,
  };
}

/** Status einer gespeicherten Freigabe (Anzeige, Angebote, BI). */
export function statusOf(r: ReleaseRow, currentProductVersion: number, at: Date): ReleaseStatusValue {
  return releaseStatus(
    {
      revokedAt: r.revoked_at,
      validFrom: r.valid_from,
      validUntil: r.valid_until,
      productVersion: r.product_version,
    },
    currentProductVersion,
    at,
  );
}

/**
 * Einwilligungen der betroffenen Personen (nur Einträge, die für Zweck/Kategorie überhaupt in Frage kommen;
 * die eigentliche Prüfung macht die Engine).
 */
export async function loadConsentFacts(
  db: DbOrTx,
  athleteIds: readonly string[],
  purpose: string,
  category: string,
): Promise<ConsentFact[]> {
  if (athleteIds.length === 0) return [];
  const ids = [...new Set(athleteIds)];
  const rows = await db
    .selectFrom('consent_record')
    .select(['athlete_id', 'purpose', 'data_category', 'status', 'valid_from', 'valid_until'])
    .where(sql<boolean>`athlete_id = any(${ids}::uuid[])`)
    .where('purpose', 'in', [purpose, '*'])
    .where('data_category', 'in', [category, '*'])
    .execute();
  return rows.map((c) => ({
    athleteId: c.athlete_id,
    purpose: c.purpose,
    dataCategory: c.data_category,
    status: c.status,
    validFrom: c.valid_from,
    validUntil: c.valid_until,
  }));
}
