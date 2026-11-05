/**
 * Wechsel des Ed25519-Knotenschlüssels mit Benachrichtigung der Partner (ADR 0013, docs/protokoll.md).
 *
 * Eigener Wechsel (rotateNodeKey):
 *  - routine: neues Schlüsselpaar; die Rotationsaussage {nodeId, alter Schlüssel, neuer Schlüssel,
 *    Zeitpunkt, Ende der Übergangszeit} wird mit beiden Schlüsseln signiert (Kontinuität und Besitz) und je
 *    vertrauenswürdigem bzw. gesperrtem Partner als Mitteilung key_rotated ins Ausgangspostfach gestellt
 *    (Umschlag mit dem bisherigen Schlüssel signiert). Bis zur Bestätigung durch den Partner (signierte
 *    Antwort auf die Mitteilung) bzw. bis zum Ende der Übergangszeit signiert der Knoten für diesen Partner
 *    weiter mit dem bisherigen Schlüssel (NodeIdentity.signerFor); danach wird dieser gelöscht.
 *  - compromised: neues Schlüsselpaar ohne Mitteilung und ohne Übergangszeit; der bisherige Schlüssel wird
 *    sofort verworfen. Partner müssen den neuen Fingerprint telefonisch abgleichen (peers.replaceKey).
 *
 * Wechsel eines Partners (receiveKeyRotation): nur von vertrauenswürdigen Partnern, Umschlag mit dem
 * gespeicherten (aktuellen) Schlüssel signiert, Aussage beginnt bei diesem Schlüssel, beide Signaturen
 * gültig. Danach gilt der neue Schlüssel; der bisherige wird bis zum Ende der Übergangszeit (höchstens
 * 30 Tage) zusätzlich angenommen, aber nie für eine weitere Rotationsmitteilung.
 */
import { randomUUID } from 'node:crypto';
import {
  KEY_ROTATION_FORMAT,
  type KeyRotatedNotice,
  KeyRotationStatement,
  MAX_KEY_GRACE_MS,
} from '../../../shared/contract/federation-wire.ts';
import { type Actor, SYSTEM_ACTOR } from '../../core/audit.ts';
import {
  ed25519Sign,
  ed25519Verify,
  fingerprint,
  generateEd25519,
  normalizeFingerprint,
} from '../../core/crypto.ts';
import { iso, isoReq } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import type { Deps } from '../../core/deps.ts';
import { conflict, invalid } from '../../core/errors.ts';
import type { Handlers } from '../../core/http.ts';
import { NodeIdentity, rotationKeyAad, type Signer } from '../../core/node-identity.ts';
import { writeTx } from '../../core/tx.ts';
import { toPeer } from './mappers.ts';
import { enqueueNotice } from './outbox.ts';
import { getPeer, isPublicKey } from './peers.ts';
import { parseJson } from './protocol.ts';
import { peerActor } from './store.ts';

export const DEFAULT_GRACE_DAYS = 7;
export const MAX_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const AAD_PRIVATE_KEY = 'node_identity.private_key';

type KeyRotatedBody = ReturnType<typeof KeyRotatedNotice.parse>;

// ---------------------------------------------------------------------------------------------
// Signaturen von Partnern: aktueller Schlüssel, bisheriger nur in der Übergangszeit
// ---------------------------------------------------------------------------------------------

/** Schlüssel eines Partners (Zeile peer oder Ausschnitt) */
export interface PeerKeys {
  public_key: string;
  previous_public_key?: string | null;
  previous_key_valid_until?: Date | null;
}

/**
 * Prüft eine Signatur eines Partners. 'current' = mit dem gespeicherten Schlüssel, 'previous' = mit dem
 * bisherigen Schlüssel innerhalb der Übergangszeit nach einem Schlüsselwechsel, null = ungültig.
 */
export function verifyPeerSignature(
  peer: PeerKeys,
  data: Uint8Array | string,
  signature: string,
  now: Date,
): 'current' | 'previous' | null {
  if (ed25519Verify(peer.public_key, data, signature)) return 'current';
  if (
    peer.previous_public_key &&
    peer.previous_key_valid_until &&
    now.getTime() <= peer.previous_key_valid_until.getTime() &&
    ed25519Verify(peer.previous_public_key, data, signature)
  ) {
    return 'previous';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rotationsaussage
// ---------------------------------------------------------------------------------------------

export function buildRotationStatement(s: Omit<KeyRotationStatement, 'format'>): string {
  const statement: KeyRotationStatement = { format: KEY_ROTATION_FORMAT, ...s };
  return JSON.stringify(statement);
}

export type StatementCheck =
  | { ok: true; statement: KeyRotationStatement }
  | { ok: false; reason: 'invalid_statement' | 'rotation_proof_invalid' | 'same_key' };

/** Aufbau und beide Signaturen (bisheriger und neuer Schlüssel) über die exakte Zeichenkette */
export function checkRotationStatement(
  n: Pick<KeyRotatedBody, 'statement' | 'signatureOld' | 'signatureNew'>,
): StatementCheck {
  const parsed = KeyRotationStatement.safeParse(parseJson(n.statement));
  if (!parsed.success) return { ok: false, reason: 'invalid_statement' };
  const st = parsed.data;
  if (st.oldPublicKey === st.newPublicKey) return { ok: false, reason: 'same_key' };
  if (!ed25519Verify(st.oldPublicKey, n.statement, n.signatureOld)) {
    return { ok: false, reason: 'rotation_proof_invalid' };
  }
  if (!ed25519Verify(st.newPublicKey, n.statement, n.signatureNew)) {
    return { ok: false, reason: 'rotation_proof_invalid' };
  }
  return { ok: true, statement: st };
}

// ---------------------------------------------------------------------------------------------
// Eigener Schlüsselwechsel
// ---------------------------------------------------------------------------------------------

export interface RotateOptions {
  mode: 'routine' | 'compromised';
  graceDays?: number;
  actor: Actor;
  userId?: string | null;
  ip?: string | null;
  requestId?: string | null;
}

export interface RotateResult {
  rotationId: string;
  mode: 'routine' | 'compromised';
  oldFingerprint: string;
  newFingerprint: string;
  graceUntil: Date;
  peersNotified: number;
}

/**
 * Wechselt den Knotenschlüssel (routine: mit Mitteilung an Partner und Übergangszeit; compromised: ohne).
 * Ein planmäßiger Wechsel ist abgelehnt, solange ein anderer läuft (conflict key_rotation_in_progress);
 * ein Wechsel wegen Kompromittierung beendet einen laufenden sofort.
 */
export async function rotateNodeKey(
  deps: Pick<Deps, 'db' | 'box' | 'audit' | 'now' | 'identity'>,
  opts: RotateOptions,
): Promise<RotateResult> {
  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  if (!Number.isInteger(graceDays) || graceDays < 1 || graceDays > MAX_GRACE_DAYS) {
    throw invalid({ graceDays: 'invalid' });
  }
  const result = await writeTx(deps, async (trx) => {
    // Zeilensperren: node_identity → node_key_rotation → peer → outbox_message (Audit zuletzt, writeTx)
    const row = await trx
      .selectFrom('node_identity')
      .selectAll()
      .where('id', '=', 1)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const running = await trx
      .selectFrom('node_key_rotation')
      .select(['id', 'old_public_key'])
      .where('finished_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (running && opts.mode === 'routine') throw conflict('key_rotation_in_progress');

    const now = deps.now();
    const oldPrivate = deps.box.open(row.private_key_enc, AAD_PRIVATE_KEY);
    const next = generateEd25519();
    const rotationId = randomUUID();
    let abortedPeers = 0;

    if (running) {
      // Kompromittierung während eines laufenden Wechsels: auch dessen bisherigen Schlüssel sofort verwerfen
      const open = await trx
        .selectFrom('node_key_rotation_peer')
        .select('outbox_message_id')
        .where('rotation_id', '=', running.id)
        .where('confirmed_at', 'is', null)
        .execute();
      const ids = open.map((o) => o.outbox_message_id).filter((id): id is string => id !== null);
      if (ids.length > 0) {
        await trx
          .updateTable('outbox_message')
          .set({ status: 'failed', last_error: 'key_rotation_expired' })
          .where('id', 'in', ids)
          .where('status', '<>', 'delivered')
          .execute();
      }
      abortedPeers = open.length;
      await trx
        .updateTable('node_key_rotation')
        .set({ finished_at: now, old_private_key_enc: null })
        .where('id', '=', running.id)
        .execute();
    }

    let graceUntil = now;
    let peersNotified = 0;
    if (opts.mode === 'routine') {
      graceUntil = new Date(now.getTime() + graceDays * DAY_MS);
      const statement = buildRotationStatement({
        nodeId: row.node_id,
        oldPublicKey: row.public_key,
        newPublicKey: next.publicKey,
        rotatedAt: now.toISOString(),
        graceUntil: graceUntil.toISOString(),
      });
      const signatureOld = ed25519Sign(oldPrivate, statement);
      const signatureNew = ed25519Sign(next.privateKey, statement);
      await trx
        .insertInto('node_key_rotation')
        .values({
          id: rotationId,
          mode: 'routine',
          old_public_key: row.public_key,
          new_public_key: next.publicKey,
          old_private_key_enc: deps.box.seal(oldPrivate, rotationKeyAad(rotationId)),
          statement,
          signature_old: signatureOld,
          signature_new: signatureNew,
          rotated_at: now,
          grace_until: graceUntil,
          rotated_by: opts.userId ?? null,
        })
        .execute();
      // Partner, mit denen Nachrichten ausgetauscht werden (auch gesperrte: sie erhalten weiter
      // Löschmitteilungen, die sie prüfen können müssen). Ausstehende Partner kennen uns ggf. noch nicht.
      const peers = await trx
        .selectFrom('peer')
        .select(['id'])
        .where('status', 'in', ['trusted', 'suspended'])
        .orderBy('node_id')
        .forUpdate()
        .execute();
      for (const p of peers) {
        const messageId = await enqueueNotice(
          trx,
          p.id,
          { kind: 'key_rotated', statement, signatureOld, signatureNew },
          now,
        );
        await trx
          .insertInto('node_key_rotation_peer')
          .values({ rotation_id: rotationId, peer_id: p.id, outbox_message_id: messageId })
          .execute();
      }
      peersNotified = peers.length;
    } else {
      // Kompromittierung: Verlauf ohne Aussage, bisheriger Schlüssel wird nicht aufbewahrt
      await trx
        .insertInto('node_key_rotation')
        .values({
          id: rotationId,
          mode: 'compromised',
          old_public_key: row.public_key,
          new_public_key: next.publicKey,
          old_private_key_enc: null,
          rotated_at: now,
          grace_until: now,
          finished_at: now,
          rotated_by: opts.userId ?? null,
        })
        .execute();
    }

    await trx
      .updateTable('node_identity')
      .set({
        public_key: next.publicKey,
        private_key_enc: deps.box.seal(next.privateKey, AAD_PRIVATE_KEY),
        previous_public_key: opts.mode === 'routine' ? row.public_key : null,
        key_created_at: now,
      })
      .where('id', '=', 1)
      .execute();

    const out: RotateResult = {
      rotationId,
      mode: opts.mode,
      oldFingerprint: fingerprint(row.public_key),
      newFingerprint: fingerprint(next.publicKey),
      graceUntil,
      peersNotified,
    };
    await deps.audit.record(
      {
        actor: opts.actor,
        action: 'node.key_rotate',
        objectType: 'node_key',
        objectId: rotationId,
        details: {
          mode: out.mode,
          oldFingerprint: out.oldFingerprint,
          newFingerprint: out.newFingerprint,
          graceUntil: opts.mode === 'routine' ? graceUntil.toISOString() : null,
          peersNotified,
          ...(running ? { abortedRotationId: running.id, abortedPeers } : {}),
        },
        ip: opts.ip ?? null,
        requestId: opts.requestId ?? null,
      },
      trx,
    );
    return out;
  });
  await deps.identity.reload(deps.db, deps.box);
  return result;
}

/** Laufender Wechsel, zu dem eine Rotationsmitteilung gehört, und dessen bisheriger Schlüssel */
export async function rotationForNotice(
  deps: Pick<Deps, 'db' | 'box' | 'identity'>,
  notice: Pick<KeyRotatedBody, 'statement'>,
): Promise<{ rotationId: string; signer: Signer } | null> {
  const st = KeyRotationStatement.safeParse(parseJson(notice.statement));
  if (!st.success) return null;
  const r = await deps.db
    .selectFrom('node_key_rotation')
    .select('id')
    .where('new_public_key', '=', st.data.newPublicKey)
    .executeTakeFirst();
  if (!r) return null;
  const signer = await NodeIdentity.rotationSigner(deps.db, deps.box, deps.identity.nodeId, r.id);
  return signer ? { rotationId: r.id, signer } : null;
}

/**
 * Wartung (minütlich): beendet Wechsel nach Ablauf der Übergangszeit (bisherigen privaten Schlüssel
 * löschen, nicht zugestellte Mitteilungen als fehlgeschlagen markieren, Partner ohne Bestätigung
 * protokollieren) und vergisst abgelaufene bisherige Schlüssel von Partnern.
 */
export async function runKeyMaintenance(
  deps: Pick<Deps, 'db' | 'box' | 'audit' | 'now' | 'identity'>,
): Promise<{ finished: number; peerKeysExpired: number }> {
  const now = deps.now();
  const finished = await writeTx(deps, async (trx) => {
    const due = await trx
      .selectFrom('node_key_rotation')
      .select(['id', 'old_public_key'])
      .where('finished_at', 'is', null)
      .where('grace_until', '<=', now)
      .forUpdate()
      .execute();
    for (const r of due) {
      const peers = await trx
        .selectFrom('node_key_rotation_peer as rp')
        .innerJoin('peer as p', 'p.id', 'rp.peer_id')
        .select(['p.node_id', 'rp.confirmed_at', 'rp.outbox_message_id'])
        .where('rp.rotation_id', '=', r.id)
        .orderBy('p.node_id')
        .execute();
      const open = peers.filter((p) => !p.confirmed_at);
      const ids = open.map((p) => p.outbox_message_id).filter((id): id is string => id !== null);
      if (ids.length > 0) {
        await trx
          .updateTable('outbox_message')
          .set({ status: 'failed', last_error: 'key_rotation_expired' })
          .where('id', 'in', ids)
          .where('status', '<>', 'delivered')
          .execute();
      }
      await trx
        .updateTable('node_key_rotation')
        .set({ finished_at: now, old_private_key_enc: null })
        .where('id', '=', r.id)
        .execute();
      await trx
        .updateTable('node_identity')
        .set({ previous_public_key: null })
        .where('id', '=', 1)
        .where('previous_public_key', '=', r.old_public_key)
        .execute();
      await deps.audit.record(
        {
          actor: { type: 'system', id: null, label: 'system' },
          action: 'node.key_rotation.finished',
          // Partner ohne Bestätigung können diesen Knoten nicht mehr prüfen: sichtbar als Fehler
          outcome: open.length > 0 ? 'error' : 'success',
          objectType: 'node_key',
          objectId: r.id,
          details: {
            confirmed: peers.length - open.length,
            unconfirmedPeers: open.map((p) => p.node_id),
          },
        },
        trx,
      );
    }
    return due.length;
  });
  if (finished > 0) await deps.identity.reload(deps.db, deps.box);
  const expired = await deps.db
    .updateTable('peer')
    .set({ previous_public_key: null, previous_key_valid_until: null })
    .where('previous_key_valid_until', '<=', now)
    .executeTakeFirst();
  return { finished, peerKeysExpired: Number(expired.numUpdatedRows) };
}

/**
 * Während der Übergangszeit signiert der Knoten für einen Partner ohne Bestätigung mit dem bisherigen
 * Schlüssel. Hat dieser Partner den neuen Schlüssel schon manuell eingetragen (peers.replaceKey), lehnt er
 * alles mit dem bisherigen ab (bad_signature) – bis zum Ende der Übergangszeit. Deshalb wiederholt der
 * Client eine solche Anfrage einmal mit dem neuen Schlüssel (client.ts); gelingt sie, kennt der Partner den
 * neuen Schlüssel nachweislich: Er gilt als bestätigt (protokolliert), ab jetzt neuer Schlüssel.
 */
export async function confirmRotationByNewKey(
  deps: Pick<Deps, 'db' | 'audit' | 'now' | 'identity'>,
  peerNodeId: string,
  messageType: string,
): Promise<boolean> {
  const rotationId = deps.identity.transitionRotationId;
  if (!rotationId) return false;
  const now = deps.now();
  return writeTx(deps, async (trx) => {
    const peer = await trx
      .selectFrom('peer')
      .select('id')
      .where('node_id', '=', peerNodeId)
      .executeTakeFirst();
    if (!peer) return false;
    const r = await trx
      .updateTable('node_key_rotation_peer')
      .set({ confirmed_at: now })
      .where('rotation_id', '=', rotationId)
      .where('peer_id', '=', peer.id)
      .where('confirmed_at', 'is', null)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) return false;
    await deps.audit.record(
      {
        actor: SYSTEM_ACTOR,
        action: 'node.key_rotation.confirmed',
        objectType: 'node_key',
        objectId: rotationId,
        details: { peerNodeId, via: 'new_key_accepted', messageType, newlyConfirmed: true },
      },
      trx,
    );
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Wechsel eines Partners (Empfang der Mitteilung key_rotated)
// ---------------------------------------------------------------------------------------------

export type NoticeOutcome =
  | { ok: true; body: { ack: true; affectedRows: number } }
  | { ok: false; code: 'bad_request' | 'untrusted' | 'bad_signature'; reason: string; audited: true };

export interface InboundContext {
  deps: Deps;
  peer: Row<'peer'>;
  /** mit welchem Schlüssel des Partners der Umschlag geprüft wurde */
  verifiedWith: 'current' | 'previous';
  messageId: string;
  now: Date;
  ip: string | null;
  requestId: string;
}

export async function receiveKeyRotation(ib: InboundContext, notice: KeyRotatedBody): Promise<NoticeOutcome> {
  const { deps, peer, now } = ib;
  const actor = peerActor(peer.node_id, peer.display_name);
  const reject = async (
    code: 'bad_request' | 'untrusted' | 'bad_signature',
    reason: string,
  ): Promise<NoticeOutcome> => {
    await deps.audit.record({
      actor,
      action: 'peer.key_rotation.rejected',
      outcome: 'denied',
      objectType: 'peer',
      objectId: peer.id,
      details: { nodeId: peer.node_id, code, reason, messageId: ib.messageId },
      ip: ib.ip,
      requestId: ib.requestId,
    });
    return { ok: false, code, reason, audited: true };
  };

  // gesperrte Partner dürfen Mitteilungen senden, die nur löschen – aber keinen neuen Schlüssel setzen
  if (peer.status !== 'trusted') return reject('untrusted', 'peer_not_trusted');
  const check = checkRotationStatement(notice);
  if (!check.ok) {
    return reject(check.reason === 'rotation_proof_invalid' ? 'bad_signature' : 'bad_request', check.reason);
  }
  const st = check.statement;
  if (st.nodeId !== peer.node_id) return reject('bad_request', 'wrong_node');

  // bereits übernommen (Antwort ging verloren, Ausgangspostfach wiederholt) oder der neue Schlüssel wurde
  // hier schon manuell eingetragen (peers.replaceKey, Fingerprint abgeglichen): bestätigen, nichts ändern.
  // Die Aussage ist mit beiden Schlüsseln gültig signiert, der Umschlag mit einem hier gültigen.
  if (peer.public_key === st.newPublicKey) {
    return { ok: true, body: { ack: true, affectedRows: 0 } };
  }
  // Kontinuität: Aussage beginnt beim heute vertrauten Schlüssel, und der Umschlag ist mit genau diesem
  // signiert (nicht mit einem bisherigen Schlüssel aus einer Übergangszeit)
  if (st.oldPublicKey !== peer.public_key) return reject('bad_request', 'stale_key');
  if (ib.verifiedWith !== 'current') return reject('bad_signature', 'previous_key');
  if (st.newPublicKey === deps.identity.publicKey) return reject('bad_request', 'own_key');
  const inUse = await deps.db
    .selectFrom('peer')
    .select('id')
    .where('public_key', '=', st.newPublicKey)
    .where('id', '<>', peer.id)
    .executeTakeFirst();
  if (inUse) return reject('bad_request', 'public_key_in_use');

  const graceUntil = new Date(Math.min(Date.parse(st.graceUntil), now.getTime() + MAX_KEY_GRACE_MS));
  const keepPrevious = graceUntil.getTime() > now.getTime();
  const applied = await writeTx(deps, async (trx) => {
    const locked = await trx
      .selectFrom('peer')
      .select(['public_key', 'status'])
      .where('id', '=', peer.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    // gleichzeitig geändert (z. B. zweite Zustellung, Sperre, manueller Schlüsseltausch)
    if (locked.public_key !== st.oldPublicKey || locked.status !== 'trusted') return false;
    await trx
      .updateTable('peer')
      .set({
        public_key: st.newPublicKey,
        fingerprint: fingerprint(st.newPublicKey),
        previous_public_key: keepPrevious ? st.oldPublicKey : null,
        previous_key_valid_until: keepPrevious ? graceUntil : null,
        key_rotated_at: now,
        last_error: null,
      })
      .where('id', '=', peer.id)
      .execute();
    await deps.audit.record(
      {
        actor,
        action: 'peer.key_rotated',
        objectType: 'peer',
        objectId: peer.id,
        details: {
          nodeId: peer.node_id,
          oldFingerprint: fingerprint(st.oldPublicKey),
          newFingerprint: fingerprint(st.newPublicKey),
          rotatedAt: st.rotatedAt,
          previousKeyValidUntil: keepPrevious ? graceUntil.toISOString() : null,
          messageId: ib.messageId,
        },
        ip: ib.ip,
        requestId: ib.requestId,
      },
      trx,
    );
    return true;
  });
  if (!applied) return reject('bad_request', 'stale_key');
  return { ok: true, body: { ack: true, affectedRows: 1 } };
}

// ---------------------------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------------------------

async function keyStatus(deps: Deps) {
  const rotation = await deps.db
    .selectFrom('node_key_rotation')
    .selectAll()
    .orderBy('rotated_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  let peers: {
    peerId: string;
    nodeId: string;
    displayName: string;
    confirmedAt: string | null;
    deliveryStatus: 'pending' | 'delivered' | 'failed' | null;
    lastError: string | null;
  }[] = [];
  if (rotation) {
    const rows = await deps.db
      .selectFrom('node_key_rotation_peer as rp')
      .innerJoin('peer as p', 'p.id', 'rp.peer_id')
      .leftJoin('outbox_message as m', 'm.id', 'rp.outbox_message_id')
      .select([
        'rp.peer_id',
        'p.node_id',
        'p.display_name',
        'rp.confirmed_at',
        'm.status as delivery_status',
        'm.last_error',
      ])
      .where('rp.rotation_id', '=', rotation.id)
      .orderBy('p.display_name')
      .execute();
    peers = rows.map((r) => ({
      peerId: r.peer_id,
      nodeId: r.node_id,
      displayName: r.display_name,
      confirmedAt: iso(r.confirmed_at),
      deliveryStatus: (r.delivery_status as 'pending' | 'delivered' | 'failed' | null) ?? null,
      lastError: r.last_error ?? null,
    }));
  }
  return {
    fingerprint: deps.identity.fingerprint,
    publicKey: deps.identity.publicKey,
    keyCreatedAt: isoReq(deps.identity.keyCreatedAt),
    rotation: rotation
      ? {
          id: rotation.id,
          mode: rotation.mode,
          rotatedAt: isoReq(rotation.rotated_at),
          graceUntil: isoReq(rotation.grace_until),
          finishedAt: iso(rotation.finished_at),
          running: rotation.finished_at === null,
          previousFingerprint: fingerprint(rotation.old_public_key),
          peers,
        }
      : null,
  };
}

export const keyHandlers: Handlers = {
  'node.keyStatus': async ({ deps }) => keyStatus(deps),

  'node.rotateKey': async ({ deps, body, user, actor, ip, requestId }) => {
    await rotateNodeKey(deps, {
      mode: body.mode,
      graceDays: body.graceDays,
      actor,
      userId: user.id,
      ip,
      requestId,
    });
    // Mitteilungen sofort zustellen (Fehler: das Ausgangspostfach wiederholt)
    void deps.services.federation
      .flushOutbox()
      .catch((err: Error) => deps.log.warn('outbox flush after key rotation failed', { error: err.message }));
    return keyStatus(deps);
  },

  /**
   * Neuen Schlüssel eines Partners manuell eintragen (Partner hat die Rotationsmitteilung verpasst oder
   * nach Kompromittierung neu erzeugt): Karte mit derselben Knoten-ID; Status danach "ausstehend", bis
   * der telefonisch abgeglichene Fingerprint bestätigt ist (peers.trust).
   */
  'peers.replaceKey': async ({ deps, params, body, actor, ip, requestId }) => {
    const peer = await getPeer(deps.db, params.id);
    const { card } = body;
    const fields: Record<string, string> = {};
    if (card.nodeId !== peer.node_id) fields['card.nodeId'] = 'mismatch';
    if (!isPublicKey(card.publicKey)) fields['card.publicKey'] = 'invalid_key';
    else if (card.publicKey === deps.identity.publicKey) fields['card.publicKey'] = 'own_key';
    else if (card.publicKey === peer.public_key) fields['card.publicKey'] = 'not_allowed';
    else if (normalizeFingerprint(fingerprint(card.publicKey)) !== normalizeFingerprint(card.fingerprint)) {
      fields['card.fingerprint'] = 'mismatch';
    }
    if (!fields['card.publicKey']) {
      const other = await deps.db
        .selectFrom('peer')
        .select('id')
        .where('public_key', '=', card.publicKey)
        .where('id', '<>', peer.id)
        .executeTakeFirst();
      if (other) fields['card.publicKey'] = 'taken';
    }
    if (Object.keys(fields).length > 0) {
      await deps.audit.record({
        actor,
        action: 'peer.key_replace',
        outcome: 'denied',
        objectType: 'peer',
        objectId: peer.id,
        details: { nodeId: peer.node_id, fields },
        ip,
        requestId,
      });
      throw invalid(fields);
    }
    const now = deps.now();
    const row = await writeTx(deps, async (trx) => {
      const updated = await trx
        .updateTable('peer')
        .set({
          public_key: card.publicKey,
          fingerprint: fingerprint(card.publicKey),
          // ohne Übergangszeit: der bisherige Schlüssel gilt sofort nicht mehr
          previous_public_key: null,
          previous_key_valid_until: null,
          key_rotated_at: now,
          // erneuter Fingerprint-Abgleich erforderlich
          status: 'pending',
          trusted_at: null,
          trusted_by: null,
          last_error: null,
        })
        .where('id', '=', peer.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await deps.audit.record(
        {
          actor,
          action: 'peer.key_replace',
          objectType: 'peer',
          objectId: peer.id,
          details: {
            nodeId: peer.node_id,
            previousStatus: peer.status,
            oldFingerprint: peer.fingerprint,
            newFingerprint: updated.fingerprint,
          },
          ip,
          requestId,
        },
        trx,
      );
      return updated;
    });
    return toPeer(row);
  },
};
