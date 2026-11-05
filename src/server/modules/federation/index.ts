import type { Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';
import { anchorHandlers } from './anchors.ts';
import { keyHandlers } from './keys.ts';
import { flushOutbox, outboxHandlers, registerOutboxEvents, startWorkers, stopWorkers } from './outbox.ts';
import { peerHandlers } from './peers.ts';
import { receivedHandlers } from './received.ts';
import { registerFederationEndpoint } from './server.ts';

/**
 * Modul "federation": Partner (Vertrauensaufnahme), signiertes Föderationsprotokoll /federation/v1/*,
 * Discovery, Abruf und Verwaltung empfangener Daten, Austauschprotokoll, Ausgangspostfach,
 * Wechsel des Knotenschlüssels (keys.ts) und externe Verankerung der Audit-Kette (anchors.ts).
 */
export const federationModule: Module = {
  name: 'federation',
  init(deps) {
    deps.services.federation = { flushOutbox: () => flushOutbox(deps) };
    registerOutboxEvents(deps);
  },
  routes(app, deps) {
    registerFederationEndpoint(app, deps);
    registerRoutes(app, deps, {
      ...peerHandlers,
      ...receivedHandlers,
      ...outboxHandlers,
      ...keyHandlers,
      ...anchorHandlers,
    });
  },
  start(deps) {
    startWorkers(deps);
  },
  stop() {
    stopWorkers();
  },
};
