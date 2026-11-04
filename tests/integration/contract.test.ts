import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { routes } from '../../src/shared/contract/index.ts';
import { createTestNode, type TestNode } from '../helpers/node.ts';

/**
 * Vertragsabdeckung: Jede Route des HTTP-Vertrags ist registriert.
 * Nicht-öffentliche Routen müssen ohne Anmeldung 401 liefern (die Prüfung erfolgt vor allem anderen);
 * die Auffangroute für Unbekanntes liefert 404.
 */
let node: TestNode;
beforeAll(async () => {
  node = await createTestNode();
});
afterAll(async () => {
  await node?.close();
});

const SAMPLE_ID = '00000000-0000-4000-8000-000000000000';

describe('Vertrag', () => {
  for (const [id, def] of Object.entries(routes)) {
    test(`${id}: ${def.method} ${def.path} ist registriert`, async () => {
      const path = def.path.replace(/:[a-zA-Z]+/g, SAMPLE_ID);
      const r = await node.request(def.method, path, { headers: { 'content-type': 'application/json' } });
      if (def.auth === 'public') expect(r.status).not.toBe(404);
      else expect(r.status).toBe(401);
    });
  }

  test('OpenAPI-Dokument enthält alle Vertragsrouten', async () => {
    const r = await node.request<{ paths: Record<string, Record<string, unknown>> }>(
      'GET',
      '/api/v1/openapi.json',
    );
    expect(r.status).toBe(200);
    for (const def of Object.values(routes)) {
      const oaPath = def.path.replace(/:([a-zA-Z]+)/g, '{$1}');
      expect(r.json.paths[oaPath]?.[def.method.toLowerCase()]).toBeDefined();
    }
  });
});
