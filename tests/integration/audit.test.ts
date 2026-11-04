import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { AuditEntry } from '../../src/shared/contract/system.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';

interface Page {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

let node: TestNode;
let auditor: TestUser;
let admin: TestUser;
let analyst: TestUser;
let midpoint: string;

beforeAll(async () => {
  node = await createTestNode();
  auditor = await node.user(['auditor']);
  admin = await node.user(['admin']);
  analyst = await node.user(['analyst']);
  const rec = (action: string, extra: Partial<Parameters<typeof node.deps.audit.record>[0]> = {}) =>
    node.deps.audit.record({ actor: { type: 'system', label: 'test' }, action, ...extra });
  await rec('test.alpha', { objectType: 'thing', objectId: 'x1', details: { n: 1 } });
  await rec('test.alpha', { objectType: 'thing', objectId: 'x2', details: { n: 2 } });
  await Bun.sleep(5);
  midpoint = new Date().toISOString();
  await Bun.sleep(5);
  await rec('test.alpha', { objectType: 'thing', objectId: 'x1', details: { n: 3 } });
  await rec('test.beta', {
    outcome: 'denied',
    actor: { type: 'user', id: analyst.id, label: analyst.email },
  });
  await rec('test.beta', { outcome: 'denied', actor: { type: 'peer', id: 'osp-nachbar', label: 'Nachbar' } });
  await rec('testXbeta', { actor: { type: 'system', label: '=HYPERLINK("http://evil")' } });
});
afterAll(async () => {
  await node?.close();
});

const list = (query: string, as: TestUser = auditor) =>
  node.request<Page>('GET', `/api/v1/audit?${query}`, { as });

describe('audit.list', () => {
  test('neueste zuerst, Felder gemäß Vertrag', async () => {
    const r = await list('');
    expect(r.status).toBe(200);
    expect(r.json.total).toBeGreaterThanOrEqual(6);
    const seqs = r.json.items.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    for (const e of r.json.items) expect(AuditEntry.safeParse(e).success).toBe(true);
    expect(r.json.items[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('Filter: action (exakt und Präfix), outcome, objectType/objectId, actorId', async () => {
    const alpha = await list('action=test.alpha');
    expect(alpha.json.total).toBe(3);
    expect(alpha.json.items.every((e) => e.action === 'test.alpha')).toBe(true);
    expect(alpha.json.items.map((e) => e.details.n)).toEqual([3, 2, 1]);

    // "_" und "%" sind keine Platzhalter; "*" nur am Ende als Präfixsuche
    expect((await list('action=test.*')).json.total).toBe(5);
    expect((await list('action=test_*')).json.total).toBe(0);

    const denied = await list('outcome=denied');
    expect(denied.json.items.map((e) => e.action)).toEqual(['test.beta', 'test.beta']);

    const obj = await list('objectType=thing&objectId=x1');
    expect(obj.json.total).toBe(2);

    const byActor = await list(`actorId=${analyst.id}`);
    expect(byActor.json.total).toBe(1);
    expect(byActor.json.items[0]!.actorType).toBe('user');
    expect(byActor.json.items[0]!.actorLabel).toBe(analyst.email);
  });

  test('Filter: Zeitraum', async () => {
    const after = await list(`action=test.alpha&from=${encodeURIComponent(midpoint)}`);
    expect(after.json.items.map((e) => e.details.n)).toEqual([3]);
    const before = await list(`action=test.alpha&to=${encodeURIComponent(midpoint)}`);
    expect(before.json.items.map((e) => e.details.n)).toEqual([2, 1]);
  });

  test('Seitenweise Abfrage', async () => {
    const p1 = await list('action=test.*&page=1&pageSize=2');
    const p2 = await list('action=test.*&page=2&pageSize=2');
    const p3 = await list('action=test.*&page=3&pageSize=2');
    expect(p1.json).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(p1.json.items.length).toBe(2);
    expect(p2.json.items.length).toBe(2);
    expect(p3.json.items.length).toBe(1);
    const ids = [...p1.json.items, ...p2.json.items, ...p3.json.items].map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
  });

  test('ungültige Filter → 400', async () => {
    expect((await list('outcome=kaputt')).status).toBe(400);
    expect((await list('pageSize=100000')).status).toBe(400);
    expect((await list('from=gestern')).status).toBe(400);
  });

  test('Rollen: Auditor und Admin dürfen lesen, Analyst nicht', async () => {
    expect((await list('', admin)).status).toBe(200);
    expect((await list('', analyst)).status).toBe(403);
    expect((await node.request('GET', '/api/v1/audit')).status).toBe(401);
  });
});

describe('audit.verify', () => {
  test('Kette ist gültig', async () => {
    const r = await node.request<{ ok: boolean; checked: number; firstBrokenSeq: number | null }>(
      'GET',
      '/api/v1/audit/verify',
      { as: auditor },
    );
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.firstBrokenSeq).toBeNull();
    expect(r.json.checked).toBeGreaterThanOrEqual(6);
    expect((await node.request('GET', '/api/v1/audit/verify', { as: admin })).status).toBe(200);
    expect((await node.request('GET', '/api/v1/audit/verify', { as: analyst })).status).toBe(403);
  });
});

describe('audit.export', () => {
  test('CSV: Download mit BOM, Kopfzeile, Formel-Schutz; Export wird selbst protokolliert', async () => {
    const before = await node.deps.db
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    const r = await node.request('GET', '/api/v1/audit/export?format=csv', { as: auditor });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-.*\.csv"$/);
    // UTF-8-BOM für Excel (TextDecoder entfernt ihn in r.text)
    const raw = await node.app.request('/api/v1/audit/export?format=csv', {
      headers: { cookie: auditor.cookie },
    });
    expect([...new Uint8Array(await raw.arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = r.text.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'id,seq,at,actorType,actorId,actorLabel,action,objectType,objectId,outcome,details,ip,requestId,hash',
    );
    expect(lines.length - 1).toBe(Number(before.n));
    expect(r.text).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(r.text).toContain('"{""n"":1}"');

    const exp = await node.deps.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'audit.export')
      .orderBy('seq', 'desc')
      .executeTakeFirst();
    expect(exp?.actor_id).toBe(auditor.id);
    expect(exp?.details).toMatchObject({ format: 'csv' });
  });

  test('JSON: gültiges Dokument, Einträge gemäß Vertrag, aufsteigend', async () => {
    const r = await node.request<{ items: AuditEntry[] }>(
      'GET',
      `/api/v1/audit/export?format=json&from=${encodeURIComponent(midpoint)}`,
      { as: auditor },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('content-disposition')).toContain('.json');
    expect(r.json.items.length).toBeGreaterThanOrEqual(4);
    for (const e of r.json.items) expect(AuditEntry.safeParse(e).success).toBe(true);
    const seqs = r.json.items.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(r.json.items.some((e) => e.action === 'test.alpha' && e.details.n === 1)).toBe(false);
  });

  test('großer Export über mehrere Blöcke', async () => {
    await sql`insert into audit_log (actor_type, action, outcome, details)
      select 'system', 'bulk.entry', 'success', jsonb_build_object('i', g) from generate_series(1, 2500) g`.execute(
      node.deps.db,
    );
    const total = await node.deps.db
      .selectFrom('audit_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    const json = await node.request<{ items: AuditEntry[] }>('GET', '/api/v1/audit/export?format=json', {
      as: auditor,
    });
    expect(json.status).toBe(200);
    expect(json.json.items.length).toBe(Number(total.n));
    expect(new Set(json.json.items.map((e) => e.seq)).size).toBe(json.json.items.length);
    const csv = await node.request('GET', '/api/v1/audit/export', { as: auditor });
    expect(csv.text.trimEnd().split('\r\n').length - 1).toBe(Number(total.n) + 1);
  });

  test('nur Auditor darf exportieren', async () => {
    expect((await node.request('GET', '/api/v1/audit/export?format=csv', { as: admin })).status).toBe(403);
    expect((await node.request('GET', '/api/v1/audit/export?format=json', { as: analyst })).status).toBe(403);
    expect((await node.request('GET', '/api/v1/audit/export?format=xml', { as: auditor })).status).toBe(400);
  });
});
