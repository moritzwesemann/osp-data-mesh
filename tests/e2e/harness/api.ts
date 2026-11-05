/**
 * HTTP-Client der E2E-Umgebung für Aufbau und Prüfungen über die echte API (wie ein echter Client:
 * Anmeldung, Sitzungs-Cookie, X-OSP-CSRF). Schreibt nie direkt in die Datenbanken der Knoten.
 */
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '../../..');

export interface ApiResult<T> {
  status: number;
  json: T;
  text: string;
  headers: Headers;
}

export class ApiClient {
  private cookie: string | null = null;

  constructor(
    readonly baseUrl: string,
    readonly label: string,
  ) {}

  async call<T = unknown>(
    method: string,
    path: string,
    opts: { body?: unknown; form?: FormData } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.cookie) headers.cookie = `osp_session=${this.cookie}`;
    if (method !== 'GET') headers['x-osp-csrf'] = '1';
    let body: FormData | string | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    for (const c of res.headers.getSetCookie()) {
      const m = /^osp_session=([^;]*)/.exec(c);
      if (m) this.cookie = m[1] ? m[1] : null;
    }
    const text = await res.text();
    let json: unknown = null;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json: json as T, text, headers: res.headers };
  }

  /** Erwartet HTTP 200 und liefert den JSON-Body */
  async ok<T>(method: string, path: string, opts: { body?: unknown; form?: FormData } = {}): Promise<T> {
    const r = await this.call<T>(method, path, opts);
    if (r.status !== 200) {
      throw new Error(`${this.label}: ${method} ${path} → HTTP ${r.status} ${r.text.slice(0, 400)}`);
    }
    return r.json;
  }

  async login(email: string, password: string): Promise<{ mustChangePassword: boolean }> {
    const r = await this.ok<{ user: { mustChangePassword: boolean } }>('POST', '/api/v1/auth/login', {
      body: { email, password },
    });
    return r.user;
  }
}

/** Multipart-Formular mit einer Datei aus fixtures/ im Feld "file" */
export function fixtureForm(rel: string): FormData {
  const bytes = new Uint8Array(readFileSync(join(ROOT, 'fixtures', rel)));
  const form = new FormData();
  form.append('file', new File([bytes], basename(rel), { type: 'text/csv' }));
  return form;
}
