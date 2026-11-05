/**
 * Hilfen für Föderationstests: Vertrauensaufnahme zweier Knoten, Ersatz für PEP/Angebote,
 * rohe signierte Anfragen, verstellbare Uhren.
 */
import { randomUUID } from 'node:crypto';
import { ed25519Verify } from '../../src/server/core/crypto.ts';
import type { ServedProduct, ServeRequest, ServeResult } from '../../src/server/core/deps.ts';
import type { DenyReason, ReleaseRule, ServedRow } from '../../src/server/modules/releases/engine.ts';
import type { ColumnDef } from '../../src/shared/contract/common.ts';
import type { NodeCard, Offer, Peer } from '../../src/shared/contract/federation.ts';
import type { TestNode, TestUser } from './node.ts';

/** Verstellbare Uhr für TestMesh/createTestNode (`now`) */
export class TestClock {
  offsetMs = 0;
  readonly now = (): Date => new Date(Date.now() + this.offsetMs);
  advance(ms: number): void {
    this.offsetMs += ms;
  }
  reset(): void {
    this.offsetMs = 0;
  }
}

const admins = new WeakMap<TestNode, TestUser>();

/** Admin-Person eines Knotens (einmal je Knoten angelegt) */
export async function adminOf(node: TestNode): Promise<TestUser> {
  let u = admins.get(node);
  if (!u) {
    u = await node.user(['admin']);
    admins.set(node, u);
  }
  return u;
}

export async function cardOf(node: TestNode): Promise<NodeCard> {
  const r = await node.request<NodeCard>('GET', '/api/v1/node/card', { as: await adminOf(node) });
  if (r.status !== 200) throw new Error(`node.card failed: ${r.status} ${r.text}`);
  return r.json;
}

/** Nimmt `other` als Partner von `node` auf (Status pending). */
export async function addPeer(node: TestNode, other: TestNode): Promise<Peer> {
  const r = await node.request<Peer>('POST', '/api/v1/peers', {
    as: await adminOf(node),
    body: { card: await cardOf(other) },
  });
  if (r.status !== 200) throw new Error(`peers.add failed: ${r.status} ${r.text}`);
  return r.json;
}

export async function trustPeer(node: TestNode, peer: Peer): Promise<Peer> {
  const r = await node.request<Peer>('POST', `/api/v1/peers/${peer.id}/trust`, {
    as: await adminOf(node),
    body: { fingerprint: peer.fingerprint },
  });
  if (r.status !== 200) throw new Error(`peers.trust failed: ${r.status} ${r.text}`);
  return r.json;
}

/** Beidseitige Vertrauensaufnahme. Liefert die Partnerzeilen: auf a (für b) und auf b (für a). */
export async function onboard(a: TestNode, b: TestNode): Promise<{ bOnA: Peer; aOnB: Peer }> {
  const bOnA = await trustPeer(a, await addPeer(a, b));
  const aOnB = await trustPeer(b, await addPeer(b, a));
  return { bOnA, aOnB };
}

/** Partnerzeile (DB) eines Knotens für einen anderen Knoten */
export async function peerRow(node: TestNode, other: TestNode) {
  return node.deps.db
    .selectFrom('peer')
    .selectAll()
    .where('node_id', '=', other.nodeId)
    .executeTakeFirstOrThrow();
}

// ---------------------------------------------------------------------------------------------
// PEP- und Angebots-Ersatz
// ---------------------------------------------------------------------------------------------

export const TEST_COLUMNS: ColumnDef[] = [
  { key: 'test_date', label: 'Testdatum', type: 'date' },
  { key: 'vo2max', label: 'VO2max', type: 'number', unit: 'ml/kg/min' },
];

export interface FakeRelease {
  id: string;
  peerId: string;
  purposes?: string[];
  columns?: ColumnDef[];
  rows?: ServedRow[];
  validUntil?: Date | null;
  product?: Partial<ServedProduct>;
  /** erzwungene Ablehnung */
  deny?: DenyReason;
}

export function allowedResult(rel: FakeRelease, req: ServeRequest): ServeResult {
  const columns = rel.columns ?? TEST_COLUMNS;
  const product: ServedProduct = {
    id: rel.product?.id ?? '00000000-0000-4000-8000-000000000001',
    version: 1,
    status: 'active',
    category: 'performance',
    specialCategory: false,
    shareability: 'on_request',
    columns,
    slug: 'leistungsdiagnostik',
    name: 'Leistungsdiagnostik',
    description: 'Spiroergometrie',
    ...rel.product,
  };
  const release: ReleaseRule = {
    id: rel.id,
    productId: product.id,
    productVersion: product.version,
    recipient: { type: 'peer', peerId: rel.peerId },
    purposes: rel.purposes ?? [req.purpose],
    columns: columns.map((c) => c.key),
    rowFilter: [],
    dataFrom: null,
    dataUntil: null,
    validFrom: new Date(0),
    validUntil: rel.validUntil ?? null,
    requiresConsent: true,
    revokedAt: null,
  };
  const rows = rel.rows ?? [];
  return {
    allowed: true,
    release,
    product,
    columns,
    rows,
    stats: {
      total: rows.length,
      returned: rows.length,
      excludedByFilter: 0,
      excludedByTime: 0,
      excludedByConsent: 0,
    },
    consentApplied: release.requiresConsent || product.specialCategory,
  };
}

/**
 * Ersetzt den PEP eines Knotens durch eine Tabelle von Freigaben (Empfänger- und Zweckprüfung wie im PEP).
 * Liefert die Liste der empfangenen Anfragen.
 */
export function fakePep(node: TestNode, releases: Map<string, FakeRelease>): ServeRequest[] {
  const calls: ServeRequest[] = [];
  node.deps.services.pep = {
    async serve(req) {
      calls.push(req);
      const rel = releases.get(req.releaseId);
      if (!rel) return { allowed: false, reason: 'release_not_found' };
      if (req.requester.type !== 'peer' || req.requester.peerId !== rel.peerId) {
        return { allowed: false, reason: 'recipient_mismatch' };
      }
      if (rel.deny) return { allowed: false, reason: rel.deny };
      if (rel.purposes && !rel.purposes.includes(req.purpose)) {
        return { allowed: false, reason: 'purpose_not_allowed' };
      }
      return allowedResult(rel, req);
    },
  };
  return calls;
}

export function fakeOffers(node: TestNode, offers: (peerId: string, q?: string) => Offer[]): void {
  node.deps.services.offers = { offersForPeer: async (peerId, q) => offers(peerId, q) };
}

export function sampleOffer(releaseId: string): Offer {
  return {
    productId: '00000000-0000-4000-8000-000000000001',
    slug: 'leistungsdiagnostik',
    name: 'Leistungsdiagnostik',
    description: 'Spiroergometrie',
    category: 'performance',
    version: 1,
    specialCategory: false,
    columns: TEST_COLUMNS,
    releases: [
      {
        releaseId,
        purposes: ['training_steering'],
        columns: TEST_COLUMNS.map((c) => c.key),
        validFrom: new Date(0).toISOString(),
        validUntil: null,
        dataFrom: null,
        dataUntil: null,
        requiresConsent: true,
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Rohe Protokollanfragen
// ---------------------------------------------------------------------------------------------

export interface RawSendOptions {
  /** Absenderknoten (signiert mit dessen Schlüssel) */
  from: TestNode;
  type?: string;
  body?: unknown;
  /** Überschreibt Felder des Umschlags */
  envelope?: Record<string, unknown>;
  /** Pfadtyp, falls abweichend vom Umschlag */
  pathType?: string;
  /** X-Mesh-Node, falls abweichend */
  headerNode?: string | null;
  /** Rohtext nach dem Signieren verändern */
  tamper?: (raw: string) => string;
  /** Exakt diesen Rohtext/diese Signatur senden (Replay) */
  replay?: { raw: string; signature: string };
  /** mit diesem Schlüssel statt dem aktuellen des Absenders signieren (z. B. bisheriger Schlüssel) */
  signWith?: { sign(data: string): string };
}

export interface RawResult {
  status: number;
  text: string;
  json: {
    v: number;
    id: string;
    inReplyTo: string | null;
    from: string;
    to: string;
    ok: boolean;
    body?: unknown;
    error?: { code: string; reason?: string };
  };
  headers: Headers;
  raw: string;
  signature: string;
  /** Antwortsignatur mit dem Schlüssel des Zielknotens gültig */
  signedByTarget: boolean;
}

export async function rawSend(target: TestNode, o: RawSendOptions): Promise<RawResult> {
  const type = o.type ?? 'ping';
  const env = {
    v: 1,
    type,
    id: randomUUID(),
    from: o.from.nodeId,
    to: target.nodeId,
    ts: o.from.deps.now().toISOString(),
    body: o.body ?? {},
    ...o.envelope,
  };
  let raw = o.replay?.raw ?? JSON.stringify(env);
  const signature = o.replay?.signature ?? (o.signWith ?? o.from.deps.identity).sign(raw);
  if (o.tamper) raw = o.tamper(raw);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-mesh-signature': signature,
  };
  const headerNode = o.headerNode === undefined ? o.from.nodeId : o.headerNode;
  if (headerNode !== null) headers['x-mesh-node'] = headerNode;
  const res = await target.app.request(`/federation/v1/${o.pathType ?? type}`, {
    method: 'POST',
    headers,
    body: raw,
  });
  const text = await res.text();
  const sig = res.headers.get('x-mesh-signature') ?? '';
  return {
    status: res.status,
    text,
    json: JSON.parse(text),
    headers: res.headers,
    raw,
    signature,
    signedByTarget:
      res.headers.get('x-mesh-node') === target.nodeId &&
      ed25519Verify(target.deps.identity.publicKey, text, sig),
  };
}

/** Audit-Einträge eines Knotens zu einer Aktion */
export async function auditEntries(node: TestNode, action: string) {
  const rows = await node.deps.db
    .selectFrom('audit_log')
    .selectAll()
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({ ...r, details: r.details as Record<string, unknown> }));
}
