import { z } from 'zod';
import { IdParam, IsoDateTime, Ok, Role, Uuid } from './common.ts';
import { route } from './route.ts';

export const Locale = z.enum(['de', 'en']);

export const SessionUser = z.object({
  id: Uuid,
  email: z.string(),
  displayName: z.string(),
  roles: z.array(Role),
  locale: Locale,
  mustChangePassword: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUser>;

export const NodeInfo = z.object({
  nodeId: z.string(),
  displayName: z.string(),
  fingerprint: z.string(),
});

/** Mindestanforderung: 12 Zeichen. Weitere Prüfungen (z. B. Name/E-Mail im Passwort) serverseitig. */
export const NewPassword = z.string().min(12).max(200);

export const ApiToken = z.object({
  id: Uuid,
  name: z.string(),
  prefix: z.string(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
  lastUsedAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
});

export const User = z.object({
  id: Uuid,
  email: z.string(),
  displayName: z.string(),
  roles: z.array(Role),
  locale: Locale,
  active: z.boolean(),
  lockedUntil: IsoDateTime.nullable(),
  mustChangePassword: z.boolean(),
  lastLoginAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type User = z.infer<typeof User>;

const Email = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());

export const authRoutes = {
  'auth.login': route({
    method: 'POST',
    path: '/api/v1/auth/login',
    auth: 'public',
    summary: 'Anmelden (setzt Sitzungs-Cookie)',
    tag: 'Anmeldung',
    body: z.object({ email: Email, password: z.string().min(1).max(200) }),
    response: z.object({ user: SessionUser }),
  }),
  'auth.logout': route({
    method: 'POST',
    path: '/api/v1/auth/logout',
    auth: 'authenticated',
    summary: 'Abmelden',
    tag: 'Anmeldung',
    response: Ok,
  }),
  'auth.me': route({
    method: 'GET',
    path: '/api/v1/auth/me',
    auth: 'authenticated',
    summary: 'Angemeldete Person und Knoten',
    tag: 'Anmeldung',
    response: z.object({ user: SessionUser, node: NodeInfo }),
  }),
  'auth.changePassword': route({
    method: 'POST',
    path: '/api/v1/auth/password',
    auth: 'authenticated',
    summary: 'Eigenes Passwort ändern',
    tag: 'Anmeldung',
    body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: NewPassword }),
    response: Ok,
  }),
  'tokens.list': route({
    method: 'GET',
    path: '/api/v1/auth/tokens',
    auth: 'authenticated',
    summary: 'Eigene API-Tokens',
    tag: 'Anmeldung',
    response: z.object({ items: z.array(ApiToken) }),
  }),
  'tokens.create': route({
    method: 'POST',
    path: '/api/v1/auth/tokens',
    auth: 'authenticated',
    summary: 'API-Token für Werkzeuge (Excel, Power BI, Python) erzeugen; Token wird nur einmal angezeigt',
    tag: 'Anmeldung',
    body: z.object({
      name: z.string().min(1).max(100),
      expiresInDays: z.number().int().min(1).max(365).default(90),
    }),
    response: z.object({ token: z.string(), item: ApiToken }),
  }),
  'tokens.revoke': route({
    method: 'DELETE',
    path: '/api/v1/auth/tokens/:id',
    auth: 'authenticated',
    summary: 'Eigenes API-Token widerrufen',
    tag: 'Anmeldung',
    params: IdParam,
    response: Ok,
  }),
  'users.list': route({
    method: 'GET',
    path: '/api/v1/users',
    auth: ['admin'],
    summary: 'Benutzer auflisten',
    tag: 'Benutzer',
    response: z.object({ items: z.array(User) }),
  }),
  'users.create': route({
    method: 'POST',
    path: '/api/v1/users',
    auth: ['admin'],
    summary: 'Benutzer anlegen (Initialpasswort muss bei erster Anmeldung geändert werden)',
    tag: 'Benutzer',
    body: z.object({
      email: Email,
      displayName: z.string().min(1).max(200),
      roles: z.array(Role).min(1),
      password: NewPassword,
      locale: Locale.default('de'),
    }),
    response: User,
  }),
  'users.update': route({
    method: 'PATCH',
    path: '/api/v1/users/:id',
    auth: ['admin'],
    summary: 'Benutzer ändern (Rollen, Status, Sprache); Sperre aufheben',
    tag: 'Benutzer',
    params: IdParam,
    body: z.object({
      displayName: z.string().min(1).max(200).optional(),
      roles: z.array(Role).min(1).optional(),
      active: z.boolean().optional(),
      locale: Locale.optional(),
      unlock: z.boolean().optional(),
    }),
    response: User,
  }),
  'users.resetPassword': route({
    method: 'POST',
    path: '/api/v1/users/:id/reset-password',
    auth: ['admin'],
    summary: 'Passwort zurücksetzen (beendet alle Sitzungen der Person)',
    tag: 'Benutzer',
    params: IdParam,
    body: z.object({ password: NewPassword }),
    response: Ok,
  }),
} as const;
