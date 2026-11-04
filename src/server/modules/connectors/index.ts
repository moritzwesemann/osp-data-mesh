import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "connectors" (Platzhalter, wird implementiert) */
export const connectorsModule: Module = {
  name: 'connectors',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
