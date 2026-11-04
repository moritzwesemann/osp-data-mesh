/**
 * Typisierter HTTP-Client, abgeleitet aus dem Vertrag (src/shared/contract).
 * Baut URL (Pfadparameter, Query), Body (JSON oder FormData), sendet CSRF-Header bei
 * zustandsändernden Anfragen und wirft bei Fehlern immer einen ApiError.
 */
import {
  type RouteClientInput,
  type RouteId,
  type RouteResponse,
  type Routes,
  routes,
} from '../../shared/contract/index.ts';

export type ApiInput<K extends RouteId> = RouteClientInput<Routes[K]>;
export type ApiOutput<K extends RouteId> = RouteResponse<Routes[K]>;

/** Codes, die nur im Client entstehen (keine Server-Antwort). */
export type ClientErrorCode = 'network_error' | 'unexpected_response';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly reason: string | undefined;
  readonly fields: Record<string, string> | undefined;

  constructor(init: {
    status: number;
    code: string;
    requestId?: string | null;
    reason?: string;
    fields?: Record<string, string>;
  }) {
    super(init.code);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.reason = init.reason;
    this.fields = init.fields;
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError({ status: 0, code: 'unexpected_response' });
}

// ---------------------------------------------------------------------------------------------
// Globale Reaktionen auf Sitzungsende und erzwungenen Passwortwechsel
// ---------------------------------------------------------------------------------------------

interface AuthHandlers {
  onUnauthenticated: () => void;
  onPasswordChangeRequired: () => void;
}
let authHandlers: AuthHandlers | null = null;

export function setAuthHandlers(h: AuthHandlers): void {
  authHandlers = h;
}

function notifyAuth(id: RouteId, err: ApiError): void {
  if (!authHandlers) return;
  if (err.status === 401 && err.code === 'unauthenticated' && !id.startsWith('auth.')) {
    authHandlers.onUnauthenticated();
  } else if (err.status === 403 && err.reason === 'password_change_required') {
    authHandlers.onPasswordChangeRequired();
  }
}

// ---------------------------------------------------------------------------------------------
// URL und Body
// ---------------------------------------------------------------------------------------------

type LooseInput = {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
};

export function buildUrl(id: RouteId, input: LooseInput | undefined): string {
  const def = routes[id];
  const params = input?.params ?? {};
  const path = def.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || v === '')
      throw new Error(`missing path parameter ${name} for ${id}`);
    return encodeURIComponent(String(v));
  });
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(input?.query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

function hasEntries(fd: FormData): boolean {
  for (const _ of fd.keys()) return true;
  return false;
}

async function parseError(res: Response): Promise<ApiError> {
  const headerId = res.headers.get('x-request-id');
  try {
    const json: unknown = await res.json();
    if (json && typeof json === 'object' && 'error' in json) {
      const e = (json as { error: Record<string, unknown> }).error;
      return new ApiError({
        status: res.status,
        code: typeof e.code === 'string' ? e.code : 'unexpected_response',
        requestId: typeof e.requestId === 'string' ? e.requestId : headerId,
        reason: typeof e.reason === 'string' ? e.reason : undefined,
        fields: e.fields && typeof e.fields === 'object' ? (e.fields as Record<string, string>) : undefined,
      });
    }
  } catch {
    // kein JSON (z. B. Proxy-Fehlerseite)
  }
  return new ApiError({
    status: res.status,
    code: res.status >= 500 ? 'internal_error' : 'unexpected_response',
    requestId: headerId,
  });
}

async function send(id: RouteId, url: string, body: unknown, accept: string): Promise<Response> {
  const def = routes[id];
  const headers: Record<string, string> = { accept };
  let payload: BodyInit | undefined;
  if (def.method !== 'GET') {
    headers['x-osp-csrf'] = '1';
    if (body instanceof FormData) {
      if (hasEntries(body)) payload = body;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  let res: Response;
  try {
    res = await fetch(url, { method: def.method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError({ status: 0, code: 'network_error' });
  }
  if (!res.ok) {
    const err = await parseError(res);
    notifyAuth(id, err);
    throw err;
  }
  return res;
}

/** Ruft eine Vertragsroute auf und liefert die typisierte JSON-Antwort. */
export async function api<K extends RouteId>(id: K, input: ApiInput<K>): Promise<ApiOutput<K>> {
  const loose = input as LooseInput;
  const res = await send(id, buildUrl(id, loose), loose.body, 'application/json');
  if (res.status === 204) return undefined as ApiOutput<K>;
  try {
    return (await res.json()) as ApiOutput<K>;
  } catch {
    throw new ApiError({
      status: res.status,
      code: 'unexpected_response',
      requestId: res.headers.get('x-request-id'),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------------

export type DownloadRouteId = 'access.data' | 'received.rows' | 'audit.export';

function fileNameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // ignorieren
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain?.[1] ?? fallback;
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function saveJson(value: unknown, fileName: string): void {
  saveBlob(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }), fileName);
}

/** Lädt einen Export (format=csv|xml|json) als Datei herunter. */
export async function downloadFile<K extends DownloadRouteId>(
  id: K,
  input: ApiInput<K>,
  fallbackName: string,
): Promise<void> {
  const loose = input as LooseInput;
  const res = await send(id, buildUrl(id, loose), undefined, '*/*');
  const blob = await res.blob();
  saveBlob(blob, fileNameFrom(res, fallbackName));
}

/** Absolute URL einer Route (z. B. für Code-Beispiele mit API-Token). */
export function absoluteUrl<K extends RouteId>(id: K, input: ApiInput<K>): string {
  return new URL(buildUrl(id, input as LooseInput), window.location.origin).toString();
}
