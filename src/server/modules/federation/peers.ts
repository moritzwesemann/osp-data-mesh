/** Routen node.card und peers.*: Vertrauensaufnahme per Knotenkarte und Fingerprint-Abgleich. */
import { PingResponse } from '../../../shared/contract/federation-wire.ts';
import { fingerprint, normalizeFingerprint } from '../../core/crypto.ts';
import { type DbOrTx, pgCode } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import { AppError, conflict, invalid, notFound } from '../../core/errors.ts';
import type { Handlers } from '../../core/http.ts';
import { writeTx } from '../../core/tx.ts';
import { errorCodeOf, PeerCallError, sendSigned } from './client.ts';
import { toPeer } from './mappers.ts';
import { normalizeBaseUrl } from './protocol.ts';

export async function getPeer(db: DbOrTx, id: string): Promise<Row<'peer'>> {
  const peer = await db.selectFrom('peer').selectAll().where('id', '=', id).executeTakeFirst();
  if (!peer) throw notFound();
  return peer;
}

/** Strikt kodierter Ed25519-Public-Key (base64, genau 32 Byte) */
export function isPublicKey(b64: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(b64)) return false;
  const raw = Buffer.from(b64, 'base64');
  return raw.length === 32 && raw.toString('base64') === b64;
}

export const peerHandlers: Handlers = {
  'node.card': async ({ deps }) => deps.identity.card(),

  'peers.list': async ({ deps }) => {
    const rows = await deps.db
      .selectFrom('peer')
      .selectAll()
      .orderBy('created_at')
      .orderBy('node_id')
      .execute();
    return { items: rows.map(toPeer) };
  },

  'peers.add': async ({ deps, body, user, actor, ip, requestId }) => {
    const { card } = body;
    const fields: Record<string, string> = {};
    if (!isPublicKey(card.publicKey)) fields['card.publicKey'] = 'invalid_key';
    else if (card.publicKey === deps.identity.publicKey) fields['card.publicKey'] = 'own_key';
    else if (normalizeFingerprint(fingerprint(card.publicKey)) !== normalizeFingerprint(card.fingerprint)) {
      // Fingerprint der Karte passt nicht zum Schlüssel: Karte manipuliert oder fehlerhaft
      fields['card.fingerprint'] = 'mismatch';
    }
    if (card.nodeId === deps.identity.nodeId) fields['card.nodeId'] = 'own_node';
    const base = normalizeBaseUrl(card.baseUrl, deps.config.MESH_FEDERATION_ALLOW_HTTP);
    if (!base.ok) fields['card.baseUrl'] = base.code;
    if (Object.keys(fields).length > 0) {
      await deps.audit.record({
        actor,
        action: 'peer.add',
        outcome: 'denied',
        objectType: 'peer',
        objectId: null,
        details: { nodeId: card.nodeId, fields },
        ip,
        requestId,
      });
      throw invalid(fields);
    }
    if (!base.ok) throw invalid({ 'card.baseUrl': base.code });

    const existing = await deps.db
      .selectFrom('peer')
      .select(['node_id', 'public_key'])
      .where((eb) => eb.or([eb('node_id', '=', card.nodeId), eb('public_key', '=', card.publicKey)]))
      .execute();
    if (existing.some((p) => p.node_id === card.nodeId)) throw conflict('node_exists');
    if (existing.length > 0) throw conflict('public_key_in_use');

    try {
      const row = await writeTx(deps, async (trx) => {
        const inserted = await trx
          .insertInto('peer')
          .values({
            node_id: card.nodeId,
            display_name: card.displayName,
            base_url: base.url,
            public_key: card.publicKey,
            // kanonische Form, aus dem Schlüssel berechnet
            fingerprint: fingerprint(card.publicKey),
            status: 'pending',
            created_by: user.id,
            created_at: deps.now(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await deps.audit.record(
          {
            actor,
            action: 'peer.add',
            objectType: 'peer',
            objectId: inserted.id,
            details: { nodeId: inserted.node_id, fingerprint: inserted.fingerprint },
            ip,
            requestId,
          },
          trx,
        );
        return inserted;
      });
      return toPeer(row);
    } catch (err) {
      if (pgCode(err) === '23505') throw conflict('node_exists');
      throw err;
    }
  },

  'peers.trust': async ({ deps, params, body, user, actor, ip, requestId }) => {
    const peer = await getPeer(deps.db, params.id);
    const stored = normalizeFingerprint(peer.fingerprint);
    const matches =
      normalizeFingerprint(body.fingerprint) === stored &&
      normalizeFingerprint(fingerprint(peer.public_key)) === stored;
    if (!matches) {
      await deps.audit.record({
        actor,
        action: 'peer.trust',
        outcome: 'denied',
        objectType: 'peer',
        objectId: peer.id,
        details: { nodeId: peer.node_id, code: 'fingerprint_mismatch' },
        ip,
        requestId,
      });
      throw invalid({ fingerprint: 'mismatch' });
    }
    const now = deps.now();
    const row = await writeTx(deps, async (trx) => {
      const updated = await trx
        .updateTable('peer')
        .set({ status: 'trusted', trusted_at: now, trusted_by: user.id })
        .where('id', '=', peer.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await deps.audit.record(
        {
          actor,
          action: 'peer.trust',
          objectType: 'peer',
          objectId: peer.id,
          details: { nodeId: peer.node_id, previousStatus: peer.status },
          ip,
          requestId,
        },
        trx,
      );
      return updated;
    });
    return toPeer(row);
  },

  'peers.suspend': async ({ deps, params, actor, ip, requestId }) => {
    const peer = await getPeer(deps.db, params.id);
    const row = await writeTx(deps, async (trx) => {
      const updated = await trx
        .updateTable('peer')
        .set({ status: 'suspended' })
        .where('id', '=', peer.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await deps.audit.record(
        {
          actor,
          action: 'peer.suspend',
          objectType: 'peer',
          objectId: peer.id,
          details: { nodeId: peer.node_id, previousStatus: peer.status },
          ip,
          requestId,
        },
        trx,
      );
      return updated;
    });
    return toPeer(row);
  },

  'peers.update': async ({ deps, params, body, actor, ip, requestId }) => {
    const peer = await getPeer(deps.db, params.id);
    const set: { display_name?: string; base_url?: string } = {};
    if (body.displayName !== undefined) set.display_name = body.displayName;
    if (body.baseUrl !== undefined) {
      const base = normalizeBaseUrl(body.baseUrl, deps.config.MESH_FEDERATION_ALLOW_HTTP);
      if (!base.ok) throw invalid({ 'body.baseUrl': base.code });
      set.base_url = base.url;
    }
    if (Object.keys(set).length === 0) return toPeer(peer);
    const row = await writeTx(deps, async (trx) => {
      const updated = await trx
        .updateTable('peer')
        .set(set)
        .where('id', '=', peer.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await deps.audit.record(
        {
          actor,
          action: 'peer.update',
          objectType: 'peer',
          objectId: peer.id,
          details: { nodeId: peer.node_id, fields: Object.keys(set) },
          ip,
          requestId,
        },
        trx,
      );
      return updated;
    });
    return toPeer(row);
  },

  'peers.ping': async ({ deps, params, actor, ip, requestId }) => {
    const peer = await getPeer(deps.db, params.id);
    if (peer.status === 'suspended') {
      return { ok: false, latencyMs: null, errorCode: 'peer_untrusted' };
    }
    const started = performance.now();
    let errorCode: string | null = null;
    let latencyMs: number | null = null;
    try {
      const reply = await sendSigned(deps, peer, 'ping', {}, { schema: PingResponse });
      if (reply.body.nodeId !== peer.node_id) {
        throw new PeerCallError('signature_invalid', { reason: 'wrong_sender' });
      }
      latencyMs = Math.max(0, Math.round(performance.now() - started));
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      errorCode = errorCodeOf(err);
    }
    const now = deps.now();
    await deps.db
      .updateTable('peer')
      .set(errorCode ? { last_error: errorCode } : { last_seen_at: now, last_error: null })
      .where('id', '=', peer.id)
      .execute();
    await deps.audit.record({
      actor,
      action: 'peer.ping',
      outcome: errorCode ? 'error' : 'success',
      objectType: 'peer',
      objectId: peer.id,
      details: { nodeId: peer.node_id, ...(errorCode ? { code: errorCode } : { latencyMs }) },
      ip,
      requestId,
    });
    return { ok: errorCode === null, latencyMs, errorCode };
  },
};
