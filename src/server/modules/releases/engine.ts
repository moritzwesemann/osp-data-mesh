/**
 * Freigabe- und Einwilligungslogik (reine Funktionen, ohne Datenbank).
 *
 * Dies ist der einzige Ort, an dem entschieden wird, ob und welche Daten ein Empfänger erhält.
 * Alle Datenausgänge (lokaler Abruf, Export, BI, Partnerknoten) laufen über den Policy Enforcement Point
 * (pep.ts), der diese Funktionen nutzt. Regeln: siehe docs/release-rules.md.
 *
 * Grundsatz: deny by default. Jede fehlende oder unklare Angabe führt zur Ablehnung bzw. zum Ausschluss.
 */
import type {
  ColumnDef,
  Condition,
  DataCategory,
  RecipientRole,
  Role,
  Scalar,
  Shareability,
} from '../../../shared/contract/common.ts';

export const DENY_REASONS = [
  'release_not_found',
  'product_mismatch',
  'recipient_mismatch',
  'peer_not_trusted',
  'revoked',
  'not_yet_valid',
  'expired',
  'product_inactive',
  'product_changed',
  'not_shareable',
  'purpose_not_allowed',
  'special_category_requires_consent',
  'no_columns',
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

export interface ReleaseRule {
  id: string;
  productId: string;
  /** Produktversion, die bei Erteilung der Freigabe galt */
  productVersion: number;
  recipient: { type: 'role'; role: RecipientRole } | { type: 'peer'; peerId: string };
  purposes: readonly string[];
  columns: readonly string[];
  rowFilter: readonly Condition[];
  /** Datenzeitraum (Beobachtungsdatum, inklusive), YYYY-MM-DD */
  dataFrom: string | null;
  dataUntil: string | null;
  validFrom: Date;
  /** exklusiv: ab diesem Zeitpunkt ungültig */
  validUntil: Date | null;
  requiresConsent: boolean;
  revokedAt: Date | null;
}

export interface ProductMeta {
  id: string;
  version: number;
  status: 'active' | 'retired';
  category: DataCategory;
  specialCategory: boolean;
  shareability: Shareability;
  columns: readonly ColumnDef[];
}

export type Requester =
  | { type: 'user'; userId: string; roles: readonly Role[] }
  | { type: 'peer'; peerId: string; peerStatus: 'pending' | 'trusted' | 'suspended' }
  /** interne BI-Materialisierung */
  | { type: 'bi' };

export interface AccessRequest {
  release: ReleaseRule | null;
  product: ProductMeta | null;
  requester: Requester;
  purpose: string;
  at: Date;
}

export type Decision = { allowed: true; columns: ColumnDef[] } | { allowed: false; reason: DenyReason };

/** Entscheidet, ob ein Empfänger eine Freigabe für einen Zweck zu einem Zeitpunkt nutzen darf. */
export function decide(req: AccessRequest): Decision {
  const { release, product, requester, purpose, at } = req;
  if (!release) return deny('release_not_found');
  if (!product || product.id !== release.productId) return deny('product_mismatch');

  // Empfänger zuerst prüfen: Nicht-Empfänger erfahren nichts über Status oder Gültigkeit der Freigabe.
  if (!recipientMatches(release, requester)) return deny('recipient_mismatch');
  if (requester.type === 'peer' && requester.peerStatus !== 'trusted') return deny('peer_not_trusted');

  if (release.revokedAt && release.revokedAt.getTime() <= at.getTime()) return deny('revoked');
  if (at.getTime() < release.validFrom.getTime()) return deny('not_yet_valid');
  if (release.validUntil && at.getTime() >= release.validUntil.getTime()) return deny('expired');

  if (product.status !== 'active') return deny('product_inactive');
  if (product.version !== release.productVersion) return deny('product_changed');
  if (release.recipient.type === 'peer' && product.shareability === 'internal') return deny('not_shareable');

  if (!release.purposes.includes(purpose)) return deny('purpose_not_allowed');
  if (product.specialCategory && !release.requiresConsent) return deny('special_category_requires_consent');

  const allowedKeys = new Set(release.columns);
  const columns = product.columns.filter((c) => allowedKeys.has(c.key));
  if (columns.length === 0) return deny('no_columns');

  return { allowed: true, columns };
}

function deny(reason: DenyReason): Decision {
  return { allowed: false, reason };
}

export function recipientMatches(release: ReleaseRule, requester: Requester): boolean {
  const r = release.recipient;
  if (r.type === 'peer') return requester.type === 'peer' && requester.peerId === r.peerId;
  if (r.role === 'bi') return requester.type === 'bi';
  return requester.type === 'user' && (requester.roles as readonly string[]).includes(r.role);
}

// ---------------------------------------------------------------------------------------------
// Zeilen
// ---------------------------------------------------------------------------------------------

export interface ProductRow {
  /** lokale Personen-ID; verlässt den Knoten nie */
  athleteId: string | null;
  /** Beobachtungsdatum (YYYY-MM-DD oder ISO-Zeitstempel) */
  observedAt: string | null;
  /** alle Produktspalten (auch nicht freigegebene, für Zeilenfilter) */
  values: Record<string, Scalar>;
}

export interface ConsentFact {
  athleteId: string;
  /** Zweck-Code oder '*' */
  purpose: string;
  /** Datensatz-Kategorie oder '*' */
  dataCategory: string;
  status: 'granted' | 'withdrawn';
  /** YYYY-MM-DD, inklusive */
  validFrom: string;
  /** YYYY-MM-DD, inklusive; null = unbefristet */
  validUntil: string | null;
}

export interface ServedRow {
  athleteId: string | null;
  values: Record<string, Scalar>;
}

export interface RowStats {
  total: number;
  returned: number;
  excludedByFilter: number;
  excludedByTime: number;
  excludedByConsent: number;
}

export interface ApplyInput {
  release: ReleaseRule;
  product: ProductMeta;
  /** Ergebnis von decide() (muss allowed sein) */
  columns: readonly ColumnDef[];
  rows: readonly ProductRow[];
  consents: readonly ConsentFact[];
  purpose: string;
  at: Date;
  /** Zeitzone für Einwilligungs-Datumsgrenzen */
  timeZone?: string;
}

/**
 * Wendet Datenzeitraum, Zeilenbeschränkung und Einwilligungspflicht an und projiziert auf die freigegebenen Spalten.
 * Reihenfolge der Ausschlussgründe (für Statistik): Zeit → Filter → Einwilligung.
 */
export function applyRelease(input: ApplyInput): { rows: ServedRow[]; stats: RowStats } {
  const { release, product, columns, rows, purpose, at } = input;
  const stats: RowStats = {
    total: rows.length,
    returned: 0,
    excludedByFilter: 0,
    excludedByTime: 0,
    excludedByConsent: 0,
  };
  const today = dateInZone(at, input.timeZone ?? 'Europe/Berlin');
  const consentIndex = indexConsents(input.consents);
  const keys = columns.map((c) => c.key);
  const out: ServedRow[] = [];

  for (const row of rows) {
    if (!withinDataWindow(row.observedAt, release.dataFrom, release.dataUntil)) {
      stats.excludedByTime++;
      continue;
    }
    if (!matchesAll(row.values, release.rowFilter)) {
      stats.excludedByFilter++;
      continue;
    }
    if (release.requiresConsent || product.specialCategory) {
      if (!row.athleteId || !hasConsent(consentIndex.get(row.athleteId), purpose, product.category, today)) {
        stats.excludedByConsent++;
        continue;
      }
    }
    const values: Record<string, Scalar> = {};
    for (const k of keys) values[k] = row.values[k] ?? null;
    out.push({ athleteId: row.athleteId, values });
  }
  stats.returned = out.length;
  return { rows: out, stats };
}

export function withinDataWindow(
  observedAt: string | null,
  from: string | null,
  until: string | null,
): boolean {
  if (!from && !until) return true;
  if (!observedAt) return false;
  const day = observedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  if (from && day < from) return false;
  if (until && day > until) return false;
  return true;
}

function indexConsents(consents: readonly ConsentFact[]): Map<string, ConsentFact[]> {
  const m = new Map<string, ConsentFact[]>();
  for (const c of consents) {
    const list = m.get(c.athleteId);
    if (list) list.push(c);
    else m.set(c.athleteId, [c]);
  }
  return m;
}

/** Eine Einwilligung deckt ab, wenn sie erteilt (nicht widerrufen) ist, Zweck und Kategorie passen und sie am Stichtag gilt. */
export function hasConsent(
  consents: readonly ConsentFact[] | undefined,
  purpose: string,
  category: string,
  day: string,
): boolean {
  if (!consents) return false;
  return consents.some(
    (c) =>
      c.status === 'granted' &&
      (c.purpose === purpose || c.purpose === '*') &&
      (c.dataCategory === category || c.dataCategory === '*') &&
      c.validFrom <= day &&
      (c.validUntil === null || c.validUntil >= day),
  );
}

export function dateInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return parts; // en-CA liefert YYYY-MM-DD
}

// ---------------------------------------------------------------------------------------------
// Bedingungen
// ---------------------------------------------------------------------------------------------

export function matchesAll(values: Record<string, Scalar>, conditions: readonly Condition[]): boolean {
  for (const c of conditions) if (!matches(values, c)) return false;
  return true;
}

/**
 * Wertet eine Bedingung aus. Fehlende Spalten und null-Werte erfüllen nur "is_null" (deny by default).
 * Vergleiche nur zwischen gleichen Typen (Zahl/Zahl, Text/Text inkl. ISO-Datum, Boolesch/Boolesch).
 */
export function matches(values: Record<string, Scalar>, c: Condition): boolean {
  const has = Object.hasOwn(values, c.column);
  const v = has ? values[c.column] : undefined;
  if (c.op === 'is_null') return has && v === null;
  if (c.op === 'not_null') return has && v !== null && v !== undefined;
  if (v === null || v === undefined) return false;
  const target = c.value;
  switch (c.op) {
    case 'eq':
      return isScalar(target) && sameType(v, target) && v === target;
    case 'neq':
      return isScalar(target) && sameType(v, target) && v !== target;
    case 'in':
      return Array.isArray(target) && target.some((t) => sameType(v, t) && v === t);
    case 'nin':
      // Typfremde Listenelemente machen die Bedingung unerfüllbar (wie bei neq): deny by default
      return Array.isArray(target) && target.length > 0 && target.every((t) => sameType(v, t) && v !== t);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (!isScalar(target) || target === null || typeof target === 'boolean' || !sameType(v, target))
        return false;
      const a = v as number | string;
      const b = target as number | string;
      if (c.op === 'gt') return a > b;
      if (c.op === 'gte') return a >= b;
      if (c.op === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

function isScalar(x: unknown): x is Scalar {
  return x === null || ['string', 'number', 'boolean'].includes(typeof x);
}

function sameType(a: unknown, b: unknown): boolean {
  return typeof a === typeof b && a !== null && b !== null;
}

// ---------------------------------------------------------------------------------------------
// Validierung beim Erteilen einer Freigabe
// ---------------------------------------------------------------------------------------------

export type ReleaseIssue =
  | { code: 'unknown_column'; column: string }
  | { code: 'unknown_filter_column'; column: string }
  | { code: 'invalid_filter_value'; column: string }
  | { code: 'special_category_requires_consent' }
  | { code: 'not_shareable' }
  | { code: 'product_inactive' }
  | { code: 'bi_requires_single_purpose' }
  | { code: 'unknown_purpose'; purpose: string }
  | { code: 'invalid_time_window' }
  | { code: 'invalid_data_window' };

export interface ReleaseDraft {
  recipient: { type: 'role'; role: RecipientRole } | { type: 'peer'; peerId: string };
  purposes: readonly string[];
  columns: readonly string[];
  rowFilter: readonly Condition[];
  dataFrom: string | null;
  dataUntil: string | null;
  validFrom: Date;
  validUntil: Date | null;
  requiresConsent: boolean;
}

/** Prüft eine geplante Freigabe gegen das Produkt. Leere Liste = gültig. */
export function validateRelease(
  draft: ReleaseDraft,
  product: ProductMeta,
  knownPurposes: readonly string[],
): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [];
  const productKeys = new Map(product.columns.map((c) => [c.key, c]));
  if (product.status !== 'active') issues.push({ code: 'product_inactive' });
  for (const col of draft.columns)
    if (!productKeys.has(col)) issues.push({ code: 'unknown_column', column: col });
  for (const cond of draft.rowFilter) {
    const col = productKeys.get(cond.column);
    if (!col) {
      issues.push({ code: 'unknown_filter_column', column: cond.column });
      continue;
    }
    if (!conditionValueFits(cond, col.type))
      issues.push({ code: 'invalid_filter_value', column: cond.column });
  }
  if (product.specialCategory && !draft.requiresConsent)
    issues.push({ code: 'special_category_requires_consent' });
  if (draft.recipient.type === 'peer' && product.shareability === 'internal')
    issues.push({ code: 'not_shareable' });
  if (draft.recipient.type === 'role' && draft.recipient.role === 'bi' && draft.purposes.length !== 1) {
    issues.push({ code: 'bi_requires_single_purpose' });
  }
  for (const p of draft.purposes)
    if (!knownPurposes.includes(p)) issues.push({ code: 'unknown_purpose', purpose: p });
  if (draft.validUntil && draft.validUntil.getTime() <= draft.validFrom.getTime())
    issues.push({ code: 'invalid_time_window' });
  if (draft.dataFrom && draft.dataUntil && draft.dataUntil < draft.dataFrom)
    issues.push({ code: 'invalid_data_window' });
  return issues;
}

/** Prüft, ob der Bedingungswert zum Spaltentyp passt. */
export function conditionValueFits(cond: Condition, type: ColumnDef['type']): boolean {
  if (cond.op === 'is_null' || cond.op === 'not_null') return cond.value === undefined || cond.value === null;
  const fits = (x: unknown): boolean => {
    switch (type) {
      case 'integer':
        return typeof x === 'number' && Number.isInteger(x);
      case 'number':
        return typeof x === 'number' && Number.isFinite(x);
      case 'boolean':
        return typeof x === 'boolean';
      case 'date':
        return typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
      case 'datetime':
        return typeof x === 'string' && !Number.isNaN(Date.parse(x));
      default:
        return typeof x === 'string';
    }
  };
  if (cond.op === 'in' || cond.op === 'nin')
    return Array.isArray(cond.value) && cond.value.length > 0 && cond.value.every(fits);
  if (['gt', 'gte', 'lt', 'lte'].includes(cond.op) && type === 'boolean') return false;
  return !Array.isArray(cond.value) && cond.value !== undefined && cond.value !== null && fits(cond.value);
}

/** Status einer Freigabe zu einem Zeitpunkt (für Anzeige). */
export function releaseStatus(
  release: Pick<ReleaseRule, 'revokedAt' | 'validFrom' | 'validUntil' | 'productVersion'>,
  currentProductVersion: number,
  at: Date,
): 'active' | 'scheduled' | 'expired' | 'revoked' | 'outdated' {
  if (release.revokedAt && release.revokedAt.getTime() <= at.getTime()) return 'revoked';
  if (release.validUntil && at.getTime() >= release.validUntil.getTime()) return 'expired';
  if (at.getTime() < release.validFrom.getTime()) return 'scheduled';
  if (release.productVersion !== currentProductVersion) return 'outdated';
  return 'active';
}
