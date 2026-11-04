/** Abbildung Datenbankzeilen (snake_case) → Vertrag (camelCase) */

import type { z } from 'zod';
import type { ApiToken, SessionUser, User } from '../../../shared/contract/auth.ts';
import type { Role } from '../../../shared/contract/common.ts';
import { iso, isoReq } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import type { AuthUser } from '../../core/deps.ts';

type Locale = 'de' | 'en';

export function toSessionUser(u: Row<'app_user'> | AuthUser): SessionUser {
  if ('via' in u) {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      roles: u.roles,
      locale: u.locale,
      mustChangePassword: u.mustChangePassword,
    };
  }
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    roles: u.roles as Role[],
    locale: u.locale as Locale,
    mustChangePassword: u.must_change_password,
  };
}

export function toUser(u: Row<'app_user'>): User {
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    roles: u.roles as Role[],
    locale: u.locale as Locale,
    active: u.active,
    lockedUntil: iso(u.locked_until),
    mustChangePassword: u.must_change_password,
    lastLoginAt: iso(u.last_login_at),
    createdAt: isoReq(u.created_at),
  };
}

export function toApiToken(t: Row<'api_token'>): z.infer<typeof ApiToken> {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    createdAt: isoReq(t.created_at),
    expiresAt: iso(t.expires_at),
    lastUsedAt: iso(t.last_used_at),
    revokedAt: iso(t.revoked_at),
  };
}
