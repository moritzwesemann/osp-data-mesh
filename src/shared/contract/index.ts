/**
 * Vollständiger HTTP-Vertrag eines OSP-Data-Nodes (ohne Föderationsprotokoll, siehe federation-wire.ts).
 * Quelle für: Server-Routing und Ein-/Ausgabeprüfung, typisierten Client der Oberfläche, OpenAPI-Dokument.
 */
import { athleteRoutes } from './athletes.ts';
import { authRoutes } from './auth.ts';
import { connectorRoutes } from './connectors.ts';
import { datasetRoutes } from './datasets.ts';
import { federationRoutes } from './federation.ts';
import { productRoutes } from './products.ts';
import { releaseRoutes } from './releases.ts';
import { systemRoutes } from './system.ts';

export const routes = {
  ...authRoutes,
  ...athleteRoutes,
  ...datasetRoutes,
  ...connectorRoutes,
  ...productRoutes,
  ...releaseRoutes,
  ...federationRoutes,
  ...systemRoutes,
} as const;

export type Routes = typeof routes;
export type RouteId = keyof Routes;

export * from './athletes.ts';
export * from './auth.ts';
export * from './common.ts';
export * from './connectors.ts';
export * from './datasets.ts';
export * from './federation.ts';
export * from './products.ts';
export * from './releases.ts';
export * from './route.ts';
export * from './system.ts';
