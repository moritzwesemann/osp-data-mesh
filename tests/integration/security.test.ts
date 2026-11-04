import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { createSession } from '../../src/server/modules/auth/sessions.ts';
import { createTestNode, type TestNode, type TestResponse, type TestUser } from '../helpers/node.ts';

interface ErrorJson {
  error: { code: string; requestId: string; reason?: string; fields?: Record<string, string> };
}
interface LoginJson {
  user: { id: string; email: string; roles: string[]; mustChangePassword: boolean };
}

let node: TestNode;
let offsetMs = 0;
let ipCounter = 0;
let admin: TestUser;

const freshIp = () => {
  ipCounter++;
  return `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
};

function login(email: string, password: string, ip = freshIp(), csrf = true) {
  return node.request<LoginJson & ErrorJson>('POST', '/api/v1/auth/login', {
    body: { email, password },
    headers: { 'x-forwarded-for': ip },
    csrf,
  });
}

function cookieOf(r: TestResponse): string {
  const sc = r.headers.get('set-cookie');
  if (!sc) throw new Error('no set-cookie header');
  return sc.split(';')[0]!;
}

function as(user: TestUser, cookie: string): TestUser {
  return { ...user, cookie };
}

async function auditRows(action: string, outcome?: string) {
  let q = node.deps.db.selectFrom('audit_log').selectAll().where('action', '=', action);
  if (outcome) q = q.where('outcome', '=', outcome as 'denied');
  return q.orderBy('seq', 'desc').execute();
}

beforeAll(async () => {
  node = await createTestNode({
    now: () => new Date(Date.now() + offsetMs),
    config: { MESH_TRUST_PROXY: 'true' },
  });
  admin = await node.user(['admin']);
});
afterAll(async () => {
  await node?.close();
});
afterEach(() => {
  offsetMs = 0;
});

describe('Anmeldung', () => {
  test('Login setzt HttpOnly-/SameSite=Strict-Cookie, Sitzung funktioniert, Audit "auth.login"', async () => {
    const u = await node.user(['analyst']);
    const r = await login(u.email.toUpperCase(), u.password);
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(u.email);
    expect(r.json.user.roles).toEqual(['analyst']);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/^osp_session=[A-Za-z0-9_-]{40,}/);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Strict');
    expect(sc).toContain('Path=/');
    expect(sc).toContain(`Max-Age=${12 * 3600}`);
    expect(sc).not.toContain('Secure');

    const me = await node.request<{ user: { id: string }; node: { nodeId: string; fingerprint: string } }>(
      'GET',
      '/api/v1/auth/me',
      { as: as(u, cookieOf(r)) },
    );
    expect(me.status).toBe(200);
    expect(me.json.user.id).toBe(u.id);
    expect(me.json.node.nodeId).toBe(node.nodeId);
    expect(me.json.node.fingerprint).toBe(node.deps.identity.fingerprint);

    const row = await node.deps.db
      .selectFrom('app_user')
      .select('last_login_at')
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(row.last_login_at).not.toBeNull();
    const audit = (await auditRows('auth.login', 'success')).find((a) => a.actor_id === u.id);
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit!.details)).not.toContain(u.password);
  });

  test('Secure-Flag, wenn MESH_COOKIE_SECURE aktiv ist', async () => {
    const u = await node.user(['coach']);
    node.deps.config.MESH_COOKIE_SECURE = true;
    try {
      const r = await login(u.email, u.password);
      expect(r.status).toBe(200);
      expect(r.headers.get('set-cookie')).toContain('Secure');
    } finally {
      node.deps.config.MESH_COOKIE_SECURE = false;
    }
  });

  test('falsches Passwort → 401 invalid_credentials, Audit "denied" ohne Passwort', async () => {
    const u = await node.user(['analyst']);
    const r = await login(u.email, 'falsches passwort 123');
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('invalid_credentials');
    expect(r.json.error.requestId).toBeTruthy();
    expect(r.headers.get('set-cookie')).toBeNull();
    const denied = (await auditRows('auth.login', 'denied')).find((a) => a.object_id === u.id);
    expect(denied).toBeDefined();
    expect((denied!.details as { reason: string }).reason).toBe('invalid_credentials');
    expect(JSON.stringify(denied)).not.toContain('falsches passwort 123');
  });

  test('unbekannte E-Mail → gleiche 401-Antwort', async () => {
    const u = await node.user(['analyst']);
    const wrongPw = await login(u.email, 'falsches passwort 123');
    const unknown = await login(`niemand.${crypto.randomUUID()}@example.org`, 'irgendein passwort');
    expect(unknown.status).toBe(401);
    expect(unknown.json.error.code).toBe(wrongPw.json.error.code);
    expect(Object.keys(unknown.json.error).sort()).toEqual(Object.keys(wrongPw.json.error).sort());
    const denied = await auditRows('auth.login', 'denied');
    expect(denied[0]!.object_id).toBeNull();
    expect(JSON.stringify(denied[0]!.details)).not.toContain('niemand');
  });

  test('Kontosperre nach 5 Fehlversuchen → einheitlich 401 auch mit richtigem Passwort; nach 15 min wieder frei', async () => {
    const u = await node.user(['analyst']);
    const ip = freshIp();
    for (let i = 1; i <= 4; i++) {
      const r = await login(u.email, `falsch-falsch-${i}`, ip);
      expect(r.status).toBe(401);
    }
    const fifth = await login(u.email, 'falsch-falsch-5', ip);
    expect(fifth.status).toBe(401);
    expect(fifth.json.error.code).toBe('invalid_credentials');
    const lockedRow = await node.deps.db
      .selectFrom('app_user')
      .select('locked_until')
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(lockedRow.locked_until!.getTime()).toBeGreaterThan(node.deps.now().getTime());

    // Sperre gilt auch mit richtigem Passwort; der wahre Grund steht nur im Audit-Log
    const correctWhileLocked = await login(u.email, u.password, ip);
    expect(correctWhileLocked.status).toBe(401);
    expect(correctWhileLocked.json.error.code).toBe('invalid_credentials');
    expect(correctWhileLocked.headers.get('set-cookie')).toBeNull();
    const locked = await auditRows('auth.login', 'denied');
    expect((locked[0]!.details as { reason: string }).reason).toBe('locked');

    offsetMs = 14 * 60_000;
    expect((await login(u.email, u.password, ip)).status).toBe(401);

    offsetMs = 16 * 60_000;
    const after = await login(u.email, u.password, ip);
    expect(after.status).toBe(200);
    const row = await node.deps.db
      .selectFrom('app_user')
      .select(['failed_logins', 'locked_until'])
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(row.failed_logins).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  test('Fehlversuche werden nach erfolgreicher Anmeldung zurückgesetzt', async () => {
    const u = await node.user(['analyst']);
    for (let i = 0; i < 4; i++) await login(u.email, `falsch-falsch-${i}`);
    expect((await login(u.email, u.password)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(u.email, `falsch-falsch-${i}`)).status).toBe(401);
    expect((await login(u.email, u.password)).status).toBe(200);
  });

  test('Admin hebt Sperre auf', async () => {
    const u = await node.user(['analyst']);
    for (let i = 0; i < 5; i++) await login(u.email, `falsch-falsch-${i}`);
    expect((await login(u.email, u.password)).status).toBe(401);
    const r = await node.request<{ lockedUntil: string | null }>('PATCH', `/api/v1/users/${u.id}`, {
      as: admin,
      body: { unlock: true },
    });
    expect(r.status).toBe(200);
    expect(r.json.lockedUntil).toBeNull();
    expect((await login(u.email, u.password)).status).toBe(200);
  });

  test('deaktiviertes Konto: Anmeldung abgewiesen, bestehende Sitzungen und Tokens ungültig', async () => {
    const u = await node.user(['analyst']);
    const tok = await node.request<{ token: string }>('POST', '/api/v1/auth/tokens', {
      as: u,
      body: { name: 'excel' },
    });
    expect(tok.status).toBe(200);
    expect((await node.request('GET', '/api/v1/auth/me', { as: u })).status).toBe(200);

    const r = await node.request<{ active: boolean }>('PATCH', `/api/v1/users/${u.id}`, {
      as: admin,
      body: { active: false },
    });
    expect(r.status).toBe(200);
    expect(r.json.active).toBe(false);

    expect((await node.request('GET', '/api/v1/auth/me', { as: u })).status).toBe(401);
    const bearer = await node.request('GET', '/api/v1/auth/me', {
      headers: { authorization: `Bearer ${tok.json.token}` },
    });
    expect(bearer.status).toBe(401);
    const l = await login(u.email, u.password);
    expect(l.status).toBe(401);
    expect(l.json.error.code).toBe('invalid_credentials');
    const denied = (await auditRows('auth.login', 'denied')).find((a) => a.object_id === u.id);
    expect((denied!.details as { reason: string }).reason).toBe('inactive');
  });

  test('Abmelden löscht Sitzung und Cookie', async () => {
    const u = await node.user(['coach']);
    const r = await node.request('POST', '/api/v1/auth/logout', { as: u });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/osp_session=;.*Max-Age=0/);
    expect((await node.request('GET', '/api/v1/auth/me', { as: u })).status).toBe(401);
    expect((await auditRows('auth.logout')).some((a) => a.actor_id === u.id)).toBe(true);
  });

  test('abgelaufene Sitzung wird abgewiesen', async () => {
    const u = await node.user(['analyst']);
    const { token } = await createSession(node.deps.db, u.id, 1, null, null, node.deps.now());
    const user = as(u, `osp_session=${token}`);
    expect((await node.request('GET', '/api/v1/auth/me', { as: user })).status).toBe(200);
    offsetMs = 61 * 60_000;
    const r = await node.request<ErrorJson>('GET', '/api/v1/auth/me', { as: user });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthenticated');
  });

  test('Ratenbegrenzung je IP-Adresse → 429, nur einmal protokolliert', async () => {
    const ip = freshIp();
    const email = `rate.${crypto.randomUUID()}@example.org`;
    for (let i = 0; i < 30; i++) {
      const r = await login(email, 'falsches passwort', ip);
      expect(r.status).toBe(401);
    }
    const blocked = await login(email, 'falsches passwort', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe('rate_limited');
    expect((await login(email, 'falsches passwort', ip)).status).toBe(429);
    // richtiges Passwort hilft während der Sperre auch nicht
    const u = await node.user(['analyst']);
    expect((await login(u.email, u.password, ip)).status).toBe(429);
    // andere IP ist nicht betroffen
    expect((await login(u.email, u.password)).status).toBe(200);
    const limited = (await auditRows('auth.login', 'denied')).filter(
      (a) => (a.details as { reason: string }).reason === 'rate_limited' && a.ip === ip,
    );
    expect(limited.length).toBe(1);
    // nach Ablauf des Zeitfensters wieder möglich
    offsetMs = 5 * 60_000 + 1000;
    expect((await login(u.email, u.password, ip)).status).toBe(200);
  }, 60_000);
});

describe('CSRF, Rollen, Token', () => {
  test('fehlender CSRF-Header → 403 csrf_failed (Sitzung und Anmeldung)', async () => {
    const u = await node.user(['analyst']);
    const r = await node.request<ErrorJson>('POST', '/api/v1/auth/logout', { as: u, csrf: false });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('csrf_failed');
    expect((await node.request('GET', '/api/v1/auth/me', { as: u })).status).toBe(200);
    const l = await login(u.email, u.password, freshIp(), false);
    expect(l.status).toBe(403);
    expect(l.json.error.code).toBe('csrf_failed');
    const wrongValue = await node.request<ErrorJson>('POST', '/api/v1/auth/logout', {
      as: u,
      csrf: false,
      headers: { 'x-osp-csrf': 'yes' },
    });
    expect(wrongValue.status).toBe(403);
  });

  test('ohne Anmeldung → 401', async () => {
    const r = await node.request<ErrorJson>('GET', '/api/v1/users');
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthenticated');
  });

  test('Rollenprüfung: Analyst → Benutzerliste 403 + Audit access.forbidden; Auditor → Systemstatus 403', async () => {
    const analyst = await node.user(['analyst']);
    const r = await node.request<ErrorJson>('GET', '/api/v1/users', { as: analyst });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden');
    const forbidden = (await auditRows('access.forbidden', 'denied')).find((a) => a.actor_id === analyst.id);
    expect(forbidden?.object_id).toBe('users.list');

    const auditor = await node.user(['auditor']);
    expect((await node.request('GET', '/api/v1/system/status', { as: auditor })).status).toBe(403);
    expect((await node.request('POST', '/api/v1/system/backups', { as: auditor })).status).toBe(403);
    expect((await node.request('GET', '/api/v1/users', { as: admin })).status).toBe(200);
  });

  test('Benutzerliste enthält keine Passwort-Hashes', async () => {
    const r = await node.request<{ items: Record<string, unknown>[] }>('GET', '/api/v1/users', { as: admin });
    expect(r.status).toBe(200);
    expect(r.json.items.length).toBeGreaterThan(0);
    expect(r.text).not.toContain('argon2');
    expect(r.json.items[0]).not.toHaveProperty('passwordHash');
  });

  test('API-Token: anlegen → Bearer ohne CSRF → widerrufen → 401', async () => {
    const u = await node.user(['analyst']);
    const created = await node.request<{ token: string; item: { id: string; prefix: string } }>(
      'POST',
      '/api/v1/auth/tokens',
      { as: u, body: { name: 'Power BI', expiresInDays: 30 } },
    );
    expect(created.status).toBe(200);
    const { token, item } = created.json;
    expect(token.startsWith('osp_')).toBe(true);
    expect(token.startsWith(item.prefix)).toBe(true);
    const stored = await node.deps.db
      .selectFrom('api_token')
      .selectAll()
      .where('id', '=', item.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);

    const bearer = { authorization: `Bearer ${token}` };
    const me = await node.request<{ user: { id: string } }>('GET', '/api/v1/auth/me', { headers: bearer });
    expect(me.status).toBe(200);
    expect(me.json.user.id).toBe(u.id);
    // zustandsändernde Anfrage mit Token braucht keinen CSRF-Header
    const second = await node.request<{ item: { id: string } }>('POST', '/api/v1/auth/tokens', {
      as: u,
      body: { name: 'python' },
    });
    const viaToken = await node.request('DELETE', `/api/v1/auth/tokens/${second.json.item.id}`, {
      headers: bearer,
      csrf: false,
    });
    expect(viaToken.status).toBe(200);

    const list = await node.request<{ items: { id: string; lastUsedAt: string | null }[] }>(
      'GET',
      '/api/v1/auth/tokens',
      { as: u },
    );
    expect(list.json.items.map((t) => t.id)).toContain(item.id);
    expect(list.text).not.toContain(token);
    expect(list.json.items.find((t) => t.id === item.id)?.lastUsedAt).not.toBeNull();

    // fremde Tokens können nicht widerrufen werden
    const other = await node.user(['analyst']);
    expect((await node.request('DELETE', `/api/v1/auth/tokens/${item.id}`, { as: other })).status).toBe(404);

    const revoke = await node.request('DELETE', `/api/v1/auth/tokens/${item.id}`, { as: u });
    expect(revoke.status).toBe(200);
    expect((await node.request('GET', '/api/v1/auth/me', { headers: bearer })).status).toBe(401);
    expect((await auditRows('token.create')).some((a) => a.object_id === item.id)).toBe(true);
    expect((await auditRows('token.revoke')).some((a) => a.object_id === item.id)).toBe(true);
  });

  test('abgelaufenes Token wird abgewiesen', async () => {
    const u = await node.user(['analyst']);
    const created = await node.request<{ token: string }>('POST', '/api/v1/auth/tokens', {
      as: u,
      body: { name: 'kurz', expiresInDays: 1 },
    });
    const bearer = { authorization: `Bearer ${created.json.token}` };
    expect((await node.request('GET', '/api/v1/auth/me', { headers: bearer })).status).toBe(200);
    offsetMs = 25 * 3600_000;
    expect((await node.request('GET', '/api/v1/auth/me', { headers: bearer })).status).toBe(401);
  });
});

describe('Passwörter und Benutzerverwaltung', () => {
  test('erzwungener Passwortwechsel: nur me/logout/password erreichbar', async () => {
    const email = `neu.${crypto.randomUUID().slice(0, 8)}@example.org`;
    const created = await node.request<{ id: string; mustChangePassword: boolean }>('POST', '/api/v1/users', {
      as: admin,
      body: { email, displayName: 'Neue Person', roles: ['analyst'], password: 'initial-passwort-1' },
    });
    expect(created.status).toBe(200);
    expect(created.json.mustChangePassword).toBe(true);

    const l = await login(email, 'initial-passwort-1');
    expect(l.status).toBe(200);
    expect(l.json.user.mustChangePassword).toBe(true);
    const u: TestUser = {
      id: created.json.id,
      email,
      password: 'initial-passwort-1',
      roles: ['analyst'],
      cookie: cookieOf(l),
    };
    const blocked = await node.request<ErrorJson>('GET', '/api/v1/auth/tokens', { as: u });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.reason).toBe('password_change_required');
    expect((await node.request('GET', '/api/v1/auth/me', { as: u })).status).toBe(200);

    const changed = await node.request('POST', '/api/v1/auth/password', {
      as: u,
      body: { currentPassword: 'initial-passwort-1', newPassword: 'mein neues langes passwort' },
    });
    expect(changed.status).toBe(200);
    expect((await node.request('GET', '/api/v1/auth/tokens', { as: u })).status).toBe(200);
    expect((await login(email, 'mein neues langes passwort')).status).toBe(200);
    expect((await login(email, 'initial-passwort-1')).status).toBe(401);
  });

  test('Passwortregeln: Mindestlänge, nicht E-Mail, nicht bisheriges Passwort; falsches aktuelles Passwort', async () => {
    const u = await node.user(['analyst'], {
      email: `policy.${crypto.randomUUID().slice(0, 6)}@example.org`,
    });
    const change = (currentPassword: string, newPassword: string) =>
      node.request<ErrorJson>('POST', '/api/v1/auth/password', {
        as: u,
        body: { currentPassword, newPassword },
      });

    const short = await change(u.password, 'kurz');
    expect(short.status).toBe(400);
    expect(short.json.error.code).toBe('validation_failed');
    expect(short.json.error.fields?.['body.newPassword']).toBe('too_small');

    const sameAsEmail = await change(u.password, u.email.toUpperCase());
    expect(sameAsEmail.status).toBe(400);
    expect(sameAsEmail.json.error.code).toBe('password_too_weak');
    expect(sameAsEmail.json.error.reason).toBe('equals_email');

    const sameAsCurrent = await change(u.password, u.password);
    expect(sameAsCurrent.status).toBe(400);
    expect(sameAsCurrent.json.error.code).toBe('password_too_weak');

    const wrongCurrent = await change('nicht mein passwort', 'ein ganz neues passwort');
    expect(wrongCurrent.status).toBe(401);
    expect(wrongCurrent.json.error.code).toBe('invalid_credentials');

    const weakCreate = await node.request<ErrorJson>('POST', '/api/v1/users', {
      as: admin,
      body: {
        email: 'gleich.wie.mail@example.org',
        displayName: 'X',
        roles: ['coach'],
        password: 'gleich.wie.mail@example.org',
      },
    });
    expect(weakCreate.status).toBe(400);
    expect(weakCreate.json.error.code).toBe('password_too_weak');
  });

  test('Passwortwechsel beendet alle anderen Sitzungen, die aktuelle bleibt', async () => {
    const u = await node.user(['analyst']);
    const second = cookieOf(await login(u.email, u.password));
    const r = await node.request('POST', '/api/v1/auth/password', {
      as: u,
      body: { currentPassword: u.password, newPassword: 'ein anderes langes passwort' },
    });
    expect(r.status).toBe(200);
    expect((await node.request('GET', '/api/v1/auth/me', { as: u })).status).toBe(200);
    expect((await node.request('GET', '/api/v1/auth/me', { as: as(u, second) })).status).toBe(401);
  });

  test('Zurücksetzen durch Admin beendet alle Sitzungen und erzwingt Passwortwechsel', async () => {
    const u = await node.user(['coach']);
    const second = cookieOf(await login(u.email, u.password));
    const r = await node.request('POST', `/api/v1/users/${u.id}/reset-password`, {
      as: admin,
      body: { password: 'vom admin gesetzt 42' },
    });
    expect(r.status).toBe(200);
    expect((await node.request('GET', '/api/v1/auth/me', { as: u })).status).toBe(401);
    expect((await node.request('GET', '/api/v1/auth/me', { as: as(u, second) })).status).toBe(401);
    expect((await login(u.email, u.password)).status).toBe(401);
    const l = await login(u.email, 'vom admin gesetzt 42');
    expect(l.status).toBe(200);
    expect(l.json.user.mustChangePassword).toBe(true);
    expect((await auditRows('user.reset_password')).some((a) => a.object_id === u.id)).toBe(true);
  });

  test('doppelte E-Mail → 409 conflict', async () => {
    const u = await node.user(['analyst']);
    const r = await node.request<ErrorJson>('POST', '/api/v1/users', {
      as: admin,
      body: {
        email: u.email.toUpperCase(),
        displayName: 'Doppelt',
        roles: ['analyst'],
        password: 'ein langes passwort',
      },
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('conflict');
  });

  test('Rollenänderung wird mit alten und neuen Rollen protokolliert; unbekannte Person → 404', async () => {
    const u = await node.user(['analyst']);
    const r = await node.request<{ roles: string[] }>('PATCH', `/api/v1/users/${u.id}`, {
      as: admin,
      body: { roles: ['analyst', 'coach', 'coach'], locale: 'en' },
    });
    expect(r.status).toBe(200);
    expect(r.json.roles).toEqual(['analyst', 'coach']);
    const entry = (await auditRows('user.update')).find((a) => a.object_id === u.id);
    expect(entry?.details).toMatchObject({
      changed: ['locale', 'roles'],
      roles: { old: ['analyst'], new: ['analyst', 'coach'] },
    });
    const missing = await node.request('PATCH', `/api/v1/users/${crypto.randomUUID()}`, {
      as: admin,
      body: { active: true },
    });
    expect(missing.status).toBe(404);
  });

  test('Admin kann sich nicht selbst die Admin-Rolle entziehen oder sich deaktivieren', async () => {
    const a = await node.user(['admin']);
    const demote = await node.request<ErrorJson>('PATCH', `/api/v1/users/${a.id}`, {
      as: a,
      body: { roles: ['analyst'] },
    });
    expect(demote.status).toBe(409);
    expect(demote.json.error.reason).toBe('cannot_remove_own_admin_role');
    const deactivate = await node.request<ErrorJson>('PATCH', `/api/v1/users/${a.id}`, {
      as: a,
      body: { active: false },
    });
    expect(deactivate.status).toBe(409);
    expect(deactivate.json.error.reason).toBe('cannot_deactivate_self');
    // andere Admins dürfen herabgestuft werden, solange eine aktive Admin-Person bleibt
    const ok = await node.request('PATCH', `/api/v1/users/${a.id}`, {
      as: admin,
      body: { roles: ['auditor'] },
    });
    expect(ok.status).toBe(200);
  });
});

describe('Letzte Administratorin', () => {
  test('gleichzeitiges gegenseitiges Herabstufen: mindestens eine aktive Admin-Person bleibt', async () => {
    const fresh = await createTestNode();
    try {
      const a = await fresh.user(['admin']);
      const b = await fresh.user(['admin']);
      const [ra, rb] = await Promise.all([
        fresh.request<ErrorJson>('PATCH', `/api/v1/users/${b.id}`, { as: a, body: { active: false } }),
        fresh.request<ErrorJson>('PATCH', `/api/v1/users/${a.id}`, { as: b, body: { roles: ['analyst'] } }),
      ]);
      const statuses = [ra.status, rb.status].sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409, 401]).toContain(statuses[1]!);
      const loser = ra.status === 200 ? rb : ra;
      if (loser.status === 409) expect(loser.json.error.reason).toBe('last_admin');
      const admins = await fresh.deps.db
        .selectFrom('app_user')
        .select('id')
        .where('active', '=', true)
        .where(sql<boolean>`'admin' = any(roles)`)
        .execute();
      expect(admins.length).toBe(1);
    } finally {
      await fresh.close();
    }
  });
});
