import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from '../../src/server/app.ts';
import type { AppEnv, Module } from '../../src/server/core/deps.ts';
import { allModules } from '../../src/server/modules/index.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';

interface ErrorJson {
  error: { code: string; requestId: string; reason?: string; fields?: Record<string, string> };
}

const SECRET_DETAIL = 'geheimes internes Detail 4711';

/** Testmodul mit Routen, die unerwartete Fehler werfen */
const failingModule: Module = {
  name: 'failing',
  routes(app) {
    app.get('/api/v1/test/boom', () => {
      throw new Error(SECRET_DETAIL);
    });
    app.post('/api/v1/test/boom-async', async () => {
      await Bun.sleep(1);
      throw new TypeError(`${SECRET_DETAIL} (async)`);
    });
  },
};

let node: TestNode;
let app: Hono<AppEnv>;
let admin: TestUser;

beforeAll(async () => {
  node = await createTestNode();
  app = createApp(node.deps, [...allModules, failingModule]);
  admin = await node.user(['admin']);
});
afterAll(async () => {
  await node?.close();
});

async function call(
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> } = {},
) {
  const res = await app.request(path, { method, body: init.body, headers: init.headers });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as ErrorJson, headers: res.headers };
}

describe('Fehlerbehandlung', () => {
  test('Validierungsfehler → 400 mit Feldcodes und Request-ID, ohne zod-Meldungstext', async () => {
    const r = await node.request<ErrorJson>('POST', '/api/v1/users', {
      as: admin,
      body: { email: 'keine-mail', displayName: '', roles: ['kaiser'], password: 'x' },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation_failed');
    expect(r.json.error.requestId).toBe(r.headers.get('x-request-id')!);
    expect(r.json.error.fields).toMatchObject({
      'body.email': 'invalid_format',
      'body.displayName': 'too_small',
      'body.roles.0': 'invalid_value',
      'body.password': 'too_small',
    });
    expect(r.text).not.toMatch(/Invalid (input|email|option)|[Ee]xpected|Too small|must (have|be)|message/);
    expect(Object.keys(r.json)).toEqual(['error']);
  });

  test('Validierung von Pfad- und Query-Parametern', async () => {
    const p = await node.request<ErrorJson>('PATCH', '/api/v1/users/keine-uuid', { as: admin, body: {} });
    expect(p.status).toBe(400);
    expect(p.json.error.fields).toEqual({ 'params.id': 'invalid_format' });
    const q = await node.request<ErrorJson>('GET', '/api/v1/system/errors?page=0', { as: admin });
    expect(q.status).toBe(400);
    expect(q.json.error.fields?.['query.page']).toBe('too_small');
  });

  test('Request-ID aus dem Header wird übernommen (nur gültiges Format)', async () => {
    const ok = await node.request<ErrorJson>('GET', '/api/v1/gibt-es-nicht', {
      headers: { 'x-request-id': 'trace-12345678' },
    });
    expect(ok.json.error.requestId).toBe('trace-12345678');
    const bad = await node.request<ErrorJson>('GET', '/api/v1/gibt-es-nicht', {
      headers: { 'x-request-id': 'x<script>' },
    });
    expect(bad.json.error.requestId).not.toBe('x<script>');
  });

  test('unbekannte Route → 404 not_found', async () => {
    const r = await node.request<ErrorJson>('GET', '/api/v1/gibt-es-nicht');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
    expect(r.json.error.requestId).toBeTruthy();
    const post = await node.request<ErrorJson>('DELETE', '/api/v1/users');
    expect(post.status).toBe(404);
  });

  test('unerwarteter Fehler → 500 internal_error ohne Details; Eintrag in app_error, sichtbar unter system.errors', async () => {
    const r = await call('GET', '/api/v1/test/boom', { headers: { 'x-request-id': 'boom-request-0001' } });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: { code: 'internal_error', requestId: 'boom-request-0001' } });
    expect(r.text).not.toContain(SECRET_DETAIL);
    expect(r.text).not.toContain('Error');

    const a = await call('POST', '/api/v1/test/boom-async');
    expect(a.status).toBe(500);
    expect(a.text).not.toContain(SECRET_DETAIL);

    const row = await node.deps.db
      .selectFrom('app_error')
      .selectAll()
      .where('request_id', '=', 'boom-request-0001')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: 500,
      code: 'internal_error',
      method: 'GET',
      path: '/api/v1/test/boom',
    });
    expect(row.message).toContain(SECRET_DETAIL);

    const list = await node.request<{
      items: { requestId: string; status: number; code: string; path: string }[];
      total: number;
    }>('GET', '/api/v1/system/errors', { as: admin });
    expect(list.status).toBe(200);
    expect(list.json.total).toBeGreaterThanOrEqual(2);
    const item = list.json.items.find((i) => i.requestId === 'boom-request-0001');
    expect(item).toMatchObject({ status: 500, code: 'internal_error', path: '/api/v1/test/boom' });
    // die Fehlermeldung selbst wird nicht über die API ausgeliefert
    expect(list.text).not.toContain(SECRET_DETAIL);

    const status = await node.request<{ errors24h: number }>('GET', '/api/v1/system/status', { as: admin });
    expect(status.json.errors24h).toBeGreaterThanOrEqual(2);
  });

  test('zu großer Body → 413 payload_too_large', async () => {
    const big = JSON.stringify({ email: 'a@b.de', password: 'x'.repeat(1024 * 1024 + 10) });
    const r = await node.request<ErrorJson>('POST', '/api/v1/auth/login', {
      body: JSON.parse(big),
    });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('payload_too_large');
    // auch ohne Content-Length (gestreamter Body)
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const s = await call('POST', '/api/v1/auth/login', {
      body: stream,
      headers: { 'content-type': 'application/json', 'x-osp-csrf': '1' },
    });
    expect(s.status).toBe(413);
  });

  test('fehlerhaftes JSON → 400 validation_failed (body: invalid_json)', async () => {
    const r = await call('POST', '/api/v1/auth/login', {
      body: '{"email": "a@b.de", "password": ',
      headers: { 'content-type': 'application/json', 'x-osp-csrf': '1' },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation_failed');
    expect(r.json.error.fields).toEqual({ body: 'invalid_json' });
    expect(r.text).not.toMatch(/SyntaxError|Unexpected|JSON Parse/i);
  });

  test('Fehlerprotokoll nur für admin', async () => {
    const auditor = await node.user(['auditor']);
    expect((await node.request('GET', '/api/v1/system/errors', { as: auditor })).status).toBe(403);
  });
});

describe('Betrieb', () => {
  test('health.live und health.ready', async () => {
    const live = await node.request<{ status: string }>('GET', '/healthz');
    expect(live.status).toBe(200);
    expect(live.json).toEqual({ status: 'ok' });
    const ready = await node.request<{ status: string; db: boolean; schema: boolean }>('GET', '/readyz');
    expect(ready.status).toBe(200);
    expect(ready.json).toEqual({ status: 'ok', db: true, schema: true });
  });

  test('system.status liefert alle Bereiche', async () => {
    const r = await node.request<Record<string, unknown>>('GET', '/api/v1/system/status', { as: admin });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      version: expect.any(String),
      node: { nodeId: node.nodeId, fingerprint: node.deps.identity.fingerprint, baseUrl: node.baseUrl },
      db: { ok: true, latestMigration: expect.stringMatching(/^\d{4}_/), migrations: expect.any(Number) },
      audit: { ok: true, firstBrokenSeq: null },
      backups: { intervalHours: 24, encrypted: true },
      outbox: { pending: 0, failed: 0 },
      bi: { views: 0, errors: 0 },
    });
  });

  test('OpenAPI-Dokument ist öffentlich und enthält alle Vertragsrouten', async () => {
    const r = await node.request<{
      openapi: string;
      paths: Record<string, Record<string, { operationId: string; security: unknown[] }>>;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
    }>('GET', '/api/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(r.json.openapi).toBe('3.1.0');
    expect(r.json.paths['/api/v1/users/{id}']?.patch?.operationId).toBe('usersUpdate');
    expect(r.json.paths['/api/v1/auth/login']?.post?.security).toEqual([{ csrfHeader: [] }]);
    expect(r.json.paths['/healthz']?.get?.security).toEqual([]);
    expect(Object.keys(r.json.components.securitySchemes).sort()).toEqual([
      'bearerToken',
      'csrfHeader',
      'sessionCookie',
    ]);
    expect(r.json.components.schemas.Error).toBeDefined();
    const { routes } = await import('../../src/shared/contract/index.ts');
    const ops = Object.values(r.json.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(ops.length).toBe(Object.keys(routes).length + 1);
  });
});
