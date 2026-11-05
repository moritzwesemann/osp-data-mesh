/**
 * OAuth 2.0 Client Credentials (RFC 6749, Abschnitt 4.4) für API-Quellen.
 *
 * Das Client-Geheimnis ist das verschlüsselt gespeicherte Zugangsgeheimnis des Connectors
 * (connectors.setSecret); es geht nur an den Token-Endpunkt – über HTTPS (bzw. Loopback oder mit
 * MESH_SOURCE_ALLOW_INSECURE_HTTP), und der Host des Token-Endpunkts muss wie die Datenadresse in
 * MESH_SOURCE_ALLOWED_HOSTS stehen (geprüft in source-http.ts, checkSource). Keine Weiterleitungen.
 *
 * Zugriffstoken liegen nur im Arbeitsspeicher des Knotens (je Connector), bis kurz vor Ablauf
 * (Sicherheitsabstand), höchstens eine Stunde; Schlüssel ist ein Fingerabdruck aus Token-Adresse,
 * Client-Kennung, Scope, Audience, Übermittlungsart und Geheimnis – jede Änderung erzwingt ein neues
 * Token. Lehnt die Datenquelle ein Token mit 401 ab, wird einmal ein neues geholt.
 *
 * Fehler werden auf die vorhandenen, übersetzten Importcodes abgebildet: source_unreachable (mit
 * reason/status) und invalid_response (reason). Freitext des Token-Endpunkts erreicht nie die Nutzenden;
 * nur die in RFC 6749 (5.2) festgelegten Fehlercodes werden ausgewertet.
 */
import { createHash } from 'node:crypto';
import type { ApiAuth } from '../../../shared/contract/connectors.ts';
import type { Deps } from '../../core/deps.ts';
import type { IssueParams } from './validate.ts';

export type OAuthClientCredentials = Extract<ApiAuth, { type: 'oauth2_client_credentials' }>;

/** Höchstgröße der Antwort des Token-Endpunkts */
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
/** Sicherheitsabstand vor Ablauf (Sekunden; bei kurzlebigen Tokens höchstens die halbe Laufzeit) */
export const TOKEN_EXPIRY_MARGIN_S = 60;
/** Laufzeit, wenn der Token-Endpunkt kein expires_in angibt */
export const DEFAULT_TOKEN_LIFETIME_S = 300;
/** längste Zwischenspeicherung eines Tokens */
export const MAX_TOKEN_CACHE_S = 3600;

/** Fehlercodes nach RFC 6749 (5.2), die eine eigene Meldung bekommen */
const OAUTH_ERRORS = new Set(['invalid_client', 'invalid_scope', 'unauthorized_client']);
/** Zeichen eines Tokens, das unverändert in eine Kopfzeile darf (sichtbares ASCII) */
const TOKEN_RE = /^[\x21-\x7e]{1,8192}$/;

export type TokenFailure = {
  ok: false;
  code: 'source_unreachable' | 'invalid_response';
  params: IssueParams;
};
export type TokenResult = { ok: true; token: string; fromCache: boolean } | TokenFailure;

interface CachedToken {
  fingerprint: string;
  token: string;
  /** Millisekunden (deps.now) */
  validUntil: number;
}

/** Token-Zwischenspeicher eines Knotens (je Connector-ID) */
export class TokenCache {
  private readonly entries = new Map<string, CachedToken>();

  get(key: string, fingerprint: string, now: number): string | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.fingerprint !== fingerprint || now >= e.validUntil) {
      this.entries.delete(key);
      return null;
    }
    return e.token;
  }

  set(key: string, entry: CachedToken): void {
    this.entries.set(key, entry);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

const caches = new WeakMap<object, TokenCache>();

/** Zwischenspeicher des Knotens (an deps gebunden: mehrere Knoten in einem Prozess teilen nichts) */
export function tokenCacheOf(deps: object): TokenCache {
  let c = caches.get(deps);
  if (!c) {
    c = new TokenCache();
    caches.set(deps, c);
  }
  return c;
}

export function tokenFingerprint(auth: OAuthClientCredentials, secret: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        auth.tokenUrl,
        auth.clientId,
        auth.scope ?? '',
        auth.audience ?? '',
        auth.clientAuth,
        secret,
      ]),
    )
    .digest('hex');
}

/** Gültigkeit eines neuen Tokens im Zwischenspeicher (Sekunden) */
export function cacheLifetime(expiresIn: number | null): number {
  const lifetime = expiresIn ?? DEFAULT_TOKEN_LIFETIME_S;
  const margin = Math.min(TOKEN_EXPIRY_MARGIN_S, Math.floor(lifetime / 2));
  return Math.max(0, Math.min(MAX_TOKEN_CACHE_S, lifetime - margin));
}

async function readLimited(res: Response, budget: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > budget) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > budget) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function parseJson(bytes: Uint8Array | null): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Formular-Kodierung für HTTP-Basic (RFC 6749, 2.3.1: Kennung und Geheimnis zuerst URL-kodiert) */
function formEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

/** Ein neues Zugriffstoken beim Token-Endpunkt holen (ohne Zwischenspeicher) */
export async function requestToken(
  fetchFn: Deps['fetch'],
  auth: OAuthClientCredentials,
  secret: string,
  timeoutMs: number,
): Promise<{ ok: true; token: string; expiresIn: number | null } | TokenFailure> {
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (auth.scope) body.set('scope', auth.scope);
  if (auth.audience) body.set('audience', auth.audience);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': 'osp-data-mesh',
  };
  if (auth.clientAuth === 'body') {
    body.set('client_id', auth.clientId);
    body.set('client_secret', secret);
  } else {
    const basic = Buffer.from(`${formEncode(auth.clientId)}:${formEncode(secret)}`, 'utf8').toString(
      'base64',
    );
    headers.authorization = `Basic ${basic}`;
  }
  let res: Response;
  try {
    res = await fetchFn(auth.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return {
      ok: false,
      code: 'source_unreachable',
      params: { reason: name === 'TimeoutError' ? 'token_timeout' : 'token_network' },
    };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readLimited(res, MAX_TOKEN_RESPONSE_BYTES);
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return {
      ok: false,
      code: 'source_unreachable',
      params: { reason: name === 'TimeoutError' ? 'token_timeout' : 'token_network' },
    };
  }
  const json = parseJson(bytes);
  if (res.status < 200 || res.status > 299) {
    const error = typeof json?.error === 'string' ? json.error : '';
    return {
      ok: false,
      code: 'source_unreachable',
      params: { status: res.status, reason: OAUTH_ERRORS.has(error) ? `oauth_${error}` : 'token_rejected' },
    };
  }
  const token = json?.access_token;
  const type = json?.token_type;
  if (
    typeof token !== 'string' ||
    !TOKEN_RE.test(token) ||
    (type !== undefined && (typeof type !== 'string' || type.toLowerCase() !== 'bearer'))
  ) {
    return { ok: false, code: 'invalid_response', params: { reason: 'token_invalid' } };
  }
  const raw = json?.expires_in;
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
  return { ok: true, token, expiresIn: Number.isFinite(n) && n >= 0 ? Math.floor(n) : null };
}

/** Bezugsquelle für Zugriffstokens eines Abrufs (fetchApiItems) */
export interface OAuthSession {
  /** Token aus dem Zwischenspeicher oder neu; refresh=true holt immer ein neues */
  token(refresh: boolean): Promise<TokenResult>;
}

export function createOAuthSession(opts: {
  fetch: Deps['fetch'];
  auth: OAuthClientCredentials;
  secret: string | null;
  timeoutMs: number;
  now: () => Date;
  /** ohne Angabe (z. B. Beispielabruf einer noch nicht gespeicherten Quelle): kein Zwischenspeicher */
  cache?: { store: TokenCache; key: string };
}): OAuthSession {
  return {
    async token(refresh) {
      const { secret, auth, cache } = opts;
      if (!secret) return { ok: false, code: 'source_unreachable', params: { reason: 'secret_missing' } };
      const fingerprint = tokenFingerprint(auth, secret);
      if (cache && !refresh) {
        const hit = cache.store.get(cache.key, fingerprint, opts.now().getTime());
        if (hit) return { ok: true, token: hit, fromCache: true };
      }
      if (cache) cache.store.delete(cache.key);
      const res = await requestToken(opts.fetch, auth, secret, opts.timeoutMs);
      if (!res.ok) return res;
      const lifetime = cacheLifetime(res.expiresIn);
      if (cache && lifetime > 0) {
        cache.store.set(cache.key, {
          fingerprint,
          token: res.token,
          validUntil: opts.now().getTime() + lifetime * 1000,
        });
      }
      return { ok: true, token: res.token, fromCache: false };
    },
  };
}
