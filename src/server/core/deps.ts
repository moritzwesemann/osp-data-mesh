/**
 * Abhängigkeiten, die jedes Modul erhält, und Schnittstellen zwischen Modulen.
 * Module rufen einander nur über diese Schnittstellen auf (keine direkten Importe von Modul-Interna).
 */
import type { Context, Hono } from 'hono';
import type { ColumnDef, Role } from '../../shared/contract/common.ts';
import type { Offer } from '../../shared/contract/federation.ts';
import type { BackupRun } from '../../shared/contract/system.ts';
import type { Config } from '../config.ts';
import type {
  DenyReason,
  ProductMeta,
  ReleaseRule,
  Requester,
  RowStats,
  ServedRow,
} from '../modules/releases/engine.ts';
import type { AuditWriter } from './audit.ts';
import type { SecretBox } from './crypto.ts';
import type { Db, DbOrTx } from './db.ts';
import type { EventBus } from './events.ts';
import type { Logger } from './logger.ts';
import type { NodeIdentity } from './node-identity.ts';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
  locale: 'de' | 'en';
  mustChangePassword: boolean;
  via: 'session' | 'token';
  /** Hash der Sitzung (nur bei via=session) */
  sessionId?: string;
}

export interface Authenticator {
  authenticate(c: Context<AppEnv>): Promise<AuthUser | null>;
}

// --- Policy Enforcement Point (Modul releases) ------------------------------------------------

export interface ServeRequest {
  releaseId: string;
  requester: Requester;
  purpose: string;
  at?: Date;
  /** max. Anzahl ausgelieferter Zeilen (Vorschau) */
  limit?: number;
  /**
   * Transaktion des Aufrufers. Lieferungen (Partner-Pull, BI-Materialisierung) übergeben die Transaktion,
   * in der sie die Liefersperre geteilt halten (core/locks.ts): der PEP liest dann auf derselben Verbindung,
   * statt eine zweite aus dem Pool zu belegen, während die Sperre gehalten wird. Diese Transaktion muss
   * READ COMMITTED sein (Standard), damit jede Abfrage den Stand nach Erhalt der Sperre sieht. Ohne Angabe
   * liest der PEP in einer eigenen Transaktion (REPEATABLE READ, nur lesend).
   */
  db?: DbOrTx;
}

export interface ServedProduct extends ProductMeta {
  slug: string;
  name: string;
  description: string;
}

export type ServeResult =
  | { allowed: false; reason: DenyReason }
  | {
      allowed: true;
      release: ReleaseRule;
      product: ServedProduct;
      columns: ColumnDef[];
      rows: ServedRow[];
      stats: RowStats;
      /**
       * Zeilen nur mit gültiger Einwilligung für Zweck und Datenkategorie (product.category) ausgeliefert
       * (Einwilligungspflicht der Freigabe oder besondere Kategorie)
       */
      consentApplied: boolean;
    };

/**
 * Einziger Weg, auf dem Daten eines Produkts den Knoten bzw. die Datenhaltung verlassen
 * (lokaler Abruf, Export, BI-Materialisierung, Partnerabruf). Prüft Freigabe und Einwilligungen.
 * Protokolliert selbst nicht; der Aufrufer schreibt Audit-/Austauschprotokoll mit dem Ergebnis.
 */
export interface PepService {
  serve(req: ServeRequest): Promise<ServeResult>;
}

/** Katalogangebote für einen Partner (Modul products/releases), genutzt vom Föderationsmodul */
export interface OffersService {
  offersForPeer(peerId: string, q?: string): Promise<Offer[]>;
}

/** BI-Materialisierung (Modul bi) */
export interface BiService {
  refreshAll(): Promise<{ refreshed: number; errors: number }>;
  /** entprellte Aktualisierung im Hintergrund anstoßen */
  requestRefresh(): void;
}

/** Sicherung (Modul system) */
export interface BackupService {
  runBackup(trigger: 'manual' | 'schedule' | 'cli', userId: string | null): Promise<BackupRun>;
}

/** Föderation (Modul federation) */
export interface FederationService {
  flushOutbox(): Promise<{ delivered: number; failed: number }>;
}

export interface Services {
  pep: PepService;
  offers: OffersService;
  bi: BiService;
  backup: BackupService;
  federation: FederationService;
}

export interface Deps {
  config: Config;
  db: Db;
  log: Logger;
  audit: AuditWriter;
  events: EventBus;
  box: SecretBox;
  identity: NodeIdentity;
  services: Services;
  authenticator: Authenticator;
  /** Uhr (in Tests ersetzbar) */
  now(): Date;
  /** Ausgehende HTTP-Aufrufe (API-Quellen, Partnerknoten); in Tests ersetzbar */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  startedAt: Date;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    ip: string | null;
    user: AuthUser | null;
  };
}

/** Ein Modul registriert Routen und optional Hintergrundaufgaben. */
export interface Module {
  name: string;
  /** Dienste bereitstellen (deps.services.*) und Ereignis-Handler registrieren */
  init?(deps: Deps): void;
  /** HTTP-Routen registrieren */
  routes?(app: Hono<AppEnv>, deps: Deps): void;
  /** Hintergrundaufgaben starten (nur wenn MESH_WORKERS=true) */
  start?(deps: Deps): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export function unregisteredServices(): Services {
  const missing = (name: string) =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(`service ${name} is not registered`);
        },
      },
    );
  return {
    pep: missing('pep') as PepService,
    offers: missing('offers') as OffersService,
    bi: missing('bi') as BiService,
    backup: missing('backup') as BackupService,
    federation: missing('federation') as FederationService,
  };
}
