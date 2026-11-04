import type { Module } from '../../core/deps.ts';
import { type HandlerCtx, registerRoutes } from '../../core/http.ts';
import { createOffers } from './offers.ts';
import { createPep } from './pep.ts';
import {
  createRelease,
  getRelease,
  listReleases,
  previewRelease,
  type RequestMeta,
  registerRetirementHandler,
  revokeRelease,
} from './service.ts';

function meta(ctx: Pick<HandlerCtx<'releases.list'>, 'actor' | 'user' | 'ip' | 'requestId'>): RequestMeta {
  return { actor: ctx.actor, userId: ctx.user.id || null, ip: ctx.ip, requestId: ctx.requestId };
}

/** Modul "releases": Freigaben, Policy Enforcement Point (services.pep), Katalogangebote (services.offers) */
export const releasesModule: Module = {
  name: 'releases',
  init(deps) {
    deps.services.pep = createPep(deps);
    deps.services.offers = createOffers(deps);
    registerRetirementHandler(deps);
  },
  routes(app, deps) {
    registerRoutes(app, deps, {
      'releases.list': async ({ query }) => ({ items: await listReleases(deps, query) }),
      'releases.get': async ({ params }) => getRelease(deps, params.id),
      'releases.create': async (ctx) => createRelease(deps, ctx.body, meta(ctx)),
      'releases.revoke': async (ctx) => revokeRelease(deps, ctx.params.id, ctx.body.reason, meta(ctx)),
      'releases.preview': async (ctx) => previewRelease(deps, ctx.body, meta(ctx)),
    });
  },
};
