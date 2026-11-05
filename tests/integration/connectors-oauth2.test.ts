/**
 * API-Quellen mit OAuth 2.0 Client Credentials gegen einen echten HTTP-Mock (Bun.serve auf 127.0.0.1,
 * Port 4471–4479): Token-Abruf, Zwischenspeicher bis kurz vor Ablauf, einmalige Erneuerung nach 401,
 * falsches Geheimnis, Freigabeliste und HTTPS-Regel für den Token-Endpunkt, Bindung des Geheimnisses.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createMockMeasurementApi } from '../../scripts/mock-measurement-api.ts';
import type { Connector } from '../../src/shared/contract/connectors.ts';
import {
  auditEntries,
  commitRun,
  fileForm,
  importTemplate,
  type RunDetail,
  startImport,
} from '../helpers/integration.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';

const CLIENT_ID = 'osp-nord client';
const CLIENT_SECRET = 'geheim:mit+sonderzeichen&=';
const INTERNAL = 'mock-intern';

interface TokenRequest {
  authorization: string | null;
  contentType: string | null;
  form: Record<string, string>;
}

/** OAuth2-Mock: Token-Endpunkt und Messwerte (Daten aus dem Mock-Messsystem der Demo) */
const mock = {
  issued: new Set<string>(),
  counter: 0,
  expiresIn: 3600 as number | undefined,
  /** Datenendpunkt lehnt jedes Token ab */
  rejectAll: false,
  /** eigene Antwort des Token-Endpunkts */
  tokenOverride: null as null | (() => Response | Promise<Response>),
  tokenRequests: [] as TokenRequest[],
  dataRequests: [] as { path: string; authorization: string | null }[],
  reset() {
    this.expiresIn = 3600;
    this.rejectAll = false;
    this.tokenOverride = null;
    this.tokenRequests.length = 0;
    this.dataRequests.length = 0;
  },
};

let server: ReturnType<typeof Bun.serve>;
let base = '';
let node: TestNode;
let steward: TestUser;
let clockOffsetMs = 0;

function credentialsOf(req: TokenRequest): { id: string; secret: string } | null {
  if (req.authorization?.startsWith('Basic ')) {
    const [id = '', secret = ''] = Buffer.from(req.authorization.slice(6), 'base64')
      .toString('utf8')
      .split(':');
    const dec = (s: string) => decodeURIComponent(s.replace(/\+/g, ' '));
    return { id: dec(id), secret: dec(secret) };
  }
  if (req.form.client_id !== undefined)
    return { id: req.form.client_id, secret: req.form.client_secret ?? '' };
  return null;
}

async function startMock(): Promise<void> {
  const measurements = createMockMeasurementApi({ token: INTERNAL });
  for (let port = 4471; port <= 4479; port++) {
    try {
      server = Bun.serve({
        hostname: '127.0.0.1',
        port,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/oauth2/token' || url.pathname === '/oauth2/other') {
            const tr: TokenRequest = {
              authorization: req.headers.get('authorization'),
              contentType: req.headers.get('content-type'),
              form: Object.fromEntries(new URLSearchParams(await req.text())),
            };
            mock.tokenRequests.push(tr);
            if (mock.tokenOverride) return mock.tokenOverride();
            const c = credentialsOf(tr);
            if (req.method !== 'POST' || tr.form.grant_type !== 'client_credentials') {
              return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
            }
            if (!c || c.id !== CLIENT_ID || c.secret !== CLIENT_SECRET) {
              return Response.json(
                { error: 'invalid_client', error_description: '<b>Freitext vom Server</b>' },
                { status: 401 },
              );
            }
            const token = `tok-${++mock.counter}`;
            mock.issued.add(token);
            return Response.json({
              access_token: token,
              token_type: 'Bearer',
              ...(mock.expiresIn === undefined ? {} : { expires_in: mock.expiresIn }),
            });
          }
          if (url.pathname.startsWith('/v1/')) {
            const authorization = req.headers.get('authorization');
            mock.dataRequests.push({ path: url.pathname, authorization });
            const token = authorization?.replace(/^Bearer /, '') ?? '';
            if (mock.rejectAll || !mock.issued.has(token)) {
              return Response.json({ error: 'invalid_token' }, { status: 401 });
            }
            return measurements(new Request(req.url, { headers: { authorization: `Bearer ${INTERNAL}` } }));
          }
          return new Response('not found', { status: 404 });
        },
      });
      base = `http://127.0.0.1:${port}`;
      return;
    } catch {
      // Port belegt: nächsten versuchen
    }
  }
  throw new Error('no free port in 4471-4479');
}

beforeAll(async () => {
  await startMock();
  node = await createTestNode({
    nodeId: 'osp-oauth-test',
    now: () => new Date(Date.now() + clockOffsetMs),
    config: {
      // freigegeben: Mock (Loopback, daher auch über http mit Geheimnis) und ein http-Host ohne TLS
      MESH_SOURCE_ALLOWED_HOSTS: `${new URL(base).host},auth.mesh.test`,
    },
  });
  steward = await node.user(['data_steward']);
  // Personen der Messwerte (Kennungen NORD-…)
  const athletes = await importTemplate(node, steward, 'athleten-stammdaten-csv');
  const run = await startImport(node, steward, athletes.id, fileForm('osp-nord/athleten.csv'));
  await commitRun(node, steward, run.run.id);
});

afterAll(async () => {
  server?.stop(true);
  await node?.close();
});

beforeEach(() => {
  mock.reset();
  mock.issued.clear();
});

async function oauthConnector(
  slug: string,
  auth: Record<string, unknown> = {},
  secret: string | null = CLIENT_SECRET,
): Promise<Connector> {
  const c = await importTemplate(node, steward, 'sprungkraft-oauth2-api', (def) => {
    def.connector.slug = slug;
    if (
      def.connector.config.type === 'http_api' &&
      def.connector.config.auth.type === 'oauth2_client_credentials'
    ) {
      def.connector.config.url = `${base}/v1/measurements`;
      def.connector.config.auth = {
        ...def.connector.config.auth,
        tokenUrl: `${base}/oauth2/token`,
        clientId: CLIENT_ID,
        ...auth,
      };
    }
  });
  if (secret !== null) {
    const r = await node.request('PUT', `/api/v1/connectors/${c.id}/secret`, {
      as: steward,
      body: { secret },
    });
    expect(r.status).toBe(200);
  }
  return (await node.request<Connector>('GET', `/api/v1/connectors/${c.id}`, { as: steward })).json;
}

async function run(c: Connector): Promise<RunDetail> {
  return startImport(node, steward, c.id);
}

async function errorsOf(runId: string) {
  const r = await node.request<{ items: { code: string; params: Record<string, unknown> }[] }>(
    'GET',
    `/api/v1/import-runs/${runId}/errors?pageSize=50`,
    { as: steward },
  );
  return r.json.items;
}

describe('Token-Abruf und Import', () => {
  let c: Connector;

  test('Vorlage mit OAuth2: Client-Geheimnis verschlüsselt gespeichert, nie ausgegeben', async () => {
    c = await oauthConnector('oauth-messsystem');
    expect(c).toMatchObject({
      kind: 'http_api',
      hasSecret: true,
      config: {
        auth: {
          type: 'oauth2_client_credentials',
          tokenUrl: `${base}/oauth2/token`,
          clientId: CLIENT_ID,
          scope: 'measurements.read',
          clientAuth: 'basic',
        },
      },
    });
    const all = await node.request('GET', '/api/v1/connectors', { as: steward });
    const exp = await node.request('GET', `/api/v1/connectors/${c.id}/export`, { as: steward });
    for (const r of [all, exp]) expect(r.text).not.toContain(CLIENT_SECRET);
    const row = await node.deps.db
      .selectFrom('connector')
      .select('secret_enc')
      .where('id', '=', c.id)
      .executeTakeFirstOrThrow();
    expect(row.secret_enc).not.toContain(CLIENT_SECRET);
  });

  test('erster Import: Token per HTTP-Basic, alle Seiten mit Bearer-Token; Geheimnis nur beim Token-Endpunkt', async () => {
    const r = await run(c);
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 123, validRows: 120, errorRows: 3 });
    expect(mock.tokenRequests.length).toBe(1);
    const tr = mock.tokenRequests[0]!;
    expect(tr.contentType).toBe('application/x-www-form-urlencoded');
    expect(tr.form).toEqual({ grant_type: 'client_credentials', scope: 'measurements.read' });
    expect(credentialsOf(tr)).toEqual({ id: CLIENT_ID, secret: CLIENT_SECRET });
    expect(mock.dataRequests.length).toBe(3);
    expect(new Set(mock.dataRequests.map((d) => d.authorization))).toEqual(new Set(['Bearer tok-1']));
    expect(JSON.stringify(mock.dataRequests)).not.toContain(CLIENT_SECRET);
    // weder Token noch Geheimnis in Lauf, Fehlerprotokoll oder Audit
    const dump = JSON.stringify([
      await node.deps.db.selectFrom('import_run').selectAll().execute(),
      await node.deps.db.selectFrom('import_error').selectAll().execute(),
      await node.deps.db.selectFrom('audit_log').select('details').execute(),
    ]);
    expect(dump).not.toContain('tok-1');
    expect(dump).not.toContain(CLIENT_SECRET);
  });

  test('zweiter Import: Token aus dem Zwischenspeicher (kein neuer Token-Abruf)', async () => {
    mock.issued.add('tok-1');
    const r = await run(c);
    expect(r.run.status).toBe('previewed');
    expect(mock.tokenRequests.length).toBe(0);
    expect(mock.dataRequests.every((d) => d.authorization === 'Bearer tok-1')).toBe(true);
  });

  test('kurz vor Ablauf (Sicherheitsabstand 60 s) wird ein neues Token geholt', async () => {
    mock.issued.add('tok-1');
    clockOffsetMs = (3600 - 61) * 1000;
    expect((await run(c)).run.status).toBe('previewed');
    expect(mock.tokenRequests.length).toBe(0);
    clockOffsetMs = (3600 - 59) * 1000;
    expect((await run(c)).run.status).toBe('previewed');
    expect(mock.tokenRequests.length).toBe(1);
    expect(mock.dataRequests.at(-1)!.authorization).toBe(`Bearer tok-${mock.counter}`);
    clockOffsetMs = 0;
  });

  test('401 der Datenquelle (Token serverseitig widerrufen): einmal neues Token, dann Erfolg', async () => {
    // Zwischenspeicher hält ein Token, das der Mock nicht mehr kennt
    const r = await run(c);
    expect(r.run).toMatchObject({ status: 'previewed', totalRows: 123 });
    expect(mock.tokenRequests.length).toBe(1);
    expect(mock.dataRequests[0]!.authorization).not.toBe(mock.dataRequests[1]!.authorization);
    expect(mock.dataRequests.map((d) => d.authorization)).toEqual([
      expect.stringMatching(/^Bearer tok-/),
      `Bearer tok-${mock.counter}`,
      `Bearer tok-${mock.counter}`,
      `Bearer tok-${mock.counter}`,
    ]);
  });

  test('401 auch mit neuem Token: genau eine Erneuerung, Lauf schlägt mit HTTP-Status fehl', async () => {
    mock.rejectAll = true;
    const r = await run(c);
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'source_unreachable' });
    expect(mock.tokenRequests.length).toBe(1);
    expect(mock.dataRequests.length).toBe(2);
    expect(await errorsOf(r.run.id)).toEqual([
      expect.objectContaining({ code: 'source_unreachable', params: { status: 401 } }),
    ]);
  });

  test('ohne expires_in: Token gilt 5 Minuten (mit Sicherheitsabstand)', async () => {
    mock.expiresIn = undefined;
    const p = await node.request('PATCH', `/api/v1/connectors/${c.id}`, {
      as: steward,
      body: {
        config: {
          ...c.config,
          auth: { ...(c.config as { auth: object }).auth, scope: 'measurements.read all' },
        },
      },
    });
    expect(p.status).toBe(200);
    // Scope geändert: Geheimnis bleibt (gleiches Ziel), Token wird neu geholt
    expect(
      (await node.request<Connector>('GET', `/api/v1/connectors/${c.id}`, { as: steward })).json.hasSecret,
    ).toBe(true);
    expect((await run(c)).run.status).toBe('previewed');
    expect(mock.tokenRequests.map((t) => t.form.scope)).toEqual(['measurements.read all']);
    clockOffsetMs = 239 * 1000;
    expect((await run(c)).run.status).toBe('previewed');
    expect(mock.tokenRequests.length).toBe(1);
    clockOffsetMs = 241 * 1000;
    expect((await run(c)).run.status).toBe('previewed');
    expect(mock.tokenRequests.length).toBe(2);
    clockOffsetMs = 0;
  });

  test('Beispielabruf (inspect) mit gespeichertem Geheimnis nutzt den Zwischenspeicher des Connectors', async () => {
    const before = mock.tokenRequests.length;
    const form = new FormData();
    form.append('connectorId', c.id);
    form.append('config', JSON.stringify(c.config));
    const r = await node.request<{ columns: string[] }>('POST', '/api/v1/connectors/inspect', {
      as: steward,
      form,
    });
    expect(r.status).toBe(200);
    expect(r.json.columns).toContain('measurement_id');
    expect(mock.tokenRequests.length).toBe(before + 1);
    const again = await node.request('POST', '/api/v1/connectors/inspect', { as: steward, form });
    expect(again.status).toBe(200);
    expect(mock.tokenRequests.length).toBe(before + 1);
  });
});

describe('Fehler und Abweisungen', () => {
  test('falsches Client-Geheimnis: Lauf fehlgeschlagen (oauth_invalid_client), keine Datenanfrage, kein Server-Freitext', async () => {
    const c = await oauthConnector('oauth-falsch', {}, 'falsches-geheimnis');
    const r = await run(c);
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'source_unreachable', totalRows: 0 });
    expect(await errorsOf(r.run.id)).toEqual([
      expect.objectContaining({
        code: 'source_unreachable',
        params: { status: 401, reason: 'oauth_invalid_client' },
      }),
    ]);
    expect(mock.dataRequests.length).toBe(0);
    const form = new FormData();
    form.append('connectorId', c.id);
    const i = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      '/api/v1/connectors/inspect',
      {
        as: steward,
        form,
      },
    );
    expect(i.status).toBe(502);
    expect(i.json.error).toMatchObject({ code: 'source_unreachable', reason: 'oauth_invalid_client' });
    expect(i.text).not.toContain('Freitext');
  });

  test('ohne hinterlegtes Client-Geheimnis: kein Token-Abruf (secret_missing)', async () => {
    const c = await oauthConnector('oauth-ohne', {}, null);
    const r = await run(c);
    expect(r.run).toMatchObject({ status: 'failed', failureCode: 'source_unreachable' });
    expect(await errorsOf(r.run.id)).toEqual([
      expect.objectContaining({ params: { reason: 'secret_missing' } }),
    ]);
    expect(mock.tokenRequests.length + mock.dataRequests.length).toBe(0);
  });

  test('Token-Endpunkt nicht in MESH_SOURCE_ALLOWED_HOSTS: abgewiesen, protokolliert, keine Anfrage', async () => {
    const c = await oauthConnector('oauth-fremd', { tokenUrl: 'https://login.fremd.example/oauth2/token' });
    const r = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      `/api/v1/connectors/${c.id}/runs`,
      {
        as: steward,
      },
    );
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'source_not_allowed', reason: 'token_url_not_allowed' });
    const audit = (await auditEntries(node, 'import.start'))[0]!;
    expect(audit).toMatchObject({ outcome: 'denied', object_id: c.id });
    expect(audit.details).toMatchObject({ reason: 'token_url_not_allowed', host: 'login.fremd.example' });
    // Beispielabruf mit einmaligem Geheimnis und fremdem Token-Endpunkt ebenso
    const form = new FormData();
    form.append('config', JSON.stringify(c.config));
    form.append('secret', CLIENT_SECRET);
    const i = await node.request<{ error: { reason: string } }>('POST', '/api/v1/connectors/inspect', {
      as: steward,
      form,
    });
    expect(i.status).toBe(400);
    expect(i.json.error.reason).toBe('token_url_not_allowed');
    expect(mock.tokenRequests.length + mock.dataRequests.length).toBe(0);
  });

  test('Token-Endpunkt über unverschlüsseltes http (kein Loopback): Geheimnis wird nicht gesendet', async () => {
    const c = await oauthConnector('oauth-http', { tokenUrl: 'http://auth.mesh.test/oauth2/token' });
    const r = await node.request<{ error: { code: string; reason: string } }>(
      'POST',
      `/api/v1/connectors/${c.id}/runs`,
      {
        as: steward,
      },
    );
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'source_not_allowed', reason: 'insecure_http' });
    const audit = (await auditEntries(node, 'import.start'))[0]!;
    expect(audit.details).toMatchObject({ reason: 'insecure_http', host: 'auth.mesh.test' });
  });

  test('Token-Endpunkt ändern verwirft das gespeicherte Geheimnis (sonst ließe es sich umleiten)', async () => {
    const c = await oauthConnector('oauth-umleiten');
    const cfg = c.config as { auth: Record<string, unknown> };
    const p = await node.request<Connector>('PATCH', `/api/v1/connectors/${c.id}`, {
      as: steward,
      body: { config: { ...c.config, auth: { ...cfg.auth, tokenUrl: `${base}/oauth2/other` } } },
    });
    expect(p.status).toBe(200);
    expect(p.json.hasSecret).toBe(false);
    const cleared = (await auditEntries(node, 'connector.secret_cleared'))[0]!;
    expect(cleared).toMatchObject({ object_id: c.id });
    const id = await node.request<Connector>('PATCH', `/api/v1/connectors/${c.id}`, {
      as: steward,
      body: { config: { ...p.json.config } },
    });
    expect(id.status).toBe(200);
  });

  test('Client-Kennung ändern verwirft das Geheimnis ebenfalls', async () => {
    const c = await oauthConnector('oauth-kennung');
    const cfg = c.config as { auth: Record<string, unknown> };
    const p = await node.request<Connector>('PATCH', `/api/v1/connectors/${c.id}`, {
      as: steward,
      body: { config: { ...c.config, auth: { ...cfg.auth, clientId: 'anderer-client' } } },
    });
    expect(p.json.hasSecret).toBe(false);
  });

  test('Übermittlung im Formular (client_secret_post) statt HTTP-Basic', async () => {
    const c = await oauthConnector('oauth-body', {
      clientAuth: 'body',
      scope: undefined,
      audience: 'https://api.messsystem',
    });
    expect((await run(c)).run.status).toBe('previewed');
    const tr = mock.tokenRequests[0]!;
    expect(tr.authorization).toBeNull();
    expect(tr.form).toEqual({
      grant_type: 'client_credentials',
      audience: 'https://api.messsystem',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
  });

  test('ungültige Token-Antworten: invalid_response (token_invalid)', async () => {
    const c = await oauthConnector('oauth-kaputt');
    for (const body of [
      { token_type: 'Bearer' },
      { access_token: 'abc', token_type: 'mac' },
      { access_token: 'mit leerzeichen\r\nX-Injected: 1', token_type: 'Bearer' },
    ]) {
      mock.tokenOverride = () => Response.json(body);
      const r = await run(c);
      expect(r.run).toMatchObject({ status: 'failed', failureCode: 'invalid_response' });
      expect(await errorsOf(r.run.id)).toEqual([
        expect.objectContaining({ params: { reason: 'token_invalid' } }),
      ]);
    }
    mock.tokenOverride = () => new Response('kein json', { status: 200 });
    expect((await run(c)).run.failureCode).toBe('invalid_response');
    mock.tokenOverride = () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    const redirected = await run(c);
    expect(await errorsOf(redirected.run.id)).toEqual([
      expect.objectContaining({
        code: 'source_unreachable',
        params: { status: 302, reason: 'token_rejected' },
      }),
    ]);
    expect(mock.dataRequests.length).toBe(0);
  });

  test('Token-Endpunkt antwortet nicht rechtzeitig: token_timeout', async () => {
    const c = await importTemplate(node, steward, 'sprungkraft-oauth2-api', (def) => {
      def.connector.slug = 'oauth-langsam';
      if (
        def.connector.config.type === 'http_api' &&
        def.connector.config.auth.type === 'oauth2_client_credentials'
      ) {
        def.connector.config.url = `${base}/v1/measurements`;
        def.connector.config.timeoutMs = 1000;
        def.connector.config.auth = { ...def.connector.config.auth, tokenUrl: `${base}/oauth2/token` };
      }
    });
    await node.request('PUT', `/api/v1/connectors/${c.id}/secret`, {
      as: steward,
      body: { secret: CLIENT_SECRET },
    });
    mock.tokenOverride = () => new Promise((resolve) => setTimeout(() => resolve(Response.json({})), 1500));
    const r = await run(c);
    expect(await errorsOf(r.run.id)).toEqual([
      expect.objectContaining({ code: 'source_unreachable', params: { reason: 'token_timeout' } }),
    ]);
  });
});
