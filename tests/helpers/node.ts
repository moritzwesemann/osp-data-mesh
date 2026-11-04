/**
 * In-Process-Testknoten: vollständige App mit eigener Testdatenbank, ohne Netzwerk-Port.
 * Partnerknoten und API-Quellen werden über eine injizierte fetch-Funktion verbunden (siehe TestMesh).
 */
import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { buildDeps, createApp } from '../../src/server/app.ts';
import { type Config, loadConfig } from '../../src/server/config.ts';
import type { AppEnv, Deps } from '../../src/server/core/deps.ts';
import { silentLogger } from '../../src/server/core/logger.ts';
import { createSession, hashPassword } from '../../src/server/modules/auth/sessions.ts';
import type { Role } from '../../src/shared/contract/common.ts';
import { createTestDb, type TestDb } from './db.ts';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  roles: Role[];
  cookie: string;
}

export interface TestResponse<T = unknown> {
  status: number;
  json: T;
  text: string;
  headers: Headers;
}

export interface TestNode {
  nodeId: string;
  baseUrl: string;
  app: Hono<AppEnv>;
  deps: Deps;
  testDb: TestDb;
  /** Person mit Rollen anlegen und anmelden (Sitzungs-Cookie) */
  user(roles: Role[], opts?: { email?: string; password?: string }): Promise<TestUser>;
  request<T = unknown>(
    method: string,
    path: string,
    opts?: {
      as?: TestUser | null;
      body?: unknown;
      form?: FormData;
      headers?: Record<string, string>;
      csrf?: boolean;
      /** TCP-Gegenstelle (Standard 127.0.0.1, wie ein Reverse Proxy auf demselben Rechner); null = unbekannt */
      peer?: string | null;
    },
  ): Promise<TestResponse<T>>;
  close(): Promise<void>;
}

export interface TestNodeOptions {
  nodeId?: string;
  displayName?: string;
  config?: Partial<Record<keyof Config, string>>;
  now?: () => Date;
  /** Routing ausgehender HTTP-Aufrufe (Partner, API-Quellen) */
  fetch?: Deps['fetch'];
}

/**
 * Umgebung für app.request/app.fetch mit einer TCP-Gegenstelle (wie Bun.serve: server.requestIP), damit
 * getConnInfo eine Adresse liefert. null: keine Gegenstelle bekannt.
 */
export function connEnv(peer: string | null = '127.0.0.1') {
  if (peer === null) return undefined;
  const family = peer.includes(':') ? 'IPv6' : 'IPv4';
  return { server: { requestIP: () => ({ address: peer, family, port: 50_000 }) } };
}

export async function createTestNode(opts: TestNodeOptions = {}): Promise<TestNode> {
  const testDb = await createTestDb();
  const nodeId = opts.nodeId ?? `test-${randomBytes(3).toString('hex')}`;
  const baseUrl = `http://${nodeId}.mesh.test`;
  const config = loadConfig({
    MESH_NODE_ID: nodeId,
    MESH_NODE_NAME: opts.displayName ?? `Testknoten ${nodeId}`,
    MESH_PUBLIC_URL: baseUrl,
    MESH_DB_URL: testDb.urls.app,
    MESH_MASTER_KEY: randomBytes(32).toString('base64'),
    MESH_BACKUP_KEY: randomBytes(32).toString('base64'),
    MESH_BACKUP_DIR: `${process.cwd()}/.local/test-backups/${nodeId}`,
    MESH_COOKIE_SECURE: 'false',
    MESH_FEDERATION_ALLOW_HTTP: 'true',
    MESH_WORKERS: 'false',
    MESH_SOURCE_ALLOWED_HOSTS: 'measure.mesh.test,127.0.0.1:4410',
    MESH_LOG_LEVEL: 'error',
    ...opts.config,
  });
  const deps = await buildDeps({
    config,
    db: testDb.db,
    log: silentLogger,
    now: opts.now,
    fetch: opts.fetch,
  });
  const app = createApp(deps);

  let userCounter = 0;
  const node: TestNode = {
    nodeId,
    baseUrl,
    app,
    deps,
    testDb,
    async user(roles, o = {}) {
      userCounter++;
      const email = o.email ?? `user${userCounter}.${roles.join('-') || 'none'}@${nodeId}.test`;
      const password = o.password ?? 'correct horse battery staple';
      const row = await deps.db
        .insertInto('app_user')
        .values({
          email,
          display_name: `Test ${roles.join(', ')}`,
          password_hash: await hashPassword(password),
          roles,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const { token } = await createSession(deps.db, row.id, 1, '127.0.0.1', 'test');
      return { id: row.id, email, password, roles, cookie: `osp_session=${token}` };
    },
    async request(method, path, o = {}) {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      if (o.as) headers.cookie = o.as.cookie;
      if (o.csrf !== false && method !== 'GET') headers['x-osp-csrf'] = '1';
      let body: BodyInit | undefined;
      if (o.form) body = o.form;
      else if (o.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(o.body);
      }
      const res = await app.request(path, { method, headers, body }, connEnv(o.peer));
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json: json as never, text, headers: res.headers };
    },
    async close() {
      await testDb.drop();
    },
  };
  return node;
}

/**
 * Mehrere Testknoten, die sich gegenseitig über eine In-Process-fetch-Funktion erreichen.
 * Weitere Ziele (z. B. Mock-Messsystem) über `routes` (Basis-URL → fetch-Handler).
 */
export class TestMesh {
  readonly nodes = new Map<string, TestNode>();
  readonly routes = new Map<string, (req: Request) => Promise<Response> | Response>();

  fetch: Deps['fetch'] = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    for (const n of this.nodes.values()) if (n.baseUrl === origin) return n.app.fetch(req);
    const handler = this.routes.get(origin);
    if (handler) return handler(req);
    throw new TypeError(`fetch failed: ${origin} unreachable`);
  };

  async add(opts: TestNodeOptions = {}): Promise<TestNode> {
    const node = await createTestNode({ ...opts, fetch: this.fetch });
    this.nodes.set(node.nodeId, node);
    return node;
  }

  async close(): Promise<void> {
    for (const n of this.nodes.values()) await n.close();
    this.nodes.clear();
  }
}
