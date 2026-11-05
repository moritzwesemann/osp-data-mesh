/**
 * Externe Verankerung der Audit-Hash-Kette (ADR 0014, docs/protokoll.md).
 *
 * Der Knoten signiert regelmäßig (MESH_AUDIT_CHECKPOINT_HOURS, Standard stündlich) und auf Anforderung einen
 * Prüfpunkt {nodeId, epoch, seq, hash, at} des Kopfes seiner Audit-Kette und sendet ihn als Mitteilung
 * audit_checkpoint an alle vertrauenswürdigen Partner. Partner verwahren ihn (peer_audit_checkpoint, nur
 * anhängbar, je Partner und Epoche nur steigende Laufnummern, höchstens
 * MESH_AUDIT_CHECKPOINT_MAX_PER_DAY je 24 Stunden), protokollieren den Empfang und geben ihn auf signierte
 * Anfrage (checkpoints) zurück.
 *
 * Prüfung (verifyAnchors): Die Kette wird im Programm aus den Rohspalten neu berechnet
 * (modules/audit/chain.ts) – nicht mit audit_verify() und nicht über die gespeicherte Spalte hash, die der
 * Eigentümer der Datenbank beliebig setzen kann. Die neu berechnete Kette muss genau die Paare (seq, hash)
 * enthalten, die Partner verwahren. Weil jeder Hash alle vorherigen Einträge einschließt, deckt ein fehlender
 * Eintrag ein Abschneiden und ein abweichender Hash ein Umschreiben auf.
 *
 * Epochen: Eine Wiederherstellung beginnt eine neue Epoche (restore). Prüfpunkte früherer Epochen müssen
 * bis zur übernommenen Laufnummer weiter passen (sonst Manipulation); dahinter liegende sind „durch die
 * Wiederherstellung verloren“ (Klärung nötig, nie still „ok“).
 *
 * Unabhängigkeit: Ohne Anker-Profil stammen Partnerliste, Partnerschlüssel, Adressen und frühere eigene
 * Schlüssel aus derselben Datenbank – die Prüfung ist dann nicht unabhängig von ihr (Oberfläche, CLI ohne
 * --profile). Mit Profil (anchor-profile.ts) nur aus dem Profil.
 */
import { sql } from 'kysely';
import { z } from 'zod';
import {
  AUDIT_CHECKPOINT_FORMAT,
  type AuditCheckpointNotice,
  AuditCheckpointStatement,
  CHECKPOINTS_PAGE_SIZE,
  CheckpointsResponse,
} from '../../../shared/contract/federation-wire.ts';
import { type Actor, SYSTEM_ACTOR } from '../../core/audit.ts';
import { ed25519Verify, fingerprint } from '../../core/crypto.ts';
import { type DbOrTx, iso, isoReq, pgCode } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import type { Deps } from '../../core/deps.ts';
import { AppError, conflict, notFound } from '../../core/errors.ts';
import type { Handlers } from '../../core/http.ts';
import { NodeIdentity, type OwnKeyWindow } from '../../core/node-identity.ts';
import { writeTx } from '../../core/tx.ts';
import { type ChainBreak, recomputeAuditChain } from '../audit/chain.ts';
import { type LoadedProfile, profileKeyWindows } from './anchor-profile.ts';
import { errorCodeOf, PeerCallError, type PeerTarget, sendSigned } from './client.ts';
import { RejectionGuard } from './guard.ts';
import { type InboundContext, type NoticeOutcome, verifyPeerSignature } from './keys.ts';
import { enqueueNotice } from './outbox.ts';
import { parseJson } from './protocol.ts';
import { peerActor } from './store.ts';

/** Prüfintervall des Planers (ob ein Prüfpunkt fällig ist) */
export const CHECKPOINT_TICK_MS = 60_000;
/** Sperre je Partner beim Verwahren seiner Prüfpunkte (zweiteiliger Schlüssel mit hashtext(peer.id)) */
export const CHECKPOINT_RECEIVE_LOCK = 7212201;
export const CHECKPOINT_EXPORT_FORMAT = 'osp-data-mesh/audit-checkpoint-export@1' as const;
const DAY_MS = 24 * 60 * 60 * 1000;

type NoticeBody = z.infer<typeof AuditCheckpointNotice>;

export function buildCheckpointStatement(s: Omit<AuditCheckpointStatement, 'format'>): string {
  const statement: AuditCheckpointStatement = { format: AUDIT_CHECKPOINT_FORMAT, ...s };
  return JSON.stringify(statement);
}

export function parseCheckpointStatement(statement: string): AuditCheckpointStatement | null {
  const r = AuditCheckpointStatement.safeParse(parseJson(statement));
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------------------------------------
// Epochen der eigenen Kette (Migration 0610)
// ---------------------------------------------------------------------------------------------

export interface EpochRecord {
  epoch: string;
  n: number | null;
  startedAt: string | null;
  reason: 'initial' | 'restore';
  previousEpoch: string | null;
  restoredSeq: number | null;
  /**
   * Nur bei Wiederherstellungen (Migration 0630; undefined = in einem älteren Profil nicht festgehalten):
   * Prüfsumme und Zeitpunkt der Sicherung, Epoche/Laufnummer/Hash des Kopfes unmittelbar davor
   */
  backupSha256?: string | null;
  backupCreatedAt?: string | null;
  preRestoreEpoch?: string | null;
  preRestoreSeq?: number | null;
  preRestoreHash?: string | null;
}

export interface EpochView extends EpochRecord {
  inDatabase: boolean;
  inProfile: boolean;
}

/** Epochenverlauf der Datenbank (n aufsteigend; die letzte ist die aktuelle) */
export async function loadEpochs(db: DbOrTx): Promise<EpochRecord[]> {
  const rows = await db.selectFrom('audit_chain_epoch').selectAll().orderBy('n').execute();
  return rows.map(epochFromRow);
}

/** Zeile von audit_chain_epoch in der Form des Profils (anchor-profile.ts) */
export function epochFromRow(r: Row<'audit_chain_epoch'>): EpochRecord {
  const num = (v: number | string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return {
    epoch: r.epoch,
    n: r.n,
    startedAt: isoReq(r.started_at),
    reason: r.reason,
    previousEpoch: r.previous_epoch,
    restoredSeq: num(r.restored_seq),
    backupSha256: r.backup_sha256 ?? null,
    backupCreatedAt: iso(r.backup_created_at ?? null),
    preRestoreEpoch: r.pre_restore_epoch ?? null,
    preRestoreSeq: num(r.pre_restore_seq),
    preRestoreHash: r.pre_restore_hash ?? null,
  };
}

export async function currentEpoch(db: DbOrTx): Promise<string> {
  const r = await db
    .selectFrom('audit_chain_epoch')
    .select('epoch')
    .orderBy('n', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!r) throw new Error('audit_chain_epoch is empty');
  return r.epoch;
}

/**
 * Epoche, aus der der Eintrag `seq` der Kette von `epoch` stammt: nach einer Wiederherstellung stammen die
 * Einträge bis restoredSeq aus der vorigen Epoche (rekursiv). null = Verlauf unvollständig oder zyklisch.
 */
export function originEpoch(
  epochs: ReadonlyMap<string, EpochRecord>,
  epoch: string,
  seq: number,
): string | null {
  let e = epochs.get(epoch);
  const seen = new Set<string>();
  while (e && !seen.has(e.epoch)) {
    seen.add(e.epoch);
    if (e.reason === 'restore' && e.restoredSeq !== null && seq <= e.restoredSeq) {
      if (!e.previousEpoch) return null;
      e = epochs.get(e.previousEpoch);
      continue;
    }
    return e.epoch;
  }
  return null;
}

/** Epochen vom aktuellen Stand rückwärts bis zur ersten (bzw. bis der Verlauf abbricht) */
export function lineage(epochs: ReadonlyMap<string, EpochRecord>, current: string): EpochRecord[] {
  const out: EpochRecord[] = [];
  const seen = new Set<string>();
  let e = epochs.get(current);
  while (e && !seen.has(e.epoch)) {
    seen.add(e.epoch);
    out.push(e);
    e = e.previousEpoch ? epochs.get(e.previousEpoch) : undefined;
  }
  return out;
}

export interface EpochContext {
  epochs: ReadonlyMap<string, EpochRecord>;
  current: string;
  /** erste Epoche des aktuellen Verlaufs (für Aussagen ohne Epoche); null = unbekannt */
  root: string | null;
}

export function epochContext(epochs: ReadonlyMap<string, EpochRecord>, current: string): EpochContext {
  const chain = lineage(epochs, current);
  const first = chain.at(-1);
  return { epochs, current, root: first?.reason === 'initial' ? first.epoch : null };
}

// ---------------------------------------------------------------------------------------------
// Eigene Prüfpunkte erstellen und versenden
// ---------------------------------------------------------------------------------------------

export interface CheckpointView {
  seq: number;
  hash: string;
  at: string;
  epoch: string;
  fingerprint: string;
  trigger: 'schedule' | 'manual' | 'cli';
  peers: number;
}

function toCheckpointView(r: Row<'audit_checkpoint'>): CheckpointView {
  return {
    seq: r.seq,
    hash: r.hash,
    at: isoReq(r.at),
    epoch: r.epoch,
    fingerprint: fingerprint(r.public_key),
    trigger: r.trigger,
    peers: r.peers,
  };
}

async function auditHead(db: DbOrTx): Promise<{ seq: number; hash: string } | null> {
  const head = await db
    .selectFrom('audit_log')
    .select(['seq', 'hash'])
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirst();
  return head ? { seq: Number(head.seq), hash: head.hash } : null;
}

/** Spielraum für Uhrabweichungen (CLI und Server, mehrere Rechner) bei „Prüfpunkt aus der Zukunft“ */
export const CLOCK_SKEW_MS = 5 * 60_000;
/** Ohne neue Einträge erstellt der Planer nach so vielen Intervallen trotzdem einen Prüfpunkt (Lebenszeichen) */
export const HEARTBEAT_INTERVALS = 2;
/** verifyAnchors: jüngster bestätigter Prüfpunkt älter als so viele Intervalle → Klärung nötig */
export const STALE_INTERVALS = 3;
/** Höchstens so viele eigene Prüfpunkte (neueste zuerst) werden nach einem gültigen durchsucht */
const MAX_SCAN = 1000;

/**
 * Eigener Prüfpunkt, der wirklich von diesem Knoten stammt: Aussage passt zur Zeile (Knoten, Epoche,
 * Laufnummer, Hash, Zeitpunkt) und ist mit einem eigenen Schlüssel signiert, der zu `at` galt. mesh_app
 * kann Zeilen nur über audit_checkpoint_append() anhängen, ohne den privaten Schlüssel aber keine gültige
 * Signatur erzeugen; solche Zeilen zählen weder für den Planer noch für den Export.
 */
export function isOwnCheckpoint(
  r: Row<'audit_checkpoint'>,
  nodeId: string,
  keys: readonly OwnKeyWindow[],
): boolean {
  const st = parseCheckpointStatement(r.statement);
  if (!st || st.nodeId !== nodeId || st.seq !== Number(r.seq) || st.hash !== r.hash) return false;
  if ((st.epoch?.toLowerCase() ?? null) !== r.epoch.toLowerCase()) return false;
  if (Date.parse(st.at) !== r.at.getTime()) return false;
  return 'key' in checkpointSigner(keys, r.statement, r.signature, st.at);
}

/**
 * Jüngster gültiger eigener Prüfpunkt (nach Zeitpunkt des Anhängens, den die Datenbank setzt), optional nur
 * der Epoche `epoch` und ohne solche, deren signierter Zeitpunkt nach `notAfter` liegt (aus der Zukunft).
 */
export async function latestOwnCheckpoint(
  deps: Pick<Deps, 'db' | 'identity'>,
  opts: { epoch?: string; notAfter?: Date } = {},
): Promise<Row<'audit_checkpoint'> | null> {
  const keys = await NodeIdentity.keyHistory(deps.db);
  const PAGE = 100;
  for (let offset = 0; offset < MAX_SCAN; offset += PAGE) {
    let q = deps.db.selectFrom('audit_checkpoint').selectAll();
    if (opts.epoch) q = q.where('epoch', '=', opts.epoch);
    const rows = await q
      .orderBy('created_at', 'desc')
      .orderBy('seq', 'desc')
      .limit(PAGE)
      .offset(offset)
      .execute();
    for (const r of rows) {
      if (opts.notAfter && r.at.getTime() > opts.notAfter.getTime()) continue;
      if (isOwnCheckpoint(r, deps.identity.nodeId, keys)) return r;
    }
    if (rows.length < PAGE) break;
  }
  return null;
}

/**
 * Signiert den Kopf der Audit-Kette und stellt den Prüfpunkt je vertrauenswürdigem Partner ins
 * Ausgangspostfach. Ein noch nicht zugestellter älterer Prüfpunkt an denselben Partner entfällt (der neue
 * schließt ihn über die Hash-Kette ein). Gibt es für den Kopf (in der aktuellen Epoche) schon einen gültigen
 * Prüfpunkt, bleibt es bei diesem. Belegt eine ungültige Zeile den Platz (über audit_checkpoint_append()
 * von mesh_app vorweggenommen), wird das protokolliert (audit.checkpoint.invalid_row); der Eintrag rückt den
 * Kopf weiter, der nächste Versuch signiert den neuen Kopf.
 */
export async function createCheckpoint(
  deps: Pick<Deps, 'db' | 'audit' | 'now' | 'identity'>,
  trigger: 'schedule' | 'manual' | 'cli',
  ctx: { actor: Actor; ip?: string | null; requestId?: string | null },
): Promise<{ checkpoint: CheckpointView; created: boolean }> {
  const keys = await NodeIdentity.keyHistory(deps.db);
  const at = async (epoch: string, seq: number) =>
    deps.db
      .selectFrom('audit_checkpoint')
      .selectAll()
      .where('epoch', '=', epoch)
      .where('seq', '=', seq)
      .executeTakeFirst();
  const invalidRow = async (r: Row<'audit_checkpoint'>) =>
    deps.audit.record({
      actor: SYSTEM_ACTOR,
      action: 'audit.checkpoint.invalid_row',
      outcome: 'error',
      objectType: 'audit_checkpoint',
      objectId: r.id,
      details: { seq: Number(r.seq), epoch: r.epoch, createdAt: isoReq(r.created_at) },
    });

  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await auditHead(deps.db);
    if (!head) throw conflict('audit_log_empty');
    const epoch = await currentEpoch(deps.db);
    const existing = await at(epoch, head.seq);
    if (existing) {
      if (isOwnCheckpoint(existing, deps.identity.nodeId, keys)) {
        return { checkpoint: toCheckpointView(existing), created: false };
      }
      await invalidRow(existing);
      continue;
    }

    const now = deps.now();
    const statement = buildCheckpointStatement({
      nodeId: deps.identity.nodeId,
      epoch,
      seq: head.seq,
      hash: head.hash,
      at: now.toISOString(),
    });
    const signature = deps.identity.sign(statement);
    try {
      const row = await writeTx(deps, async (trx) => {
        const peers = await trx
          .selectFrom('peer')
          .select('id')
          .where('status', '=', 'trusted')
          .orderBy('node_id')
          .execute();
        // nur über die Funktion (prüft Epoche, Laufnummer und Hash; created_at setzt die Datenbank)
        const r = await sql<Row<'audit_checkpoint'>>`
          select * from audit_checkpoint_append(${epoch}::uuid, ${head.seq}::bigint, ${head.hash},
            ${now}::timestamptz, ${statement}, ${signature}, ${deps.identity.publicKey}, ${trigger},
            ${peers.length}::integer)`.execute(trx);
        const inserted = r.rows[0];
        if (!inserted) throw new Error('audit_checkpoint_append returned nothing');
        for (const p of peers) {
          await trx
            .deleteFrom('outbox_message')
            .where('peer_id', '=', p.id)
            .where('type', '=', 'notice')
            .where('status', 'in', ['pending', 'failed'])
            .where(sql<boolean>`body->>'kind' = 'audit_checkpoint'`)
            .execute();
          await enqueueNotice(trx, p.id, { kind: 'audit_checkpoint', statement, signature }, now);
        }
        await deps.audit.record(
          {
            actor: ctx.actor,
            action: 'audit.checkpoint.create',
            objectType: 'audit_checkpoint',
            objectId: String(head.seq),
            details: { seq: head.seq, hash: head.hash, epoch, trigger, peers: peers.length },
            ip: ctx.ip ?? null,
            requestId: ctx.requestId ?? null,
          },
          trx,
        );
        return inserted;
      });
      return { checkpoint: toCheckpointView(row), created: true };
    } catch (err) {
      // gleichzeitig für denselben Kopf erstellt (oder Platz vorweggenommen)
      if (pgCode(err) !== '23505') throw err;
      const again = await at(epoch, head.seq);
      if (again && isOwnCheckpoint(again, deps.identity.nodeId, keys)) {
        return { checkpoint: toCheckpointView(again), created: false };
      }
      if (again) await invalidRow(again);
    }
  }
  throw conflict('checkpoint_slot_occupied');
}

/**
 * Planer: Prüfpunkt, wenn das Intervall seit dem letzten gültigen eigenen Prüfpunkt der Epoche abgelaufen
 * ist und die Kette seit diesem gewachsen ist; ohne Wachstum nach HEARTBEAT_INTERVALS Intervallen trotzdem
 * (Lebenszeichen: verifyAnchors meldet sonst einen veralteten Anker). Nach einer Wiederherstellung (neue
 * Epoche ohne eigenen Prüfpunkt) sofort, damit Partner die Epoche erfahren.
 *
 * Maßgeblich ist der signierte Zeitpunkt eines gültig signierten eigenen Prüfpunkts – nicht eine beliebige
 * Zeile: Zeilen mit falscher Signatur und solche aus der Zukunft (mehr als CLOCK_SKEW_MS) zählen nicht, sonst
 * könnte eine vorgetäuschte Zeile den Planer dauerhaft anhalten.
 */
export async function scheduledCheckpoint(
  deps: Pick<Deps, 'db' | 'audit' | 'now' | 'identity' | 'config'>,
): Promise<boolean> {
  const hours = deps.config.MESH_AUDIT_CHECKPOINT_HOURS;
  if (!hours) return false;
  const now = deps.now();
  const epoch = await currentEpoch(deps.db);
  const last = await latestOwnCheckpoint(deps, {
    epoch,
    notAfter: new Date(now.getTime() + CLOCK_SKEW_MS),
  });
  const head = await auditHead(deps.db);
  if (!head) return false;
  if (last) {
    const age = now.getTime() - last.at.getTime();
    const interval = hours * 3600_000;
    if (age < interval) return false;
    // nur der Eintrag des letzten Prüfpunkts selbst ist hinzugekommen: Lebenszeichen erst später
    if (head.seq <= Number(last.seq) + 1 && age < HEARTBEAT_INTERVALS * interval) return false;
  }
  await createCheckpoint(deps, 'schedule', { actor: SYSTEM_ACTOR });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Partner: Prüfpunkt empfangen und verwahren, auf Anfrage zurückgeben
// ---------------------------------------------------------------------------------------------

const checkpointGuards = new WeakMap<object, RejectionGuard>();
/** Zusammenfassung wiederholter Ablehnungen (Rate, Reihenfolge) im Audit-Log je Partner und Grund */
function checkpointGuard(deps: Deps): RejectionGuard {
  let g = checkpointGuards.get(deps);
  if (!g) {
    g = new RejectionGuard();
    checkpointGuards.set(deps, g);
  }
  return g;
}

export async function receiveCheckpoint(ib: InboundContext, notice: NoticeBody): Promise<NoticeOutcome> {
  const { deps, peer, now } = ib;
  const actor = peerActor(peer.node_id, peer.display_name);
  const reject = async (
    code: 'bad_request' | 'untrusted' | 'bad_signature',
    reason: string,
    extra: Record<string, unknown> = {},
    action = 'audit.checkpoint.rejected',
  ): Promise<NoticeOutcome> => {
    await deps.audit.record({
      actor,
      action,
      outcome: 'denied',
      objectType: 'peer',
      objectId: peer.id,
      details: { nodeId: peer.node_id, code, reason, ...extra, messageId: ib.messageId },
      ip: ib.ip,
      requestId: ib.requestId,
    });
    return { ok: false, code, reason, audited: true };
  };
  /**
   * Wiederholbare Ablehnungen eines gültig signierten Partners (zu viele, nicht steigend): jede im
   * Betriebslog, im Audit-Log zusammengefasst wie Ablehnungen der Protokollprüfung (guard.ts): die erste je
   * Partner und Grund im Zeitfenster, der nächste Eintrag nennt die Zahl der dazwischen (`suppressed`).
   */
  const rejectAggregated = async (reason: string, extra: Record<string, unknown>): Promise<NoticeOutcome> => {
    const decision = checkpointGuard(deps).decide(reason, null, peer.node_id, now.getTime());
    deps.log.info('audit checkpoint rejected', { node: peer.node_id, reason, audited: decision.audit });
    if (!decision.audit) return { ok: false, code: 'bad_request', reason, audited: true };
    return reject('bad_request', reason, {
      ...extra,
      ...(decision.suppressed > 0 ? { suppressed: decision.suppressed } : {}),
    });
  };

  // gesperrte Partner dürfen nur löschende Mitteilungen senden
  if (peer.status !== 'trusted') return reject('untrusted', 'peer_not_trusted');
  const st = parseCheckpointStatement(notice.statement);
  if (!st) return reject('bad_request', 'invalid_statement');
  if (st.nodeId !== peer.node_id) return reject('bad_request', 'wrong_node');
  const keyUsed = verifyPeerSignature(peer, notice.statement, notice.signature, now);
  if (!keyUsed) return reject('bad_signature', 'checkpoint_signature_invalid', { seq: st.seq });
  const publicKey = keyUsed === 'current' ? peer.public_key : (peer.previous_public_key ?? peer.public_key);
  const epoch = st.epoch?.toLowerCase() ?? null;
  const sameEpoch = sql<boolean>`epoch is not distinct from ${epoch}::uuid`;
  const limit = deps.config.MESH_AUDIT_CHECKPOINT_MAX_PER_DAY;

  /**
   * Prüfungen und Verwahren in EINER Transaktion unter einer Sperre je Partner (CHECKPOINT_RECEIVE_LOCK,
   * vor jeder Zeilensperre und jedem Audit-Eintrag, core/locks.ts): gleichzeitige Zustellungen desselben
   * Partners können Reihenfolge und Ratenbegrenzung nicht unterlaufen. Ablehnungen werden nach der
   * Transaktion protokolliert.
   */
  type Decision =
    | { kind: 'stored' }
    | { kind: 'duplicate' }
    | { kind: 'conflict'; heldHash: string }
    | { kind: 'epoch_required' }
    | { kind: 'not_increasing'; heldMaxSeq: number }
    | { kind: 'rate_limited' };
  const decision = await writeTx(deps, async (trx): Promise<Decision> => {
    await sql`select pg_advisory_xact_lock(${sql.lit(CHECKPOINT_RECEIVE_LOCK)}::integer,
                                           hashtext(${peer.id}::text))`.execute(trx);
    if (epoch === null) {
      // Aussagen ohne Epoche stammen von Knoten vor Migration 0610. Hat der Partner schon Prüfpunkte mit
      // Epoche gesendet, wäre eine ohne Epoche eine zweite, nicht vergleichbare Aussage zu denselben Laufnummern.
      const withEpoch = await trx
        .selectFrom('peer_audit_checkpoint')
        .select('id')
        .where('peer_id', '=', peer.id)
        .where('epoch', 'is not', null)
        .limit(1)
        .executeTakeFirst();
      if (withEpoch) return { kind: 'epoch_required' };
    }
    const held = await trx
      .selectFrom('peer_audit_checkpoint')
      .select('hash')
      .where('peer_id', '=', peer.id)
      .where(sameEpoch)
      .where('seq', '=', st.seq)
      .executeTakeFirst();
    if (held) {
      // Wiederholung (Ausgangspostfach): bestätigen, nicht doppelt
      return held.hash === st.hash ? { kind: 'duplicate' } : { kind: 'conflict', heldHash: held.hash };
    }
    // je Partner, Epoche und signierendem Schlüssel nur steigende Laufnummern: Prüfpunkte eines gestohlenen,
    // inzwischen ersetzten Schlüssels (auch mit Laufnummern nahe 2^53) blockieren die des neuen nicht
    const max = await trx
      .selectFrom('peer_audit_checkpoint')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .where('peer_id', '=', peer.id)
      .where(sameEpoch)
      .where('public_key', '=', publicKey)
      .executeTakeFirst();
    const heldMaxSeq = max?.seq == null ? null : Number(max.seq);
    if (heldMaxSeq !== null && st.seq < heldMaxSeq) return { kind: 'not_increasing', heldMaxSeq };
    // höchstens MESH_AUDIT_CHECKPOINT_MAX_PER_DAY neue Prüfpunkte je Partner in 24 Stunden
    const recent = await trx
      .selectFrom('peer_audit_checkpoint')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('peer_id', '=', peer.id)
      .where('received_at', '>', new Date(now.getTime() - DAY_MS))
      .executeTakeFirst();
    if (Number(recent?.n ?? 0) >= limit) return { kind: 'rate_limited' };

    const knownEpochs = await trx
      .selectFrom('peer_audit_checkpoint')
      .select('epoch')
      .distinct()
      .where('peer_id', '=', peer.id)
      .execute();
    await trx
      .insertInto('peer_audit_checkpoint')
      .values({
        peer_id: peer.id,
        seq: st.seq,
        hash: st.hash,
        epoch,
        checkpoint_at: st.at,
        statement: notice.statement,
        signature: notice.signature,
        public_key: publicKey,
        message_id: ib.messageId,
        received_at: now,
      })
      .execute();
    await deps.audit.record(
      {
        actor,
        action: 'audit.checkpoint.received',
        objectType: 'peer',
        objectId: peer.id,
        details: {
          nodeId: peer.node_id,
          epoch,
          seq: st.seq,
          hash: st.hash,
          at: st.at,
          messageId: ib.messageId,
        },
        ip: ib.ip,
        requestId: ib.requestId,
      },
      trx,
    );
    const previous = knownEpochs.map((k) => k.epoch);
    if (previous.length > 0 && !previous.includes(epoch)) {
      // neue Epoche des Partners (nach dessen Wiederherstellung): angenommen, eigens protokolliert, damit
      // die Revision den Zeitpunkt des Wechsels bei den Partnern nachvollziehen kann
      await deps.audit.record(
        {
          actor,
          action: 'audit.checkpoint.epoch_changed',
          objectType: 'peer',
          objectId: peer.id,
          details: { nodeId: peer.node_id, epoch, previousEpochs: previous, seq: st.seq, at: st.at },
          ip: ib.ip,
          requestId: ib.requestId,
        },
        trx,
      );
    }
    return { kind: 'stored' };
  });

  switch (decision.kind) {
    case 'stored':
      return { ok: true, body: { ack: true, affectedRows: 1 } };
    case 'duplicate':
      return { ok: true, body: { ack: true, affectedRows: 0 } };
    case 'conflict':
      return reject(
        'bad_request',
        'checkpoint_conflict',
        { seq: st.seq, epoch, heldHash: decision.heldHash, receivedHash: st.hash },
        // zwei widersprüchliche, gültig signierte Aussagen des Partners zur selben Position seiner Kette
        'audit.checkpoint.conflict',
      );
    case 'epoch_required':
      return reject('bad_request', 'checkpoint_epoch_required', { seq: st.seq });
    case 'not_increasing':
      return rejectAggregated('checkpoint_not_increasing', {
        seq: st.seq,
        epoch,
        heldMaxSeq: decision.heldMaxSeq,
        fingerprint: fingerprint(publicKey),
      });
    case 'rate_limited':
      return rejectAggregated('checkpoint_rate_limited', { seq: st.seq, epoch, limitPerDay: limit });
  }
}

export async function serveCheckpoints(
  ib: InboundContext,
  req: { afterSeq: number; afterEpoch?: string; limit: number },
): Promise<{ ok: true; body: z.infer<typeof CheckpointsResponse> }> {
  const { deps, peer } = ib;
  const epochKey = sql<string>`coalesce(epoch::text, '') collate "C"`;
  let q = deps.db
    .selectFrom('peer_audit_checkpoint')
    .select(['seq', 'statement', 'signature'])
    .where('peer_id', '=', peer.id);
  q =
    req.afterEpoch === undefined
      ? q.where('seq', '>', req.afterSeq)
      : q.where(
          sql<boolean>`(seq, ${epochKey}) > (${req.afterSeq}::bigint, ${req.afterEpoch.toLowerCase()}::text collate "C")`,
        );
  const rows = await q
    .orderBy('seq')
    .orderBy(epochKey)
    .limit(req.limit + 1)
    .execute();
  const more = rows.length > req.limit;
  const page = rows.slice(0, req.limit);
  await deps.audit.record({
    actor: peerActor(peer.node_id, peer.display_name),
    action: 'audit.checkpoint.served',
    objectType: 'peer',
    objectId: peer.id,
    details: {
      nodeId: peer.node_id,
      afterSeq: req.afterSeq,
      ...(req.afterEpoch ? { afterEpoch: req.afterEpoch } : {}),
      count: page.length,
      messageId: ib.messageId,
    },
    ip: ib.ip,
    requestId: ib.requestId,
  });
  return {
    ok: true,
    body: { checkpoints: page.map((r) => ({ statement: r.statement, signature: r.signature })), more },
  };
}

// ---------------------------------------------------------------------------------------------
// Prüfung der eigenen Kette gegen die bei Partnern verwahrten Prüfpunkte
// ---------------------------------------------------------------------------------------------

export type AnchorProblemKind =
  /** Eintrag fehlt: Kette abgeschnitten (Manipulation) */
  | 'missing'
  /** Hash weicht ab: Kette umgeschrieben (Manipulation) */
  | 'hash_mismatch'
  /** Abweichung, aber mit einem als kompromittiert abgelösten Schlüssel signiert: kein Beweis */
  | 'inconclusive'
  /** Prüfpunkt einer früheren Epoche hinter der bei der Wiederherstellung übernommenen Laufnummer */
  | 'lost_by_restore'
  /**
   * Prüfpunkt einer früheren Epoche hinter dem Kopf, den die Wiederherstellung unmittelbar vorher festhielt
   * (bzw. an dessen Laufnummer mit anderem Hash): die Kette war schon vor der Wiederherstellung abgeschnitten
   * oder umgeschrieben, oder die Angaben zur Wiederherstellung sind erfunden (Manipulation)
   */
  | 'beyond_pre_restore'
  /** Epoche weder in der Datenbank noch im Profil bekannt */
  | 'unknown_epoch';

export type AnchorProblem = { seq: number; kind: AnchorProblemKind; epoch?: string | null };

const MANIPULATION: ReadonlySet<AnchorProblemKind> = new Set([
  'missing',
  'hash_mismatch',
  'beyond_pre_restore',
]);

export interface ComparableCheckpoint {
  seq: number;
  hash: string;
  /** Epoche der Aussage; undefined/null = ohne Epoche (gilt als erste Epoche des Verlaufs) */
  epoch?: string | null;
  /** mit einem als kompromittiert abgelösten eigenen Schlüssel signiert */
  compromisedKey?: boolean;
  /** signierter Zeitpunkt */
  at?: string;
}

/** Ende der Epoche `epoch` laut einer späteren Wiederherstellung (Kopf unmittelbar davor), sonst null */
function preRestoreHead(
  epochs: ReadonlyMap<string, EpochRecord>,
  epoch: string,
): { seq: number; hash: string | null } | null {
  for (const e of epochs.values()) {
    if (e.preRestoreEpoch === epoch && e.preRestoreSeq !== null && e.preRestoreSeq !== undefined) {
      return { seq: e.preRestoreSeq, hash: e.preRestoreHash ?? null };
    }
  }
  return null;
}

/**
 * Vergleicht verwahrte Prüfpunkte mit der (neu berechneten) lokalen Kette: jeder muss als (seq, hash)
 * vorkommen. Mit Epochen (`ctx`): verglichen wird nur, wenn der Eintrag seq der Prüfpunkt-Epoche derselbe
 * ist wie in der aktuellen Kette (gleiche Ursprungs-Epoche), sonst ist er durch eine Wiederherstellung
 * verloren – es sei denn, er liegt hinter dem Kopf, den diese Wiederherstellung vorher festhielt.
 * latestMatched: bestätigter Prüfpunkt mit der höchsten Laufnummer.
 */
export function compareCheckpoints(
  local: ReadonlyMap<number, string>,
  checkpoints: readonly ComparableCheckpoint[],
  ctx?: EpochContext,
): { problems: AnchorProblem[]; matched: number; latestMatched: ComparableCheckpoint | null } {
  const problems: AnchorProblem[] = [];
  let matched = 0;
  let latestMatched: ComparableCheckpoint | null = null;
  const sorted = [...checkpoints].sort(
    (a, b) => a.seq - b.seq || String(a.epoch ?? '').localeCompare(String(b.epoch ?? '')),
  );
  for (const cp of sorted) {
    // Epoche nur angeben, wenn der Prüfpunkt nicht zur aktuellen gehört
    const ofOtherEpoch = ctx && (cp.epoch ?? ctx.root) !== ctx.current;
    const push = (kind: AnchorProblemKind) =>
      problems.push(ofOtherEpoch ? { seq: cp.seq, kind, epoch: cp.epoch ?? null } : { seq: cp.seq, kind });
    if (ctx) {
      const epoch = cp.epoch ?? ctx.root;
      const ofCheckpoint = epoch ? originEpoch(ctx.epochs, epoch, cp.seq) : null;
      const ofCurrent = originEpoch(ctx.epochs, ctx.current, cp.seq);
      if (!ofCheckpoint || !ofCurrent) {
        push('unknown_epoch');
        continue;
      }
      if (ofCheckpoint !== ofCurrent) {
        const end = preRestoreHead(ctx.epochs, ofCheckpoint);
        const beyond =
          end !== null &&
          (cp.seq > end.seq || (cp.seq === end.seq && end.hash !== null && end.hash !== cp.hash));
        push(beyond && !cp.compromisedKey ? 'beyond_pre_restore' : 'lost_by_restore');
        continue;
      }
    }
    const hash = local.get(cp.seq);
    if (hash === cp.hash) {
      matched++;
      if (!latestMatched || cp.seq > latestMatched.seq) latestMatched = cp;
    } else if (cp.compromisedKey) push('inconclusive');
    else push(hash === undefined ? 'missing' : 'hash_mismatch');
  }
  return { problems, matched, latestMatched };
}

/** Eigener Schlüssel, mit dem ein Prüfpunkt gültig signiert ist (Gültigkeitszeitraum über `at`) */
export function checkpointSigner(
  keys: readonly OwnKeyWindow[],
  statement: string,
  signature: string,
  at: string,
): { key: OwnKeyWindow } | { invalid: 'signature' | 'outside_window' } {
  const t = Date.parse(at);
  let outside = false;
  for (const k of keys) {
    if (!ed25519Verify(k.publicKey, statement, signature)) continue;
    if ((k.validFrom && t < k.validFrom.getTime()) || (k.validUntil && t > k.validUntil.getTime())) {
      outside = true;
      continue;
    }
    return { key: k };
  }
  return { invalid: outside ? 'outside_window' : 'signature' };
}

export interface PartnerAnchorResult {
  peerId: string | null;
  nodeId: string;
  displayName: string;
  /** Fingerprint des Schlüssels, mit dem die Antworten des Partners geprüft wurden */
  fingerprint: string;
  status: 'ok' | 'mismatch' | 'needs_review' | 'no_checkpoints' | 'unreachable' | 'error';
  errorCode: string | null;
  /** vom Prüfenden begründet entschuldigt (nur mit Profil) */
  excused: boolean;
  /** gültig signierte Prüfpunkte */
  checkpoints: number;
  /** davon mit der lokalen Kette übereinstimmend */
  matched: number;
  latestSeq: number | null;
  latestAt: string | null;
  /** bestätigter Prüfpunkt mit der höchsten Laufnummer (und dessen signierter Zeitpunkt) */
  latestMatchedSeq: number | null;
  latestMatchedAt: string | null;
  /** ungültig signiert, unbekannter Schlüssel oder außerhalb von dessen Gültigkeitszeitraum */
  invalidSignatures: number;
  /**
   * Belege für Manipulation (missing, hash_mismatch, beyond_pre_restore; mit Profil und nicht dokumentierter
   * Epoche auch lost_by_restore)
   */
  problems: number;
  firstProblem: AnchorProblem | null;
  lostByRestore: number;
  inconclusive: number;
  unknownEpoch: number;
}

export type AnchorFindingCode =
  | 'insufficient_partners'
  | 'partner_missing'
  | 'partner_excused'
  | 'partner_not_trusted_in_database'
  | 'partner_differs_from_database'
  | 'epoch_not_in_profile'
  | 'epoch_conflict'
  | 'restore_epoch'
  | 'lost_by_restore'
  | 'unknown_epoch'
  | 'inconclusive'
  /** jüngster von Partnern bestätigter Prüfpunkt älter als STALE_INTERVALS × Intervall */
  | 'anchor_stale'
  /** Einträge der Hash-Version 1 mit '|' in einem Feld (Feldgrenzen dort nicht eindeutig) */
  | 'legacy_digest_ambiguous';

export interface AnchorFinding {
  code: AnchorFindingCode;
  /** fail = nicht ausreichend verankert; review = Klärung nötig; info = nur Hinweis */
  severity: 'fail' | 'review' | 'info';
  nodeId?: string;
  epoch?: string;
  count?: number;
  seq?: number;
  detail?: string;
}

export interface AnchorVerification {
  result: 'ok' | 'manipulated' | 'unanchored' | 'needs_review';
  at: string;
  /** false: Partner und frühere eigene Schlüssel stammen aus der geprüften Datenbank selbst */
  independent: boolean;
  source: 'database' | 'profile';
  profile: { sha256: string; createdAt: string; minPartners: number } | null;
  requiredPartners: number;
  anchoredPartners: number;
  local: {
    ok: boolean;
    checked: number;
    firstBrokenSeq: number | null;
    breakKind: ChainBreak | null;
    headSeq: number | null;
    /** Einträge je Version der Hash-Eingabe (Migration 0620) */
    digest: { v1: number; v2: number; ambiguousV1: number };
  };
  /**
   * Stand der Verankerung: höchste Laufnummer, die mindestens requiredPartners Partner bestätigen, deren
   * signierter Zeitpunkt, und wie viele Einträge danach noch nicht verankert sind (der Eigentümer der
   * Datenbank könnte sie unbemerkt ändern oder löschen). staleAfterHours: ab diesem Alter des jüngsten
   * bestätigten Prüfpunkts „Klärung nötig“ (null = kein Planer, MESH_AUDIT_CHECKPOINT_HOURS = 0).
   */
  anchoring: {
    lastAnchoredSeq: number | null;
    lastAnchoredAt: string | null;
    unanchoredEntries: number;
    staleAfterHours: number | null;
  };
  epoch: { current: string; history: EpochView[] };
  partners: PartnerAnchorResult[];
  findings: AnchorFinding[];
}

export interface VerifyOptions {
  /** Anker-Profil: Partner, Partnerschlüssel, Adressen und eigene Schlüssel ausschließlich daraus */
  profile?: LoadedProfile;
  /** Partner aus dem Profil, deren Ausbleiben begründet ist (z. B. Wartung) */
  excuse?: { nodeIds: readonly string[]; reason: string };
}

/** Höchstens so viele Seiten je Partner (Schutz vor endlosen Antworten) */
const MAX_PAGES = 1000;

interface PartnerTarget extends PeerTarget {
  peerId: string | null;
  displayName: string;
}

interface Collected {
  target: PartnerTarget;
  error: { status: 'unreachable' | 'error'; code: string } | null;
  valid: (ComparableCheckpoint & { at: string })[];
  invalid: number;
}

/** Holt alle beim Partner verwahrten eigenen Prüfpunkte und prüft deren Signatur */
async function collectFromPartner(
  deps: Deps,
  target: PartnerTarget,
  nodeId: string,
  keys: readonly OwnKeyWindow[],
): Promise<Collected> {
  const valid: Collected['valid'] = [];
  let invalid = 0;
  try {
    let after = { seq: 0, epoch: '' };
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply = await sendSigned(
        deps,
        target,
        'checkpoints',
        { afterSeq: after.seq, afterEpoch: after.epoch, limit: CHECKPOINTS_PAGE_SIZE },
        { schema: CheckpointsResponse },
      );
      let last: { seq: number; epoch: string } | null = null;
      for (const cp of reply.body.checkpoints) {
        const st = parseCheckpointStatement(cp.statement);
        if (st) last = { seq: st.seq, epoch: st.epoch?.toLowerCase() ?? '' };
        const signer =
          st && st.nodeId === nodeId ? checkpointSigner(keys, cp.statement, cp.signature, st.at) : null;
        if (!st || !signer || 'invalid' in signer) {
          // vom Partner nicht unterscheidbar verfälscht oder unbekannter Schlüssel: kein Beleg gegen die Kette
          invalid++;
          continue;
        }
        valid.push({
          seq: st.seq,
          hash: st.hash,
          at: st.at,
          epoch: st.epoch?.toLowerCase() ?? null,
          compromisedKey: signer.key.retired === 'compromised',
        });
      }
      if (!reply.body.more || !last) break;
      const progressed = last.seq > after.seq || (last.seq === after.seq && last.epoch > after.epoch);
      if (!progressed) break;
      after = last;
    }
  } catch (err) {
    if (!(err instanceof AppError)) {
      deps.log.error('anchor verification failed', { peer: target.node_id, error: (err as Error).message });
    }
    const unreachable = err instanceof PeerCallError && err.code === 'peer_unreachable';
    return {
      target,
      error: { status: unreachable ? 'unreachable' : 'error', code: errorCodeOf(err) },
      valid,
      invalid,
    };
  }
  return { target, error: null, valid, invalid };
}

function partnerResult(
  c: Collected,
  local: ReadonlyMap<number, string>,
  ctx: EpochContext,
  excused: boolean,
  lostIsManipulation: boolean,
): PartnerAnchorResult {
  const base: PartnerAnchorResult = {
    peerId: c.target.peerId,
    nodeId: c.target.node_id,
    displayName: c.target.displayName,
    fingerprint: fingerprint(c.target.public_key),
    status: 'ok',
    errorCode: null,
    excused,
    checkpoints: 0,
    matched: 0,
    latestSeq: null,
    latestAt: null,
    latestMatchedSeq: null,
    latestMatchedAt: null,
    invalidSignatures: 0,
    problems: 0,
    firstProblem: null,
    lostByRestore: 0,
    inconclusive: 0,
    unknownEpoch: 0,
  };
  if (c.error) return { ...base, status: c.error.status, errorCode: c.error.code };
  const { problems, matched, latestMatched } = compareCheckpoints(local, c.valid, ctx);
  // mit Profil und nicht dokumentierter Epoche ist ein Verlust durch „Wiederherstellung“ nicht erklärt
  const isManipulation = (k: AnchorProblemKind) =>
    MANIPULATION.has(k) || (lostIsManipulation && k === 'lost_by_restore');
  const manipulation = problems.filter((p) => isManipulation(p.kind));
  const count = (k: AnchorProblemKind) => problems.filter((p) => p.kind === k).length;
  const review =
    (lostIsManipulation ? 0 : count('lost_by_restore')) + count('inconclusive') + count('unknown_epoch');
  const latest = c.valid.reduce<(typeof c.valid)[number] | null>(
    (m, v) => (!m || v.seq > m.seq ? v : m),
    null,
  );
  const status: PartnerAnchorResult['status'] =
    manipulation.length > 0
      ? 'mismatch'
      : c.invalid > 0
        ? 'error'
        : review > 0
          ? 'needs_review'
          : matched === 0
            ? 'no_checkpoints'
            : 'ok';
  return {
    ...base,
    status,
    errorCode: status === 'error' ? 'checkpoint_signature_invalid' : null,
    checkpoints: c.valid.length,
    matched,
    latestSeq: latest?.seq ?? null,
    latestAt: latest?.at ?? null,
    latestMatchedSeq: latestMatched?.seq ?? null,
    latestMatchedAt: latestMatched?.at ?? null,
    invalidSignatures: c.invalid,
    problems: manipulation.length,
    firstProblem: manipulation[0] ?? null,
    lostByRestore: count('lost_by_restore'),
    inconclusive: count('inconclusive'),
    unknownEpoch: count('unknown_epoch'),
  };
}

/** Datenbank und Profil widersprechen sich zu einer Epoche (im Profil nicht festgehaltene Angaben zählen nicht) */
export function epochsDisagree(db: EpochRecord, profile: EpochRecord): boolean {
  if (db.previousEpoch !== profile.previousEpoch || db.restoredSeq !== profile.restoredSeq) return true;
  if (db.reason !== profile.reason) return true;
  const both = <T>(a: T | undefined, b: T | undefined) => a !== undefined && b !== undefined;
  if (both(db.backupSha256, profile.backupSha256) && db.backupSha256 !== profile.backupSha256) return true;
  if (
    both(db.backupCreatedAt, profile.backupCreatedAt) &&
    (db.backupCreatedAt ? Date.parse(db.backupCreatedAt) : null) !==
      (profile.backupCreatedAt ? Date.parse(profile.backupCreatedAt) : null)
  ) {
    return true;
  }
  for (const k of ['preRestoreEpoch', 'preRestoreSeq', 'preRestoreHash'] as const) {
    if (both(db[k], profile[k]) && db[k] !== profile[k]) return true;
  }
  return false;
}

/**
 * Prüft die lokale Kette (im Programm neu berechnet) und gleicht sie mit den bei den Partnern verwahrten
 * Prüfpunkten ab. Ohne Profil: vertrauenswürdige und gesperrte Partner aus der Datenbank, Schlüsselverlauf
 * aus der Datenbank (nicht unabhängig). Mit Profil: genau die Partner des Profils, mit Adresse und Schlüssel
 * aus dem Profil; jeder muss bestätigen (oder begründet entschuldigt sein), mindestens minPartners.
 *
 * Ergebnis: manipulated (Kette gebrochen, abgeschnitten oder umgeschrieben; mit Profil auch: Prüfpunkte, die
 * eine im Profil nicht dokumentierte Epoche „durch Wiederherstellung verloren“ hätte, oder solche hinter dem
 * vor einer Wiederherstellung festgehaltenen Kopf) vor unanchored (nicht ausreichend bestätigt) vor
 * needs_review (z. B. durch Wiederherstellung verlorene Prüfpunkte, nicht im Profil dokumentierte Epoche,
 * Abweichung mit kompromittiertem Schlüssel, jüngster bestätigter Prüfpunkt älter als STALE_INTERVALS
 * Intervalle) vor ok. Immer gemeldet: Zahl der noch nicht verankerten Einträge (anchoring). Protokolliert
 * als audit.anchor.verify (outcome error, wenn nicht ok).
 */
export async function verifyAnchors(
  deps: Deps,
  ctx: { actor: Actor; ip?: string | null; requestId?: string | null },
  opts: VerifyOptions = {},
): Promise<AnchorVerification> {
  const at = deps.now();
  const profile = opts.profile?.profile ?? null;
  const findings: AnchorFinding[] = [];
  if (profile && profile.nodeId !== deps.identity.nodeId) throw new Error('profile_other_node');
  const excused = new Set(opts.excuse?.nodeIds ?? []);
  for (const id of excused) {
    if (!profile?.partners.some((p) => p.nodeId === id)) throw new Error(`excused_not_in_profile:${id}`);
  }

  // eigene Schlüssel
  const keys = profile ? profileKeyWindows(profile) : await NodeIdentity.keyHistory(deps.db);

  // Epochen: Datenbank, mit Profil zusätzlich dessen (vertrauenswürdiger) Verlauf
  const dbEpochs = await loadEpochs(deps.db);
  const current = dbEpochs.at(-1)?.epoch;
  if (!current) throw new Error('audit_chain_epoch is empty');
  const merged = new Map<string, EpochRecord>(dbEpochs.map((e) => [e.epoch, e]));
  const inDb = new Set(dbEpochs.map((e) => e.epoch));
  const inProfile = new Set(profile?.epochs.map((e) => e.epoch) ?? []);
  for (const e of profile?.epochs ?? []) {
    const known = merged.get(e.epoch);
    if (known && epochsDisagree(known, e)) {
      findings.push({ code: 'epoch_conflict', severity: 'review', epoch: e.epoch });
    }
    // Angaben des Profils haben Vorrang (außerhalb der Datenbank verwahrt)
    merged.set(e.epoch, { ...e });
  }
  const ectx = epochContext(merged, current);
  const chainOfEpochs = lineage(merged, current);
  for (const e of chainOfEpochs) {
    if (profile && !inProfile.has(e.epoch)) {
      findings.push({
        code: 'epoch_not_in_profile',
        severity: 'review',
        epoch: e.epoch,
        ...(e.restoredSeq !== null ? { seq: e.restoredSeq } : {}),
        ...(e.startedAt ? { detail: e.startedAt } : {}),
      });
    }
    if (e.reason === 'restore') {
      findings.push({
        code: 'restore_epoch',
        severity: 'info',
        epoch: e.epoch,
        ...(e.restoredSeq !== null ? { seq: e.restoredSeq } : {}),
        ...(e.startedAt ? { detail: e.startedAt } : {}),
      });
    }
  }
  const epochsDocumented = !findings.some(
    (f) => f.code === 'epoch_not_in_profile' || f.code === 'epoch_conflict',
  );
  // Profil (außerhalb der Datenbank verwahrt) kennt eine Epoche des Verlaufs nicht: durch eine solche
  // „Wiederherstellung“ verlorene Prüfpunkte gelten als Abschneiden (Manipulation), bis die Wiederherstellung
  // mit ihrem Protokoll abgeglichen und das Profil neu exportiert ist (--accept-epochs)
  const lostIsManipulation = profile !== null && findings.some((f) => f.code === 'epoch_not_in_profile');

  // Partner
  let targets: PartnerTarget[];
  if (profile) {
    const rows = await deps.db
      .selectFrom('peer')
      .selectAll()
      .where(
        'node_id',
        'in',
        profile.partners.map((p) => p.nodeId),
      )
      .execute();
    const byNode = new Map(rows.map((r) => [r.node_id, r]));
    targets = profile.partners.map((p) => {
      const row = byNode.get(p.nodeId);
      // Abweichungen der Datenbank vom Profil: Hinweis auf Manipulation der Partnerliste oder einen
      // Schlüsselwechsel des Partners seit dem Export (dann Profil neu exportieren)
      if (row?.status !== 'trusted') {
        findings.push({
          code: 'partner_not_trusted_in_database',
          severity: 'review',
          nodeId: p.nodeId,
          detail: row ? row.status : 'missing',
        });
      }
      if (row && row.public_key !== p.publicKey) {
        findings.push({
          code: 'partner_differs_from_database',
          severity: 'review',
          nodeId: p.nodeId,
          detail: 'public_key',
        });
      }
      if (row && row.base_url !== p.baseUrl) {
        findings.push({
          code: 'partner_differs_from_database',
          severity: 'review',
          nodeId: p.nodeId,
          detail: 'base_url',
        });
      }
      return {
        peerId: row?.id ?? null,
        node_id: p.nodeId,
        displayName: p.displayName,
        base_url: p.baseUrl,
        public_key: p.publicKey,
        previous_public_key: null,
        previous_key_valid_until: null,
      };
    });
  } else {
    const rows = await deps.db
      .selectFrom('peer')
      .selectAll()
      // auch gesperrte: sie geben Prüfpunkte nur zurück, fälschen können sie sie nicht
      .where('status', 'in', ['trusted', 'suspended'])
      .orderBy('display_name')
      .execute();
    targets = rows.map((r) => ({ ...r, peerId: r.id, displayName: r.display_name }));
  }
  const nodeId = profile?.nodeId ?? deps.identity.nodeId;
  const collected = await Promise.all(targets.map((t) => collectFromPartner(deps, t, nodeId, keys)));

  // lokale Kette neu berechnen (Hashes genau der Laufnummern, zu denen Prüfpunkte vorliegen)
  const chain = await recomputeAuditChain(
    deps.db,
    collected.flatMap((c) => c.valid.map((v) => v.seq)),
  );
  const partners = collected.map((c) =>
    partnerResult(c, chain.hashes, ectx, excused.has(c.target.node_id), lostIsManipulation),
  );

  for (const p of partners) {
    if (p.lostByRestore > 0) {
      findings.push({
        code: 'lost_by_restore',
        // nur mit Profil, das alle Epochen des Verlaufs dokumentiert, ist der Verlust erklärt
        severity: lostIsManipulation ? 'fail' : profile && epochsDocumented ? 'info' : 'review',
        nodeId: p.nodeId,
        count: p.lostByRestore,
      });
    }
    if (p.unknownEpoch > 0) {
      findings.push({ code: 'unknown_epoch', severity: 'review', nodeId: p.nodeId, count: p.unknownEpoch });
    }
    if (p.inconclusive > 0) {
      findings.push({ code: 'inconclusive', severity: 'review', nodeId: p.nodeId, count: p.inconclusive });
    }
  }
  const confirms = (p: PartnerAnchorResult) =>
    p.matched > 0 && (p.status === 'ok' || p.status === 'needs_review');
  const anchoredPartners = partners.filter(confirms).length;
  const requiredPartners = profile?.minPartners ?? 1;
  if (profile) {
    for (const p of partners) {
      if (confirms(p) || p.status === 'mismatch') continue;
      if (p.excused) {
        findings.push({
          code: 'partner_excused',
          severity: 'info',
          nodeId: p.nodeId,
          detail: opts.excuse?.reason,
        });
      } else {
        findings.push({
          code: 'partner_missing',
          severity: 'fail',
          nodeId: p.nodeId,
          detail: p.errorCode ?? p.status,
        });
      }
    }
  }
  if (anchoredPartners < requiredPartners) {
    findings.push({
      code: 'insufficient_partners',
      severity: 'fail',
      count: anchoredPartners,
      seq: requiredPartners,
    });
  }

  // Stand der Verankerung: k-höchster bestätigter Kopf (k = requiredPartners)
  const confirmed = partners
    .filter((p) => confirms(p) && p.latestMatchedSeq !== null)
    .map((p) => ({ seq: p.latestMatchedSeq as number, at: p.latestMatchedAt }))
    .sort((x, y) => y.seq - x.seq);
  const anchoredHead = confirmed[requiredPartners - 1] ?? null;
  const hours = deps.config.MESH_AUDIT_CHECKPOINT_HOURS;
  const staleAfterHours = hours > 0 ? STALE_INTERVALS * hours : null;
  const anchoring: AnchorVerification['anchoring'] = {
    lastAnchoredSeq: anchoredHead?.seq ?? null,
    lastAnchoredAt: anchoredHead?.at ?? null,
    unanchoredEntries: Math.max(0, (chain.headSeq ?? 0) - (anchoredHead?.seq ?? 0)),
    staleAfterHours,
  };
  // Planer angehalten oder Zustellung unterbrochen: Einträge nach dem letzten Anker könnte der Eigentümer
  // unbemerkt ändern oder löschen. Kein Beweis (ein Knoten, der lange nicht lief, sieht genauso aus), aber
  // nie still „ok“. Das Lebenszeichen des Planers (HEARTBEAT_INTERVALS) hält einen laufenden Knoten frisch.
  if (
    staleAfterHours !== null &&
    anchoredHead?.at &&
    at.getTime() - Date.parse(anchoredHead.at) > staleAfterHours * 3600_000
  ) {
    findings.push({
      code: 'anchor_stale',
      severity: 'review',
      seq: anchoredHead.seq,
      count: anchoring.unanchoredEntries,
      detail: anchoredHead.at,
    });
  }
  if (chain.digest.ambiguousV1 > 0) {
    findings.push({ code: 'legacy_digest_ambiguous', severity: 'info', count: chain.digest.ambiguousV1 });
  }

  const manipulated = !chain.ok || partners.some((p) => p.status === 'mismatch');
  const result: AnchorVerification['result'] = manipulated
    ? 'manipulated'
    : findings.some((f) => f.severity === 'fail')
      ? 'unanchored'
      : findings.some((f) => f.severity === 'review')
        ? 'needs_review'
        : 'ok';
  const history: EpochView[] = [...merged.values()]
    .map((e) => ({ ...e, inDatabase: inDb.has(e.epoch), inProfile: inProfile.has(e.epoch) }))
    .sort((a, b) => (a.n ?? Number.MAX_SAFE_INTEGER) - (b.n ?? Number.MAX_SAFE_INTEGER));
  const verification: AnchorVerification = {
    result,
    at: at.toISOString(),
    independent: profile !== null,
    source: profile ? 'profile' : 'database',
    profile: opts.profile
      ? {
          sha256: opts.profile.sha256,
          createdAt: opts.profile.profile.createdAt,
          minPartners: opts.profile.profile.minPartners,
        }
      : null,
    requiredPartners,
    anchoredPartners,
    local: {
      ok: chain.ok,
      checked: chain.checked,
      firstBrokenSeq: chain.firstBrokenSeq,
      breakKind: chain.breakKind,
      headSeq: chain.headSeq,
      digest: chain.digest,
    },
    anchoring,
    epoch: { current, history },
    partners,
    findings,
  };
  await deps.audit.record({
    actor: ctx.actor,
    action: 'audit.anchor.verify',
    outcome: result === 'ok' ? 'success' : 'error',
    objectType: 'audit_log',
    details: {
      result,
      source: verification.source,
      ...(opts.profile ? { profileSha256: opts.profile.sha256 } : {}),
      chainOk: chain.ok,
      firstBrokenSeq: chain.firstBrokenSeq,
      ...(chain.breakKind ? { breakKind: chain.breakKind } : {}),
      headSeq: chain.headSeq,
      lastAnchoredSeq: anchoring.lastAnchoredSeq,
      unanchoredEntries: anchoring.unanchoredEntries,
      epoch: current,
      partners: partners.map((p) => ({
        nodeId: p.nodeId,
        status: p.status,
        checkpoints: p.checkpoints,
        latestSeq: p.latestSeq,
        ...(p.firstProblem ? { firstProblem: p.firstProblem } : {}),
        ...(p.errorCode ? { code: p.errorCode } : {}),
        ...(p.excused ? { excused: true } : {}),
      })),
      findings: findings.filter((f) => f.severity !== 'info' || f.code === 'partner_excused'),
      ...(opts.excuse && excused.size > 0 ? { excuseReason: opts.excuse.reason } : {}),
    },
    ip: ctx.ip ?? null,
    requestId: ctx.requestId ?? null,
  });
  return verification;
}

// ---------------------------------------------------------------------------------------------
// Export des letzten Prüfpunkts (Verankerung außerhalb des Netzes, z. B. bei Dritten)
// ---------------------------------------------------------------------------------------------

export const CheckpointExport = z.object({
  format: z.literal(CHECKPOINT_EXPORT_FORMAT),
  nodeId: z.string(),
  /** Epoche der Kette (fehlt bei Prüfpunkten vor Migration 0610) */
  epoch: z.string().nullable().optional(),
  seq: z.number().int(),
  hash: z.string(),
  at: z.string(),
  /** exakt signierte Aussage; die Signatur gilt für diese Zeichenkette (UTF-8) */
  statement: z.string(),
  /** base64(Ed25519) über statement */
  signature: z.string(),
  /** öffentlicher Schlüssel (base64, 32 Byte) und Fingerprint des Knotens zum Zeitpunkt des Prüfpunkts */
  publicKey: z.string(),
  fingerprint: z.string(),
});
export type CheckpointExport = z.infer<typeof CheckpointExport>;

/** Jüngster gültig signierter eigener Prüfpunkt (Zeilen ohne gültige Signatur zählen nicht) */
export async function latestCheckpointExport(deps: Pick<Deps, 'db' | 'identity'>): Promise<CheckpointExport> {
  const r = await latestOwnCheckpoint(deps);
  if (!r) throw notFound();
  const st = parseCheckpointStatement(r.statement);
  return {
    format: CHECKPOINT_EXPORT_FORMAT,
    nodeId: st?.nodeId ?? '',
    epoch: st?.epoch ?? null,
    seq: r.seq,
    hash: r.hash,
    at: isoReq(r.at),
    statement: r.statement,
    signature: r.signature,
    publicKey: r.public_key,
    fingerprint: fingerprint(r.public_key),
  };
}

export interface ExportCheck {
  signatureValid: boolean;
  /** Schlüssel gehört (heute oder früher) zu diesem Knoten und galt zum Zeitpunkt des Prüfpunkts */
  keyKnown: boolean;
  /** Schlüssel wurde wegen Kompromittierung abgelöst: eine Abweichung ist kein Beweis */
  keyCompromised: boolean;
  nodeMatches: boolean;
  epoch: string | null;
  seq: number | null;
  local: 'match' | AnchorProblemKind | null;
  chain: { ok: boolean; checked: number; firstBrokenSeq: number | null; breakKind: ChainBreak | null };
  ok: boolean;
}

/**
 * Prüft einen exportierten Prüfpunkt gegen die (neu berechnete) lokale Kette (Kommandozeile verify-audit
 * --checkpoint). Mit Profil gelten nur dessen eigene Schlüssel und Epochen zusätzlich zur Datenbank.
 */
export async function checkCheckpointExport(
  db: DbOrTx,
  nodeId: string,
  raw: unknown,
  opts: { profile?: LoadedProfile } = {},
): Promise<ExportCheck> {
  const exp = CheckpointExport.safeParse(raw);
  const st = exp.success ? parseCheckpointStatement(exp.data.statement) : null;
  const chain = await recomputeAuditChain(db, st ? [st.seq] : []);
  const chainView = {
    ok: chain.ok,
    checked: chain.checked,
    firstBrokenSeq: chain.firstBrokenSeq,
    breakKind: chain.breakKind,
  };
  const empty: ExportCheck = {
    signatureValid: false,
    keyKnown: false,
    keyCompromised: false,
    nodeMatches: false,
    epoch: null,
    seq: null,
    local: null,
    chain: chainView,
    ok: false,
  };
  if (!exp.success || !st) return empty;
  const signatureValid = ed25519Verify(exp.data.publicKey, exp.data.statement, exp.data.signature);
  const profile = opts.profile?.profile;
  const keys = profile ? profileKeyWindows(profile) : await NodeIdentity.keyHistory(db);
  const signer = checkpointSigner(
    keys.filter((k) => k.publicKey === exp.data.publicKey),
    exp.data.statement,
    exp.data.signature,
    st.at,
  );
  const keyKnown = 'key' in signer;
  const keyCompromised = 'key' in signer && signer.key.retired === 'compromised';
  const nodeMatches = st.nodeId === nodeId;
  const epochs = new Map((await loadEpochs(db)).map((e) => [e.epoch, e] as const));
  const current = [...epochs.values()].at(-1)?.epoch ?? '';
  for (const e of profile?.epochs ?? []) epochs.set(e.epoch, { ...e });
  const { problems } = compareCheckpoints(
    chain.hashes,
    [{ seq: st.seq, hash: st.hash, epoch: st.epoch?.toLowerCase() ?? null, compromisedKey: keyCompromised }],
    epochContext(epochs, current),
  );
  const local = problems[0]?.kind ?? 'match';
  return {
    signatureValid,
    keyKnown,
    keyCompromised,
    nodeMatches,
    epoch: st.epoch ?? null,
    seq: st.seq,
    local,
    chain: chainView,
    ok: signatureValid && keyKnown && nodeMatches && local === 'match' && chain.ok,
  };
}

// ---------------------------------------------------------------------------------------------
// Routen
// ---------------------------------------------------------------------------------------------

export const anchorHandlers: Handlers = {
  'anchors.status': async ({ deps }) => {
    const latest = await latestOwnCheckpoint(deps);
    const outbox = await deps.db
      .selectFrom('outbox_message')
      .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
      .where('type', '=', 'notice')
      .where(sql<boolean>`body->>'kind' = 'audit_checkpoint'`)
      .where('status', 'in', ['pending', 'failed'])
      .groupBy('status')
      .execute();
    const count = (s: string) => Number(outbox.find((o) => o.status === s)?.n ?? 0);
    const held = await deps.db
      .selectFrom('peer_audit_checkpoint as c')
      .innerJoin('peer as p', 'p.id', 'c.peer_id')
      .select([
        'p.node_id',
        'p.display_name',
        (eb) => eb.fn.countAll<string>().as('n'),
        (eb) => eb.fn.max('c.seq').as('latest_seq'),
        (eb) => eb.fn.max('c.received_at').as('latest_received_at'),
      ])
      .groupBy(['p.node_id', 'p.display_name'])
      .orderBy('p.display_name')
      .execute();
    return {
      intervalHours: deps.config.MESH_AUDIT_CHECKPOINT_HOURS,
      epoch: await currentEpoch(deps.db),
      latest: latest ? toCheckpointView(latest) : null,
      pending: count('pending'),
      failed: count('failed'),
      heldForPartners: held.map((h) => ({
        nodeId: h.node_id,
        displayName: h.display_name,
        count: Number(h.n),
        latestSeq: Number(h.latest_seq),
        latestReceivedAt: isoReq(h.latest_received_at as Date),
      })),
    };
  },

  'anchors.create': async ({ deps, actor, ip, requestId }) => {
    const r = await createCheckpoint(deps, 'manual', { actor, ip, requestId });
    // sofort zustellen (Fehler: das Ausgangspostfach wiederholt)
    void deps.services.federation
      .flushOutbox()
      .catch((err: Error) => deps.log.warn('outbox flush after checkpoint failed', { error: err.message }));
    return r;
  },

  'anchors.latest': async ({ deps, actor, ip, requestId }) => {
    const exp = await latestCheckpointExport(deps);
    await deps.audit.record({
      actor,
      action: 'audit.checkpoint.export',
      objectType: 'audit_checkpoint',
      objectId: String(exp.seq),
      details: { seq: exp.seq, epoch: exp.epoch ?? null },
      ip,
      requestId,
    });
    return exp;
  },

  // läuft im Server mit der Partnerliste der Datenbank: nicht unabhängig (independent = false); unabhängig
  // nur über die Kommandozeile mit Anker-Profil
  'anchors.verify': async ({ deps, actor, ip, requestId }) => verifyAnchors(deps, { actor, ip, requestId }),
};
