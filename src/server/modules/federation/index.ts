import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "federation" (Platzhalter, wird implementiert) */
export const federationModule: Module = {
  name: 'federation',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
