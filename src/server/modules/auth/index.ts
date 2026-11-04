import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';
import { authHandlers } from './login.ts';
import { SessionAuthenticator } from './sessions.ts';
import { userHandlers } from './users.ts';

/** Modul "auth": Anmeldung, Sitzungen, API-Tokens, Benutzerverwaltung */
export const authModule: Module = {
  name: 'auth',
  init(deps) {
    deps.authenticator = new SessionAuthenticator(deps);
  },
  routes(app, deps) {
    registerRoutes(app, deps, { ...authHandlers(deps), ...userHandlers(deps) });
  },
};
