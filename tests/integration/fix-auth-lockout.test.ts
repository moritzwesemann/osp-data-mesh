/**
 * Regression (Sicherheitsbefund 3): Die Anmeldung verrät nicht, ob ein Konto existiert oder gesperrt ist –
 * gesperrte Konten antworten wie eine falsche Anmeldung (401 invalid_credentials). Die Sperre selbst und
 * der wahre Grund im Audit-Log bleiben; die Administration kann entsperren.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MAX_FAILED_LOGINS } from '../../src/server/modules/auth/policy.ts';
import { createTestNode, type TestNode, type TestResponse, type TestUser } from '../helpers/node.ts';

interface ErrorJson {
  error: { code: string; requestId: string; reason?: string };
}

let node: TestNode;
let admin: TestUser;
let ipCounter = 0;

function login(email: string, password: string) {
  ipCounter++;
  return node.request<ErrorJson>('POST', '/api/v1/auth/login', {
    body: { email, password },
    headers: { 'x-forwarded-for': `10.3.0.${ipCounter}` },
  });
}

/** Vergleichbare Form einer Antwort (ohne Request-ID) */
function shape(r: TestResponse<ErrorJson>) {
  return {
    status: r.status,
    code: r.json.error.code,
    keys: Object.keys(r.json.error).sort(),
    cookie: r.headers.get('set-cookie'),
  };
}

beforeAll(async () => {
  node = await createTestNode({ config: { MESH_TRUST_PROXY: 'true' } });
  admin = await node.user(['admin']);
});
afterAll(async () => {
  await node?.close();
});

describe('Anmeldung: keine Konto-Aufzählung über die Sperre', () => {
  test('gesperrtes Konto antwortet wie eine unbekannte E-Mail-Adresse – auch beim sperrenden Versuch und mit richtigem Passwort', async () => {
    const u = await node.user(['analyst']);
    const unknown = shape(await login(`niemand.${crypto.randomUUID()}@example.org`, 'irgendein passwort'));
    expect(unknown).toEqual({
      status: 401,
      code: 'invalid_credentials',
      keys: ['code', 'requestId'],
      cookie: null,
    });

    const attempts = [];
    for (let i = 1; i <= MAX_FAILED_LOGINS + 2; i++)
      attempts.push(shape(await login(u.email, `falsch-${i}-xx`)));
    attempts.push(shape(await login(u.email, u.password)));
    for (const a of attempts) expect(a).toEqual(unknown);

    // die Sperre besteht trotzdem, der Grund steht im Audit-Log
    const row = await node.deps.db
      .selectFrom('app_user')
      .select('locked_until')
      .where('id', '=', u.id)
      .executeTakeFirstOrThrow();
    expect(row.locked_until!.getTime()).toBeGreaterThan(Date.now());
    const reasons = (
      await node.deps.db
        .selectFrom('audit_log')
        .select('details')
        .where('action', '=', 'auth.login')
        .where('object_id', '=', u.id)
        .orderBy('seq')
        .execute()
    ).map((e) => (e.details as { reason: string; locked?: boolean }).reason);
    expect(reasons.slice(0, MAX_FAILED_LOGINS)).toEqual(Array(MAX_FAILED_LOGINS).fill('invalid_credentials'));
    expect(reasons.slice(MAX_FAILED_LOGINS)).toEqual(['locked', 'locked', 'locked']);
  });

  test('Administration hebt die Sperre auf (users.update unlock)', async () => {
    const u = await node.user(['coach']);
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await login(u.email, `falsch-${i}-xx`);
    expect((await login(u.email, u.password)).status).toBe(401);
    const r = await node.request<{ lockedUntil: string | null }>('PATCH', `/api/v1/users/${u.id}`, {
      as: admin,
      body: { unlock: true },
    });
    expect(r.status).toBe(200);
    expect(r.json.lockedUntil).toBeNull();
    expect((await login(u.email, u.password)).status).toBe(200);
  });
});
