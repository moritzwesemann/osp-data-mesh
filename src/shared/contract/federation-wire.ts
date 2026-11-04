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

export const MessageType = z.enum(['ping', 'catalog', 'pull', 'notice']);
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
export const NoticeBody = z.discriminatedUnion('kind', [
  /** Freigabe widerrufen oder Produkt stillgelegt: Empfänger löscht die Kopie */
  z.object({ kind: z.literal('release_revoked'), releaseId: Uuid, reason: z.string().max(1000) }),
  /** Einwilligung widerrufen / Person gelöscht: Empfänger löscht Zeilen dieser Pseudonyme */
  z.object({
    kind: z.literal('subjects_withdrawn'),
    releaseId: Uuid,
    subjects: z.array(z.string().min(8).max(64)).min(1).max(10000),
    reason: z.enum(['consent_withdrawn', 'erasure']),
  }),
]);
export type NoticeBody = z.infer<typeof NoticeBody>;
export const NoticeResponse = z.object({ ack: z.literal(true), affectedRows: z.number().int() });
