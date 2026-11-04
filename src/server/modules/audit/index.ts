import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';

/** Modul "audit" (Platzhalter, wird implementiert) */
export const auditModule: Module = {
  name: 'audit',
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
