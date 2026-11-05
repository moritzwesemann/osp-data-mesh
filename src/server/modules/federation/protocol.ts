/**
 * Föderationsprotokoll osp-mesh/1: Umschläge bauen und signieren, Bytes prüfen (siehe docs/protokoll.md).
 *
 * Die Signatur deckt exakt die übertragenen Bytes ab. Deshalb wird jeder Umschlag genau einmal mit
 * JSON.stringify serialisiert, diese Zeichenkette signiert und unverändert (UTF-8) übertragen.
 */
import { randomUUID } from 'node:crypto';
import {
  type FederationErrorCode,
  MAX_CLOCK_SKEW_MS,
  type MessageType,
  PROTOCOL_VERSION,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '../../../shared/contract/federation-wire.ts';
import type { Signer as NodeSigner } from '../../core/node-identity.ts';

export const HEADER_NODE = 'x-mesh-node';
export const HEADER_SIGNATURE = 'x-mesh-signature';
export const FEDERATION_PATH = '/federation/v1';

/**
 * Höchstgröße einer Anfrage (Body-Limit in app.ts und im Endpunkt). Anfragen sind klein (größte: Mitteilung
 * mit bis zu 10 000 Pseudonymen, < 1 MB); groß sind nur Antworten auf Abrufe.
 */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** Höchstgröße einer Antwort (vom Client beim Lesen erzwungen) */
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
/** Nonces werden 15 Minuten gespeichert (Zeitfenster ±5 Minuten → Replays danach scheitern an clock_skew) */
export const NONCE_TTL_MS = 15 * 60 * 1000;

export const NODE_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** HTTP-Status je Protokollfehler */
export const FEDERATION_STATUS: Record<FederationErrorCode, number> = {
  bad_request: 400,
  unknown_node: 401,
  untrusted: 401,
  bad_signature: 401,
  wrong_recipient: 401,
  clock_skew: 401,
  replay: 401,
  access_denied: 403,
  not_found: 404,
  internal_error: 500,
};

export interface Signed<E> {
  envelope: E;
  /** exakt übertragene Zeichenkette (UTF-8) */
  raw: string;
  /** base64(Ed25519(raw)) */
  signature: string;
}

type Signer = Pick<NodeSigner, 'nodeId' | 'sign'>;

export function signRequest(
  identity: Signer,
  to: string,
  type: MessageType,
  body: unknown,
  now: Date,
): Signed<RequestEnvelope> {
  const envelope: RequestEnvelope = {
    v: PROTOCOL_VERSION,
    type,
    id: randomUUID(),
    from: identity.nodeId,
    to,
    ts: now.toISOString(),
    body,
  };
  const raw = JSON.stringify(envelope);
  return { envelope, raw, signature: identity.sign(raw) };
}

export type ResponseResult =
  | { ok: true; body: unknown }
  | { ok: false; code: FederationErrorCode; reason?: string };

export function signResponse(
  identity: Signer,
  to: string,
  inReplyTo: string | null,
  result: ResponseResult,
  now: Date,
): Signed<ResponseEnvelope> {
  const base = {
    v: PROTOCOL_VERSION,
    id: randomUUID(),
    inReplyTo,
    from: identity.nodeId,
    to,
    ts: now.toISOString(),
  };
  const envelope: ResponseEnvelope = result.ok
    ? { ...base, ok: true, body: result.body }
    : {
        ...base,
        ok: false,
        error: { code: result.code, ...(result.reason ? { reason: result.reason } : {}) },
      };
  const raw = JSON.stringify(envelope);
  return { envelope, raw, signature: identity.sign(raw) };
}

/** Zeitstempel höchstens MAX_CLOCK_SKEW_MS von der eigenen Uhr entfernt */
export function withinSkew(ts: string, now: Date): boolean {
  const t = Date.parse(ts);
  return Number.isFinite(t) && Math.abs(t - now.getTime()) <= MAX_CLOCK_SKEW_MS;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Striktes UTF-8 (ungültige Bytes → null; ein BOM bleibt erhalten und macht das JSON ungültig) */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Anfrage oder Antwort, deren Body gelesen wird */
interface BodySource {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Liest einen Body (Anfrage oder Antwort) bis max Bytes; null, wenn größer (der Rest wird nicht gelesen). */
export async function readLimited(src: BodySource, max: number): Promise<Uint8Array | null> {
  const declared = Number(src.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    await src.body?.cancel().catch(() => {});
    return null;
  }
  if (!src.body) return new Uint8Array(0);
  const reader = src.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}

/** Liest höchstens die ersten max Bytes eines Bodys (Rest wird verworfen), z. B. um eine Anfrage-id zu finden. */
export async function readHead(src: BodySource, max: number): Promise<Uint8Array> {
  if (!src.body) return new Uint8Array(0);
  const reader = src.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) return concat(chunks, total);
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return concat(chunks, total).subarray(0, max);
}

/**
 * Normalisiert eine Partneradresse: nur https (http nur mit MESH_FEDERATION_ALLOW_HTTP), keine Zugangsdaten,
 * keine Query/Fragment, ohne abschließenden Schrägstrich.
 */
export function normalizeBaseUrl(
  raw: string,
  allowHttp: boolean,
): { ok: true; url: string } | { ok: false; code: 'invalid_url' | 'https_required' } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, code: 'invalid_url' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, code: 'invalid_url' };
  if (u.protocol === 'http:' && !allowHttp) return { ok: false, code: 'https_required' };
  if (u.username || u.password || u.search || u.hash) return { ok: false, code: 'invalid_url' };
  return { ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, '') };
}
