/**
 * Abruf von API-Quellen (JSON über HTTP): Host-Freigabeliste (SSRF-Schutz), Authentifizierung,
 * Seitenweise Abfrage, Zeitlimit, Größenbegrenzung. Keine Weiterleitungen (könnten die Freigabeliste umgehen).
 */
import { createHash } from 'node:crypto';
import type { HttpApiConfig } from '../../../shared/contract/connectors.ts';
import type { Deps } from '../../core/deps.ts';
import { getPath } from './pipeline.ts';
import type { IssueParams } from './validate.ts';

export const MAX_API_BYTES = 50 * 1024 * 1024;
export const MAX_SOURCE_ROWS = 100_000;

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

export type ApiFetchResult =
  | { ok: true; items: unknown[]; sha256: string; size: number; pages: number; truncated: boolean }
  | {
      ok: false;
      code: 'source_unreachable' | 'invalid_response';
      params: IssueParams;
      sha256: string;
      size: number;
    };

export async function fetchApiItems(
  fetchFn: Deps['fetch'],
  config: HttpApiConfig,
  secret: string | null,
  opts: { maxPages?: number } = {},
): Promise<ApiFetchResult> {
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
  const fail = (code: 'source_unreachable' | 'invalid_response', params: IssueParams): ApiFetchResult => ({
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
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      const name = (err as { name?: string })?.name;
      return fail('source_unreachable', { reason: name === 'TimeoutError' ? 'timeout' : 'network' });
    }
    pages++;
    size += bytes.byteLength;
    hash.update(bytes);
    if (size > MAX_API_BYTES) return fail('invalid_response', { reason: 'too_large' });

    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    } catch {
      return fail('invalid_response', { reason: 'not_json' });
    }
    const pageItems = getPath(json, config.itemsPath);
    if (!Array.isArray(pageItems)) return fail('invalid_response', { reason: 'items_not_array' });
    items.push(...pageItems);
    if (items.length > MAX_SOURCE_ROWS) return fail('invalid_response', { reason: 'too_many_items' });

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
