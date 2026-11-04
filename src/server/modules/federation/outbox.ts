/**
 * Ausgangspostfach für Mitteilungen an Partner (Widerruf, Löschung von Personen) mit Wiederholungen,
 * Ereignis-Handler, die Mitteilungen atomar mit der auslösenden Änderung einstellen, und Aufbewahrung.
 */
import { sql } from 'kysely';
import { NoticeBody, NoticeResponse } from '../../../shared/contract/federation-wire.ts';
import { type Actor, SYSTEM_ACTOR } from '../../core/audit.ts';
import { sha256Hex } from '../../core/crypto.ts';
import type { DbOrTx, Tx } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import type { Deps } from '../../core/deps.ts';
import type { Handlers } from '../../core/http.ts';
import { assertDeliveryLock } from '../../core/locks.ts';
import { writeTx } from '../../core/tx.ts';
import { errorCodeOf, sendSigned } from './client.ts';
import { toOutboxMessage } from './mappers.ts';
import { NONCE_TTL_MS } from './protocol.ts';
import { clearReceivedCopies, logExchange, NOTICE_REF } from './store.ts';

export const MAX_ATTEMPTS = 20;
const BASE_DELAY_MS = 10_000;
const MAX_DELAY_MS = 60 * 60 * 1000;
/** Reservierung beanspruchter Nachrichten (verhindert parallele Zustellung durch zweiten Lauf) */
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const BATCH = 50;
const OUTBOX_LIST_LIMIT = 500;

export const FLUSH_INTERVAL_MS = 5_000;
export const RETENTION_INTERVAL_MS = 60_000;

/** Wartezeit nach einem Fehlversuch: min(2^bisherigeVersuche × 10 s, 1 h) */
export function backoffMs(previousAttempts: number): number {
  return Math.min(2 ** previousAttempts * BASE_DELAY_MS, MAX_DELAY_MS);
}

export async function enqueueNotice(trx: DbOrTx, peerId: string, body: NoticeBody, now: Date): Promise<void> {
  await trx
    .insertInto('outbox_message')
    .values({
      peer_id: peerId,
      type: 'notice',
      body: JSON.stringify(body),
      next_attempt_at: now,
      created_at: now,
    })
    .execute();
}

// ---------------------------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------------------------

export function registerOutboxEvents(deps: Deps): void {
  deps.events.onTx('release.revoked', async (e, trx) => {
    if (e.recipientType !== 'peer' || !e.recipientPeerId) return;
    await enqueueNotice(
      trx,
      e.recipientPeerId,
      { kind: 'release_revoked', releaseId: e.releaseId, reason: e.reason.slice(0, 1000) },
      deps.now(),
    );
  });

  // Produkt stillgelegt: gelieferte Kopien aller noch nicht widerrufenen Partnerfreigaben löschen lassen
  deps.events.onTx('product.changed', async (e, trx) => {
    if (!e.retired) return;
    // Stilllegung hält die Liefersperre exklusiv (core/locks.ts): alle Lieferungen sind protokolliert
    assertDeliveryLock(trx, 'exclusive');
    const releases = await trx
      .selectFrom('data_release as r')
      .select(['r.id', 'r.recipient_peer_id'])
      .where('r.product_id', '=', e.productId)
      .where('r.recipient_type', '=', 'peer')
      .where('r.revoked_at', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('exchange_log as el')
            .select('el.id')
            .whereRef('el.release_id', '=', 'r.id')
            .where('el.direction', '=', 'outgoing')
            .where('el.outcome', '=', 'delivered'),
        ),
      )
      .execute();
    for (const r of releases) {
      if (!r.recipient_peer_id) continue;
      await enqueueNotice(
        trx,
        r.recipient_peer_id,
        { kind: 'release_revoked', releaseId: r.id, reason: 'product_retired' },
        deps.now(),
      );
    }
  });

  deps.events.onTx('consent.withdrawn', (e, trx) =>
    withdrawSubject(deps, trx, e.athleteId, 'consent_withdrawn', {
      purpose: e.purpose,
      dataCategory: e.dataCategory,
    }),
  );

  deps.events.onTx('athlete.deleted', (e, trx) => withdrawSubject(deps, trx, e.athleteId, 'erasure', null));
}

interface DeliveredSubject {
  release_id: string;
  subject: string;
  peer_id: string | null;
  purpose: string | null;
  data_category: string | null;
  consent_applied: boolean | null;
  requires_consent: boolean | null;
  source_type: string | null;
  category: string | null;
  special_category: boolean | null;
}

/**
 * Erfasst ein Einwilligungswiderruf (Zweck, Datenkategorie; '*' erfasst alles) diese Lieferung?
 * Maßgeblich ist, unter welcher Einstufung geliefert wurde (exchange_log.data_category, consent_applied),
 * nicht die heutige: eine spätere Neueinstufung des Datensatzes ändert nichts daran, auf welcher
 * Einwilligung die beim Partner liegende Kopie beruht. Ohne diese Angaben (Lieferungen vor Migration 0500,
 * soweit nicht nachgetragen) gilt die heutige Einstufung; ist auch sie unbekannt, im Zweifel löschen lassen.
 */
export function consentWithdrawalCovers(
  consent: { purpose: string; dataCategory: string },
  d: Pick<
    DeliveredSubject,
    | 'purpose'
    | 'data_category'
    | 'consent_applied'
    | 'requires_consent'
    | 'source_type'
    | 'category'
    | 'special_category'
  >,
): boolean {
  const consentApplied =
    d.consent_applied ??
    (d.requires_consent === null ? true : d.requires_consent || d.special_category === true);
  if (!consentApplied) return false;
  if (consent.purpose !== '*' && d.purpose !== consent.purpose) return false;
  const category = d.data_category ?? d.category ?? (d.source_type === 'athletes' ? 'master' : null);
  if (consent.dataCategory !== '*' && category !== null && category !== consent.dataCategory) return false;
  return true;
}

/**
 * Sucht alle an Partner gelieferten Freigaben, in denen die Person (als freigabebezogenes Pseudonym)
 * enthalten war, und stellt je Freigabe eine Mitteilung subjects_withdrawn ein.
 *  - consent_withdrawn: nur Lieferungen, für die eine Einwilligung galt und deren Lieferzweck und
 *    Datenkategorie (wie geliefert) vom Widerruf erfasst sind (consentWithdrawalCovers)
 *  - erasure: alle gelieferten Freigaben
 * Gesucht wird nach dem Pseudonym in der heutigen und in der früheren Form (NodeIdentity.legacyPseudonym);
 * die Mitteilung nennt die Formen, die tatsächlich geliefert wurden.
 */
async function withdrawSubject(
  deps: Deps,
  trx: Tx,
  athleteId: string,
  reason: 'consent_withdrawn' | 'erasure',
  consent: { purpose: string; dataCategory: string } | null,
): Promise<void> {
  // Die auslösende Transaktion hält die Liefersperre exklusiv (core/locks.ts): laufende Lieferungen sind
  // abgeschlossen und protokolliert; spätere warten und sehen den Widerruf bereits im PEP
  assertDeliveryLock(trx, 'exclusive');
  const releases = await trx
    .selectFrom('exchange_log')
    .select('release_id')
    .distinct()
    .where('direction', '=', 'outgoing')
    .where('outcome', '=', 'delivered')
    .where('release_id', 'is not', null)
    .where(sql<boolean>`cardinality(subjects) > 0`)
    .execute();
  const releaseIds: string[] = [];
  const subjects: string[] = [];
  for (const { release_id: releaseId } of releases) {
    if (!releaseId) continue;
    const forms = new Set([
      deps.identity.pseudonym(releaseId, athleteId),
      deps.identity.legacyPseudonym(releaseId, athleteId),
    ]);
    for (const subject of forms) {
      releaseIds.push(releaseId);
      subjects.push(subject);
    }
  }
  if (releaseIds.length === 0) return;

  const delivered = await sql<DeliveredSubject>`
    select distinct el.release_id::text as release_id, s.subject,
      coalesce(r.recipient_peer_id, el.peer_id)::text as peer_id, el.purpose, el.data_category,
      el.consent_applied, r.requires_consent, p.source_type, d.category, d.special_category
    from unnest(${releaseIds}::uuid[], ${subjects}::text[]) as s(release_id, subject)
    join exchange_log el on el.release_id = s.release_id and el.subjects @> array[s.subject]
    left join data_release r on r.id = el.release_id
    left join data_product p on p.id = r.product_id
    left join dataset d on d.id = p.dataset_id
    where el.direction = 'outgoing' and el.outcome = 'delivered'`.execute(trx);

  const targets = new Map<string, { peerId: string; subjects: Set<string> }>();
  for (const d of delivered.rows) {
    if (!d.peer_id) continue;
    if (consent && !consentWithdrawalCovers(consent, d)) continue;
    const target = targets.get(d.release_id) ?? { peerId: d.peer_id, subjects: new Set<string>() };
    target.subjects.add(d.subject);
    targets.set(d.release_id, target);
  }

  const now = deps.now();
  for (const [releaseId, target] of [...targets].sort(([a], [b]) => a.localeCompare(b))) {
    await enqueueNotice(
      trx,
      target.peerId,
      { kind: 'subjects_withdrawn', releaseId, subjects: [...target.subjects].sort(), reason },
      now,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Zustellung
// ---------------------------------------------------------------------------------------------

type Message = Row<'outbox_message'>;

async function markFailedAttempt(deps: Deps, peer: Row<'peer'> | null, m: Message, code: string) {
  const now = deps.now();
  const attempts = m.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await writeTx(deps, async (trx) => {
      await trx
        .updateTable('outbox_message')
        .set({ status: 'failed', attempts, last_error: code })
        .where('id', '=', m.id)
        .execute();
      await deps.audit.record(
        {
          actor: SYSTEM_ACTOR,
          action: 'exchange.notice.failed',
          outcome: 'error',
          objectType: 'outbox_message',
          objectId: m.id,
          details: { peerNodeId: peer?.node_id ?? null, attempts, code },
        },
        trx,
      );
    });
    return;
  }
  await deps.db
    .updateTable('outbox_message')
    .set({
      attempts,
      last_error: code,
      next_attempt_at: new Date(now.getTime() + backoffMs(m.attempts)),
    })
    .where('id', '=', m.id)
    .execute();
}

/** Stellt eine Nachricht zu. Liefert 'delivered', 'failed' oder 'unreachable' (weitere Nachrichten an diesen Partner überspringen). */
async function deliver(
  deps: Deps,
  peer: Row<'peer'>,
  m: Message,
): Promise<'delivered' | 'failed' | 'unreachable'> {
  const notice = NoticeBody.safeParse(m.body);
  if (m.type !== 'notice' || !notice.success) {
    // nicht zustellbar (sollte nicht vorkommen): sofort endgültig fehlgeschlagen
    await markFailedAttempt(deps, peer, { ...m, attempts: MAX_ATTEMPTS - 1 }, 'bad_request');
    return 'failed';
  }
  try {
    const reply = await sendSigned(deps, peer, 'notice', notice.data, { schema: NoticeResponse });
    const now = deps.now();
    await writeTx(deps, async (trx) => {
      await trx
        .updateTable('outbox_message')
        .set({ status: 'delivered', delivered_at: now, attempts: m.attempts + 1, last_error: null })
        .where('id', '=', m.id)
        .execute();
      await logExchange(trx, {
        direction: 'outgoing',
        peer_id: peer.id,
        peer_node_id: peer.node_id,
        release_id: notice.data.releaseId,
        product_ref: NOTICE_REF[notice.data.kind],
        outcome: 'delivered',
        row_count: reply.body.affectedRows,
        payload_sha256: sha256Hex(reply.rawText),
        request_id: reply.requestId,
        at: now,
      });
      await deps.audit.record(
        {
          actor: SYSTEM_ACTOR,
          action: 'exchange.notice.sent',
          objectType: 'outbox_message',
          objectId: m.id,
          details: {
            kind: notice.data.kind,
            releaseId: notice.data.releaseId,
            peerNodeId: peer.node_id,
            affectedRows: reply.body.affectedRows,
            attempts: m.attempts + 1,
          },
        },
        trx,
      );
    });
    return 'delivered';
  } catch (err) {
    const code = errorCodeOf(err);
    if (code === 'internal_error') {
      deps.log.error('outbox delivery failed', { messageId: m.id, error: (err as Error).message });
    }
    await markFailedAttempt(deps, peer, m, code);
    return code === 'peer_unreachable' ? 'unreachable' : 'failed';
  }
}

/**
 * Setzt endgültig fehlgeschlagene Mitteilungen wieder auf "ausstehend" und sofort fällig (Aktion
 * "Jetzt zustellen", z. B. nachdem die Verbindung zum Partner wiederhergestellt ist). Die Zahl der Versuche
 * bleibt erhalten: scheitert auch dieser Versuch, ist die Mitteilung sofort wieder fehlgeschlagen.
 */
export async function requeueFailed(
  deps: Deps,
  ctx: { actor: Actor; ip: string | null; requestId: string },
): Promise<number> {
  return writeTx(deps, async (trx) => {
    const rows = await trx
      .updateTable('outbox_message')
      .set({ status: 'pending', next_attempt_at: deps.now() })
      .where('status', '=', 'failed')
      .returning('id')
      .execute();
    if (rows.length > 0) {
      await deps.audit.record(
        {
          actor: ctx.actor,
          action: 'outbox.requeue',
          objectType: 'outbox',
          details: { messages: rows.length },
          ip: ctx.ip,
          requestId: ctx.requestId,
        },
        trx,
      );
    }
    return rows.length;
  });
}

/** Stellt fällige Mitteilungen zu (je Partner der Reihe nach, Partner parallel). */
export async function flushOutbox(deps: Deps): Promise<{ delivered: number; failed: number }> {
  const now = deps.now();
  const claimed = await deps.db
    .updateTable('outbox_message')
    .set({ next_attempt_at: new Date(now.getTime() + CLAIM_LEASE_MS) })
    .where('id', 'in', (eb) =>
      eb
        .selectFrom('outbox_message')
        .select('id')
        .where('status', '=', 'pending')
        .where('next_attempt_at', '<=', now)
        .orderBy('created_at')
        .limit(BATCH)
        .forUpdate()
        .skipLocked(),
    )
    .returningAll()
    .execute();
  if (claimed.length === 0) return { delivered: 0, failed: 0 };

  const peerIds = [...new Set(claimed.map((m) => m.peer_id))];
  const peers = new Map(
    (await deps.db.selectFrom('peer').selectAll().where('id', 'in', peerIds).execute()).map((p) => [p.id, p]),
  );
  const byPeer = new Map<string, Message[]>();
  for (const m of claimed.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())) {
    const list = byPeer.get(m.peer_id) ?? [];
    list.push(m);
    byPeer.set(m.peer_id, list);
  }

  let delivered = 0;
  let failed = 0;
  await Promise.all(
    [...byPeer].map(async ([peerId, messages]) => {
      const peer = peers.get(peerId);
      let unreachable = false;
      for (const m of messages) {
        if (!peer) {
          // Partner gelöscht: Nachrichten werden per Kaskade entfernt
          continue;
        }
        if (unreachable) {
          await markFailedAttempt(deps, peer, m, 'peer_unreachable');
          failed++;
          continue;
        }
        const r = await deliver(deps, peer, m);
        if (r === 'delivered') delivered++;
        else failed++;
        if (r === 'unreachable') unreachable = true;
      }
    }),
  );
  return { delivered, failed };
}

// ---------------------------------------------------------------------------------------------
// Aufbewahrung
// ---------------------------------------------------------------------------------------------

/**
 * Löscht empfangene Kopien, deren Freigabe abgelaufen ist (Status expired), und alte Nonces.
 */
export async function runRetention(deps: Deps): Promise<{ expired: number; noncesPurged: number }> {
  const now = deps.now();
  const expired = await writeTx(deps, async (trx) => {
    const due = await trx
      .selectFrom('received_product')
      .select(['id', 'remote_release_id', 'peer_id'])
      .where('status', '=', 'active')
      .where('release_valid_until', '<=', now)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const p of due) {
      const deletedRows = await clearReceivedCopies(trx, [p.id], 'expired', 'release_expired', now);
      await deps.audit.record(
        {
          actor: SYSTEM_ACTOR,
          action: 'received.expire',
          objectType: 'received_product',
          objectId: p.id,
          details: { remoteReleaseId: p.remote_release_id, deletedRows },
        },
        trx,
      );
    }
    return due.length;
  });
  const purged = await deps.db
    .deleteFrom('federation_nonce')
    .where('seen_at', '<', new Date(now.getTime() - NONCE_TTL_MS))
    .executeTakeFirst();
  return { expired, noncesPurged: Number(purged.numDeletedRows) };
}

// ---------------------------------------------------------------------------------------------
// Hintergrundaufgaben
// ---------------------------------------------------------------------------------------------

const timers = new Set<ReturnType<typeof setInterval>>();

function every(deps: Deps, name: string, ms: number, task: () => Promise<unknown>) {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (err) {
      deps.log.error('federation worker failed', { task: name, error: (err as Error).message });
    } finally {
      running = false;
    }
  }, ms);
  timers.add(t);
}

export function startWorkers(deps: Deps): void {
  every(deps, 'outbox', FLUSH_INTERVAL_MS, () => flushOutbox(deps));
  every(deps, 'retention', RETENTION_INTERVAL_MS, () => runRetention(deps));
}

export function stopWorkers(): void {
  for (const t of timers) clearInterval(t);
  timers.clear();
}

// ---------------------------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------------------------

export const outboxHandlers: Handlers = {
  'outbox.list': async ({ deps }) => {
    const rows = await deps.db
      .selectFrom('outbox_message as m')
      .innerJoin('peer as p', 'p.id', 'm.peer_id')
      .selectAll('m')
      .select('p.node_id as peer_node_id')
      .orderBy('m.created_at', 'desc')
      .limit(OUTBOX_LIST_LIMIT)
      .execute();
    return { items: rows.map(toOutboxMessage) };
  },

  'outbox.flush': async ({ deps, actor, ip, requestId }) => {
    // fehlgeschlagene Mitteilungen erneut versuchen (manuell; der Hintergrundlauf tut das nicht)
    const requeued = await requeueFailed(deps, { actor, ip, requestId });
    const result = await flushOutbox(deps);
    await deps.audit.record({
      actor,
      action: 'outbox.flush',
      objectType: 'outbox',
      details: { ...result, requeued },
      ip,
      requestId,
    });
    return result;
  },
};
