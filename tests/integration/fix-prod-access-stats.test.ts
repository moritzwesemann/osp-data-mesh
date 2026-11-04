/**
 * Regression: access.data verriet Empfängern Angaben über Zeilen außerhalb der Freigabe (Gesamtzahl,
 * Ausschlüsse nach Zeilenbeschränkung, Datenzeitraum und fehlender Einwilligung – also z. B., für wie viele
 * Personen keine Einwilligung vorliegt). Empfänger erhalten jetzt nur die Zahl gelieferter Zeilen; die
 * vollständige Statistik bleibt den Vorschauen für Datenverantwortliche vorbehalten.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AccessDataResult, DataResult, Product } from '../../src/shared/contract/products.ts';
import type { Release } from '../../src/shared/contract/releases.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';
import { type StandardSeed, seedStandard } from '../helpers/seed.ts';

let node: TestNode;
let seed: StandardSeed;
let steward: TestUser;
let analyst: TestUser;
let product: Product;
let release: Release;

/** Zeitraum ab Februar (Januar-Einträge entfallen), nur Rudern, mit Einwilligungsprüfung */
const draft = () => ({
  productId: product.id,
  recipient: { type: 'role', role: 'analyst' },
  purposes: ['training_steering'],
  columns: ['last_name', 'cmj'],
  rowFilter: [{ column: 'sport', op: 'eq', value: 'Rudern' }],
  dataFrom: '2026-02-01',
  requiresConsent: true,
});

beforeAll(async () => {
  node = await createTestNode();
  seed = await seedStandard(node.deps.db);
  steward = await node.user(['data_steward']);
  analyst = await node.user(['analyst']);
  const p = await node.request<Product>('POST', '/api/v1/products', {
    as: steward,
    body: {
      slug: 'leistung',
      name: 'Leistung',
      sourceType: 'dataset',
      datasetId: seed.performance,
      columns: [
        { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
        { key: 'sport', label: 'Sportart', source: 'athlete.sport' },
        { key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' },
      ],
    },
  });
  expect(p.status).toBe(200);
  product = p.json;
  const r = await node.request<Release>('POST', '/api/v1/releases', { as: steward, body: draft() });
  expect(r.status).toBe(200);
  release = r.json;
});
afterAll(async () => {
  await node?.close();
});

describe('access.data: Statistik für Empfänger', () => {
  test('nur die Zahl gelieferter Zeilen, nichts über ausgeschlossene Zeilen', async () => {
    const res = await node.request<AccessDataResult>(
      'GET',
      `/api/v1/access/${release.id}/data?purpose=training_steering`,
      { as: analyst },
    );
    expect(res.status).toBe(200);
    // März-Einträge von Adler und Berg; Eck (Einwilligung abgelaufen) entfällt
    expect(res.json.rows.map((r) => r.last_name).sort()).toEqual(['Adler', 'Berg']);
    expect(res.json.stats).toEqual({ returned: 2 });
    for (const leaked of ['total', 'excludedByFilter', 'excludedByTime', 'excludedByConsent']) {
      expect(res.text).not.toContain(leaked);
    }

    const limited = await node.request<AccessDataResult>(
      'GET',
      `/api/v1/access/${release.id}/data?purpose=training_steering&limit=1`,
      { as: analyst },
    );
    expect(limited.json.stats).toEqual({ returned: 1 });
  });

  test('OpenAPI: Antwortschema von access.data hat nur stats.returned', async () => {
    const r = await node.request<{ paths: Record<string, Record<string, unknown>> }>(
      'GET',
      '/api/v1/openapi.json',
    );
    expect(r.status).toBe(200);
    const op = r.json.paths['/api/v1/access/{id}/data']?.get as {
      responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    };
    const schema = op.responses['200']?.content?.['application/json']?.schema as {
      properties: { stats: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(schema.properties.stats.properties)).toEqual(['returned']);
  });

  test('Datenverantwortliche sehen die vollständige Statistik in den Vorschauen', async () => {
    const preview = await node.request<{ stats: DataResult['stats'] }>('POST', '/api/v1/releases/preview', {
      as: steward,
      body: { release: draft(), purpose: 'training_steering' },
    });
    expect(preview.status).toBe(200);
    expect(preview.json.stats).toEqual({
      total: 10,
      returned: 2,
      excludedByTime: 5,
      excludedByFilter: 2,
      excludedByConsent: 1,
    });

    const productPreview = await node.request<DataResult>(
      'GET',
      `/api/v1/products/${product.id}/preview?limit=3`,
      { as: steward },
    );
    expect(productPreview.status).toBe(200);
    expect(productPreview.json.stats).toMatchObject({ total: 10, returned: 3 });

    // Empfänger haben keinen Zugriff auf die Vorschauen
    expect(
      (
        await node.request('POST', '/api/v1/releases/preview', {
          as: analyst,
          body: { release: draft(), purpose: 'training_steering' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await node.request('GET', `/api/v1/products/${product.id}/preview`, { as: analyst })).status,
    ).toBe(403);
  });
});
