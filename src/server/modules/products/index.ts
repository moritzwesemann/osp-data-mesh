import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "products" (Platzhalter, wird implementiert) */
export const productsModule: Module = {
  name: 'products',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
