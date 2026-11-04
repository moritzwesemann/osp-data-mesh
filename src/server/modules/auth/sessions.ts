/**
 * Sitzungen und API-Tokens.
 *  - Sitzung: zufälliges Token im Cookie "osp_session" (HttpOnly, SameSite=Strict, Secure);
 *    in der Datenbank nur SHA-256(Token) als user_session.id.
 *  - API-Token: "osp_" + Zufall, Header "Authorization: Bearer …"; gespeichert als SHA-256 in api_token.token_hash.
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Role } from '../../../shared/contract/common.ts';
import { randomToken, sha256Hex } from '../../core/crypto.ts';
import type { DbOrTx } from '../../core/db.ts';
import type { AppEnv, Authenticator, AuthUser, Deps } from '../../core/deps.ts';

export const SESSION_COOKIE = 'osp_session';
export const API_TOKEN_PREFIX = 'osp_';

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export async function createSession(
  db: DbOrTx,
  userId: string,
  ttlHours: number,
  ip: string | null,
  userAgent: string | null,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + ttlHours * 3600_000);
  await db
    .insertInto('user_session')
    .values({
      id: sha256Hex(token),
      user_id: userId,
      created_at: now,
      last_seen_at: now,
      expires_at: expiresAt,
      ip,
      user_agent: userAgent?.slice(0, 300) ?? null,
    })
    .execute();
  return { token, expiresAt };
}

export function newApiToken(): { token: string; hash: string; prefix: string } {
  const token = `${API_TOKEN_PREFIX}${randomToken(32)}`;
  return { token, hash: sha256Hex(token), prefix: token.slice(0, 10) };
}

/** Ermittelt die Person aus Sitzungs-Cookie oder Bearer-Token. Inaktive Konten werden abgewiesen. */
export class SessionAuthenticator implements Authenticator {
  constructor(private readonly deps: Pick<Deps, 'db' | 'now'>) {}

  async authenticate(c: Context<AppEnv>): Promise<AuthUser | null> {
    const now = this.deps.now();
    const authz = c.req.header('authorization');
    if (authz?.startsWith('Bearer ')) {
      const token = authz.slice(7).trim();
      if (!token.startsWith(API_TOKEN_PREFIX)) return null;
      const row = await this.deps.db
        .selectFrom('api_token as t')
        .innerJoin('app_user as u', 'u.id', 't.user_id')
        .select([
          't.id as token_id',
          't.expires_at',
          't.revoked_at',
          'u.id',
          'u.email',
          'u.display_name',
          'u.roles',
          'u.locale',
          'u.active',
          'u.must_change_password',
        ])
        .where('t.token_hash', '=', sha256Hex(token))
        .executeTakeFirst();
      if (!row?.active || row.revoked_at || (row.expires_at && row.expires_at <= now)) return null;
      await this.deps.db
        .updateTable('api_token')
        .set({ last_used_at: now })
        .where('id', '=', row.token_id)
        .execute();
      return {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        roles: row.roles as Role[],
        locale: row.locale as 'de' | 'en',
        mustChangePassword: row.must_change_password,
        via: 'token',
      };
    }
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie || cookie.length > 200) return null;
    const sid = sha256Hex(cookie);
    const row = await this.deps.db
      .selectFrom('user_session as s')
      .innerJoin('app_user as u', 'u.id', 's.user_id')
      .select([
        's.id as sid',
        's.expires_at',
        's.last_seen_at',
        'u.id',
        'u.email',
        'u.display_name',
        'u.roles',
        'u.locale',
        'u.active',
        'u.must_change_password',
      ])
      .where('s.id', '=', sid)
      .executeTakeFirst();
    if (!row?.active || row.expires_at <= now) return null;
    // last_seen höchstens minütlich aktualisieren
    if (now.getTime() - row.last_seen_at.getTime() > 60_000) {
      await this.deps.db
        .updateTable('user_session')
        .set({ last_seen_at: now })
        .where('id', '=', sid)
        .execute();
    }
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      roles: row.roles as Role[],
      locale: row.locale as 'de' | 'en',
      mustChangePassword: row.must_change_password,
      via: 'session',
      sessionId: sid,
    };
  }
}
