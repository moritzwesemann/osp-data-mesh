import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';
import { type StandardSeed, seedConnector, seedProduct, seedStandard } from '../helpers/seed.ts';

interface CatalogItem {
  kind: 'source' | 'dataset' | 'product';
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  version: number;
  shareability: string;
  specialCategory: boolean;
  fields: { key: string; label: string; type: string; unit?: string }[];
  mappings: { source: string; target: string }[];
  related: { kind: string; id: string; name: string }[];
  updatedAt: string;
}

let node: TestNode;
let seed: StandardSeed;
let coach: TestUser;
let csvSource: string;
let athleteSource: string;
let healthSource: string;
let product: string;
let retired: string;

async function catalog(query = ''): Promise<CatalogItem[]> {
  const res = await node.request<{ items: CatalogItem[] }>('GET', `/api/v1/catalog${query}`, { as: coach });
  expect(res.status).toBe(200);
  return res.json.items;
}

beforeAll(async () => {
  node = await createTestNode();
  seed = await seedStandard(node.deps.db);
  coach = await node.user(['coach']);
  csvSource = await seedConnector(node.deps.db, {
    slug: 'sprungmessung-csv',
    name: 'Sprungmessung (CSV)',
    description: 'Export der Sprungmatte',
    targetDatasetId: seed.performance,
    mapping: [
      { source: 'Name', target: 'athlete.last_name' },
      { source: 'Vorname', target: 'athlete.first_name' },
      { source: 'Datum', target: 'data.test_date' },
      { source: 'CMJ [cm]', target: 'data.cmj_cm' },
    ],
    version: 3,
  });
  athleteSource = await seedConnector(node.deps.db, {
    slug: 'kaderliste',
    name: 'Kaderliste',
    kind: 'http_api',
    mapping: [
      { source: 'id', target: 'athlete.external_id' },
      { source: 'nachname', target: 'athlete.last_name' },
      { source: 'kader', target: 'athlete.squad_status' },
    ],
  });
  healthSource = await seedConnector(node.deps.db, {
    slug: 'arztbefund',
    name: 'Arztbefund',
    targetDatasetId: seed.health,
    mapping: [{ source: 'Puls', target: 'data.resting_hr' }],
  });
  product = await seedProduct(node.deps.db, {
    slug: 'leistung',
    name: 'Leistungsprofil',
    description: 'Sprunghöhen je Person',
    datasetId: seed.performance,
    columns: [
      { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
      { key: 'test_date', label: 'Testdatum', source: 'record.observed_at' },
      { key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' },
    ],
    version: 2,
  });
  retired = await seedProduct(node.deps.db, {
    slug: 'alt',
    name: 'Altes Produkt',
    datasetId: seed.performance,
    columns: [{ key: 'last_name', source: 'athlete.last_name' }],
    status: 'retired',
  });
});

afterAll(async () => {
  await node?.close();
});

describe('Lokaler Metadatenkatalog', () => {
  test('für jede angemeldete Person, nicht anonym', async () => {
    expect((await node.request('GET', '/api/v1/catalog')).status).toBe(401);
    const items = await catalog();
    expect(items.map((i) => i.kind).sort()).toEqual([
      'dataset',
      'dataset',
      'product',
      'source',
      'source',
      'source',
    ]);
  });

  test('Quelle: Zielfelder mit Typen, Zuordnungen, Kategorie/Teilbarkeit des Zieldatensatzes, Version', async () => {
    const items = await catalog();
    const src = items.find((i) => i.id === csvSource)!;
    expect(src).toMatchObject({
      kind: 'source',
      slug: 'sprungmessung-csv',
      name: 'Sprungmessung (CSV)',
      description: 'Export der Sprungmatte',
      category: 'performance',
      version: 3,
      shareability: 'on_request',
      specialCategory: false,
    });
    expect(src.fields).toEqual([
      { key: 'athlete.last_name', label: 'Nachname', type: 'string' },
      { key: 'athlete.first_name', label: 'Vorname', type: 'string' },
      { key: 'data.test_date', label: 'Testdatum', type: 'date' },
      { key: 'data.cmj_cm', label: 'Sprunghöhe CMJ', type: 'number', unit: 'cm' },
    ]);
    expect(src.mappings).toEqual([
      { source: 'Name', target: 'athlete.last_name' },
      { source: 'Vorname', target: 'athlete.first_name' },
      { source: 'Datum', target: 'data.test_date' },
      { source: 'CMJ [cm]', target: 'data.cmj_cm' },
    ]);
    expect(src.related).toEqual([{ kind: 'dataset', id: seed.performance, name: 'Leistungsdiagnostik' }]);

    const athletes = items.find((i) => i.id === athleteSource)!;
    expect(athletes).toMatchObject({
      category: 'master',
      shareability: 'on_request',
      specialCategory: false,
    });
    expect(athletes.fields[0]).toEqual({
      key: 'athlete.external_id',
      label: 'Externe Kennung',
      type: 'string',
    });
    expect(athletes.related).toEqual([]);

    const healthSrc = items.find((i) => i.id === healthSource)!;
    expect(healthSrc).toMatchObject({ category: 'health', specialCategory: true });
    expect(healthSrc.fields).toEqual([
      { key: 'data.resting_hr', label: 'Ruhepuls', type: 'integer', unit: 'bpm' },
    ]);
  });

  test('Datensatz: Felder, verknüpfte Quellen und Produkte', async () => {
    const items = await catalog();
    const ds = items.find((i) => i.id === seed.performance)!;
    expect(ds).toMatchObject({
      kind: 'dataset',
      slug: 'leistungstest',
      category: 'performance',
      version: 1,
      shareability: 'on_request',
      specialCategory: false,
    });
    expect(ds.fields.map((f) => f.key)).toEqual([
      'test_date',
      'cmj_cm',
      'sprint_s',
      'reps',
      'valid',
      'protocol',
      'note',
    ]);
    expect(ds.fields.find((f) => f.key === 'protocol')?.type).toBe('enum');
    expect(ds.related).toEqual([
      { kind: 'source', id: csvSource, name: 'Sprungmessung (CSV)' },
      { kind: 'product', id: product, name: 'Leistungsprofil' },
    ]);
    const health = items.find((i) => i.id === seed.health)!;
    expect(health).toMatchObject({ category: 'health', specialCategory: true });
  });

  test('Produkt: Spalten mit Typen, Datensatz, Version; stillgelegte Produkte fehlen', async () => {
    const items = await catalog();
    const p = items.find((i) => i.id === product)!;
    expect(p).toMatchObject({ kind: 'product', slug: 'leistung', version: 2, category: 'performance' });
    expect(p.fields).toEqual([
      { key: 'last_name', label: 'Nachname', type: 'string' },
      { key: 'test_date', label: 'Testdatum', type: 'date' },
      { key: 'cmj', label: 'CMJ', type: 'number', unit: 'cm' },
    ]);
    expect(p.related).toEqual([{ kind: 'dataset', id: seed.performance, name: 'Leistungsdiagnostik' }]);
    expect(items.some((i) => i.id === retired)).toBe(false);
  });

  test('nur Metadaten, keine Daten', async () => {
    const res = await node.request('GET', '/api/v1/catalog', { as: coach });
    expect(res.text).not.toContain('Adler');
    expect(res.text).not.toContain('41.5');
  });

  test('Filter nach Art und Suchbegriff (Name, Kürzel, Beschreibung; ohne Groß-/Kleinschreibung)', async () => {
    expect((await catalog('?kind=product')).map((i) => i.id)).toEqual([product]);
    expect((await catalog('?kind=source')).map((i) => i.id).sort()).toEqual(
      [csvSource, athleteSource, healthSource].sort(),
    );
    expect((await catalog('?q=SPRUNG')).map((i) => i.id).sort()).toEqual(
      [csvSource, seed.performance, product].sort(),
    );
    expect((await catalog('?q=kaderliste')).map((i) => i.id)).toEqual([athleteSource]);
    expect((await catalog('?q=gesundheit&kind=dataset')).map((i) => i.id)).toEqual([seed.health]);
    expect(await catalog('?q=%25')).toEqual([]);
    expect(await catalog('?q=nichtvorhanden')).toEqual([]);
  });
});
