/**
 * Anmeldung, Abmeldung, eigenes Passwort, eigene API-Tokens.
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sql } from 'kysely';
import type { Actor } from '../../core/audit.ts';
import { sha256Hex } from '../../core/crypto.ts';
import type { AppEnv, Deps } from '../../core/deps.ts';
import { AppError, notFound } from '../../core/errors.ts';
import type { Handlers } from '../../core/http.ts';
import { toApiToken, toSessionUser } from './map.ts';
import {
  assertPasswordPolicy,
  dummyPasswordHash,
  LOCK_MINUTES,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_MS,
  MAX_FAILED_LOGINS,
  RateLimiter,
} from './policy.ts';
import { createSession, hashPassword, newApiToken, SESSION_COOKIE, verifyPassword } from './sessions.ts';

const ANONYMOUS: Actor = { type: 'anonymous', id: null, label: null };

function cookieOptions(deps: Deps) {
  return {
    httpOnly: true,
    sameSite: 'Strict' as const,
    path: '/',
    secure: deps.config.MESH_COOKIE_SECURE,
  };
}

function setSessionCookie(c: Context<AppEnv>, deps: Deps, token: string, expiresAt: Date) {
  setCookie(c, SESSION_COOKIE, token, {
    ...cookieOptions(deps),
    maxAge: Math.round(deps.config.MESH_SESSION_TTL_HOURS * 3600),
    expires: expiresAt,
  });
}

export function authHandlers(deps: Deps): Handlers {
  // je App-Instanz eigener Zähler (Tests mit mehreren Knoten im selben Prozess)
  const loginLimiter = new RateLimiter(LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS);
  const passwordLimiter = new RateLimiter(LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS);
  // Dummy-Hash früh berechnen, damit die erste Anmeldung mit unbekannter E-Mail nicht auffällt
  void dummyPasswordHash();

  return {
    'auth.login': async ({ body, c, ip, requestId }) => {
      const now = deps.now();
      const deny = (reason: string, userId: string | null, extra: Record<string, unknown> = {}) =>
        deps.audit.record({
          actor: ANONYMOUS,
          action: 'auth.login',
          outcome: 'denied',
          objectType: 'user',
          objectId: userId,
          details: { reason, ...extra },
          ip,
          requestId,
        });

      const limit = loginLimiter.hit(ip ?? 'unknown', now.getTime());
      if (!limit.allowed) {
        // nur die erste Abweisung je Zeitfenster protokollieren (kein Fluten des Audit-Logs)
        if (limit.firstBlocked) await deny('rate_limited', null);
        throw new AppError('rate_limited');
      }

      const user = await deps.db
        .selectFrom('app_user')
        .selectAll()
        .where('email', '=', body.email)
        .executeTakeFirst();

      if (!user) {
        await verifyPassword(body.password, await dummyPasswordHash());
        await deny('invalid_credentials', null);
        throw new AppError('invalid_credentials');
      }
      if (!user.active) {
        // gleiche Antwort wie bei falschem Passwort (verrät nicht, dass das Konto existiert)
        await verifyPassword(body.password, user.password_hash);
        await deny('inactive', user.id);
        throw new AppError('invalid_credentials');
      }
      if (user.locked_until && user.locked_until > now) {
        // auch mit richtigem Passwort gesperrt; Fehlversuche verlängern die Sperre nicht
        await verifyPassword(body.password, await dummyPasswordHash());
        await deny('locked', user.id);
        throw new AppError('account_locked');
      }
      if (!(await verifyPassword(body.password, user.password_hash))) {
        const lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000);
        const updated = await deps.db
          .updateTable('app_user')
          .set({
            failed_logins: sql<number>`case when failed_logins + 1 >= ${MAX_FAILED_LOGINS} then 0 else failed_logins + 1 end`,
            locked_until: sql<Date | null>`case when failed_logins + 1 >= ${MAX_FAILED_LOGINS} then ${lockUntil}::timestamptz else locked_until end`,
          })
          .where('id', '=', user.id)
          .returning(['locked_until'])
          .executeTakeFirst();
        const lockedNow = !!updated?.locked_until && updated.locked_until > now;
        await deny('invalid_credentials', user.id, lockedNow ? { locked: true } : {});
        throw new AppError(lockedNow ? 'account_locked' : 'invalid_credentials');
      }

      const previous = getCookie(c, SESSION_COOKIE);
      const session = await deps.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('app_user')
          .set({ failed_logins: 0, locked_until: null, last_login_at: now })
          .where('id', '=', user.id)
          .execute();
        // Sitzungsfixierung vermeiden und abgelaufene Sitzungen aufräumen
        if (previous && previous.length <= 200) {
          await trx.deleteFrom('user_session').where('id', '=', sha256Hex(previous)).execute();
        }
        await trx
          .deleteFrom('user_session')
          .where('user_id', '=', user.id)
          .where('expires_at', '<=', now)
          .execute();
        const s = await createSession(
          trx,
          user.id,
          deps.config.MESH_SESSION_TTL_HOURS,
          ip,
          c.req.header('user-agent') ?? null,
          now,
        );
        await deps.audit.record(
          {
            actor: { type: 'user', id: user.id, label: user.email },
            action: 'auth.login',
            objectType: 'user',
            objectId: user.id,
            details: { via: 'password' },
            ip,
            requestId,
          },
          trx,
        );
        return s;
      });
      setSessionCookie(c, deps, session.token, session.expiresAt);
      return { user: toSessionUser({ ...user, failed_logins: 0, locked_until: null, last_login_at: now }) };
    },

    'auth.logout': async ({ user, actor, c, ip, requestId }) => {
      await deps.db.transaction().execute(async (trx) => {
        if (user.via === 'session' && user.sessionId) {
          await trx.deleteFrom('user_session').where('id', '=', user.sessionId).execute();
        }
        await deps.audit.record(
          {
            actor,
            action: 'auth.logout',
            objectType: 'user',
            objectId: user.id,
            details: { via: user.via },
            ip,
            requestId,
          },
          trx,
        );
      });
      deleteCookie(c, SESSION_COOKIE, cookieOptions(deps));
      return { ok: true as const };
    },

    'auth.me': async ({ user }) => ({
      user: toSessionUser(user),
      node: {
        nodeId: deps.identity.nodeId,
        displayName: deps.identity.displayName,
        fingerprint: deps.identity.fingerprint,
      },
    }),

    'auth.changePassword': async ({ body, user, actor, ip, requestId }) => {
      const now = deps.now();
      if (!passwordLimiter.hit(user.id, now.getTime()).allowed) throw new AppError('rate_limited');
      const row = await deps.db
        .selectFrom('app_user')
        .select(['email', 'password_hash'])
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow();
      if (!(await verifyPassword(body.currentPassword, row.password_hash))) {
        await deps.audit.record({
          actor,
          action: 'auth.password_change',
          outcome: 'denied',
          objectType: 'user',
          objectId: user.id,
          details: { reason: 'invalid_credentials' },
          ip,
          requestId,
        });
        throw new AppError('invalid_credentials');
      }
      assertPasswordPolicy(body.newPassword, { email: row.email, current: body.currentPassword });
      const hash = await hashPassword(body.newPassword);
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('app_user')
          .set({ password_hash: hash, must_change_password: false, failed_logins: 0, locked_until: null })
          .where('id', '=', user.id)
          .execute();
        // alle anderen Sitzungen beenden (die aktuelle bleibt bestehen)
        let del = trx.deleteFrom('user_session').where('user_id', '=', user.id);
        if (user.via === 'session' && user.sessionId) del = del.where('id', '<>', user.sessionId);
        const ended = await del.executeTakeFirst();
        await deps.audit.record(
          {
            actor,
            action: 'auth.password_change',
            objectType: 'user',
            objectId: user.id,
            details: { sessionsEnded: Number(ended.numDeletedRows) },
            ip,
            requestId,
          },
          trx,
        );
      });
      return { ok: true as const };
    },

    'tokens.list': async ({ user }) => {
      const rows = await deps.db
        .selectFrom('api_token')
        .selectAll()
        .where('user_id', '=', user.id)
        .orderBy('created_at', 'desc')
        .execute();
      return { items: rows.map(toApiToken) };
    },

    'tokens.create': async ({ body, user, actor, ip, requestId }) => {
      const now = deps.now();
      const t = newApiToken();
      const row = await deps.db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('api_token')
          .values({
            user_id: user.id,
            name: body.name,
            token_hash: t.hash,
            prefix: t.prefix,
            created_at: now,
            expires_at: new Date(now.getTime() + body.expiresInDays * 86_400_000),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await deps.audit.record(
          {
            actor,
            action: 'token.create',
            objectType: 'api_token',
            objectId: inserted.id,
            details: { prefix: t.prefix, expiresInDays: body.expiresInDays },
            ip,
            requestId,
          },
          trx,
        );
        return inserted;
      });
      return { token: t.token, item: toApiToken(row) };
    },

    'tokens.revoke': async ({ params, user, actor, ip, requestId }) => {
      await deps.db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('api_token')
          .select(['id', 'revoked_at'])
          .where('id', '=', params.id)
          .where('user_id', '=', user.id)
          .executeTakeFirst();
        if (!row) throw notFound();
        if (row.revoked_at) return;
        await trx.updateTable('api_token').set({ revoked_at: deps.now() }).where('id', '=', row.id).execute();
        await deps.audit.record(
          { actor, action: 'token.revoke', objectType: 'api_token', objectId: row.id, ip, requestId },
          trx,
        );
      });
      return { ok: true as const };
    },
  };
}
