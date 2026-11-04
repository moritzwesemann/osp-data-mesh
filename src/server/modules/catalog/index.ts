import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "catalog" (Platzhalter, wird implementiert) */
export const catalogModule: Module = {
  name: 'catalog',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
