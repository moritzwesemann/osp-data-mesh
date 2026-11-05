/**
 * Startpunkt eines OSP-Data-Nodes: `bun run start` (bzw. `bun src/server/main.ts`).
 * Migrationen laufen NICHT hier, sondern vorab mit
 * `bun --env-file=.env --env-file=.env.owner run cli migrate` (Rolle mesh_owner).
 */

import { buildDeps, createApp, startModules, stopModules } from './app.ts';
import { APP_VERSION } from './config.ts';
import { SERVER_APPLICATION_NAME } from './core/db.ts';
import { tryAcquireNodeLock } from './core/node-lock.ts';

const deps = await buildDeps();
const nodeLock = await tryAcquireNodeLock(deps.config.MESH_DB_URL, `${SERVER_APPLICATION_NAME}-lock`, (err) =>
  deps.log.error('node lock connection lost', { error: err.message }),
);
if (!nodeLock) {
  deps.log.error(
    'node lock is held by another process (another server on this database or a restore in progress); refusing to start',
  );
  await deps.db.destroy();
  process.exit(1);
}
const app = createApp(deps);
await startModules(deps);

const server = Bun.serve({
  hostname: deps.config.MESH_HOST,
  port: deps.config.MESH_PORT,
  fetch: (req, srv) => app.fetch(req, { server: srv }),
  maxRequestBodySize: 60 * 1024 * 1024,
});

deps.log.info('node started', {
  version: APP_VERSION,
  nodeId: deps.identity.nodeId,
  url: `http://${server.hostname}:${server.port}`,
  fingerprint: deps.identity.fingerprint,
});
await deps.audit.record({
  actor: { type: 'system', label: 'system' },
  action: 'system.start',
  details: { version: APP_VERSION },
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  deps.log.info('node stopping', { signal });
  server.stop();
  await stopModules();
  await deps.db.destroy();
  await nodeLock?.release();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
