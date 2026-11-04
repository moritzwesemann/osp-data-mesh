import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "bi" (Platzhalter, wird implementiert) */
export const biModule: Module = {
  name: 'bi',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
