import type { RecipientRole } from '../../../shared/contract/common.ts';
import { RECIPIENT_ROLES } from '../../../shared/contract/common.ts';
import type { AccessGrant } from '../../../shared/contract/products.ts';
import { iso, isoReq } from '../../core/db.ts';
import type { Module } from '../../core/deps.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { fileResponse } from '../../core/formats.ts';
import { type HandlerCtx, registerRoutes } from '../../core/http.ts';
import { decide } from '../releases/engine.ts';
import { statusOf, toRule } from '../releases/rules.ts';
import { type LoadedProduct, loadProductRows, productMeta } from './rows.ts';
import {
  createProduct,
  getProductApi,
  listProducts,
  type RequestMeta,
  registerDatasetChangeHandler,
  retireProduct,
  updateProduct,
} from './service.ts';

function meta(ctx: Pick<HandlerCtx<'products.list'>, 'actor' | 'user' | 'ip' | 'requestId'>): RequestMeta {
  return { actor: ctx.actor, userId: ctx.user.id || null, ip: ctx.ip, requestId: ctx.requestId };
}

/** Modul "products": Datenprodukte (Definition, Versionierung) und Datenzugriff für lokale Rollen */
export const productsModule: Module = {
  name: 'products',
  init(deps) {
    registerDatasetChangeHandler(deps);
  },
  routes(app, deps) {
    registerRoutes(app, deps, {
      'products.list': async () => ({ items: await listProducts(deps) }),

      'products.get': async ({ params }) => getProductApi(deps, params.id),

      'products.create': async (ctx) => createProduct(deps, ctx.body, meta(ctx)),

      'products.update': async (ctx) => updateProduct(deps, ctx.params.id, ctx.body, meta(ctx)),

      'products.retire': async (ctx) => retireProduct(deps, ctx.params.id, meta(ctx)),

      'products.preview': async (ctx) => {
        const product = await productMeta(deps.db, ctx.params.id);
        if (!product) throw notFound();
        const rows = await loadProductRows(deps.db, product, { timeZone: deps.config.MESH_TIMEZONE });
        const limited = rows.slice(0, ctx.query.limit);
        await deps.audit.record({
          actor: ctx.actor,
          action: 'product.preview',
          objectType: 'product',
          objectId: product.id,
          details: { version: product.version, rowCount: limited.length, total: rows.length },
          ip: ctx.ip,
          requestId: ctx.requestId,
        });
        return {
          columns: [...product.columns],
          rows: limited.map((r) => r.values),
          stats: {
            total: rows.length,
            returned: limited.length,
            excludedByFilter: 0,
            excludedByTime: 0,
            excludedByConsent: 0,
          },
        };
      },

      'access.list': async ({ user }) => {
        const roles = RECIPIENT_ROLES.filter(
          (r): r is Exclude<RecipientRole, 'bi'> => r !== 'bi' && (user.roles as string[]).includes(r),
        );
        if (roles.length === 0) return { items: [] };
        const rows = await deps.db
          .selectFrom('data_release')
          .selectAll()
          .where('recipient_type', '=', 'role')
          .where('recipient_role', 'in', roles)
          .where('revoked_at', 'is', null)
          .orderBy('created_at', 'desc')
          .execute();
        const at = deps.now();
        const products = new Map<string, LoadedProduct | null>();
        const items: AccessGrant[] = [];
        for (const r of rows) {
          if (!products.has(r.product_id))
            products.set(r.product_id, await productMeta(deps.db, r.product_id));
          const product = products.get(r.product_id);
          if (product?.status !== 'active') continue;
          if (statusOf(r, product.version, at) !== 'active') continue;
          const purpose = r.purposes[0];
          if (!purpose) continue;
          const d = decide({
            release: toRule(r),
            product,
            requester: { type: 'user', userId: user.id, roles: user.roles },
            purpose,
            at,
          });
          if (!d.allowed) continue;
          items.push({
            releaseId: r.id,
            recipientRole: r.recipient_role as RecipientRole,
            product: {
              id: product.id,
              slug: product.slug,
              name: product.name,
              description: product.description,
              category: product.category,
              specialCategory: product.specialCategory,
            },
            purposes: r.purposes,
            columns: d.columns,
            validFrom: isoReq(r.valid_from),
            validUntil: iso(r.valid_until),
            dataFrom: r.data_from,
            dataUntil: r.data_until,
            requiresConsent: r.requires_consent,
          });
        }
        return { items };
      },

      'access.data': async (ctx) => {
        const { params, query, user } = ctx;
        const result = await deps.services.pep.serve({
          releaseId: params.id,
          requester: { type: 'user', userId: user.id, roles: user.roles },
          purpose: query.purpose,
          limit: query.limit,
        });
        if (!result.allowed) {
          await deps.audit.record({
            actor: ctx.actor,
            action: 'access.data',
            outcome: 'denied',
            objectType: 'release',
            objectId: params.id,
            details: { releaseId: params.id, purpose: query.purpose, reason: result.reason, via: user.via },
            ip: ctx.ip,
            requestId: ctx.requestId,
          });
          throw new AppError('access_denied', { reason: result.reason });
        }
        await deps.audit.record({
          actor: ctx.actor,
          action: 'access.data',
          objectType: 'release',
          objectId: params.id,
          details: {
            releaseId: params.id,
            productId: result.product.id,
            productVersion: result.product.version,
            purpose: query.purpose,
            format: query.format,
            rowCount: result.rows.length,
            columns: result.columns.map((c) => c.key),
            via: user.via,
          },
          ip: ctx.ip,
          requestId: ctx.requestId,
        });
        const rows = result.rows.map((r) => r.values);
        // Empfänger erfahren nur die Zahl gelieferter Zeilen, nichts über Zeilen außerhalb der Freigabe
        if (query.format === 'json')
          return { columns: result.columns, rows, stats: { returned: rows.length } };
        return fileResponse(
          query.format,
          result.product.slug,
          {
            name: result.product.name,
            generatedAt: deps.now().toISOString(),
            product: result.product.slug,
            version: String(result.product.version),
            releaseId: result.release.id,
            purpose: query.purpose,
          },
          result.columns,
          rows,
        );
      },
    });
  },
};
