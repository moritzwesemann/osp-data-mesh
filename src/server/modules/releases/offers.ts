/**
 * Katalogangebote für Partnerknoten: Metadaten aller aktiven, auf Anfrage teilbaren Produkte und die
 * für den anfragenden Partner aktuell gültigen Freigaben. Keine Daten.
 */

import type { Offer } from '../../../shared/contract/federation.ts';
import { iso, isoReq } from '../../core/db.ts';
import type { Deps, OffersService } from '../../core/deps.ts';
import { productMeta, UUID_RE } from '../products/rows.ts';
import { statusOf } from './rules.ts';

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function createOffers(deps: Deps): OffersService {
  return {
    async offersForPeer(peerId: string, q?: string): Promise<Offer[]> {
      if (!UUID_RE.test(peerId)) return [];
      // Verteidigung in der Tiefe: nur vertrauenswürdige Partner erhalten Angebote
      const peer = await deps.db
        .selectFrom('peer')
        .select('status')
        .where('id', '=', peerId)
        .executeTakeFirst();
      if (peer?.status !== 'trusted') return [];

      let query = deps.db
        .selectFrom('data_product')
        .select('id')
        .where('status', '=', 'active')
        .where('shareability', '=', 'on_request')
        .orderBy('name')
        .orderBy('slug');
      const term = q?.trim();
      if (term) {
        const pattern = `%${escapeLike(term)}%`;
        query = query.where((eb) =>
          eb.or([
            eb('name', 'ilike', pattern),
            eb('slug', 'ilike', pattern),
            eb('description', 'ilike', pattern),
          ]),
        );
      }
      const ids = (await query.execute()).map((r) => r.id);
      const releases = await deps.db
        .selectFrom('data_release')
        .selectAll()
        .where('recipient_type', '=', 'peer')
        .where('recipient_peer_id', '=', peerId)
        .where('revoked_at', 'is', null)
        .orderBy('created_at', 'desc')
        .execute();
      const at = deps.now();
      const offers: Offer[] = [];
      for (const id of ids) {
        const p = await productMeta(deps.db, id);
        if (p?.status !== 'active' || p.shareability !== 'on_request') continue;
        const productKeys = p.columns.map((c) => c.key);
        offers.push({
          productId: p.id,
          slug: p.slug,
          name: p.name,
          description: p.description,
          category: p.category,
          version: p.version,
          specialCategory: p.specialCategory,
          columns: [...p.columns],
          releases: releases
            .filter((r) => r.product_id === p.id && statusOf(r, p.version, at) === 'active')
            .map((r) => ({
              releaseId: r.id,
              purposes: r.purposes,
              // nur Spalten, die das Produkt (noch) hat, in Produktreihenfolge
              columns: productKeys.filter((k) => r.columns.includes(k)),
              validFrom: isoReq(r.valid_from),
              validUntil: iso(r.valid_until),
              dataFrom: r.data_from,
              dataUntil: r.data_until,
              requiresConsent: r.requires_consent,
            })),
        });
      }
      return offers;
    },
  };
}
