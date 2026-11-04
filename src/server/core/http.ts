/**
 * Registrierung von Routen gegen den Vertrag (src/shared/contract):
 * Authentifizierung, Rollenprüfung, CSRF-Schutz, Eingabevalidierung, Ausgabefilterung (zod entfernt
 * unbekannte Felder), zentrale Fehlerbehandlung mit Fehlerprotokoll.
 */
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { type RouteId, type Routes, routes } from '../../shared/contract/index.ts';
import type { RouteBody, RouteParams, RouteQuery, RouteResponse } from '../../shared/contract/route.ts';
import type { Actor } from './audit.ts';
import type { AppEnv, AuthUser, Deps } from './deps.ts';
import { AppError } from './errors.ts';

export interface HandlerCtx<K extends RouteId> {
  params: RouteParams<Routes[K]>;
  query: RouteQuery<Routes[K]>;
  body: RouteBody<Routes[K]>;
  /** Angemeldete Person. Bei öffentlichen Routen ein anonymer Platzhalter (id = ''). */
  user: AuthUser;
  actor: Actor;
  ip: string | null;
  requestId: string;
  c: Context<AppEnv>;
  deps: Deps;
}

export type Handler<K extends RouteId> = (ctx: HandlerCtx<K>) => Promise<RouteResponse<Routes[K]> | Response>;
export type Handlers = { [K in RouteId]?: Handler<K> };

const ANONYMOUS: AuthUser = {
  id: '',
  email: '',
  displayName: '',
  roles: [],
  locale: 'de',
  mustChangePassword: false,
  via: 'session',
};

/** Routen, die bei erzwungenem Passwortwechsel erreichbar bleiben */
const ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED = new Set<RouteId>([
  'auth.me',
  'auth.logout',
  'auth.changePassword',
]);

export function actorOf(user: AuthUser | null): Actor {
  if (!user?.id) return { type: 'anonymous', id: null, label: null };
  return { type: 'user', id: user.id, label: user.email };
}

export function zodFields(err: z.ZodError, prefix = ''): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.') || '_';
    fields[path] ??= issue.code;
  }
  return fields;
}

function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown, prefix: string): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new AppError('validation_failed', { fields: zodFields(r.error, prefix) });
  return r.data;
}

/** Registriert die Handler eines Moduls. Jede Route muss im Vertrag stehen. */
export function registerRoutes(app: Hono<AppEnv>, deps: Deps, handlers: Handlers): void {
  for (const [id, handler] of Object.entries(handlers) as [RouteId, Handler<RouteId>][]) {
    const def = routes[id];
    if (!def) throw new Error(`route ${id} is not part of the contract`);
    app.on(def.method, def.path, async (c) => {
      const user = def.auth === 'public' ? null : await deps.authenticator.authenticate(c);
      c.set('user', user);
      const requestId = c.get('requestId');
      const ip = c.get('ip');
      if (def.auth !== 'public') {
        if (!user) throw new AppError('unauthenticated');
        if (user.mustChangePassword && !ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED.has(id)) {
          throw new AppError('forbidden', { reason: 'password_change_required' });
        }
        if (Array.isArray(def.auth) && !def.auth.some((r) => user.roles.includes(r))) {
          await deps.audit.record({
            actor: actorOf(user),
            action: 'access.forbidden',
            outcome: 'denied',
            objectType: 'route',
            objectId: id,
            details: { method: def.method, path: c.req.path },
            ip,
            requestId,
          });
          throw new AppError('forbidden');
        }
        // CSRF: zustandsändernde Anfragen mit Sitzungs-Cookie brauchen den Header X-OSP-CSRF
        // (kann von fremden Seiten ohne CORS-Freigabe nicht gesetzt werden). Token-Zugriffe sind ausgenommen.
        if (def.method !== 'GET' && user.via === 'session' && c.req.header('x-osp-csrf') !== '1') {
          throw new AppError('csrf_failed');
        }
      } else if (def.method !== 'GET' && c.req.header('x-osp-csrf') !== '1') {
        throw new AppError('csrf_failed');
      }

      const params = def.params ? parseOrThrow(def.params, c.req.param(), 'params') : {};
      const query = def.query ? parseOrThrow(def.query, c.req.query(), 'query') : {};
      let body: unknown;
      if (def.body === 'multipart') {
        const type = c.req.header('content-type') ?? '';
        if (!type.startsWith('multipart/form-data')) {
          if (type && !type.startsWith('application/json')) throw new AppError('unsupported_format');
          body = new FormData();
        } else {
          body = await c.req.formData().catch(() => {
            throw new AppError('validation_failed', { fields: { body: 'invalid_multipart' } });
          });
        }
      } else if (def.body) {
        const raw = await c.req.json().catch(() => {
          throw new AppError('validation_failed', { fields: { body: 'invalid_json' } });
        });
        body = parseOrThrow(def.body, raw, 'body');
      }

      const result = await handler({
        params: params as never,
        query: query as never,
        body: body as never,
        user: user ?? ANONYMOUS,
        actor: actorOf(user),
        ip,
        requestId,
        c,
        deps,
      });
      if (result instanceof Response) return result;
      const out = def.response.safeParse(result);
      if (!out.success) {
        throw new Error(`response of ${id} does not match contract: ${JSON.stringify(zodFields(out.error))}`);
      }
      return c.json(out.data as object);
    });
  }
}
