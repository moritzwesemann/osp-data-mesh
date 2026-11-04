import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "athletes" (Platzhalter, wird implementiert) */
export const athletesModule: Module = {
  name: 'athletes',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
