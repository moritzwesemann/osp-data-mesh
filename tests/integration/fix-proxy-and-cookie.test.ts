/**
 * Regression:
 *  - X-Forwarded-For wurde mit MESH_TRUST_PROXY=true von JEDER Gegenstelle übernommen (linkeste Adresse).
 *    Ein kompromittierter Dienst im selben Netz (z. B. Superset) konnte die Adresse eines Partners vorgeben
 *    und ihn in die Ratenbegrenzung der Föderation treiben, die Anmeldebegrenzung umgehen und
 *    Audit-Adressen fälschen. Jetzt nur von MESH_TRUSTED_PROXIES, rechteste nicht vertrauenswürdige Adresse.
 *  - Das Sitzungs-Cookie "osp_session" konnte von einem anderen Host derselben Domain (z. B. bi.<domain>)
 *    als Domain-Cookie gesetzt werden und überdeckte dann das echte (Hono nimmt das erste). Jetzt mit HTTPS
 *    "__Host-osp_session" (Secure, Path=/, ohne Domain); "osp_session" nur für lokales http.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createSession } from '../../src/server/modules/auth/sessions.ts';
import { MAX_REJECTIONS_PER_IP } from '../../src/server/modules/federation/guard.ts';
import { connEnv, createTestNode, type TestNode } from '../helpers/node.ts';

const nodes: TestNode[] = [];
afterAll(async () => {
  for (const n of nodes) await n.close();
});

async function node(config: Record<string, string>): Promise<TestNode> {
  const n = await createTestNode({ config });
  nodes.push(n);
  return n;
}

/** fehlgeschlagene Anmeldung von peer mit X-Forwarded-For; liefert die protokollierte Adresse */
async function loggedIp(n: TestNode, peer: string, xff?: string): Promise<string | null> {
  const r = await n.request('POST', '/api/v1/auth/login', {
    body: { email: `nobody-${crypto.randomUUID()}@example.org`, password: 'x' },
    headers: xff ? { 'x-forwarded-for': xff } : {},
    peer,
  });
  expect(r.status).toBe(401);
  const entry = await n.deps.db
    .selectFrom('audit_log')
    .select('ip')
    .where('action', '=', 'auth.login')
    .orderBy('seq', 'desc')
    .limit(1)
    .executeTakeFirstOrThrow();
  return entry.ip;
}

describe('X-Forwarded-For nur von vertrauenswürdigen Proxys (MESH_TRUSTED_PROXIES)', () => {
  let n: TestNode;
  beforeAll(async () => {
    n = await node({ MESH_TRUST_PROXY: 'true' });
  });

  test('Standard 127.0.0.1/::1: Adresse aus der Kette, rechteste nicht vertrauenswürdige', async () => {
    expect(await loggedIp(n, '127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(await loggedIp(n, '::1', '203.0.113.8')).toBe('203.0.113.8');
    // ein Client trägt links eine fremde Adresse ein: zählt nicht
    expect(await loggedIp(n, '127.0.0.1', '198.51.100.50, 203.0.113.9')).toBe('203.0.113.9');
    expect(await loggedIp(n, '127.0.0.1')).toBe('127.0.0.1');
  });

  test('andere Gegenstelle (z. B. Superset im selben Netz): X-Forwarded-For wird ignoriert', async () => {
    expect(await loggedIp(n, '172.31.252.20', '198.51.100.50')).toBe('172.31.252.20');
  });

  test('gefälschte Partneradresse treibt nur die eigene Adresse in die Ratenbegrenzung', async () => {
    const partnerIp = '198.51.100.50';
    const reject = (peer: string, node: string) =>
      n.app.request(
        '/federation/v1/ping',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mesh-node': node,
            'x-mesh-signature': 'AAAA',
            'x-forwarded-for': partnerIp,
          },
          body: '{}',
        },
        connEnv(peer),
      );
    for (let i = 0; i < MAX_REJECTIONS_PER_IP + 5; i++) await reject('172.31.252.20', `ghost-a${i}`);
    expect((await reject('172.31.252.20', 'ghost-a-last')).status).toBe(429);
    // der echte Partner (über den Proxy, Adresse aus X-Forwarded-For) ist nicht betroffen
    expect((await reject('127.0.0.1', 'ghost-b')).status).toBe(401);
  });

  test('ohne MESH_TRUST_PROXY: immer die Gegenstelle', async () => {
    const plain = await node({ MESH_TRUST_PROXY: 'false' });
    expect(await loggedIp(plain, '127.0.0.1', '203.0.113.7')).toBe('127.0.0.1');
  });

  test('eigene Liste (Docker: Caddy 172.31.252.10): nur diese Adresse darf die Client-Adresse setzen', async () => {
    const docker = await node({ MESH_TRUST_PROXY: 'true', MESH_TRUSTED_PROXIES: '172.31.252.10' });
    expect(await loggedIp(docker, '172.31.252.10', '203.0.113.7')).toBe('203.0.113.7');
    expect(await loggedIp(docker, '::ffff:172.31.252.10', '203.0.113.8')).toBe('203.0.113.8');
    expect(await loggedIp(docker, '127.0.0.1', '203.0.113.7')).toBe('127.0.0.1');
    expect(await loggedIp(docker, '172.31.252.11', '203.0.113.7')).toBe('172.31.252.11');
  });
});

describe('Sitzungs-Cookie mit Präfix __Host- (MESH_COOKIE_SECURE=true)', () => {
  let n: TestNode;
  beforeAll(async () => {
    n = await node({ MESH_COOKIE_SECURE: 'true' });
  });

  test('Anmeldung setzt __Host-osp_session mit Secure, Path=/ und ohne Domain', async () => {
    const u = await n.user(['analyst']);
    const r = await n.request('POST', '/api/v1/auth/login', {
      body: { email: u.email, password: u.password },
    });
    expect(r.status).toBe(200);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/^__Host-osp_session=[A-Za-z0-9_-]{40,};/);
    expect(sc).toContain('Secure');
    expect(sc).toContain('Path=/');
    expect(sc).toContain('HttpOnly');
    expect(sc).not.toMatch(/domain=/i);
    const cookie = sc.split(';')[0]!;
    const me = await n.request<{ user: { id: string } }>('GET', '/api/v1/auth/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(me.json.user.id).toBe(u.id);

    const out = await n.request('POST', '/api/v1/auth/logout', { headers: { cookie } });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/^__Host-osp_session=;.*Max-Age=0/);
  });

  test('ein von einem anderen Host gesetztes osp_session überdeckt die Sitzung nicht', async () => {
    const victim = await n.user(['analyst']);
    const attacker = await n.user(['analyst']);
    const victimToken = (await createSession(n.deps.db, victim.id, 1, null, null)).token;
    const attackerToken = (await createSession(n.deps.db, attacker.id, 1, null, null)).token;
    // Browser sendet das Domain-Cookie des anderen Hosts (zuerst) und das eigene __Host-Cookie
    const both = await n.request<{ user: { id: string } }>('GET', '/api/v1/auth/me', {
      headers: { cookie: `osp_session=${attackerToken}; __Host-osp_session=${victimToken}` },
    });
    expect(both.status).toBe(200);
    expect(both.json.user.id).toBe(victim.id);
    // ein osp_session allein gilt bei HTTPS nicht
    const plain = await n.request('GET', '/api/v1/auth/me', {
      headers: { cookie: `osp_session=${attackerToken}` },
    });
    expect(plain.status).toBe(401);
  });

  test('lokales http (MESH_COOKIE_SECURE=false): osp_session ohne Secure', async () => {
    const local = await node({ MESH_COOKIE_SECURE: 'false' });
    const u = await local.user(['analyst']);
    const r = await local.request('POST', '/api/v1/auth/login', {
      body: { email: u.email, password: u.password },
    });
    expect(r.status).toBe(200);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/^osp_session=/);
    expect(sc).not.toContain('Secure');
  });
});
