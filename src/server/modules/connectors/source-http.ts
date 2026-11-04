/**
 * Abruf von API-Quellen (JSON über HTTP): Host-Freigabeliste (SSRF-Schutz), Authentifizierung,
 * Seitenweise Abfrage, Zeitlimit, Größenbegrenzung. Keine Weiterleitungen (könnten die Freigabeliste umgehen).
 *
 * Zugangsgeheimnisse gehen nur über https:// (oder an Loopback-Adressen bzw. mit
 * MESH_SOURCE_ALLOW_INSECURE_HTTP=true) und nur an das gespeicherte Ziel ihres Connectors (siehe index.ts).
 */
import { createHash } from 'node:crypto';
import type { ConnectorConfig, HttpApiConfig } from '../../../shared/contract/connectors.ts';
import type { Deps } from '../../core/deps.ts';
import { getPath, MAX_SOURCE_ROWS } from './pipeline.ts';
import type { IssueParams } from './validate.ts';

export { MAX_SOURCE_ROWS };
export const MAX_API_BYTES = 50 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** Darf ein Zugangsgeheimnis an diese URL gesendet werden? (https, Loopback oder ausdrücklich erlaubt) */
export function secureTransport(url: string, allowInsecureHttp: boolean): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return allowInsecureHttp || LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
}

/** Wird beim Abruf ein Geheimnis mitgesendet? */
export function sendsSecret(config: HttpApiConfig, secret: string | null): boolean {
  return !!secret && config.auth.type !== 'none';
}

/**
 * Ziel, an das ein gespeichertes Geheimnis gebunden ist: Origin (Schema, Host, Port) und Art der
 * Authentifizierung. Ändert sich das Ziel, wird das Geheimnis verworfen. CSV-Quellen: null.
 */
export function secretTarget(config: ConnectorConfig): string | null {
  if (config.type !== 'http_api') return null;
  let origin: string;
  try {
    origin = new URL(config.url).origin.toLowerCase();
  } catch {
    origin = config.url;
  }
  const auth =
    config.auth.type === 'header' ? `header:${config.auth.headerName.toLowerCase()}` : config.auth.type;
  return `${origin}|${auth}`;
}

export type SourceDenial = 'source_not_allowed' | 'insecure_http';

/** Prüfung vor jedem Abruf: Host freigegeben, Geheimnis nur über sichere Verbindung */
export function checkSource(
  config: HttpApiConfig,
  secret: string | null,
  cfg: { MESH_SOURCE_ALLOWED_HOSTS: readonly string[]; MESH_SOURCE_ALLOW_INSECURE_HTTP: boolean },
): SourceDenial | null {
  if (!isHostAllowed(config.url, cfg.MESH_SOURCE_ALLOWED_HOSTS)) return 'source_not_allowed';
  if (sendsSecret(config, secret) && !secureTransport(config.url, cfg.MESH_SOURCE_ALLOW_INSECURE_HTTP)) {
    return 'insecure_http';
  }
  return null;
}

/** host[:port] der URL steht in MESH_SOURCE_ALLOWED_HOSTS (Vergleich in Kleinbuchstaben) */
export function isHostAllowed(url: string, allowed: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((a) => a.toLowerCase() === host);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Quellbezeichnung ohne Query-Parameter (könnten Zugangsdaten enthalten) */
export function sourceNameOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'api';
  }
}

type ApiFailure = 'source_unreachable' | 'invalid_response' | 'too_many_rows';

export type ApiFetchResult =
  | { ok: true; items: unknown[]; sha256: string; size: number; pages: number; truncated: boolean }
  | { ok: false; code: ApiFailure; params: IssueParams; sha256: string; size: number };

/** Antwortkörper lesen, höchstens budget Bytes (bricht beim Überschreiten ab, statt alles zu laden) */
async function readBody(res: Response, budget: number): Promise<Uint8Array | null> {
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
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export async function fetchApiItems(
  fetchFn: Deps['fetch'],
  config: HttpApiConfig,
  secret: string | null,
  opts: { maxPages?: number; allowInsecureHttp?: boolean } = {},
): Promise<ApiFetchResult> {
  // Absicherung: Aufrufer prüfen vorher mit checkSource (Audit, verständlicher Fehler)
  if (sendsSecret(config, secret) && !secureTransport(config.url, opts.allowInsecureHttp ?? false)) {
    throw new Error('refusing to send source credentials over insecure transport');
  }
  const hash = createHash('sha256');
  let size = 0;
  const items: unknown[] = [];
  const pg = config.pagination;
  const maxPages = Math.min(opts.maxPages ?? Number.POSITIVE_INFINITY, pg.type === 'none' ? 1 : pg.maxPages);
  let page = pg.type === 'page' ? pg.firstPage : 0;
  let cursor: string | null = null;
  let pages = 0;
  let done = false;

  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'osp-data-mesh' };
  if (secret) {
    if (config.auth.type === 'bearer') headers.authorization = `Bearer ${secret}`;
    else if (config.auth.type === 'header') headers[config.auth.headerName] = secret;
  }
  const fail = (code: ApiFailure, params: IssueParams): ApiFetchResult => ({
    ok: false,
    code,
    params,
    sha256: hash.copy().digest('hex'),
    size,
  });

  while (pages < maxPages) {
    const url = new URL(config.url);
    for (const [k, v] of Object.entries(config.query)) url.searchParams.set(k, v);
    if (pg.type === 'page') {
      url.searchParams.set(pg.pageParam, String(page));
      if (pg.sizeParam) url.searchParams.set(pg.sizeParam, String(pg.pageSize));
    } else if (pg.type === 'cursor' && cursor !== null) {
      url.searchParams.set(pg.cursorParam, cursor);
    }

    let res: Response;
    try {
      res = await fetchFn(url.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      return fail('source_unreachable', { reason: name === 'TimeoutError' ? 'timeout' : 'network' });
    }
    if (res.status < 200 || res.status > 299) {
      await res.body?.cancel().catch(() => {});
      return fail('source_unreachable', { status: res.status });
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readBody(res, MAX_API_BYTES - size);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      return fail('source_unreachable', { reason: name === 'TimeoutError' ? 'timeout' : 'network' });
    }
    if (!bytes) return fail('invalid_response', { reason: 'too_large' });
    pages++;
    size += bytes.byteLength;
    hash.update(bytes);

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch {
      return fail('invalid_response', { reason: 'not_json' });
    }
    const pageItems = getPath(json, config.itemsPath);
    if (!Array.isArray(pageItems)) return fail('invalid_response', { reason: 'items_not_array' });
    // vor dem Übernehmen prüfen; kein Spread (große Seiten würden den Aufrufstapel sprengen)
    if (items.length + pageItems.length > MAX_SOURCE_ROWS)
      return fail('too_many_rows', { max: MAX_SOURCE_ROWS });
    for (const item of pageItems) items.push(item);

    if (pg.type === 'none') {
      done = true;
      break;
    }
    if (pg.type === 'page') {
      if (pageItems.length === 0 || (pg.sizeParam && pageItems.length < pg.pageSize)) {
        done = true;
        break;
      }
      page++;
    } else {
      const next = getPath(json, pg.nextCursorPath);
      if (next === null || next === undefined || next === '' || pageItems.length === 0) {
        done = true;
        break;
      }
      cursor = String(next);
    }
  }
  return { ok: true, items, sha256: hash.digest('hex'), size, pages, truncated: !done };
}
