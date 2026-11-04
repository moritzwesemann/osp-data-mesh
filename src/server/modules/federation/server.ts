/**
 * Server des Föderationsprotokolls: POST /federation/v1/:type (ping | catalog | pull | notice).
 *
 * Prüfreihenfolge (docs/protokoll.md): unknown_node → untrusted → bad_signature → bad_request →
 * wrong_recipient → clock_skew → replay. Absender (unknown_node/untrusted) werden geprüft, bevor der Body
 * gelesen wird; Ablehnungen werden signiert beantwortet, gezählt (Ratenbegrenzung) und zusammengefasst
 * auditiert (guard.ts). Antworten werden immer über die exakt gesendeten Bytes signiert (X-Mesh-Node,
 * X-Mesh-Signature).
 */
import type { Context, Hono } from 'hono';
import { Uuid } from '../../../shared/contract/common.ts';
import {
  CatalogRequest,
  CatalogResponse,
  type FederationErrorCode,
  type MessageType,
  NoticeBody,
  PingBody,
  PullRequest,
  type PullResponse,
  type RequestEnvelope,
  RequestEnvelope as RequestEnvelopeSchema,
  type ResponseEnvelope,
} from '../../../shared/contract/federation-wire.ts';
import type { AuditEntryInput } from '../../core/audit.ts';
import { ed25519Verify, sha256Hex } from '../../core/crypto.ts';
import type { Tx } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import type { AppEnv, Deps } from '../../core/deps.ts';
import type { DenyReason } from '../releases/engine.ts';
import { REJECTION_WINDOW_MS, RejectionGuard } from './guard.ts';
import {
  decodeUtf8,
  FEDERATION_PATH,
  FEDERATION_STATUS,
  HEADER_NODE,
  HEADER_SIGNATURE,
  MAX_REQUEST_BYTES,
  NODE_ID_RE,
  parseJson,
  type ResponseResult,
  readHead,
  readLimited,
  type Signed,
  signResponse,
  withinSkew,
} from './protocol.ts';
import {
  clearReceivedCopies,
  lockDeliveries,
  lockReceivedCopy,
  logExchange,
  NOTICE_REF,
  peerActor,
} from './store.ts';

/** Ablehnungsgründe, die Partner nur als not_found sehen (Freigabe-IDs nicht ausspähbar) */
const HIDDEN_DENY_REASONS = new Set<DenyReason>([
  'release_not_found',
  'product_mismatch',
  'recipient_mismatch',
]);

/**
 * Anfang des Bodys, in dem vor der Signaturprüfung die Anfrage-id (für inReplyTo der Ablehnung) gesucht
 * wird. Von nicht zugelassenen Absendern wird nur dieser Anfang gelesen.
 */
const PEEK_HEAD_BYTES = 4096;

/**
 * Gleichzeitig bediente Abrufe je Knoten. Ein Abruf hält eine Verbindung (Transaktion mit Liefersperre),
 * während der PEP weitere Verbindungen nutzt; die Begrenzung verhindert, dass der Pool erschöpft wird.
 */
const MAX_CONCURRENT_PULLS = 2;

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const pullSlots = new WeakMap<Deps, Semaphore>();
function pullSlot(deps: Deps): Semaphore {
  let s = pullSlots.get(deps);
  if (!s) {
    s = new Semaphore(MAX_CONCURRENT_PULLS);
    pullSlots.set(deps, s);
  }
  return s;
}

const guards = new WeakMap<Deps, RejectionGuard>();
/** Ratenbegrenzung und Audit-Zusammenfassung je Knoten (Tests mit mehreren Knoten im selben Prozess) */
function rejectionGuard(deps: Deps): RejectionGuard {
  let g = guards.get(deps);
  if (!g) {
    g = new RejectionGuard();
    guards.set(deps, g);
  }
  return g;
}

interface RequestMeta {
  deps: Deps;
  pathType: string;
  headerNode: string;
  httpRequestId: string;
  ip: string | null;
  /** bekannter Partner laut X-Mesh-Node (noch nicht authentifiziert) */
  peer: Row<'peer'> | null;
}

interface Inbound extends RequestMeta {
  peer: Row<'peer'>;
  envelope: RequestEnvelope;
  now: Date;
}

type Outcome =
  | { ok: true; body: unknown }
  /** bereits signierte Antwort (Pull: Hash der exakten Bytes wird vor dem Senden protokolliert) */
  | { ok: true; signed: Signed<ResponseEnvelope> }
  | { ok: false; code: FederationErrorCode; reason?: string; audited?: boolean };

export function registerFederationEndpoint(app: Hono<AppEnv>, deps: Deps): void {
  app.post(`${FEDERATION_PATH}/:type`, (c) => handleInbound(deps, c));
}

function respond(status: number, nodeId: string, signed: Signed<unknown>): Response {
  return new Response(signed.raw, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      [HEADER_NODE]: nodeId,
      [HEADER_SIGNATURE]: signed.signature,
    },
  });
}

function sendResult(meta: RequestMeta, to: string, inReplyTo: string | null, result: ResponseResult) {
  const { deps } = meta;
  const signed = signResponse(deps.identity, to, inReplyTo, result, deps.now());
  const status = result.ok ? 200 : FEDERATION_STATUS[result.code];
  return respond(status, deps.identity.nodeId, signed);
}

const ENVELOPE_ID_RE = /"id"\s*:\s*"([0-9a-fA-F-]{36})"/;
const lenientUtf8 = new TextDecoder('utf-8');

/**
 * Anfrage-id vor der Signaturprüfung (nur zur Zuordnung der Ablehnung beim Absender). Gesucht wird im
 * Anfang des Bodys (Umschläge beginnen mit v, type, id); kurze Bodys werden vollständig geparst.
 */
function peekId(bytes: Uint8Array): string | null {
  const whole = bytes.byteLength <= PEEK_HEAD_BYTES;
  const text = lenientUtf8.decode(whole ? bytes : bytes.subarray(0, PEEK_HEAD_BYTES));
  let candidate: unknown = ENVELOPE_ID_RE.exec(text)?.[1];
  if (candidate === undefined && whole) {
    const json = parseJson(text);
    if (typeof json === 'object' && json !== null) candidate = (json as { id?: unknown }).id;
  }
  const id = Uuid.safeParse(candidate);
  return id.success ? id.data : null;
}

/**
 * Absender, deren Nachrichten dieses Typs angenommen werden (geprüft, bevor der Body gelesen wird).
 * Gesperrte Partner dürfen weiterhin Mitteilungen senden: eine Mitteilung kann beim Empfänger nur Daten
 * löschen, die von genau diesem Partner stammen (Widerruf, Löschung, Einwilligungswiderruf).
 */
function acceptsFrom(peer: Row<'peer'>, pathType: string): boolean {
  if (peer.status === 'trusted') return true;
  return peer.status === 'suspended' && pathType === 'notice';
}

/**
 * Protokoll-Ablehnung zählen (Ratenbegrenzung) und zusammengefasst auditieren: jede im Betriebslog, im
 * Audit-Log nur die erste je Quelle und Code im Zeitfenster (guard.ts).
 */
async function noteRejection(
  meta: RequestMeta,
  code: FederationErrorCode | 'rate_limited',
  inReplyTo: string | null,
  reason?: string,
): Promise<void> {
  const { deps } = meta;
  const guard = rejectionGuard(deps);
  const nowMs = deps.now().getTime();
  if (code !== 'rate_limited') guard.count(meta.ip, meta.headerNode, nowMs);
  const decision = guard.decide(code, meta.ip, meta.peer?.node_id ?? '?', nowMs);
  const type = meta.pathType.slice(0, 20);
  deps.log.info('federation request rejected', {
    requestId: meta.httpRequestId,
    code,
    type,
    node: meta.headerNode.slice(0, 100),
    ip: meta.ip,
    audited: decision.audit,
  });
  if (decision.budgetExhausted) {
    deps.log.warn('federation rejections: audit budget of this window exhausted, further ones only logged', {
      requestId: meta.httpRequestId,
      windowMinutes: REJECTION_WINDOW_MS / 60_000,
    });
  }
  if (!decision.audit) return;
  await deps.audit.record({
    actor: peerActor(meta.headerNode || 'unknown'),
    action: 'federation.request.rejected',
    outcome: 'denied',
    objectType: 'federation_message',
    objectId: inReplyTo,
    details: {
      code,
      type,
      ...(reason ? { reason } : {}),
      ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
    },
    ip: meta.ip,
    requestId: meta.httpRequestId,
  });
}

async function reject(
  meta: RequestMeta,
  code: FederationErrorCode,
  inReplyTo: string | null,
  opts: {
    reason?: string;
    /** bereits vom Nachrichten-Handler auditiert */
    audited?: boolean;
    /**
     * Ablehnung der Protokollprüfung (Schritte 1–6): gezählt und zusammengefasst auditiert. Sonst ein
     * Ergebnis des Handlers zu einer frischen, gültig signierten Nachricht eines zugelassenen Partners:
     * jede wird auditiert.
     */
    protocol?: boolean;
  } = {},
): Promise<Response> {
  const { deps } = meta;
  if (opts.protocol) {
    await noteRejection(meta, code, inReplyTo, opts.reason);
  } else if (!opts.audited) {
    await deps.audit.record({
      actor: peerActor(meta.headerNode || 'unknown'),
      action: code === 'internal_error' ? 'federation.request.failed' : 'federation.request.rejected',
      outcome: code === 'internal_error' ? 'error' : 'denied',
      objectType: 'federation_message',
      objectId: inReplyTo,
      details: { code, type: meta.pathType.slice(0, 20), ...(opts.reason ? { reason: opts.reason } : {}) },
      ip: meta.ip,
      requestId: meta.httpRequestId,
    });
  }
  const to = NODE_ID_RE.test(meta.headerNode) ? meta.headerNode : '';
  return sendResult(meta, to, inReplyTo, { ok: false, code, reason: opts.reason });
}

/** Zu viele Ablehnungen von dieser Quelle: 429 ohne Lesen des Bodys und ohne weitere Prüfung (unsigniert) */
async function tooManyRejections(meta: RequestMeta): Promise<Response> {
  await noteRejection(meta, 'rate_limited', null);
  return new Response(JSON.stringify({ error: { code: 'rate_limited', requestId: meta.httpRequestId } }), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(Math.ceil(REJECTION_WINDOW_MS / 1000)),
    },
  });
}

async function handleInbound(deps: Deps, c: Context<AppEnv>): Promise<Response> {
  const meta: RequestMeta = {
    deps,
    pathType: c.req.param('type') ?? '',
    headerNode: c.req.header(HEADER_NODE) ?? '',
    httpRequestId: c.get('requestId'),
    ip: c.get('ip'),
    peer: null,
  };
  const guard = rejectionGuard(deps);

  // 0. Ratenbegrenzung je IP-Adresse: weder Datenbank noch Body
  if (guard.ipBlocked(meta.ip, deps.now().getTime())) return tooManyRejections(meta);

  // 1. bekannter und zugelassener Absender – geprüft, bevor der Body gelesen wird
  const peer = NODE_ID_RE.test(meta.headerNode)
    ? await deps.db.selectFrom('peer').selectAll().where('node_id', '=', meta.headerNode).executeTakeFirst()
    : undefined;
  meta.peer = peer ?? null;
  if (!peer || !acceptsFrom(peer, meta.pathType)) {
    // je behauptetem Absender nur hier: zugelassene Partner kann eine gefälschte Kennung nicht aussperren
    if (guard.nodeBlocked(meta.headerNode, deps.now().getTime())) return tooManyRejections(meta);
    // nur den Anfang lesen: Anfrage-id, damit der Absender die signierte Ablehnung zuordnen kann
    const head = await readHead(c.req.raw, PEEK_HEAD_BYTES);
    return reject(meta, peer ? 'untrusted' : 'unknown_node', peekId(head), { protocol: true });
  }

  // 2. Signatur über die exakt empfangenen Bytes (höchstens MAX_REQUEST_BYTES, auch ohne Content-Length)
  const bytes = await readLimited(c.req.raw, MAX_REQUEST_BYTES);
  if (!bytes) return reject(meta, 'bad_request', null, { reason: 'payload_too_large', protocol: true });
  const signature = c.req.header(HEADER_SIGNATURE) ?? '';
  if (!signature || !ed25519Verify(peer.public_key, bytes, signature)) {
    return reject(meta, 'bad_signature', peekId(bytes), { protocol: true });
  }

  // 3. Aufbau: Schema, v = 1, from = Header, type = Pfad
  const parsed = RequestEnvelopeSchema.safeParse(parseJson(decodeUtf8(bytes)));
  if (!parsed.success) return reject(meta, 'bad_request', peekId(bytes), { protocol: true });
  const env = parsed.data;
  if (env.from !== peer.node_id || env.type !== meta.pathType) {
    return reject(meta, 'bad_request', env.id, { protocol: true });
  }

  // 4. Empfänger
  if (env.to !== deps.identity.nodeId) return reject(meta, 'wrong_recipient', env.id, { protocol: true });

  // 5. Uhrzeit
  const now = deps.now();
  if (!withinSkew(env.ts, now)) return reject(meta, 'clock_skew', env.id, { protocol: true });

  // 6. Replay-Schutz: id je Absender nur einmal
  const fresh = await deps.db
    .insertInto('federation_nonce')
    .values({ node_id: peer.node_id, nonce: env.id, seen_at: now })
    .onConflict((oc) => oc.columns(['node_id', 'nonce']).doNothing())
    .returning('nonce')
    .executeTakeFirst();
  if (!fresh) return reject(meta, 'replay', env.id, { protocol: true });

  const inbound: Inbound = { ...meta, peer, envelope: env, now };
  let outcome: Outcome;
  try {
    outcome = await HANDLERS[env.type](inbound, env.body);
  } catch (err) {
    deps.log.error('federation handler failed', {
      requestId: meta.httpRequestId,
      type: env.type,
      error: (err as Error).message,
    });
    outcome = { ok: false, code: 'internal_error' };
  }
  if (!outcome.ok) {
    return reject(meta, outcome.code, env.id, { reason: outcome.reason, audited: outcome.audited });
  }

  const signed =
    'signed' in outcome
      ? outcome.signed
      : signResponse(deps.identity, peer.node_id, env.id, { ok: true, body: outcome.body }, deps.now());
  try {
    await deps.db.updateTable('peer').set({ last_seen_at: now }).where('id', '=', peer.id).execute();
  } catch (err) {
    deps.log.warn('could not update peer.last_seen_at', { error: (err as Error).message });
  }
  return respond(200, deps.identity.nodeId, signed);
}

// ---------------------------------------------------------------------------------------------
// Nachrichten
// ---------------------------------------------------------------------------------------------

type MessageHandler = (ib: Inbound, body: unknown) => Promise<Outcome>;

const HANDLERS: Record<MessageType, MessageHandler> = {
  ping: handlePing,
  catalog: handleCatalog,
  pull: handlePull,
  notice: handleNotice,
};

const BAD_REQUEST: Outcome = { ok: false, code: 'bad_request' };

async function handlePing(ib: Inbound, body: unknown): Promise<Outcome> {
  if (!PingBody.safeParse(body).success) return BAD_REQUEST;
  const { identity } = ib.deps;
  return {
    ok: true,
    body: { nodeId: identity.nodeId, displayName: identity.displayName, time: ib.now.toISOString() },
  };
}

async function handleCatalog(ib: Inbound, body: unknown): Promise<Outcome> {
  const req = CatalogRequest.safeParse(body);
  if (!req.success) return BAD_REQUEST;
  const { deps, peer } = ib;
  const offers = await deps.services.offers.offersForPeer(peer.id, req.data.q);
  const out = CatalogResponse.safeParse({
    node: { nodeId: deps.identity.nodeId, displayName: deps.identity.displayName },
    offers,
  });
  if (!out.success) throw new Error('offers do not match the wire contract');
  await deps.audit.record({
    actor: peerActor(peer.node_id, peer.display_name),
    action: 'exchange.catalog.served',
    objectType: 'peer',
    objectId: peer.id,
    details: {
      offers: out.data.offers.length,
      releases: out.data.offers.reduce((n, o) => n + o.releases.length, 0),
      messageId: ib.envelope.id,
    },
    ip: ib.ip,
    requestId: ib.httpRequestId,
  });
  return { ok: true, body: out.data };
}

async function handlePull(ib: Inbound, body: unknown): Promise<Outcome> {
  const req = PullRequest.safeParse(body);
  if (!req.success) return BAD_REQUEST;
  const { deps } = ib;
  // PEP-Prüfung, Signatur und Protokolleintrag in einer Transaktion unter der Liefersperre (store.ts).
  // Diese Transaktion schreibt bewusst kein Audit: der Audit-Trigger nimmt eine globale Sperre, die ein
  // auslösendes Modul (z. B. Einwilligungswiderruf) schon halten kann, bevor es auf die Liefersperre wartet.
  const served = await pullSlot(deps).run(() =>
    deps.db.transaction().execute(async (trx) => {
      await lockDeliveries(trx, 'shared');
      return servePull(ib, trx, req.data.releaseId, req.data.purpose);
    }),
  );
  try {
    // Audit vor dem Senden: ohne Audit-Eintrag verlassen keine Daten den Knoten
    await deps.audit.record(served.audit);
  } catch (err) {
    await deps.db
      .updateTable('exchange_log')
      .set({ outcome: 'error', deny_reason: 'audit_failed' })
      .where('id', '=', served.logId)
      .execute()
      .catch(() => {});
    throw err;
  }
  return served.outcome;
}

async function servePull(
  ib: Inbound,
  trx: Tx,
  releaseId: string,
  purpose: string,
): Promise<{ outcome: Outcome; audit: AuditEntryInput; logId: string }> {
  const { deps, peer, envelope } = ib;
  const actor = peerActor(peer.node_id, peer.display_name);
  const auditBase = {
    actor,
    objectType: 'release',
    objectId: releaseId,
    ip: ib.ip,
    requestId: ib.httpRequestId,
  };

  const result = await deps.services.pep.serve({
    releaseId,
    purpose,
    requester: {
      type: 'peer',
      peerId: peer.id,
      peerStatus: peer.status as 'pending' | 'trusted' | 'suspended',
    },
    at: ib.now,
  });

  let denyReason: DenyReason | null = result.allowed ? null : result.reason;
  if (
    result.allowed &&
    (result.release.id !== releaseId ||
      result.release.recipient.type !== 'peer' ||
      result.release.recipient.peerId !== peer.id)
  ) {
    // Verteidigung in der Tiefe: Ergebnis des PEP passt nicht zur Anfrage
    deps.log.error('pep returned a release that does not match the pull request', {
      requestId: ib.httpRequestId,
    });
    denyReason = 'recipient_mismatch';
  }

  if (!result.allowed || denyReason) {
    const reason = denyReason ?? 'release_not_found';
    const logId = await logExchange(trx, {
      direction: 'outgoing',
      peer_id: peer.id,
      peer_node_id: peer.node_id,
      release_id: releaseId,
      purpose,
      outcome: 'denied',
      deny_reason: reason,
      request_id: envelope.id,
      at: ib.now,
    });
    return {
      logId,
      audit: {
        ...auditBase,
        action: 'exchange.pull.denied',
        outcome: 'denied',
        details: { releaseId, purpose, reason, messageId: envelope.id },
      },
      outcome: HIDDEN_DENY_REASONS.has(reason)
        ? { ok: false, code: 'not_found', audited: true }
        : { ok: false, code: 'access_denied', reason, audited: true },
    };
  }

  const { release, product, columns } = result;
  const keys = columns.map((c) => c.key);
  const subjects = new Set<string>();
  const rows = result.rows.map((row, index) => {
    const subject = deps.identity.pseudonym(releaseId, row.athleteId ?? `row:${index}`);
    subjects.add(subject);
    // nur freigegebene Spalten (auch wenn der PEP mehr liefern sollte)
    const values: Record<string, (typeof row.values)[string]> = {};
    for (const k of keys) values[k] = row.values[k] ?? null;
    return { subject, values };
  });
  const response: PullResponse = {
    release: {
      id: release.id,
      productId: product.id,
      productSlug: product.slug,
      productName: product.name,
      productDescription: product.description,
      productVersion: product.version,
      specialCategory: product.specialCategory,
      purpose,
      validUntil: release.validUntil ? release.validUntil.toISOString() : null,
      dataFrom: release.dataFrom,
      dataUntil: release.dataUntil,
    },
    columns: columns.map((c) => ({
      key: c.key,
      label: c.label,
      type: c.type,
      ...(c.unit ? { unit: c.unit } : {}),
    })),
    rows,
    generatedAt: ib.now.toISOString(),
  };

  const signed = signResponse(
    deps.identity,
    peer.node_id,
    envelope.id,
    { ok: true, body: response },
    deps.now(),
  );
  const logId = await logExchange(trx, {
    direction: 'outgoing',
    peer_id: peer.id,
    peer_node_id: peer.node_id,
    release_id: releaseId,
    product_ref: product.slug,
    purpose,
    outcome: 'delivered',
    row_count: rows.length,
    columns: keys,
    subjects: [...subjects],
    payload_sha256: sha256Hex(signed.raw),
    request_id: envelope.id,
    at: ib.now,
  });
  return {
    logId,
    audit: {
      ...auditBase,
      action: 'exchange.pull.served',
      details: { releaseId, purpose, rowCount: rows.length, columns: keys, messageId: envelope.id },
    },
    outcome: { ok: true, signed },
  };
}

async function handleNotice(ib: Inbound, body: unknown): Promise<Outcome> {
  const parsed = NoticeBody.safeParse(body);
  if (!parsed.success) return BAD_REQUEST;
  const notice = parsed.data;
  const { deps, peer, envelope } = ib;

  const subjects = notice.kind === 'subjects_withdrawn' ? [...new Set(notice.subjects)] : [];
  const affectedRows = await deps.db.transaction().execute(async (trx) => {
    // gegen gleichzeitiges Speichern eines Abrufs derselben Freigabe (received.ts: storePull)
    await lockReceivedCopy(trx, peer.id, notice.releaseId);
    // Nur Kopien, die von genau diesem Partner (Datenhalter) stammen
    const products = await trx
      .selectFrom('received_product')
      .select(['id', 'status'])
      .where('peer_id', '=', peer.id)
      .where('remote_release_id', '=', notice.releaseId)
      .forUpdate()
      .execute();
    const ids = products.map((p) => p.id);
    let affected = 0;
    if (notice.kind === 'release_revoked') {
      const toRevoke = products.filter((p) => p.status !== 'deleted').map((p) => p.id);
      affected = await clearReceivedCopies(trx, toRevoke, 'revoked', notice.reason, ib.now);
      // bereits lokal gelöschte Kopien behalten ihren Status, enthalten aber keine Zeilen mehr
      const rest = ids.filter((id) => !toRevoke.includes(id));
      if (rest.length) {
        const del = await trx
          .deleteFrom('received_row')
          .where('received_product_id', 'in', rest)
          .executeTakeFirst();
        affected += Number(del.numDeletedRows);
      }
    } else if (ids.length > 0) {
      const del = await trx
        .deleteFrom('received_row')
        .where('received_product_id', 'in', ids)
        .where('subject', 'in', subjects)
        .executeTakeFirst();
      affected = Number(del.numDeletedRows);
      for (const id of ids) {
        const { n } = await trx
          .selectFrom('received_row')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('received_product_id', '=', id)
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('received_product')
          .set({ row_count: Number(n) })
          .where('id', '=', id)
          .execute();
      }
    }
    await logExchange(trx, {
      direction: 'incoming',
      peer_id: peer.id,
      peer_node_id: peer.node_id,
      remote_release_id: notice.releaseId,
      product_ref: NOTICE_REF[notice.kind],
      outcome: 'delivered',
      row_count: affected,
      // zurückgezogene Pseudonyme: werden auf einen gleichzeitig laufenden Abruf nachträglich angewandt
      subjects,
      request_id: envelope.id,
      at: ib.now,
    });
    await deps.audit.record(
      {
        actor: peerActor(peer.node_id, peer.display_name),
        action: 'exchange.notice.received',
        objectType: 'remote_release',
        objectId: notice.releaseId,
        details: {
          kind: notice.kind,
          releaseId: notice.releaseId,
          affectedRows: affected,
          products: ids.length,
          ...(notice.kind === 'subjects_withdrawn'
            ? { subjects: notice.subjects.length, reason: notice.reason }
            : {}),
          messageId: envelope.id,
        },
        ip: ib.ip,
        requestId: ib.httpRequestId,
      },
      trx,
    );
    return affected;
  });

  return { ok: true, body: { ack: true, affectedRows } };
}
