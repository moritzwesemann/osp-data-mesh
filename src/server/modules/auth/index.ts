import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';
import { SessionAuthenticator } from './sessions.ts';

/** Modul "auth": Anmeldung, Sitzungen, API-Tokens, Benutzerverwaltung */
export const authModule: Module = {
  name: 'auth',
  init(deps) {
    deps.authenticator = new SessionAuthenticator(deps);
  },
  routes(app, deps) {
    registerRoutes(app, deps, {});
  },
};
