/**
 * „Zuletzt geöffnet“ auf der Startseite: Art und ID der zuletzt angesehenen Einträge, je Knoten und Person,
 * nur in diesem Browser (localStorage).
 *
 * Bewusst nur Kennungen, keine Namen: Personenbezogene Angaben bleiben auf dem Server. Die Startseite lädt
 * Bezeichnungen mit den Rechten der angemeldeten Person nach (Athleten über athletes.list mit ids, das
 * protokolliert, welche Personen angezeigt wurden). Fehlt der Speicher (privates Fenster, gesperrt), bleibt
 * die Liste einfach leer.
 */
import { useEffect } from 'react';
import type { RouteId } from '../../shared/contract/index.ts';
import { useSession } from './session.tsx';

export const RECENT_KINDS = [
  'athlete',
  'dataset',
  'product',
  'connector',
  'release',
  'received',
  'myData',
] as const;
export type RecentKind = (typeof RECENT_KINDS)[number];

export interface RecentEntry {
  kind: RecentKind;
  id: string;
  /** Zeitpunkt des Öffnens (ms seit 1970) */
  at: number;
}

/** Route, mit der die Startseite die Bezeichnung lädt; ohne dieses Recht erscheint der Eintrag nicht. */
export const RECENT_SOURCE: Record<RecentKind, RouteId> = {
  athlete: 'athletes.list',
  dataset: 'datasets.list',
  product: 'products.list',
  connector: 'connectors.list',
  release: 'releases.list',
  received: 'received.list',
  myData: 'access.list',
};

const MAX_ENTRIES = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function storageKey(nodeId: string, userId: string): string {
  return `osp.recent.${nodeId}.${userId}`;
}

function isEntry(v: unknown): v is RecentEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.kind === 'string' &&
    (RECENT_KINDS as readonly string[]).includes(e.kind) &&
    typeof e.id === 'string' &&
    UUID.test(e.id) &&
    typeof e.at === 'number' &&
    Number.isFinite(e.at)
  );
}

/** Gespeicherte Einträge, neueste zuerst; ungültige oder fehlende Daten ergeben eine leere Liste. */
export function readRecent(nodeId: string, userId: string): RecentEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(nodeId, userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

function writeRecent(nodeId: string, userId: string, entries: RecentEntry[]) {
  try {
    localStorage.setItem(storageKey(nodeId, userId), JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // ohne Speicher keine Liste – kein Fehler für die Person
  }
}

export function rememberVisit(nodeId: string, userId: string, kind: RecentKind, id: string) {
  if (!UUID.test(id)) return;
  const rest = readRecent(nodeId, userId).filter((e) => !(e.kind === kind && e.id === id));
  writeRecent(nodeId, userId, [{ kind, id, at: Date.now() }, ...rest]);
}

/** Schlüssel eines Eintrags („athlete:<id>“), z. B. für forgetVisits */
export function recentKey(e: Pick<RecentEntry, 'kind' | 'id'>): string {
  return `${e.kind}:${e.id}`;
}

/** Einträge entfernen, die es nicht mehr gibt (gelöscht, widerrufen); keys aus recentKey */
export function forgetVisits(nodeId: string, userId: string, keys: readonly string[]) {
  if (keys.length === 0) return;
  const drop = new Set(keys);
  writeRecent(
    nodeId,
    userId,
    readRecent(nodeId, userId).filter((e) => !drop.has(recentKey(e))),
  );
}

/** Auf Detailseiten: merkt sich den Eintrag, sobald er geladen ist (ready). */
export function useRememberVisit(kind: RecentKind, id: string | undefined, ready: boolean) {
  const s = useSession();
  const nodeId = s.node.nodeId;
  const userId = s.user.id;
  useEffect(() => {
    if (ready && id) rememberVisit(nodeId, userId, kind, id);
  }, [ready, kind, id, nodeId, userId]);
}
