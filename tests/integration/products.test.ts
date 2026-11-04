import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DataResult, Product } from '../../src/shared/contract/products.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';
import { type StandardSeed, seedApiToken, seedDataset, seedRelease, seedStandard } from '../helpers/seed.ts';

let node: TestNode;
let seed: StandardSeed;
let steward: TestUser;
let analyst: TestUser;
let coach: TestUser;
let admin: TestUser;

interface ErrorJson {
  error: { code: string; reason?: string; fields?: Record<string, string> };
}

const COLUMNS = [
  { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
  { key: 'sport', label: 'Sportart', source: 'athlete.sport' },
  { key: 'test_date', label: 'Testdatum', source: 'record.observed_at' },
  { key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' },
  { key: 'note', label: 'Bemerkung', source: 'data.note' },
];

async function createProduct(body: Record<string, unknown>) {
  return node.request<Product & ErrorJson>('POST', '/api/v1/products', { as: steward, body });
}

async function audit(action: string) {
  return node.deps.db
    .selectFrom('audit_log')
    .selectAll()
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
}

beforeAll(async () => {
  node = await createTestNode();
  seed = await seedStandard(node.deps.db);
  steward = await node.user(['data_steward']);
  analyst = await node.user(['analyst']);
  coach = await node.user(['coach']);
  admin = await node.user(['admin']);
});

afterAll(async () => {
  await node?.close();
});

describe('Datenprodukte: Anlegen und Prüfung', () => {
  test('Produkt aus Datensatz: Spalten mit Typ/Einheit, Kategorie vom Datensatz, Version 1', async () => {
    const res = await createProduct({
      slug: 'leistung',
      name: 'Leistung',
      sourceType: 'dataset',
      datasetId: seed.performance,
      columns: COLUMNS,
    });
    expect(res.status).toBe(200);
    expect(res.json.version).toBe(1);
    expect(res.json.status).toBe('active');
    expect(res.json.category).toBe('performance');
    expect(res.json.specialCategory).toBe(false);
    expect(res.json.shareability).toBe('on_request');
    expect(res.json.datasetName).toBe('Leistungsdiagnostik');
    expect(res.json.activeReleaseCount).toBe(0);
    expect(res.json.columns).toEqual([
      { key: 'last_name', label: 'Nachname', source: 'athlete.last_name', type: 'string' },
      { key: 'sport', label: 'Sportart', source: 'athlete.sport', type: 'string' },
      { key: 'test_date', label: 'Testdatum', source: 'record.observed_at', type: 'date' },
      { key: 'cmj', label: 'CMJ', source: 'data.cmj_cm', type: 'number', unit: 'cm' },
      { key: 'note', label: 'Bemerkung', source: 'data.note', type: 'string' },
    ]);
    const entries = await audit('product.create');
    expect(entries.at(-1)?.object_id).toBe(res.json.id);
    expect(entries.at(-1)?.actor_id).toBe(steward.id);
  });

  test('Produkt aus dem Athletenkern: Kategorie master', async () => {
    const res = await createProduct({
      slug: 'kader',
      name: 'Kader',
      sourceType: 'athletes',
      columns: [
        { key: 'name', label: 'Name', source: 'athlete.last_name' },
        { key: 'jahrgang', label: 'Jahrgang', source: 'athlete.birth_year' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.category).toBe('master');
    expect(res.json.columns[1]!.type).toBe('integer');
  });

  test('Gesundheitsdaten: besondere Kategorie', async () => {
    const res = await createProduct({
      slug: 'gesundheit',
      name: 'Gesundheit',
      sourceType: 'dataset',
      datasetId: seed.health,
      columns: [
        { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
        { key: 'hr', label: 'Ruhepuls', source: 'data.resting_hr' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.category).toBe('health');
    expect(res.json.specialCategory).toBe(true);
    expect(res.json.columns[1]).toMatchObject({ type: 'integer', unit: 'bpm' });
  });

  test('Produkt eines internen Datensatzes ist immer intern', async () => {
    const ds = await seedDataset(node.deps.db, {
      slug: 'intern_ds',
      category: 'training',
      shareability: 'internal',
      fields: [{ name: 'x', type: 'integer' }],
    });
    const res = await createProduct({
      slug: 'intern_prod',
      name: 'Intern',
      sourceType: 'dataset',
      datasetId: ds,
      columns: [{ key: 'x', label: 'X', source: 'data.x' }],
      shareability: 'on_request',
    });
    expect(res.status).toBe(200);
    expect(res.json.shareability).toBe('internal');
  });

  test('Prüfungen: doppelte Schlüssel, ungültige Quellen, unbekannte Felder, Filter', async () => {
    const base = { slug: 'kaputt', name: 'X', sourceType: 'dataset', datasetId: seed.performance };
    let res = await createProduct({
      ...base,
      columns: [
        { key: 'a', label: 'A', source: 'athlete.last_name' },
        { key: 'a', label: 'A2', source: 'athlete.first_name' },
        { key: 'b', label: 'B', source: 'data.does_not_exist' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation_failed');
    expect(res.json.error.fields).toEqual({
      'body.columns.1.key': 'duplicate',
      'body.columns.2.source': 'unknown_field',
    });

    res = await createProduct({
      slug: 'kaputt',
      name: 'X',
      sourceType: 'athletes',
      columns: [
        { key: 'a', label: 'A', source: 'record.observed_at' },
        { key: 'b', label: 'B', source: 'data.cmj_cm' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.json.error.fields).toEqual({
      'body.columns.0.source': 'invalid_source',
      'body.columns.1.source': 'invalid_source',
    });

    res = await createProduct({
      ...base,
      columns: [{ key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' }],
      filters: [
        { column: 'other', op: 'eq', value: 1 },
        { column: 'cmj', op: 'gt', value: 'viel' },
        { column: 'cmj', op: 'gt', value: 30 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.json.error.fields).toEqual({
      'body.filters.0.column': 'unknown_column',
      'body.filters.1.value': 'invalid_value',
    });

    res = await createProduct({ ...base, datasetId: null, columns: COLUMNS.slice(0, 1) });
    expect(res.json.error.fields).toEqual({ 'body.datasetId': 'required' });
    res = await createProduct({ ...base, datasetId: crypto.randomUUID(), columns: COLUMNS.slice(0, 1) });
    expect(res.json.error.fields).toEqual({ 'body.datasetId': 'not_found' });
    res = await createProduct({
      ...base,
      sourceType: 'athletes',
      columns: COLUMNS.slice(0, 1),
    });
    expect(res.json.error.fields).toEqual({ 'body.datasetId': 'not_allowed' });
  });

  test('Kürzel ist eindeutig (409)', async () => {
    const res = await createProduct({
      slug: 'leistung',
      name: 'Doppelt',
      sourceType: 'athletes',
      columns: [{ key: 'n', label: 'N', source: 'athlete.last_name' }],
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('conflict');
  });

  test('nur Datenverantwortliche verwalten Produkte', async () => {
    expect((await node.request('GET', '/api/v1/products', { as: analyst })).status).toBe(403);
    expect((await node.request('GET', '/api/v1/products', { as: admin })).status).toBe(403);
    expect((await node.request('GET', '/api/v1/products')).status).toBe(401);
    const list = await node.request<{ items: Product[] }>('GET', '/api/v1/products', { as: steward });
    expect(list.status).toBe(200);
    expect(list.json.items.map((p) => p.slug)).toContain('leistung');
  });
});

describe('Datenprodukte: Ändern, Versionierung, Stilllegen', () => {
  let id: string;

  beforeAll(async () => {
    const res = await createProduct({
      slug: 'versioniert',
      name: 'Versioniert',
      sourceType: 'dataset',
      datasetId: seed.performance,
      columns: COLUMNS.slice(0, 4),
      filters: [{ column: 'cmj', op: 'gte', value: 30 }],
    });
    id = res.json.id;
  });

  test('Name/Beschreibung ändern: Version bleibt, Filter bleiben erhalten', async () => {
    const res = await node.request<Product>('PATCH', `/api/v1/products/${id}`, {
      as: steward,
      body: { name: 'Neuer Name', description: 'Beschreibung' },
    });
    expect(res.status).toBe(200);
    expect(res.json.name).toBe('Neuer Name');
    expect(res.json.version).toBe(1);
    expect(res.json.filters).toEqual([{ column: 'cmj', op: 'gte', value: 30 }]);
    expect(res.json.shareability).toBe('on_request');
  });

  test('Spalten ändern erhöht die Version', async () => {
    const res = await node.request<Product>('PATCH', `/api/v1/products/${id}`, {
      as: steward,
      body: { columns: COLUMNS },
    });
    expect(res.json.version).toBe(2);
    expect(res.json.columns).toHaveLength(5);
  });

  test('Filter ändern erhöht die Version; ungültige Filter werden abgelehnt', async () => {
    let res = await node.request<Product & ErrorJson>('PATCH', `/api/v1/products/${id}`, {
      as: steward,
      body: { filters: [{ column: 'nope', op: 'is_null' }] },
    });
    expect(res.status).toBe(400);
    expect(res.json.error.fields).toEqual({ 'body.filters.0.column': 'unknown_column' });
    res = await node.request<Product & ErrorJson>('PATCH', `/api/v1/products/${id}`, {
      as: steward,
      body: { filters: [] },
    });
    expect(res.json.version).toBe(3);
    expect(res.json.filters).toEqual([]);
  });

  test('Änderung löst product.changed in der Transaktion aus und wird protokolliert', async () => {
    const seen: string[] = [];
    node.deps.events.onTx('product.changed', async (p) => {
      if (p.productId === id) seen.push(p.retired ? 'retired' : 'changed');
    });
    await node.request('PATCH', `/api/v1/products/${id}`, { as: steward, body: { description: 'x' } });
    expect(seen).toEqual(['changed']);
    const entries = (await audit('product.update')).filter((e) => e.object_id === id);
    expect(entries.length).toBeGreaterThanOrEqual(4);
    expect(entries.at(-1)?.details).toMatchObject({
      changed: ['description'],
      version: 3,
      versionChanged: false,
    });
  });

  test('Stilllegen: Status retired, danach keine Änderungen mehr', async () => {
    const res = await node.request<Product>('POST', `/api/v1/products/${id}/retire`, { as: steward });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('retired');
    expect((await node.request('POST', `/api/v1/products/${id}/retire`, { as: steward })).status).toBe(409);
    expect(
      (await node.request('PATCH', `/api/v1/products/${id}`, { as: steward, body: { name: 'y' } })).status,
    ).toBe(409);
    expect((await audit('product.retire')).some((e) => e.object_id === id)).toBe(true);
  });

  test('unbekanntes Produkt: 404', async () => {
    expect(
      (await node.request('GET', `/api/v1/products/${crypto.randomUUID()}`, { as: steward })).status,
    ).toBe(404);
  });
});

describe('Datenprodukte: Vorschau für Datenverantwortliche', () => {
  test('ungefilterte Zeilen (Limit), protokolliert', async () => {
    const list = await node.request<{ items: Product[] }>('GET', '/api/v1/products', { as: steward });
    const p = list.json.items.find((x) => x.slug === 'leistung')!;
    const res = await node.request<DataResult>('GET', `/api/v1/products/${p.id}/preview?limit=3`, {
      as: steward,
    });
    expect(res.status).toBe(200);
    expect(res.json.rows).toHaveLength(3);
    expect(res.json.stats.total).toBe(10);
    expect(res.json.columns.map((c) => c.key)).toEqual(['last_name', 'sport', 'test_date', 'cmj', 'note']);
    const entries = await audit('product.preview');
    expect(entries.at(-1)?.object_id).toBe(p.id);
    expect(entries.at(-1)?.details).toMatchObject({ rowCount: 3 });
    expect((await node.request('GET', `/api/v1/products/${p.id}/preview`, { as: analyst })).status).toBe(403);
  });
});

describe('Datenzugriff (access.*)', () => {
  let productId: string;
  let analystRelease: string;
  let coachRelease: string;
  let revokedRelease: string;
  let biRelease: string;

  beforeAll(async () => {
    const list = await node.request<{ items: Product[] }>('GET', '/api/v1/products', { as: steward });
    productId = list.json.items.find((x) => x.slug === 'leistung')!.id;
    analystRelease = await seedRelease(node.deps.db, {
      productId,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering', 'performance_diagnostics'],
      columns: ['last_name', 'test_date', 'note', 'cmj'],
    });
    coachRelease = await seedRelease(node.deps.db, {
      productId,
      recipient: { type: 'role', role: 'coach' },
      purposes: ['training_steering'],
      columns: ['last_name', 'cmj'],
      rowFilter: [{ column: 'sport', op: 'eq', value: 'Kanu' }],
    });
    revokedRelease = await seedRelease(node.deps.db, {
      productId,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
      revokedAt: new Date(Date.now() - 1000),
    });
    // abgelaufen und veraltet: nicht in der Liste
    await seedRelease(node.deps.db, {
      productId,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
      validUntil: new Date(Date.now() - 1000),
      validFrom: new Date(Date.now() - 100_000),
    });
    await seedRelease(node.deps.db, {
      productId,
      productVersion: 0,
      recipient: { type: 'role', role: 'analyst' },
      purposes: ['training_steering'],
      columns: ['last_name'],
    });
    biRelease = await seedRelease(node.deps.db, {
      productId,
      recipient: { type: 'role', role: 'bi' },
      purposes: ['reporting'],
      columns: ['last_name'],
    });
  });

  test('access.list: nur aktive Freigaben an die eigenen Rollen, mit wirksamen Spalten', async () => {
    const a = await node.request<{
      items: { releaseId: string; columns: { key: string }[]; product: { slug: string } }[];
    }>('GET', '/api/v1/access', { as: analyst });
    expect(a.status).toBe(200);
    expect(a.json.items.map((i) => i.releaseId)).toEqual([analystRelease]);
    expect(a.json.items[0]!.columns.map((c) => c.key)).toEqual(['last_name', 'test_date', 'cmj', 'note']);
    expect(a.json.items[0]!.product.slug).toBe('leistung');

    const c = await node.request<{ items: { releaseId: string }[] }>('GET', '/api/v1/access', { as: coach });
    expect(c.json.items.map((i) => i.releaseId)).toEqual([coachRelease]);

    const ad = await node.request<{ items: unknown[] }>('GET', '/api/v1/access', { as: admin });
    expect(ad.json.items).toEqual([]);
    const st = await node.request<{ items: { releaseId: string }[] }>('GET', '/api/v1/access', {
      as: steward,
    });
    expect(st.json.items.map((i) => i.releaseId)).not.toContain(biRelease);
  });

  test('access.data JSON: nur freigegebene Spalten und Zeilen, protokolliert', async () => {
    const res = await node.request<DataResult>(
      'GET',
      `/api/v1/access/${coachRelease}/data?purpose=training_steering`,
      { as: coach },
    );
    expect(res.status).toBe(200);
    expect(res.json.columns.map((c) => c.key)).toEqual(['last_name', 'cmj']);
    expect(res.json.rows).toHaveLength(4);
    expect(new Set(res.json.rows.map((r) => r.last_name))).toEqual(new Set(['Clausen', 'Dorn']));
    expect(res.json.stats.excludedByFilter).toBe(6);
    const entry = (await audit('access.data')).at(-1)!;
    expect(entry.outcome).toBe('success');
    expect(entry.actor_id).toBe(coach.id);
    expect(entry.details).toMatchObject({
      releaseId: coachRelease,
      purpose: 'training_steering',
      format: 'json',
      rowCount: 4,
    });
  });

  test('access.data CSV: Kopfzeile, BOM, Schutz vor Formel-Injection', async () => {
    const res = await node.request(
      'GET',
      `/api/v1/access/${analystRelease}/data?purpose=training_steering&format=csv`,
      { as: analyst },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('leistung.csv');
    // BOM für Excel/Power Query (Response.text() entfernt ihn beim Dekodieren, daher Rohbytes prüfen)
    const raw = await node.app.request(
      `/api/v1/access/${analystRelease}/data?purpose=training_steering&format=csv`,
      {
        headers: { cookie: analyst.cookie },
      },
    );
    expect([...new Uint8Array(await raw.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = res.text.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('last_name,test_date,cmj,note');
    expect(lines).toContain("Adler,2026-01-15,41.5,'=1+1");
    expect(lines).toContain('Berg,2026-01-15,38.2,"A&B <x> ""q"""');
    expect(res.text).not.toContain(',=1+1');
    expect(lines.filter((l) => l.length > 0)).toHaveLength(11);
    const csvAudits = (await audit('access.data')).filter(
      (e) => (e.details as { format?: string }).format === 'csv',
    );
    expect(csvAudits.at(-1)?.details).toMatchObject({ format: 'csv', rowCount: 10 });
  });

  test('access.data XML: wohlgeformt, Werte maskiert', async () => {
    const res = await node.request(
      'GET',
      `/api/v1/access/${analystRelease}/data?purpose=performance_diagnostics&format=xml`,
      { as: analyst },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = res.text;
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(isWellFormed(xml)).toBe(true);
    expect(xml).toContain('<note>A&amp;B &lt;x&gt; &quot;q&quot;</note>');
    expect(xml).toContain('<column key="cmj" type="number" label="CMJ" unit="cm"/>');
    expect((xml.match(/<row>/g) ?? []).length).toBe(10);
    expect(xml).toContain(`releaseId="${analystRelease}"`);
    expect(xml).toContain('purpose="performance_diagnostics"');
  });

  test('access.data: falsche Rolle, falscher Zweck, widerrufen → 403 access_denied mit Grund, protokolliert', async () => {
    const cases: [TestUser, string, string, string][] = [
      [coach, analystRelease, 'training_steering', 'recipient_mismatch'],
      [admin, analystRelease, 'training_steering', 'recipient_mismatch'],
      [steward, biRelease, 'reporting', 'recipient_mismatch'],
      [analyst, analystRelease, 'research', 'purpose_not_allowed'],
      [analyst, revokedRelease, 'training_steering', 'revoked'],
      [analyst, crypto.randomUUID(), 'training_steering', 'release_not_found'],
    ];
    for (const [user, releaseId, purpose, expected] of cases) {
      const res = await node.request<ErrorJson>(
        'GET',
        `/api/v1/access/${releaseId}/data?purpose=${purpose}`,
        {
          as: user,
        },
      );
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('access_denied');
      expect(res.json.error.reason).toBe(expected);
      const entry = (await audit('access.data')).at(-1)!;
      expect(entry.outcome).toBe('denied');
      expect(entry.actor_id).toBe(user.id);
      expect(entry.details).toMatchObject({ releaseId, purpose, reason: expected });
    }
  });

  test('access.data: Zweck ist Pflicht', async () => {
    const res = await node.request<ErrorJson>('GET', `/api/v1/access/${analystRelease}/data`, {
      as: analyst,
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation_failed');
  });

  test('API-Token (Bearer) für Werkzeuge wie Python oder Power BI', async () => {
    const { token } = await seedApiToken(node.deps.db, analyst.id);
    const res = await node.request<DataResult>(
      'GET',
      `/api/v1/access/${analystRelease}/data?purpose=training_steering&limit=2`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    expect(res.json.rows).toHaveLength(2);
    expect((await audit('access.data')).at(-1)?.details).toMatchObject({ via: 'token', rowCount: 2 });

    const csv = await node.request(
      'GET',
      `/api/v1/access/${analystRelease}/data?purpose=training_steering&format=csv`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(csv.status).toBe(200);

    const revoked = await seedApiToken(node.deps.db, analyst.id, { revoked: true });
    const denied = await node.request(
      'GET',
      `/api/v1/access/${analystRelease}/data?purpose=training_steering`,
      { headers: { authorization: `Bearer ${revoked.token}` } },
    );
    expect(denied.status).toBe(401);
    const coachToken = await seedApiToken(node.deps.db, coach.id);
    const wrongRole = await node.request<ErrorJson>(
      'GET',
      `/api/v1/access/${analystRelease}/data?purpose=training_steering`,
      { headers: { authorization: `Bearer ${coachToken.token}` } },
    );
    expect(wrongRole.status).toBe(403);
    expect(wrongRole.json.error.reason).toBe('recipient_mismatch');
  });

  test('Produktliste zählt aktive Freigaben', async () => {
    const res = await node.request<Product>('GET', `/api/v1/products/${productId}`, { as: steward });
    // analyst, coach, bi (widerrufen/abgelaufen/veraltet zählen nicht)
    expect(res.json.activeReleaseCount).toBe(3);
  });
});

/** Minimale Wohlgeformtheitsprüfung: Tags balanciert, keine rohen & oder < im Text. */
function isWellFormed(xml: string): boolean {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  const re =
    /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[A-Za-z_][\w.-]*="[^"<&]*(?:&(?:amp|lt|gt|quot|apos);[^"<&]*)*")*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let roots = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: Tokenizer-Schleife
  while ((m = re.exec(body))) {
    const text = body.slice(last, m.index);
    if (/[<]/.test(text) || /&(?!(amp|lt|gt|quot|apos);)/.test(text)) return false;
    last = re.lastIndex;
    const [, closing, name, , selfClosing] = m;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else if (!selfClosing) {
      if (stack.length === 0) roots++;
      stack.push(name!);
    } else if (stack.length === 0) roots++;
  }
  return stack.length === 0 && roots === 1 && body.slice(last).trim() === '';
}
