/**
 * Zusammenbau eines Knotens: Abhängigkeiten, Middleware, Module, statische Auslieferung.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from 'hono/bun';
import { secureHeaders } from 'hono/secure-headers';
import { type Config, loadConfig } from './config.ts';
import { AuditWriter } from './core/audit.ts';
import { SecretBox } from './core/crypto.ts';
import { createDb, type Db } from './core/db.ts';
import { type AppEnv, type Deps, type Module, unregisteredServices } from './core/deps.ts';
import { AppError } from './core/errors.ts';
import { EventBus } from './core/events.ts';
import { createLogger, type Logger } from './core/logger.ts';
import { NodeIdentity } from './core/node-identity.ts';
import { allModules } from './modules/index.ts';

export interface BuildOptions {
  config?: Config;
  log?: Logger;
  db?: Db;
  now?: () => Date;
  fetch?: Deps['fetch'];
}

export async function buildDeps(opts: BuildOptions = {}): Promise<Deps> {
  const config = opts.config ?? loadConfig();
  const log = opts.log ?? createLogger(config.MESH_LOG_LEVEL, { node: config.MESH_NODE_ID });
  const db = opts.db ?? createDb(config.MESH_DB_URL, config.MESH_DB_POOL_MAX);
  const box = new SecretBox(config.MESH_MASTER_KEY, config.MESH_MASTER_KEY_PREVIOUS);
  const identity = await NodeIdentity.ensure(db, box, config);
  return {
    config,
    db,
    log,
    audit: new AuditWriter(db),
    events: new EventBus(log),
    box,
    identity,
    services: unregisteredServices(),
    authenticator: {
      async authenticate() {
        return null;
      },
    },
    now: opts.now ?? (() => new Date()),
    fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
    startedAt: new Date(),
  };
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export function createApp(deps: Deps, modules: Module[] = allModules): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  for (const m of modules) m.init?.(deps);

  app.use('*', async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('user', null);
    let ip: string | null = null;
    if (deps.config.MESH_TRUST_PROXY) {
      ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    }
    if (!ip) {
      try {
        ip = getConnInfo(c).remote.address ?? null;
      } catch {
        ip = null;
      }
    }
    c.set('ip', ip);
    await next();
    c.header('x-request-id', requestId);
  });

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
      strictTransportSecurity: deps.config.MESH_COOKIE_SECURE ? 'max-age=31536000; includeSubDomains' : false,
      referrerPolicy: 'no-referrer',
      crossOriginResourcePolicy: 'same-origin',
    }),
  );

  // Uploads (CSV) bis 20 MB, Föderation bis 50 MB, sonst 1 MB
  const tooLarge = () => {
    throw new AppError('payload_too_large');
  };
  app.use('/api/v1/connectors/*', bodyLimit({ maxSize: 20 * 1024 * 1024, onError: tooLarge }));
  app.use('/federation/*', bodyLimit({ maxSize: 50 * 1024 * 1024, onError: tooLarge }));
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/v1/connectors/')) return next();
    return bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge })(c, next);
  });

  app.onError(async (err, c) => {
    const requestId = c.get('requestId') ?? crypto.randomUUID();
    const user = c.get('user');
    if (err instanceof AppError) {
      if (err.status >= 500)
        await logAppError(deps, c.req.method, c.req.path, err.status, err.code, err, requestId, user?.id);
      else
        deps.log.info('request rejected', {
          requestId,
          code: err.code,
          status: err.status,
          path: c.req.path,
        });
      return c.json(
        {
          error: {
            code: err.code,
            requestId,
            ...(err.reason ? { reason: err.reason } : {}),
            ...(err.fields ? { fields: err.fields } : {}),
          },
        },
        err.status as 400,
      );
    }
    await logAppError(deps, c.req.method, c.req.path, 500, 'internal_error', err, requestId, user?.id);
    return c.json({ error: { code: 'internal_error', requestId } }, 500);
  });

  for (const m of modules) m.routes?.(app, deps);

  app.all('/api/*', (c) => c.json({ error: { code: 'not_found', requestId: c.get('requestId') } }, 404));
  app.all('/federation/*', (c) =>
    c.json({ error: { code: 'not_found', requestId: c.get('requestId') } }, 404),
  );

  // Deutsche HTML-Dokumentation unter /hilfe
  const docsDir = resolve(deps.config.MESH_DOCS_DIR);
  app.get('/hilfe', (c) => c.redirect('/hilfe/'));
  app.get('/hilfe/*', async (c) => {
    const rel = c.req.path.replace(/^\/hilfe\/?/, '') || 'index.html';
    return serveStatic(docsDir, rel, c) ?? c.text('Not found', 404);
  });

  // Web-Oberfläche (SPA) mit Fallback auf index.html
  const uiDir = resolve(deps.config.MESH_UI_DIR);
  app.get('*', async (c) => {
    const rel = c.req.path.replace(/^\//, '');
    const file = rel ? serveStatic(uiDir, rel, c) : null;
    if (file) return file;
    const index = serveStatic(uiDir, 'index.html', c, 'no-cache');
    return index ?? c.text('OSP-Data-Mesh: Web-Oberfläche nicht gebaut (bun run build).', 503);
  });

  return app;
}

function serveStatic(root: string, rel: string, _c: unknown, cache?: string): Response | null {
  if (rel.includes('\0')) return null;
  const full = resolve(join(root, rel));
  if (!full.startsWith(`${root}/`) && full !== root) return null;
  if (!existsSync(full)) return null;
  const f = Bun.file(full);
  if (f.size === 0 && !full.endsWith('.html')) return null;
  const immutable = /\/assets\//.test(full);
  return new Response(f, {
    headers: {
      'cache-control': cache ?? (immutable ? 'public, max-age=31536000, immutable' : 'no-cache'),
    },
  });
}

async function logAppError(
  deps: Deps,
  method: string,
  path: string,
  status: number,
  code: string,
  err: unknown,
  requestId: string,
  userId: string | null | undefined,
) {
  const message = err instanceof Error ? err.message : String(err);
  deps.log.error('request failed', { requestId, method, path, status, code, error: message });
  try {
    await deps.db
      .insertInto('app_error')
      .values({
        request_id: requestId,
        method,
        path: path.slice(0, 500),
        status,
        code,
        message: message.slice(0, 2000),
        user_id: userId && /^[0-9a-f-]{36}$/.test(userId) ? userId : null,
        details: JSON.stringify({}),
      })
      .execute();
  } catch (e) {
    deps.log.error('could not persist app error', { error: (e as Error).message });
  }
}

export async function startModules(deps: Deps, modules: Module[] = allModules) {
  if (!deps.config.MESH_WORKERS) return;
  for (const m of modules) await m.start?.(deps);
}

export async function stopModules(modules: Module[] = allModules) {
  for (const m of [...modules].reverse()) await m.stop?.();
}
