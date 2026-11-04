/**
 * Client des Föderationsprotokolls: signierte Anfrage senden, signierte Antwort vollständig prüfen.
 *
 * Fehler werden auf drei Codes abgebildet:
 *  - peer_unreachable   Netzwerkfehler, Zeitüberschreitung, unzulässige Adresse
 *  - signature_invalid  Antwort unsigniert, falsch signiert, falsch adressiert oder ungültig aufgebaut
 *  - peer_rejected      Partner hat signiert abgelehnt (remoteCode + ggf. Ablehnungsgrund)
 */
import type { z } from 'zod';
import {
  type FederationErrorCode,
  type MessageType,
  type RequestEnvelope,
  ResponseEnvelope,
} from '../../../shared/contract/federation-wire.ts';
import { ed25519Verify } from '../../core/crypto.ts';
import type { Deps } from '../../core/deps.ts';
import { AppError } from '../../core/errors.ts';
import { DENY_REASONS } from '../releases/engine.ts';
import {
  decodeUtf8,
  FEDERATION_PATH,
  HEADER_NODE,
  HEADER_SIGNATURE,
  MAX_MESSAGE_BYTES,
  normalizeBaseUrl,
  parseJson,
  readLimited,
  type Signed,
  signRequest,
  withinSkew,
} from './protocol.ts';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DISCOVERY_TIMEOUT_MS = 5_000;

export type PeerCallCode = 'peer_unreachable' | 'signature_invalid' | 'peer_rejected';

/** Fehler eines Partneraufrufs. Ist ein AppError und kann direkt an die API weitergereicht werden. */
export class PeerCallError extends AppError {
  declare readonly code: PeerCallCode;
  /** Fehlercode des Partners (nur bei peer_rejected) */
  readonly remoteCode: FederationErrorCode | null;
  /** id (Nonce) der gesendeten Anfrage, falls bereits erzeugt */
  messageId: string | null;

  constructor(
    code: PeerCallCode,
    opts: { remoteCode?: FederationErrorCode; reason?: string; cause?: unknown; messageId?: string } = {},
  ) {
    super(code, { reason: opts.reason, cause: opts.cause });
    this.name = 'PeerCallError';
    this.remoteCode = opts.remoteCode ?? null;
    this.messageId = opts.messageId ?? null;
  }
}

/** Übersetzbarer Fehlercode für Anzeige/Speicherung (bei Ablehnung der Code des Partners) */
export function errorCodeOf(err: unknown): string {
  if (err instanceof PeerCallError) return err.remoteCode ?? err.code;
  if (err instanceof AppError) return err.code;
  return 'internal_error';
}

/** Minimale Sicht auf eine Partnerzeile */
export interface PeerTarget {
  node_id: string;
  base_url: string;
  public_key: string;
}

export interface SignedReply<T> {
  body: T;
  /** exakte Antwort-Bytes als Text (Grundlage für den Herkunftsnachweis) */
  rawText: string;
  /** Signatur des Partners über rawText */
  signature: string;
  /** id der eigenen Anfrage (Nonce) */
  requestId: string;
  envelope: ResponseEnvelope;
}

const SAFE_REASONS = new Set<string>(DENY_REASONS);

/** Ablehnungsgründe des Partners nur übernehmen, wenn sie bekannte Codes sind (kein Fremdtext an Nutzende). */
function safeReason(reason: string | undefined): string | undefined {
  return reason && SAFE_REASONS.has(reason) ? reason : undefined;
}

export async function sendSigned<T = unknown>(
  deps: Deps,
  peer: PeerTarget,
  type: MessageType,
  body: unknown,
  opts: { timeoutMs?: number; schema?: z.ZodType<T> } = {},
): Promise<SignedReply<T>> {
  const base = normalizeBaseUrl(peer.base_url, deps.config.MESH_FEDERATION_ALLOW_HTTP);
  if (!base.ok) throw new PeerCallError('peer_unreachable', { reason: base.code });
  const url = `${base.url}${FEDERATION_PATH}/${type}`;

  const req = signRequest(deps.identity, peer.node_id, type, body, deps.now());
  try {
    return await exchange(deps, peer, url, req, opts);
  } catch (err) {
    if (err instanceof PeerCallError) err.messageId = req.envelope.id;
    throw err;
  }
}

async function exchange<T>(
  deps: Deps,
  peer: PeerTarget,
  url: string,
  req: Signed<RequestEnvelope>,
  opts: { timeoutMs?: number; schema?: z.ZodType<T> },
): Promise<SignedReply<T>> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        [HEADER_NODE]: deps.identity.nodeId,
        [HEADER_SIGNATURE]: req.signature,
      },
      body: req.raw,
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new PeerCallError('peer_unreachable', { cause });
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readLimited(res, MAX_MESSAGE_BYTES);
  } catch (cause) {
    throw new PeerCallError('peer_unreachable', { cause });
  }
  if (!bytes) throw new PeerCallError('signature_invalid', { reason: 'response_too_large' });

  const signature = res.headers.get(HEADER_SIGNATURE);
  if (!signature) {
    // Gateway-Fehler eines vorgeschalteten Proxys: Partner nicht erreichbar
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new PeerCallError('peer_unreachable', { reason: 'gateway_error' });
    }
    throw new PeerCallError('signature_invalid', { reason: 'unsigned_response' });
  }
  if (res.headers.get(HEADER_NODE) !== peer.node_id) {
    throw new PeerCallError('signature_invalid', { reason: 'wrong_sender' });
  }
  if (!ed25519Verify(peer.public_key, bytes, signature)) {
    throw new PeerCallError('signature_invalid', { reason: 'bad_signature' });
  }

  const rawText = decodeUtf8(bytes);
  const parsed = ResponseEnvelope.safeParse(parseJson(rawText));
  if (rawText === null || !parsed.success) {
    throw new PeerCallError('signature_invalid', { reason: 'bad_envelope' });
  }
  const env = parsed.data;
  if (env.from !== peer.node_id || env.to !== deps.identity.nodeId) {
    throw new PeerCallError('signature_invalid', { reason: 'wrong_address' });
  }
  if (env.inReplyTo !== req.envelope.id) {
    throw new PeerCallError('signature_invalid', { reason: 'wrong_reply' });
  }

  if (!env.ok) {
    // Bindung an die frische Anfrage-id (inReplyTo) verhindert das Wiedereinspielen alter Antworten;
    // die Zeitprüfung entfällt hier, damit z. B. clock_skew des Partners lesbar bleibt.
    if (!env.error) throw new PeerCallError('signature_invalid', { reason: 'bad_envelope' });
    const reason = safeReason(env.error.reason);
    throw new PeerCallError('peer_rejected', {
      remoteCode: env.error.code,
      reason: reason ?? env.error.code,
    });
  }
  if (!res.ok) throw new PeerCallError('signature_invalid', { reason: 'bad_envelope' });
  if (!withinSkew(env.ts, deps.now())) {
    throw new PeerCallError('signature_invalid', { reason: 'clock_skew' });
  }

  let out: T = env.body as T;
  if (opts.schema) {
    const r = opts.schema.safeParse(env.body);
    if (!r.success) throw new PeerCallError('signature_invalid', { reason: 'bad_body' });
    out = r.data;
  }
  return { body: out, rawText, signature, requestId: req.envelope.id, envelope: env };
}
