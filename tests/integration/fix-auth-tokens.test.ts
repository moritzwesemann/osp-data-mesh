/**
 * Regression (Sicherheitsbefund 2): API-Tokens überdauern weder den eigenen Passwortwechsel noch das
 * Zurücksetzen durch die Administration noch eine Deaktivierung; Tokens können keine Tokens erzeugen.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestNode, type TestNode, type TestResponse, type TestUser } from '../helpers/node.ts';

interface ErrorJson {
  error: { code: string; reason?: string };
}

let node: TestNode;
let admin: TestUser;
let ipCounter = 0;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const me = (token: string) => node.request('GET', '/api/v1/auth/me', { headers: bearer(token) });

async function mint(u: TestUser, name = 'excel'): Promise<{ token: string; id: string }> {
  const r = await node.request<{ token: string; item: { id: string } }>('POST', '/api/v1/auth/tokens', {
    as: u,
    body: { name },
  });
  expect(r.status).toBe(200);
  return { token: r.json.token, id: r.json.item.id };
}

async function tokenRow(id: string) {
  return node.deps.db.selectFrom('api_token').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

async function audit(action: string) {
  return node.deps.db
    .selectFrom('audit_log')
    .selectAll()
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
}

function cookieOf(r: TestResponse): string {
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

function login(email: string, password: string) {
  ipCounter++;
  return node.request('POST', '/api/v1/auth/login', {
    body: { email, password },
    headers: { 'x-forwarded-for': `10.2.0.${ipCounter}` },
  });
}

beforeAll(async () => {
  node = await createTestNode({ config: { MESH_TRUST_PROXY: 'true' } });
  admin = await node.user(['admin']);
});
afterAll(async () => {
  await node?.close();
});

describe('API-Tokens und Zugangswechsel', () => {
  test('eigener Passwortwechsel widerruft alle Tokens der Person – auch ein mit gestohlener Sitzung erzeugtes', async () => {
    const victim = await node.user(['analyst']);
    const bystander = await node.user(['analyst']);
    const stolen = await mint(victim, 'angreifer');
    const own = await mint(victim, 'power bi');
    const other = await mint(bystander);
    expect((await me(stolen.token)).status).toBe(200);

    const changed = await node.request('POST', '/api/v1/auth/password', {
      as: victim,
      body: { currentPassword: victim.password, newPassword: 'ein ganz neues passwort 1' },
    });
    expect(changed.status).toBe(200);

    expect((await me(stolen.token)).status).toBe(401);
    expect((await me(own.token)).status).toBe(401);
    expect((await tokenRow(stolen.id)).revoked_at).not.toBeNull();
    // Tokens anderer Personen bleiben gültig
    expect((await me(other.token)).status).toBe(200);

    const revokes = (await audit('token.revoke')).filter((e) => [stolen.id, own.id].includes(e.object_id!));
    expect(revokes).toHaveLength(2);
    expect(revokes.every((e) => (e.details as { reason: string }).reason === 'password_change')).toBe(true);
    const change = (await audit('auth.password_change')).filter((e) => e.object_id === victim.id).at(-1)!;
    expect(change.details).toMatchObject({ tokensRevoked: 2 });

    // danach erzeugte Tokens funktionieren
    const fresh = await mint(victim);
    expect((await me(fresh.token)).status).toBe(200);
  });

  test('Zurücksetzen durch die Administration widerruft Tokens – auch nach dem erzwungenen Wechsel bleiben sie ungültig', async () => {
    const victim = await node.user(['coach']);
    const stolen = await mint(victim);
    const reset = await node.request('POST', `/api/v1/users/${victim.id}/reset-password`, {
      as: admin,
      body: { password: 'vom admin gesetzt 42' },
    });
    expect(reset.status).toBe(200);
    expect((await me(stolen.token)).status).toBe(401);
    expect((await audit('user.reset_password')).at(-1)!.details).toMatchObject({ tokensRevoked: 1 });

    const l = await login(victim.email, 'vom admin gesetzt 42');
    expect(l.status).toBe(200);
    const session: TestUser = { ...victim, cookie: cookieOf(l) };
    const forced = await node.request('POST', '/api/v1/auth/password', {
      as: session,
      body: { currentPassword: 'vom admin gesetzt 42', newPassword: 'mein eigenes passwort 7' },
    });
    expect(forced.status).toBe(200);
    expect((await me(stolen.token)).status).toBe(401);
    const revoke = (await audit('token.revoke')).find((e) => e.object_id === stolen.id)!;
    expect(revoke.details).toMatchObject({ reason: 'password_reset' });
  });

  test('Deaktivierung widerruft Tokens; nach der Reaktivierung bleiben sie ungültig', async () => {
    const u = await node.user(['analyst']);
    const t = await mint(u);
    const off = await node.request('PATCH', `/api/v1/users/${u.id}`, { as: admin, body: { active: false } });
    expect(off.status).toBe(200);
    const on = await node.request('PATCH', `/api/v1/users/${u.id}`, { as: admin, body: { active: true } });
    expect(on.status).toBe(200);
    expect((await me(t.token)).status).toBe(401);
    expect((await tokenRow(t.id)).revoked_at).not.toBeNull();
    const update = (await audit('user.update')).filter((e) => e.object_id === u.id);
    expect(update[0]!.details).toMatchObject({ changed: ['active'], tokensRevoked: 1 });
    expect((await audit('token.revoke')).find((e) => e.object_id === t.id)!.details).toMatchObject({
      reason: 'user_deactivated',
    });
  });

  test('ein Token kann keine Tokens erzeugen (nur mit Sitzung) → 403 forbidden', async () => {
    const u = await node.user(['analyst']);
    const t = await mint(u);
    const r = await node.request<ErrorJson>('POST', '/api/v1/auth/tokens', {
      headers: bearer(t.token),
      body: { name: 'nachschub' },
      csrf: false,
    });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatchObject({ code: 'forbidden', reason: 'session_required' });
    const tokens = await node.deps.db
      .selectFrom('api_token')
      .select('id')
      .where('user_id', '=', u.id)
      .execute();
    expect(tokens).toHaveLength(1);
    const denied = (await audit('token.create')).filter((e) => e.outcome === 'denied' && e.actor_id === u.id);
    expect(denied).toHaveLength(1);
    // mit Sitzung weiterhin möglich; das Token selbst bleibt nutzbar
    await mint(u, 'zweites');
    expect((await me(t.token)).status).toBe(200);
  });
});
