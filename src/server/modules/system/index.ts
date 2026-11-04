import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "system" (Platzhalter, wird implementiert) */
export const systemModule: Module = {
  name: 'system',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
