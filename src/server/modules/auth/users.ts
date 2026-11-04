/**
 * Benutzerverwaltung (nur admin). Schutzregeln:
 *  - eine Administratorin kann sich nicht selbst die Rolle admin entziehen oder sich deaktivieren,
 *  - mindestens eine aktive Person mit Rolle admin bleibt immer bestehen.
 */
import { sql } from 'kysely';
import type { Role } from '../../../shared/contract/common.ts';
import type { Tx } from '../../core/db.ts';
import { pgCode } from '../../core/db.ts';
import type { RowUpdate } from '../../core/db-types.ts';
import type { Deps } from '../../core/deps.ts';
import { conflict, forbidden, notFound } from '../../core/errors.ts';
import type { Handlers } from '../../core/http.ts';
import { toUser } from './map.ts';
import { assertPasswordPolicy } from './policy.ts';
import { hashPassword } from './sessions.ts';

function uniqueRoles(roles: readonly Role[]): Role[] {
  return [...new Set(roles)];
}

/**
 * Sperrt alle aktiven Administratorinnen (immer in derselben Reihenfolge, damit sich gleichzeitige
 * Änderungen nicht gegenseitig blockieren) und liefert ihre IDs.
 */
async function lockActiveAdmins(trx: Tx): Promise<string[]> {
  const rows = await trx
    .selectFrom('app_user')
    .select('id')
    .where('active', '=', true)
    .where(sql<boolean>`'admin' = any(roles)`)
    .orderBy('id')
    .forUpdate()
    .execute();
  return rows.map((r) => r.id);
}

export function userHandlers(deps: Deps): Handlers {
  return {
    'users.list': async () => {
      const rows = await deps.db.selectFrom('app_user').selectAll().orderBy('email').execute();
      return { items: rows.map(toUser) };
    },

    'users.create': async ({ body, actor, ip, requestId }) => {
      assertPasswordPolicy(body.password, { email: body.email });
      const hash = await hashPassword(body.password);
      const roles = uniqueRoles(body.roles);
      try {
        const row = await deps.db.transaction().execute(async (trx) => {
          const inserted = await trx
            .insertInto('app_user')
            .values({
              email: body.email,
              display_name: body.displayName,
              password_hash: hash,
              roles,
              locale: body.locale,
              must_change_password: true,
              created_at: deps.now(),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await deps.audit.record(
            {
              actor,
              action: 'user.create',
              objectType: 'user',
              objectId: inserted.id,
              details: { roles },
              ip,
              requestId,
            },
            trx,
          );
          return inserted;
        });
        return toUser(row);
      } catch (err) {
        if (pgCode(err) === '23505') throw conflict('email_exists');
        throw err;
      }
    },

    'users.update': async ({ params, body, user, actor, ip, requestId }) => {
      const row = await deps.db.transaction().execute(async (trx) => {
        // Rollen-/Statusänderungen: zuerst alle aktiven Admins sperren, dann die Zielperson
        const affectsAdmins = body.roles !== undefined || body.active !== undefined;
        const admins = affectsAdmins ? await lockActiveAdmins(trx) : null;
        // gleichzeitige Herabstufung der handelnden Person (nach Anmeldung) berücksichtigen
        if (admins && !admins.includes(user.id)) throw forbidden();
        const target = await trx
          .selectFrom('app_user')
          .selectAll()
          .where('id', '=', params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!target) throw notFound();

        const oldRoles = target.roles as Role[];
        const newRoles = body.roles ? uniqueRoles(body.roles) : oldRoles;
        const newActive = body.active ?? target.active;
        const isSelf = target.id === user.id;
        const wasActiveAdmin = target.active && oldRoles.includes('admin');
        const staysActiveAdmin = newActive && newRoles.includes('admin');

        if (isSelf && oldRoles.includes('admin') && !newRoles.includes('admin')) {
          throw conflict('cannot_remove_own_admin_role');
        }
        if (isSelf && !newActive) throw conflict('cannot_deactivate_self');
        if (
          wasActiveAdmin &&
          !staysActiveAdmin &&
          (admins ?? []).filter((id) => id !== target.id).length === 0
        ) {
          throw conflict('last_admin');
        }

        const set: RowUpdate<'app_user'> = {};
        const changed: string[] = [];
        const details: Record<string, unknown> = {};
        if (body.displayName !== undefined && body.displayName !== target.display_name) {
          set.display_name = body.displayName;
          changed.push('displayName');
        }
        if (body.locale !== undefined && body.locale !== target.locale) {
          set.locale = body.locale;
          changed.push('locale');
        }
        if (
          body.roles &&
          (newRoles.length !== oldRoles.length || newRoles.some((r) => !oldRoles.includes(r)))
        ) {
          set.roles = newRoles;
          changed.push('roles');
          details.roles = { old: oldRoles, new: newRoles };
        }
        if (newActive !== target.active) {
          set.active = newActive;
          changed.push('active');
          details.active = { old: target.active, new: newActive };
        }
        if (body.unlock && (target.locked_until || target.failed_logins > 0)) {
          set.locked_until = null;
          set.failed_logins = 0;
          changed.push('unlock');
        }
        if (changed.length === 0) return target;

        const updated = await trx
          .updateTable('app_user')
          .set(set)
          .where('id', '=', target.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        if (!newActive && target.active) {
          // deaktivierte Konten: Sitzungen beenden (Tokens weist der Authenticator ab)
          await trx.deleteFrom('user_session').where('user_id', '=', target.id).execute();
        }
        await deps.audit.record(
          {
            actor,
            action: 'user.update',
            objectType: 'user',
            objectId: target.id,
            details: { changed, ...details },
            ip,
            requestId,
          },
          trx,
        );
        return updated;
      });
      return toUser(row);
    },

    'users.resetPassword': async ({ params, body, actor, ip, requestId }) => {
      const target = await deps.db
        .selectFrom('app_user')
        .select(['id', 'email'])
        .where('id', '=', params.id)
        .executeTakeFirst();
      if (!target) throw notFound();
      assertPasswordPolicy(body.password, { email: target.email });
      const hash = await hashPassword(body.password);
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('app_user')
          .set({ password_hash: hash, must_change_password: true, failed_logins: 0, locked_until: null })
          .where('id', '=', target.id)
          .execute();
        const ended = await trx
          .deleteFrom('user_session')
          .where('user_id', '=', target.id)
          .executeTakeFirst();
        await deps.audit.record(
          {
            actor,
            action: 'user.reset_password',
            objectType: 'user',
            objectId: target.id,
            details: { sessionsEnded: Number(ended.numDeletedRows) },
            ip,
            requestId,
          },
          trx,
        );
      });
      return { ok: true as const };
    },
  };
}
