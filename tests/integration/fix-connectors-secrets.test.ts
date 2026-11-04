/**
 * Regression: Ein gespeichertes Zugangsgeheimnis ist an Ziel (Origin) und Authentifizierungsart seines
 * Connectors gebunden und wird nie unverschlüsselt (http://) an fremde Hosts gesendet.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMockMeasurementApi } from '../../scripts/mock-measurement-api.ts';
import { loadConfig } from '../../src/server/config.ts';
import type { Connector } from '../../src/shared/contract/connectors.ts';
import { auditEntries, importTemplate, type RunDetail, startImport } from '../helpers/integration.ts';
import { TestMesh, type TestNode, type TestUser } from '../helpers/node.ts';

const SECRET = 'SUPER-SECRET-TOKEN';
const HTTPS_URL = 'https://measure.mesh.test/v1/measurements';
const PLAIN_URL = 'http://measure.mesh.test/v1/measurements';
const LOOPBACK_URL = 'http://127.0.0.1:4410/v1/measurements';

let mesh: TestMesh;
let node: TestNode;
let steward: TestUser;
/** alle bei den Testzielen eingegangenen Anfragen: Origin, Pfad, Header */
const seen: { origin: string; path: string; headers: Record<string, string> }[] = [];

function capture(origin: string, handler: (req: Request) => Response | Promise<Response>) {
  mesh.routes.set(origin, (req) => {
    const url = new URL(req.url);
    seen.push({ origin, path: url.pathname, headers: Object.fromEntries(req.headers.entries()) });
    return handler(req);
  });
}

const leaked = () => seen.filter((r) => Object.values(r.headers).some((v) => v.includes(SECRET)));

beforeAll(async () => {
  mesh = new TestMesh();
  const api = createMockMeasurementApi({ token: SECRET });
  capture('https://measure.mesh.test', api);
  capture('http://measure.mesh.test', api);
  capture('http://127.0.0.1:4410', api);
  node = await mesh.add({ nodeId: 'osp-geheim-test' });
  steward = await node.user(['data_steward']);
});

afterAll(async () => {
  await mesh?.close();
});

async function apiConnector(slug: string, url: string, secret: string | null = SECRET): Promise<Connector> {
  const c = await importTemplate(node, steward, 'sprungkraft-api', (def) => {
    def.connector.slug = slug;
    if (def.connector.config.type === 'http_api') def.connector.config.url = url;
  });
  if (secret) {
    const r = await node.request('PUT', `/api/v1/connectors/${c.id}/secret`, {
      as: steward,
      body: { secret },
    });
    expect(r.status).toBe(200);
  }
  return (await node.request<Connector>('GET', `/api/v1/connectors/${c.id}`, { as: steward })).json;
}

async function patchConfig(c: Connector, config: Record<string, unknown>): Promise<Connector> {
  const r = await node.request<Connector>('PATCH', `/api/v1/connectors/${c.id}`, {
    as: steward,
    body: { config: { ...c.config, ...config } },
  });
  expect(r.status).toBe(200);
  return r.json;
}

describe('inspect mit connectorId nutzt nur das gespeicherte Ziel', () => {
  test('angefragte URL/Authentifizierung werden ignoriert, das Geheimnis geht nicht an fremde Hosts', async () => {
    const c = await apiConnector('geheim-inspect', HTTPS_URL);
    seen.length = 0;
    const form = new FormData();
    form.append(
      'config',
      JSON.stringify({
        ...c.config,
        url: 'http://127.0.0.1:4410/leak',
        auth: { type: 'header', headerName: 'x-leak' },
      }),
    );
    form.append('connectorId', c.id);
    const r = await node.request<{ columns: string[] }>('POST', '/api/v1/connectors/inspect', {
      as: steward,
      form,
    });
    expect(r.status).toBe(200);
    expect(seen.map((s) => `${s.origin}${s.path}`)).toEqual([HTTPS_URL]);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen.some((s) => 'x-leak' in s.headers)).toBe(false);
  });

  test('ohne config wird die gespeicherte Konfiguration verwendet; unbekannte Connectoren → 404', async () => {
    const c = await apiConnector('geheim-inspect-ohne', HTTPS_URL);
    const form = new FormData();
    form.append('connectorId', c.id);
    const r = await node.request('POST', '/api/v1/connectors/inspect', { as: steward, form });
    expect(r.status).toBe(200);
    const unknown = new FormData();
    unknown.append('config', JSON.stringify(c.config));
    unknown.append('connectorId', crypto.randomUUID());
    expect(
      (await node.request('POST', '/api/v1/connectors/inspect', { as: steward, form: unknown })).status,
    ).toBe(404);
  });
});

describe('Änderung des Ziels entfernt das Geheimnis', () => {
  test('anderer Origin: Geheimnis gelöscht, Audit, nächster Import sendet nichts', async () => {
    const c = await apiConnector('geheim-umzug', HTTPS_URL);
    expect(c.hasSecret).toBe(true);
    const moved = await patchConfig(c, { url: 'http://127.0.0.1:4410/v1/measurements' });
    expect(moved.hasSecret).toBe(false);
    const row = await node.deps.db
      .selectFrom('connector')
      .select('secret_enc')
      .where('id', '=', c.id)
      .executeTakeFirstOrThrow();
    expect(row.secret_enc).toBeNull();
    const [audit] = await auditEntries(node, 'connector.secret_cleared');
    expect(audit).toMatchObject({ object_id: c.id, actor_id: steward.id });
    expect(JSON.stringify(audit!.details)).not.toContain(SECRET);

    seen.length = 0;
    const run = await startImport(node, steward, c.id);
    expect(run.run).toMatchObject({ status: 'failed', failureCode: 'source_unreachable' });
    expect(seen.length).toBe(1);
    expect(leaked()).toEqual([]);
  });

  test('anderer Port, anderes Schema, andere Authentifizierung: Geheimnis gelöscht', async () => {
    const changes: Record<string, unknown>[] = [
      { url: 'https://measure.mesh.test:8443/v1/measurements' },
      { url: PLAIN_URL },
      { auth: { type: 'header', headerName: 'x-leak' } },
      { auth: { type: 'none' } },
    ];
    for (const [i, change] of changes.entries()) {
      const c = await apiConnector(`geheim-wechsel-${i}`, HTTPS_URL);
      expect((await patchConfig(c, change)).hasSecret).toBe(false);
    }
    const h = await apiConnector('geheim-header', HTTPS_URL);
    const withHeader = await patchConfig(h, { auth: { type: 'header', headerName: 'X-Api-Key' } });
    await node.request('PUT', `/api/v1/connectors/${h.id}/secret`, { as: steward, body: { secret: SECRET } });
    const renamed = await patchConfig(withHeader, { auth: { type: 'header', headerName: 'X-Other-Key' } });
    expect(renamed.hasSecret).toBe(false);
  });

  test('gleicher Origin (Pfad, Abfrage, Paginierung, Name) behält das Geheimnis', async () => {
    const c = await apiConnector('geheim-bleibt', HTTPS_URL);
    const r = await node.request<Connector>('PATCH', `/api/v1/connectors/${c.id}`, {
      as: steward,
      body: {
        name: 'Neuer Name',
        config: {
          ...c.config,
          url: 'https://MEASURE.mesh.test:443/v1/measurements?x=1',
          query: { since: 'x' },
        },
      },
    });
    expect(r.status).toBe(200);
    expect(r.json.hasSecret).toBe(true);
    seen.length = 0;
    await startImport(node, steward, c.id);
    expect(seen.every((s) => s.origin === 'https://measure.mesh.test')).toBe(true);
  });
});

describe('kein Geheimnis über unverschlüsseltes http', () => {
  test('Import: http:// zu fremdem Host mit Geheimnis → 400 source_not_allowed, nichts gesendet', async () => {
    const c = await apiConnector('geheim-http', PLAIN_URL);
    seen.length = 0;
    const r = await node.request<{ error: { code: string; reason?: string } }>(
      'POST',
      `/api/v1/connectors/${c.id}/runs`,
      { as: steward },
    );
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'source_not_allowed', reason: 'insecure_http' });
    expect(seen).toEqual([]);
    const [audit] = await auditEntries(node, 'import.start');
    expect(audit).toMatchObject({ outcome: 'denied', object_id: c.id });
    expect(audit!.details).toMatchObject({ reason: 'insecure_http', host: 'measure.mesh.test' });
  });

  test('Analyse: mitgegebenes Geheimnis über http:// wird ebenfalls abgewiesen', async () => {
    const form = new FormData();
    form.append(
      'config',
      JSON.stringify({ type: 'http_api', url: PLAIN_URL, itemsPath: 'data', auth: { type: 'bearer' } }),
    );
    form.append('secret', SECRET);
    seen.length = 0;
    const r = await node.request<{ error: { code: string; reason?: string } }>(
      'POST',
      '/api/v1/connectors/inspect',
      { as: steward, form },
    );
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'source_not_allowed', reason: 'insecure_http' });
    expect(seen).toEqual([]);
  });

  test('ohne Geheimnis ist http:// erlaubt; Loopback-Adressen auch mit Geheimnis', async () => {
    const open = await apiConnector('offen-http', PLAIN_URL, null);
    seen.length = 0;
    const r = await startImport(node, steward, open.id);
    expect(r.run.failureCode).toBe('source_unreachable'); // 401 der Quelle, aber Anfrage erlaubt
    expect(seen.length).toBe(1);

    const local = await apiConnector('geheim-loopback', LOOPBACK_URL);
    seen.length = 0;
    const ok = await startImport(node, steward, local.id);
    expect(ok.run.status).toBe('previewed');
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  test('MESH_SOURCE_ALLOW_INSECURE_HTTP=true erlaubt http:// ausdrücklich', async () => {
    expect(loadConfigWith({}).MESH_SOURCE_ALLOW_INSECURE_HTTP).toBe(false);
    expect(loadConfigWith({ MESH_SOURCE_ALLOW_INSECURE_HTTP: 'true' }).MESH_SOURCE_ALLOW_INSECURE_HTTP).toBe(
      true,
    );
    const lax = await mesh.add({
      nodeId: 'osp-geheim-http',
      config: { MESH_SOURCE_ALLOW_INSECURE_HTTP: 'true' },
    });
    const st = await lax.user(['data_steward']);
    const c = await importTemplate(lax, st, 'sprungkraft-api', (def) => {
      if (def.connector.config.type === 'http_api') def.connector.config.url = PLAIN_URL;
    });
    await lax.request('PUT', `/api/v1/connectors/${c.id}/secret`, { as: st, body: { secret: SECRET } });
    const r = await lax.request<RunDetail>('POST', `/api/v1/connectors/${c.id}/runs`, { as: st });
    expect(r.status).toBe(200);
    expect(r.json.run.status).toBe('previewed');
  });
});

function loadConfigWith(extra: Record<string, string>) {
  return loadConfig({
    MESH_NODE_ID: 'cfg-test',
    MESH_NODE_NAME: 'x',
    MESH_PUBLIC_URL: 'https://x.example',
    MESH_DB_URL: 'postgres://x',
    MESH_MASTER_KEY: Buffer.alloc(32).toString('base64'),
    ...extra,
  });
}
