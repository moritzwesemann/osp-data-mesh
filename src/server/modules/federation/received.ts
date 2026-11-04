/** Routen discovery.search, received.*, exchange.log: Abruf bei Partnern und empfangene Kopien. */
import { sql } from 'kysely';
import type { ColumnDef, Scalar } from '../../../shared/contract/common.ts';
import { CatalogResponse, PullResponse } from '../../../shared/contract/federation-wire.ts';
import { sha256Hex } from '../../core/crypto.ts';
import type { Db, DbOrTx } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { fileResponse } from '../../core/formats.ts';
import type { HandlerCtx, Handlers } from '../../core/http.ts';
import { DISCOVERY_TIMEOUT_MS, errorCodeOf, PeerCallError, type SignedReply, sendSigned } from './client.ts';
import { type ReceivedWithPeer, toExchangeLogEntry, toReceived } from './mappers.ts';
import { getPeer } from './peers.ts';
import { clearReceivedCopies, lockReceivedCopy, logExchange, NOTICE_REF } from './store.ts';

/** Spaltenschlüssel empfangener Produkte: sicher als JSON-Schlüssel, CSV-Kopf und XML-Elementname */
const COLUMN_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Pseudonyme (müssen später per subjects_withdrawn adressierbar sein) */
const SUBJECT_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** Ablehnungsgründe des Datenhalters, bei denen die lokale Kopie sofort gelöscht wird */
const CLEAR_ON_DENIAL = new Set(['revoked', 'expired', 'product_inactive']);
const INSERT_CHUNK = 1000;
const HISTORY_LIMIT = 100;

function receivedQuery(db: DbOrTx) {
  return db
    .selectFrom('received_product as r')
    .innerJoin('peer as p', 'p.id', 'r.peer_id')
    .selectAll('r')
    .select([
      'p.node_id as peer_node_id',
      'p.display_name as peer_display_name',
      'p.fingerprint as peer_fingerprint',
    ]);
}

async function getReceived(db: DbOrTx, id: string) {
  const row = await receivedQuery(db).where('r.id', '=', id).executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

/** Prüft den Inhalt einer Pull-Antwort gegen die Anfrage. Liefert einen Fehlercode oder null. */
export function checkPullPayload(
  payload: PullResponse,
  request: { releaseId: string; purpose: string },
): string | null {
  if (payload.release.id !== request.releaseId) return 'release_mismatch';
  if (payload.release.purpose !== request.purpose) return 'purpose_mismatch';
  const keys = new Set<string>();
  for (const c of payload.columns) {
    if (!COLUMN_KEY_RE.test(c.key) || keys.has(c.key)) return 'invalid_columns';
    keys.add(c.key);
  }
  for (const row of payload.rows) {
    if (!SUBJECT_RE.test(row.subject)) return 'invalid_subject';
    for (const k of Object.keys(row.values)) if (!keys.has(k)) return 'unexpected_column';
  }
  return null;
}

type PullCtx = HandlerCtx<'received.pull'>;

/** Fehlgeschlagener oder abgelehnter Abruf: protokollieren, bei Widerruf/Ablauf lokale Kopie löschen. */
async function recordFailedPull(ctx: PullCtx, peer: Row<'peer'>, err: PeerCallError): Promise<void> {
  const { deps, body } = ctx;
  const now = deps.now();
  const denied = err.code === 'peer_rejected';
  const reason = denied ? (err.reason ?? err.remoteCode ?? err.code) : err.code;
  await deps.db.transaction().execute(async (trx) => {
    await logExchange(trx, {
      direction: 'incoming',
      peer_id: peer.id,
      peer_node_id: peer.node_id,
      remote_release_id: body.releaseId,
      purpose: body.purpose,
      outcome: denied ? 'denied' : 'error',
      deny_reason: reason,
      request_id: err.messageId,
      at: now,
    });
    let clearedRows = 0;
    if (denied && CLEAR_ON_DENIAL.has(reason)) {
      const copies = await trx
        .selectFrom('received_product')
        .select('id')
        .where('peer_id', '=', peer.id)
        .where('remote_release_id', '=', body.releaseId)
        .where('status', '!=', 'deleted')
        .forUpdate()
        .execute();
      clearedRows = await clearReceivedCopies(
        trx,
        copies.map((c) => c.id),
        reason === 'expired' ? 'expired' : 'revoked',
        reason,
        now,
      );
    }
    await trx
      .updateTable('peer')
      .set(denied ? { last_seen_at: now, last_error: null } : { last_error: err.code })
      .where('id', '=', peer.id)
      .execute();
    await deps.audit.record(
      {
        actor: ctx.actor,
        action: 'exchange.pull.received',
        outcome: denied ? 'denied' : 'error',
        objectType: 'remote_release',
        objectId: body.releaseId,
        details: {
          peerNodeId: peer.node_id,
          releaseId: body.releaseId,
          purpose: body.purpose,
          code: err.remoteCode ?? err.code,
          reason,
          clearedRows,
        },
        ip: ctx.ip,
        requestId: ctx.requestId,
      },
      trx,
    );
  });
}

/**
 * Speichert eine Pull-Antwort (ersetzt die Kopie). Mitteilungen desselben Datenhalters, die nach dem Absenden
 * der Anfrage eingegangen sind, werden nachträglich angewandt: Widerruf → nichts speichern (null),
 * zurückgezogene Pseudonyme → diese Zeilen nicht speichern.
 */
async function storePull(ctx: PullCtx, peer: Row<'peer'>, reply: SignedReply<PullResponse>, sentAt: Date) {
  const { deps, body } = ctx;
  const now = deps.now();
  const p = reply.body;
  const payloadSha256 = sha256Hex(reply.rawText);
  const columnKeys = p.columns.map((c) => c.key);
  const audit = (trx: DbOrTx, entry: { outcome: 'success' | 'denied'; objectId: string; details: object }) =>
    deps.audit.record(
      {
        actor: ctx.actor,
        action: 'exchange.pull.received',
        outcome: entry.outcome,
        objectType: entry.outcome === 'success' ? 'received_product' : 'remote_release',
        objectId: entry.objectId,
        details: {
          peerNodeId: peer.node_id,
          releaseId: p.release.id,
          purpose: body.purpose,
          rowCount: p.rows.length,
          columns: columnKeys,
          payloadSha256,
          ...entry.details,
        },
        ip: ctx.ip,
        requestId: ctx.requestId,
      },
      trx,
    );

  return deps.db.transaction().execute(async (trx) => {
    await lockReceivedCopy(trx, peer.id, p.release.id);
    const notices = await trx
      .selectFrom('exchange_log')
      .select(['product_ref', 'subjects'])
      .where('direction', '=', 'incoming')
      .where('peer_id', '=', peer.id)
      .where('remote_release_id', '=', p.release.id)
      .where('product_ref', 'in', [NOTICE_REF.release_revoked, NOTICE_REF.subjects_withdrawn])
      .where('at', '>=', sentAt)
      .execute();

    if (notices.some((n) => n.product_ref === NOTICE_REF.release_revoked)) {
      await logExchange(trx, {
        direction: 'incoming',
        peer_id: peer.id,
        peer_node_id: peer.node_id,
        remote_release_id: p.release.id,
        product_ref: p.release.productSlug,
        purpose: body.purpose,
        outcome: 'denied',
        deny_reason: 'revoked',
        row_count: p.rows.length,
        columns: columnKeys,
        payload_sha256: payloadSha256,
        request_id: reply.requestId,
        at: now,
      });
      await audit(trx, {
        outcome: 'denied',
        objectId: p.release.id,
        details: { reason: 'revoked_during_pull' },
      });
      return null;
    }
    const withdrawn = new Set(notices.flatMap((n) => n.subjects));
    const rows = withdrawn.size > 0 ? p.rows.filter((r) => !withdrawn.has(r.subject)) : p.rows;

    const meta = {
      remote_product_id: p.release.productId,
      remote_product_slug: p.release.productSlug,
      title: p.release.productName,
      description: p.release.productDescription,
      columns: JSON.stringify(p.columns),
      product_version: p.release.productVersion,
      special_category: p.release.specialCategory,
      release_valid_until: p.release.validUntil ? new Date(p.release.validUntil) : null,
      status: 'active',
      row_count: rows.length,
      payload_sha256: payloadSha256,
      response_signature: reply.signature,
      last_pulled_at: now,
    };
    const product = await trx
      .insertInto('received_product')
      .values({
        ...meta,
        peer_id: peer.id,
        remote_release_id: p.release.id,
        purpose: body.purpose,
        created_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['peer_id', 'remote_release_id', 'purpose']).doUpdateSet({
          ...meta,
          status_changed_at: sql<Date | null>`case when received_product.status = 'active'
            then received_product.status_changed_at else ${now}::timestamptz end`,
          status_reason: sql<string | null>`case when received_product.status = 'active'
            then received_product.status_reason else null end`,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    // Jeder Abruf ersetzt die Kopie vollständig (keine Deltas)
    await trx.deleteFrom('received_row').where('received_product_id', '=', product.id).execute();
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await trx
        .insertInto('received_row')
        .values(
          rows.slice(i, i + INSERT_CHUNK).map((r) => ({
            received_product_id: product.id,
            subject: r.subject,
            data: JSON.stringify(r.values),
          })),
        )
        .execute();
    }
    await logExchange(trx, {
      direction: 'incoming',
      peer_id: peer.id,
      peer_node_id: peer.node_id,
      remote_release_id: p.release.id,
      product_ref: p.release.productSlug,
      purpose: body.purpose,
      outcome: 'delivered',
      row_count: p.rows.length,
      columns: columnKeys,
      payload_sha256: payloadSha256,
      request_id: reply.requestId,
      at: now,
    });
    await trx
      .updateTable('peer')
      .set({ last_seen_at: now, last_error: null })
      .where('id', '=', peer.id)
      .execute();
    await audit(trx, {
      outcome: 'success',
      objectId: product.id,
      details: rows.length !== p.rows.length ? { storedRows: rows.length } : {},
    });
    return getReceived(trx, product.id);
  });
}

/** Spalten und Zeilen für die Ausgabe: Pseudonym als erste Spalte, dann die Produktspalten */
function outputShape(columns: ColumnDef[]) {
  const subjectKey = columns.some((c) => c.key === 'subject') ? '_subject' : 'subject';
  const outColumns: ColumnDef[] = [{ key: subjectKey, label: 'Pseudonym', type: 'string' }, ...columns];
  const mapRow = (r: { subject: string; data: unknown }): Record<string, Scalar> => {
    const data = (r.data ?? {}) as Record<string, Scalar>;
    const out: Record<string, Scalar> = { [subjectKey]: r.subject };
    for (const c of columns) out[c.key] = Object.hasOwn(data, c.key) ? (data[c.key] ?? null) : null;
    return out;
  };
  return { outColumns, mapRow };
}

export const receivedHandlers: Handlers = {
  'discovery.search': async ({ deps, query, actor, ip, requestId }) => {
    const at = deps.now();
    const peers = await deps.db
      .selectFrom('peer')
      .selectAll()
      .where('status', '=', 'trusted')
      .orderBy('display_name')
      .execute();
    const results = await Promise.all(
      peers.map(async (peer) => {
        const ref = { id: peer.id, nodeId: peer.node_id, displayName: peer.display_name };
        try {
          const reply = await sendSigned(deps, peer, 'catalog', query.q ? { q: query.q } : {}, {
            timeoutMs: DISCOVERY_TIMEOUT_MS,
            schema: CatalogResponse,
          });
          if (reply.body.node.nodeId !== peer.node_id) {
            throw new PeerCallError('signature_invalid', { reason: 'wrong_sender' });
          }
          return { peer: ref, status: 'ok' as const, errorCode: null, offers: reply.body.offers };
        } catch (err) {
          if (!(err instanceof AppError)) {
            deps.log.error('discovery failed', { peer: peer.node_id, error: (err as Error).message });
          }
          const status =
            err instanceof PeerCallError && err.code === 'peer_unreachable'
              ? ('unreachable' as const)
              : err instanceof PeerCallError && err.code === 'peer_rejected'
                ? ('rejected' as const)
                : ('error' as const);
          return { peer: ref, status, errorCode: errorCodeOf(err), offers: [] };
        }
      }),
    );
    await deps.audit.record({
      actor,
      action: 'discovery.search',
      objectType: 'discovery',
      details: {
        peers: peers.length,
        ok: results.filter((r) => r.status === 'ok').length,
        hasQuery: Boolean(query.q),
      },
      ip,
      requestId,
    });
    return { at: at.toISOString(), results };
  },

  'received.pull': async (ctx) => {
    const { deps, body } = ctx;
    const peer = await getPeer(deps.db, body.peerId);
    if (peer.status !== 'trusted') throw new AppError('peer_untrusted');
    const sentAt = deps.now();
    let reply: SignedReply<PullResponse>;
    try {
      reply = await sendSigned(
        deps,
        peer,
        'pull',
        { releaseId: body.releaseId, purpose: body.purpose },
        { schema: PullResponse },
      );
      const problem = checkPullPayload(reply.body, body);
      if (problem) {
        throw new PeerCallError('signature_invalid', { reason: problem, messageId: reply.requestId });
      }
    } catch (err) {
      if (err instanceof PeerCallError) await recordFailedPull(ctx, peer, err);
      throw err;
    }
    const stored = await storePull(ctx, peer, reply, sentAt);
    // während des Abrufs widerrufen: nichts gespeichert
    if (!stored) throw new AppError('peer_rejected', { reason: 'revoked' });
    return toReceived(stored);
  },

  'received.list': async ({ deps }) => {
    const rows = await receivedQuery(deps.db).orderBy('r.created_at', 'desc').execute();
    return { items: rows.map((r) => toReceived(r as ReceivedWithPeer)) };
  },

  'received.get': async ({ deps, params }) => {
    const r = await getReceived(deps.db, params.id);
    const history = await deps.db
      .selectFrom('exchange_log')
      .selectAll()
      .where('peer_id', '=', r.peer_id)
      .where('remote_release_id', '=', r.remote_release_id)
      .where('direction', '=', 'incoming')
      .orderBy('at', 'desc')
      .limit(HISTORY_LIMIT)
      .execute();
    return {
      ...toReceived(r),
      provenance: {
        sourceNodeId: r.peer_node_id,
        sourceNodeName: r.peer_display_name,
        sourceFingerprint: r.peer_fingerprint,
        remoteReleaseId: r.remote_release_id,
        remoteProductId: r.remote_product_id,
        productVersion: r.product_version,
        purpose: r.purpose,
        pulledAt: r.last_pulled_at ? r.last_pulled_at.toISOString() : null,
        payloadSha256: r.payload_sha256,
        responseSignature: r.response_signature,
      },
      history: history.map(toExchangeLogEntry),
    };
  },

  'received.rows': async ({ deps, params, query, actor, ip, requestId }) => {
    const r = await getReceived(deps.db, params.id);
    const { outColumns, mapRow } = outputShape(r.columns as ColumnDef[]);
    const base = deps.db
      .selectFrom('received_row')
      .select(['subject', 'data'])
      .where('received_product_id', '=', r.id)
      .orderBy('id');
    const audit = (rowCount: number) =>
      deps.audit.record({
        actor,
        action: 'received.read',
        objectType: 'received_product',
        objectId: r.id,
        details: { format: query.format, rowCount, page: query.format === 'json' ? query.page : null },
        ip,
        requestId,
      });

    if (query.format !== 'json') {
      const rows = (await base.execute()).map(mapRow);
      await audit(rows.length);
      return fileResponse(
        query.format,
        `${r.remote_product_slug}_${r.peer_node_id}`,
        {
          name: r.title,
          generatedAt: deps.now().toISOString(),
          source: r.peer_node_id,
          purpose: r.purpose,
        },
        outColumns,
        rows,
      );
    }
    const total = await countRows(deps.db, r.id);
    const rows = (
      await base
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute()
    ).map(mapRow);
    await audit(rows.length);
    return { columns: outColumns, rows, total, page: query.page, pageSize: query.pageSize };
  },

  'received.delete': async ({ deps, params, actor, ip, requestId }) => {
    const r = await getReceived(deps.db, params.id);
    await deps.db.transaction().execute(async (trx) => {
      const deleted = await clearReceivedCopies(trx, [r.id], 'deleted', null, deps.now());
      await deps.audit.record(
        {
          actor,
          action: 'received.delete',
          objectType: 'received_product',
          objectId: r.id,
          details: { peerNodeId: r.peer_node_id, remoteReleaseId: r.remote_release_id, deletedRows: deleted },
          ip,
          requestId,
        },
        trx,
      );
    });
    return { ok: true as const };
  },

  'exchange.log': async ({ deps, query }) => {
    let q = deps.db.selectFrom('exchange_log');
    if (query.direction) q = q.where('direction', '=', query.direction);
    const { n } = await q.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const rows = await q
      .selectAll()
      .orderBy('at', 'desc')
      .orderBy('id')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return {
      items: rows.map(toExchangeLogEntry),
      total: Number(n),
      page: query.page,
      pageSize: query.pageSize,
    };
  },
};

async function countRows(db: Db, productId: string): Promise<number> {
  const { n } = await db
    .selectFrom('received_row')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('received_product_id', '=', productId)
    .executeTakeFirstOrThrow();
  return Number(n);
}
