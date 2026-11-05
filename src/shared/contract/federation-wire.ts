/**
 * Föderationsprotokoll "osp-mesh/1" zwischen Knoten (siehe docs/protocol.md).
 *
 * Transport: HTTPS POST {peer.baseUrl}/federation/v1/{type}
 * Signatur:  Header "X-Mesh-Node" = Absender-nodeId, "X-Mesh-Signature" = base64(Ed25519(rawBody))
 *            Die Signatur deckt exakt die übertragenen Body-Bytes ab (keine Kanonisierung nötig).
 * Antwort:   ebenfalls signiert (gleiche Header); "inReplyTo" bindet die Antwort an die Anfrage.
 */
import { z } from 'zod';
import { ColumnDef, IsoDate, IsoDateTime, PurposeCode, Scalar, Uuid } from './common.ts';
import { Offer } from './federation.ts';

export const PROTOCOL_VERSION = 1 as const;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const MessageType = z.enum(['ping', 'catalog', 'pull', 'notice', 'checkpoints']);
export type MessageType = z.infer<typeof MessageType>;

export const RequestEnvelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: MessageType,
  /** Nonce, je Absender eindeutig (Replay-Schutz) */
  id: Uuid,
  from: z.string(),
  to: z.string(),
  ts: IsoDateTime,
  body: z.unknown(),
});
export type RequestEnvelope = z.infer<typeof RequestEnvelope>;

export const FederationErrorCode = z.enum([
  'bad_request',
  'unknown_node',
  'untrusted',
  'bad_signature',
  'wrong_recipient',
  'clock_skew',
  'replay',
  'access_denied',
  'not_found',
  'internal_error',
]);
export type FederationErrorCode = z.infer<typeof FederationErrorCode>;

export const ResponseEnvelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: Uuid,
  inReplyTo: Uuid.nullable(),
  from: z.string(),
  to: z.string(),
  ts: IsoDateTime,
  ok: z.boolean(),
  body: z.unknown().optional(),
  /** bei ok=false */
  error: z.object({ code: FederationErrorCode, reason: z.string().optional() }).optional(),
});
export type ResponseEnvelope = z.infer<typeof ResponseEnvelope>;

// --- ping -------------------------------------------------------------------------------------
export const PingBody = z.object({});
export const PingResponse = z.object({ nodeId: z.string(), displayName: z.string(), time: IsoDateTime });

// --- catalog ----------------------------------------------------------------------------------
export const CatalogRequest = z.object({ q: z.string().max(100).optional() });
export const CatalogResponse = z.object({
  node: z.object({ nodeId: z.string(), displayName: z.string() }),
  offers: z.array(Offer),
});

// --- pull -------------------------------------------------------------------------------------
export const PullRequest = z.object({ releaseId: Uuid, purpose: PurposeCode });
export const PullResponse = z.object({
  release: z.object({
    id: Uuid,
    productId: Uuid,
    productSlug: z.string(),
    productName: z.string(),
    productDescription: z.string(),
    productVersion: z.number().int(),
    specialCategory: z.boolean(),
    purpose: PurposeCode,
    validUntil: IsoDateTime.nullable(),
    dataFrom: IsoDate.nullable(),
    dataUntil: IsoDate.nullable(),
  }),
  columns: z.array(ColumnDef),
  /** subject = freigabebezogenes Pseudonym der Person (keine Rückschlüsse auf lokale IDs) */
  rows: z.array(z.object({ subject: z.string(), values: z.record(z.string(), Scalar) })),
  generatedAt: IsoDateTime,
});
export type PullResponse = z.infer<typeof PullResponse>;

// --- notice -----------------------------------------------------------------------------------
/** Ed25519-Public-Key, base64 (32 Byte) bzw. Signatur, base64 (64 Byte) */
export const PublicKeyB64 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
export const SignatureB64 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);

/** Mitteilungen zu freigegebenen Daten (Datenhalter → Empfänger): Empfänger löscht Kopie bzw. Zeilen */
export const ReleaseRevokedNotice = z.object({
  kind: z.literal('release_revoked'),
  releaseId: Uuid,
  reason: z.string().max(1000),
});
export const SubjectsWithdrawnNotice = z.object({
  kind: z.literal('subjects_withdrawn'),
  releaseId: Uuid,
  subjects: z.array(z.string().min(8).max(64)).min(1).max(10000),
  reason: z.enum(['consent_withdrawn', 'erasure']),
});

/**
 * Wechsel des Knotenschlüssels (ADR 0013). `statement` ist die exakt signierte Rotationsaussage
 * (KeyRotationStatement als JSON-Text), signiert mit dem bisherigen (Kontinuität) und dem neuen Schlüssel
 * (Besitz). Der Umschlag ist mit dem bisherigen Schlüssel signiert.
 */
export const KeyRotatedNotice = z.object({
  kind: z.literal('key_rotated'),
  statement: z.string().max(2000),
  signatureOld: SignatureB64,
  signatureNew: SignatureB64,
});

/** Signierter Prüfpunkt der Audit-Kette des Absenders (ADR 0014); `statement` = AuditCheckpointStatement als JSON-Text */
export const AuditCheckpointNotice = z.object({
  kind: z.literal('audit_checkpoint'),
  statement: z.string().max(1000),
  signature: SignatureB64,
});

export const NoticeBody = z.discriminatedUnion('kind', [
  /** Freigabe widerrufen oder Produkt stillgelegt: Empfänger löscht die Kopie */
  ReleaseRevokedNotice,
  /** Einwilligung widerrufen / Person gelöscht: Empfänger löscht Zeilen dieser Pseudonyme */
  SubjectsWithdrawnNotice,
  /** Schlüsselwechsel des Absenders: Empfänger übernimmt den neuen Schlüssel */
  KeyRotatedNotice,
  /** Prüfpunkt der Audit-Kette des Absenders: Empfänger verwahrt ihn */
  AuditCheckpointNotice,
]);
export type NoticeBody = z.infer<typeof NoticeBody>;
/** Mitteilungen, die empfangene Daten betreffen (Widerruf, Löschung) */
export type DataNoticeBody = z.infer<typeof ReleaseRevokedNotice> | z.infer<typeof SubjectsWithdrawnNotice>;
export const NoticeResponse = z.object({ ack: z.literal(true), affectedRows: z.number().int() });

// --- Schlüsselwechsel ---------------------------------------------------------------------------
export const KEY_ROTATION_FORMAT = 'osp-data-mesh/key-rotation@1' as const;
/** Längste Übergangszeit, in der ein Empfänger den bisherigen Schlüssel noch annimmt */
export const MAX_KEY_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const KeyRotationStatement = z.object({
  format: z.literal(KEY_ROTATION_FORMAT),
  nodeId: z.string(),
  oldPublicKey: PublicKeyB64,
  newPublicKey: PublicKeyB64,
  rotatedAt: IsoDateTime,
  /** bis dahin nimmt der Empfänger auch den bisherigen Schlüssel an (höchstens MAX_KEY_GRACE_MS nach Empfang) */
  graceUntil: IsoDateTime,
});
export type KeyRotationStatement = z.infer<typeof KeyRotationStatement>;

// --- Prüfpunkte der Audit-Kette -----------------------------------------------------------------
export const AUDIT_CHECKPOINT_FORMAT = 'osp-data-mesh/audit-checkpoint@1' as const;
export const AuditCheckpointStatement = z.object({
  format: z.literal(AUDIT_CHECKPOINT_FORMAT),
  nodeId: z.string(),
  /**
   * Epoche der Kette (neu nach jeder Wiederherstellung, ADR 0014). Fehlt nur bei Aussagen von Knoten vor
   * Migration 0610; diese gelten als Aussagen der ersten Epoche.
   */
  epoch: Uuid.optional(),
  /** Laufnummer und Hash des Kopfes der Audit-Kette */
  seq: z.number().int().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Zeitpunkt des Prüfpunkts */
  at: IsoDateTime,
});
export type AuditCheckpointStatement = z.infer<typeof AuditCheckpointStatement>;

// --- checkpoints: beim Partner verwahrte eigene Prüfpunkte abrufen -------------------------------
export const CHECKPOINTS_PAGE_SIZE = 1000;
/**
 * Seitenweise nach (seq, Epoche) sortiert: nach einer Wiederherstellung gibt es dieselbe Laufnummer in
 * mehreren Epochen. afterEpoch: Epoche des letzten Eintrags der vorigen Seite ('' = ohne Epoche); fehlt es,
 * gilt nur seq > afterSeq.
 */
export const CheckpointsRequest = z.object({
  afterSeq: z.number().int().min(0),
  afterEpoch: z.union([Uuid, z.literal('')]).optional(),
  limit: z.number().int().min(1).max(CHECKPOINTS_PAGE_SIZE),
});
export const CheckpointsResponse = z.object({
  checkpoints: z.array(z.object({ statement: z.string().max(1000), signature: z.string().max(200) })),
  more: z.boolean(),
});
