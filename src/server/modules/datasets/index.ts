import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "datasets" (Platzhalter, wird implementiert) */
export const datasetsModule: Module = {
  name: 'datasets',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
