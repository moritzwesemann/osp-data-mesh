import type { Module } from '../core/deps.ts';
import { athletesModule } from './athletes/index.ts';
import { auditModule } from './audit/index.ts';
import { authModule } from './auth/index.ts';
import { biModule } from './bi/index.ts';
import { catalogModule } from './catalog/index.ts';
import { connectorsModule } from './connectors/index.ts';
import { datasetsModule } from './datasets/index.ts';
import { federationModule } from './federation/index.ts';
import { productsModule } from './products/index.ts';
import { releasesModule } from './releases/index.ts';
import { systemModule } from './system/index.ts';

/** Reihenfolge = Initialisierungsreihenfolge (init) */
export const allModules: Module[] = [
  authModule,
  auditModule,
  systemModule,
  athletesModule,
  datasetsModule,
  connectorsModule,
  productsModule,
  releasesModule,
  biModule,
  catalogModule,
  federationModule,
];
