import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "releases" (Platzhalter, wird implementiert) */
export const releasesModule: Module = {
  name: 'releases',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
