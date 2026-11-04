import { isoReq } from '../../core/db.ts';
import type { Deps, Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';
import { BiMaterializer, biConnectionInfo } from './materialize.ts';

/** Je Knoten (deps) eine Instanz; Modulobjekte werden in Tests von mehreren Knoten geteilt. */
const instances = new WeakMap<Deps, BiMaterializer>();
const running = new Set<BiMaterializer>();

function materializer(deps: Deps): BiMaterializer {
  let m = instances.get(deps);
  if (!m) {
    m = new BiMaterializer(deps);
    instances.set(deps, m);
  }
  return m;
}

/** Modul "bi": typisierte, read-only Views im Schema "bi" für BI-Werkzeuge (nur über BI-Freigaben) */
export const biModule: Module = {
  name: 'bi',
  init(deps) {
    const m = materializer(deps);
    deps.services.bi = m;

    // In der auslösenden Transaktion: Daten sofort entfernen
    deps.events.onTx('release.revoked', async (p, trx) => {
      if (p.recipientType === 'role' && p.recipientRole === 'bi') await m.dropInRevocation(trx, p.releaseId);
    });
    deps.events.onTx('consent.withdrawn', async (p, trx) => m.removeSubject(trx, p.athleteId, true));
    deps.events.onTx('athlete.deleted', async (p, trx) => m.removeSubject(trx, p.athleteId, false));

    // Nach dem Commit: entprellte Neuberechnung (nur mit Hintergrundaufgaben)
    const refresh = async () => m.requestRefresh();
    deps.events.onAfter('release.created', refresh);
    deps.events.onAfter('release.revoked', refresh);
    deps.events.onAfter('product.changed', refresh);
    deps.events.onAfter('consent.withdrawn', refresh);
    deps.events.onAfter('athlete.deleted', refresh);
    deps.events.onAfter('data.changed', refresh);
  },
  routes(app, deps) {
    const m = materializer(deps);
    registerRoutes(app, deps, {
      'bi.views': async () => {
        const rows = await deps.db
          .selectFrom('bi_view as v')
          .innerJoin('data_release as r', 'r.id', 'v.release_id')
          .innerJoin('data_product as p', 'p.id', 'r.product_id')
          .select([
            'v.release_id',
            'v.view_name',
            'v.status',
            'v.row_count',
            'v.refreshed_at',
            'v.error_code',
            'p.name as product_name',
          ])
          .orderBy('v.view_name')
          .orderBy('v.refreshed_at', 'desc')
          .execute();
        return {
          items: rows.map((r) => ({
            releaseId: r.release_id,
            productName: r.product_name,
            viewName: r.view_name,
            status: r.status,
            rowCount: r.row_count,
            refreshedAt: isoReq(r.refreshed_at),
            errorCode: r.error_code,
          })),
          connection: biConnectionInfo(deps.config),
        };
      },
      'bi.refresh': async (ctx) =>
        m.refresh({ actor: ctx.actor, ip: ctx.ip, requestId: ctx.requestId, alwaysAudit: true }),
    });
  },
  async start(deps) {
    const m = materializer(deps);
    running.add(m);
    await m.start();
  },
  stop() {
    for (const m of running) m.stop();
    running.clear();
  },
};
