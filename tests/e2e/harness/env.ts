/**
 * Beschreibung der laufenden E2E-Umgebung: vom Starter (tests/e2e/run.ts) als JSON geschrieben, von den
 * Testdateien über MESH_E2E_ENV gelesen.
 */
import { readFileSync } from 'node:fs';

/** Passwort aller Personen der E2E-Umgebung (nur lokal, nur synthetische Daten) */
export const E2E_PASSWORD = 'E2E-Passwort-2026!';

export type UserKey = 'admin' | 'steward' | 'analyst' | 'coach' | 'auditor';
export type NodeKey = 'nord' | 'mitte';

export interface NodeEnv {
  id: string;
  name: string;
  url: string;
  port: number;
  /** E-Mail-Adressen der angelegten Personen */
  users: Partial<Record<UserKey, string>>;
}

export interface E2eEnv {
  password: string;
  /** Bildschirmfotos und Seiteninhalte fehlgeschlagener Tests (gitignored) */
  artifactsDir: string;
  nodes: Record<NodeKey, NodeEnv>;
  seed: {
    /** Datenprodukt „Kaderübersicht“ auf osp-nord (Quelle: Stammdaten) */
    kaderProductId: string;
    kaderProductName: string;
    /** Freigabe Kaderübersicht → Rolle Analyse (osp-nord) */
    analystReleaseId: string;
    analystColumns: string[];
    /** Freigabe Kaderübersicht → Partnerknoten osp-mitte */
    partnerReleaseId: string;
    partnerColumns: string[];
    /** Anzahl Personen in osp-nord nach dem Stammdaten-Import */
    nordAthletes: number;
  };
}

export function loadEnv(): E2eEnv {
  const file = process.env.MESH_E2E_ENV;
  if (!file) {
    throw new Error(
      'MESH_E2E_ENV fehlt: E2E-Tests nur über `bun run test:e2e` starten (baut Oberfläche, startet Knoten).',
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as E2eEnv;
}
