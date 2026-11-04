/**
 * Policy Enforcement Point: der einzige Weg, auf dem Produktdaten ausgegeben werden
 * (lokaler Abruf/Export, BI-Materialisierung, Partnerabruf).
 *
 * Ablauf: Freigabe laden → Produkt laden → decide() → Produktzeilen laden → Einwilligungen laden →
 * applyRelease() → Limit. Alles in einer lesenden Transaktion (REPEATABLE READ), damit Freigabe, Produkt,
 * Zeilen und Einwilligungen aus demselben Datenbankstand stammen.
 * Protokolliert nicht selbst; Aufrufer schreiben Audit-/Austauschprotokoll.
 * Nimmt keine Zeilensperren und schreibt nicht: Lieferungen rufen den PEP unter der geteilten Liefersperre
 * auf (core/locks.ts), auf deren exklusive Hälfte Widerrufe und Löschungen mit eigenen Sperren warten.
 */
import type { Deps, PepService, ServeRequest, ServeResult } from '../../core/deps.ts';
import { loadProductRows, productMeta, servedProduct, UUID_RE } from '../products/rows.ts';
import { applyRelease, decide } from './engine.ts';
import { loadConsentFacts, toRule } from './rules.ts';

export function createPep(deps: Deps): PepService {
  return {
    async serve(req: ServeRequest): Promise<ServeResult> {
      const at = req.at ?? deps.now();
      const timeZone = deps.config.MESH_TIMEZONE;
      return deps.db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (trx) => {
          const row = UUID_RE.test(req.releaseId)
            ? await trx
                .selectFrom('data_release')
                .selectAll()
                .where('id', '=', req.releaseId)
                .executeTakeFirst()
            : undefined;
          const release = row ? toRule(row) : null;
          const product = release ? await productMeta(trx, release.productId) : null;
          const decision = decide({ release, product, requester: req.requester, purpose: req.purpose, at });
          if (!decision.allowed) return { allowed: false, reason: decision.reason };
          // decide() erlaubt nur mit Freigabe und Produkt
          if (!release || !product) return { allowed: false, reason: 'release_not_found' };

          const rows = await loadProductRows(trx, product, { timeZone });
          const needsConsent = release.requiresConsent || product.specialCategory;
          const consents = needsConsent
            ? await loadConsentFacts(
                trx,
                rows.map((r) => r.athleteId).filter((x): x is string => !!x),
                req.purpose,
                product.category,
              )
            : [];
          const applied = applyRelease({
            release,
            product,
            columns: decision.columns,
            rows,
            consents,
            purpose: req.purpose,
            at,
            timeZone,
          });
          const limited =
            req.limit !== undefined && req.limit >= 0 ? applied.rows.slice(0, req.limit) : applied.rows;
          return {
            allowed: true,
            release,
            product: servedProduct(product),
            columns: decision.columns,
            rows: limited,
            stats: { ...applied.stats, returned: limited.length },
          };
        });
    },
  };
}
