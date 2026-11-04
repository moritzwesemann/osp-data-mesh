import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import type { AppError } from '../../src/server/core/errors.ts';
import { BackupFileError, sha256File } from '../../src/server/modules/system/backup-file.ts';
import { restoreBackup } from '../../src/server/modules/system/restore.ts';
import type { BackupRun } from '../../src/shared/contract/system.ts';
import { queryAs } from '../helpers/db.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';

let node: TestNode;
let admin: TestUser;
let backupDir: string;
let scratch: string;
let backupFile: string;
const MARKER_EMAIL = `marker.${randomBytes(4).toString('hex')}@sicherung.example`;
const MARKER_NAME = `Sicherungstest${randomBytes(3).toString('hex')}`;

async function snapshot() {
  const users = await node.deps.db
    .selectFrom('app_user')
    .select(['id', 'email', 'roles', 'password_hash', 'active'])
    .orderBy('id')
    .execute();
  const athletes = await node.deps.db.selectFrom('athlete').selectAll().orderBy('id').execute();
  return { users, athletes };
}

async function createBiObjects() {
  await sql`create table bi_data.r_test (subject uuid, wert numeric)`.execute(node.deps.db);
  await sql`create view bi.test_produkt as select t.wert from bi_data.r_test t
    where exists (select 1 from public.data_release r join public.data_product p on p.id = r.product_id)`.execute(
    node.deps.db,
  );
}

async function biObjectCount(): Promise<number> {
  const r = await queryAs<{ n: string }>(
    node.testDb.urls.owner,
    `select count(*) as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('bi', 'bi_data') and c.relkind in ('v', 'r')`,
  );
  return Number(r.rows[0]!.n);
}

async function expectRestoreError(p: Promise<unknown>, code: BackupFileError['code']) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BackupFileError);
    expect((err as BackupFileError).code).toBe(code);
    return;
  }
  throw new Error(`restore did not fail (expected ${code})`);
}

beforeAll(async () => {
  node = await createTestNode();
  backupDir = resolve(node.deps.config.MESH_BACKUP_DIR);
  scratch = join(backupDir, 'scratch');
  admin = await node.user(['admin']);
  await node.user(['analyst'], { email: MARKER_EMAIL });
  await node.deps.db
    .insertInto('athlete')
    .values({
      last_name: MARKER_NAME,
      first_name: 'Erika',
      date_of_birth: '2004-05-17',
      sport: 'Rudern',
      squad_status: 'NK1',
      sex: 'f',
    })
    .execute();
  for (let i = 0; i < 3; i++) {
    await node.deps.audit.record({ actor: { type: 'system' }, action: 'test.seed', details: { i } });
  }
});
afterAll(async () => {
  await node?.close();
  if (backupDir) rmSync(backupDir, { recursive: true, force: true });
});

describe('Sicherung', () => {
  test('erzeugt verschlüsselte .mbk-Datei (0600) und Manifest; kein Klartext in der Datei', async () => {
    const run = await node.deps.services.backup.runBackup('manual', admin.id);
    expect(run.status).toBe('ok');
    expect(run.trigger).toBe('manual');
    expect(run.fileName).toMatch(new RegExp(`^${node.nodeId}-\\d{8}T\\d{6}\\.\\d{3}Z\\.mbk$`));
    backupFile = join(backupDir, run.fileName!);
    expect(existsSync(backupFile)).toBe(true);
    expect(statSync(backupFile).mode & 0o777).toBe(0o600);
    expect(run.sizeBytes).toBe(statSync(backupFile).size);
    expect(run.sha256).toBe(await sha256File(backupFile));

    const manifest = JSON.parse(readFileSync(`${backupFile}.json`, 'utf8'));
    expect(manifest).toMatchObject({
      format: 'osp-data-mesh/backup@1',
      nodeId: node.nodeId,
      fileName: run.fileName,
      sha256: run.sha256,
      sizeBytes: run.sizeBytes,
      schemaVersion: expect.stringMatching(/^\d{4}$/),
      cipher: 'aes-256-gcm',
    });
    expect(statSync(`${backupFile}.json`).mode & 0o777).toBe(0o600);

    const bytes = readFileSync(backupFile);
    expect(bytes.subarray(0, 7).toString('ascii')).toBe('OSPMBK1');
    expect(bytes.includes(Buffer.from(MARKER_EMAIL))).toBe(false);
    expect(bytes.includes(Buffer.from(MARKER_NAME))).toBe(false);
    expect(bytes.includes(Buffer.from('PGDMP'))).toBe(false);

    const row = await node.deps.db
      .selectFrom('backup_run')
      .selectAll()
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ok');
    expect(row.created_by).toBe(admin.id);
    const audit = await node.deps.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'backup.create')
      .where('object_id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(audit.outcome).toBe('success');
    expect(audit.actor_id).toBe(admin.id);
  });

  test('HTTP: Sicherung anstoßen und auflisten (nur admin), Status zeigt letzte Sicherung', async () => {
    const r = await node.request<BackupRun>('POST', '/api/v1/system/backups', { as: admin });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('ok');
    const list = await node.request<{ items: BackupRun[] }>('GET', '/api/v1/system/backups', { as: admin });
    expect(list.json.items[0]!.id).toBe(r.json.id);
    expect(list.json.items.length).toBeGreaterThanOrEqual(2);
    const status = await node.request<{ backups: { last: BackupRun; encrypted: boolean } }>(
      'GET',
      '/api/v1/system/status',
      { as: admin },
    );
    expect(status.json.backups.last.id).toBe(r.json.id);
    expect(status.json.backups.encrypted).toBe(true);
    const analyst = await node.user(['analyst']);
    expect((await node.request('POST', '/api/v1/system/backups', { as: analyst })).status).toBe(403);
  });

  test('Aufbewahrung: nur die neuesten MESH_BACKUP_RETENTION Dateien bleiben', async () => {
    const cfg = node.deps.config;
    const before = cfg.MESH_BACKUP_RETENTION;
    cfg.MESH_BACKUP_RETENTION = 2;
    try {
      const runs: BackupRun[] = [];
      for (let i = 0; i < 3; i++) runs.push(await node.deps.services.backup.runBackup('schedule', null));
      const files = readdirSync(backupDir).filter((f) => f.endsWith('.mbk'));
      expect(files.sort()).toEqual([runs[1]!.fileName!, runs[2]!.fileName!].sort());
      expect(readdirSync(backupDir).filter((f) => f.endsWith('.mbk.json')).length).toBe(2);
      // die erste Sicherung (für die Wiederherstellung) als Kopie behalten
    } finally {
      cfg.MESH_BACKUP_RETENTION = before;
    }
  });

  test('fehlender Sicherungsschlüssel → fehlgeschlagener Lauf, backup_failed', async () => {
    const cfg = node.deps.config;
    const key = cfg.MESH_BACKUP_KEY;
    cfg.MESH_BACKUP_KEY = undefined;
    try {
      let error: AppError | null = null;
      try {
        await node.deps.services.backup.runBackup('manual', admin.id);
      } catch (err) {
        error = err as AppError;
      }
      expect(error?.code).toBe('backup_failed');
      expect(error?.reason).toBe('backup_key_missing');
      const last = await node.deps.db
        .selectFrom('backup_run')
        .selectAll()
        .orderBy('started_at', 'desc')
        .executeTakeFirstOrThrow();
      expect(last.status).toBe('failed');
      expect(last.error_code).toBe('backup_key_missing');
      expect(last.finished_at).not.toBeNull();

      const http = await node.request<{ error: { code: string; reason?: string } }>(
        'POST',
        '/api/v1/system/backups',
        {
          as: admin,
        },
      );
      expect(http.status).toBe(500);
      expect(http.json.error.code).toBe('backup_failed');
      const status = await node.request<{ backups: { encrypted: boolean; last: BackupRun } }>(
        'GET',
        '/api/v1/system/status',
        { as: admin },
      );
      expect(status.json.backups.encrypted).toBe(false);
      expect(status.json.backups.last.status).toBe('failed');
      const audit = await node.deps.db
        .selectFrom('audit_log')
        .selectAll()
        .where('action', '=', 'backup.create')
        .where('outcome', '=', 'error')
        .executeTakeFirst();
      expect(audit?.details).toMatchObject({ errorCode: 'backup_key_missing' });
    } finally {
      cfg.MESH_BACKUP_KEY = key;
    }
  });

  test('pg_dump nicht verfügbar → fehlgeschlagener Lauf ohne Dateireste', async () => {
    const cfg = node.deps.config;
    const before = cfg.MESH_PG_DUMP;
    cfg.MESH_PG_DUMP = '/nonexistent/pg_dump';
    const filesBefore = readdirSync(backupDir).sort();
    try {
      await expect(node.deps.services.backup.runBackup('manual', null)).rejects.toMatchObject({
        code: 'backup_failed',
      });
      const last = await node.deps.db
        .selectFrom('backup_run')
        .selectAll()
        .orderBy('started_at', 'desc')
        .executeTakeFirstOrThrow();
      expect(last.status).toBe('failed');
      expect(last.error_code).toMatch(/^pg_dump_/);
      expect(readdirSync(backupDir).sort()).toEqual(filesBefore);
    } finally {
      cfg.MESH_PG_DUMP = before;
    }
  });
});

describe('Wiederherstellung', () => {
  let first: string;

  beforeAll(async () => {
    // eigene Sicherung als Ausgangspunkt (unabhängig von der Aufbewahrungsregel oben)
    const run = await node.deps.services.backup.runBackup('cli', null);
    first = join(backupDir, run.fileName!);
    rmSync(scratch, { recursive: true, force: true });
    Bun.spawnSync(['mkdir', '-p', scratch]);
  });

  const opts = (file: string, extra: Partial<Parameters<typeof restoreBackup>[0]> = {}) => ({
    file,
    ownerUrl: node.testDb.urls.owner,
    backupKey: node.deps.config.MESH_BACKUP_KEY!,
    expectedNodeId: node.nodeId,
    tmpDir: scratch,
    ...extra,
  });

  test('manipulierte Datei: mit Manifest → manifest_mismatch, ohne Manifest → decrypt_failed', async () => {
    const tampered = join(scratch, 'tampered.mbk');
    copyFileSync(first, tampered);
    copyFileSync(`${first}.json`, `${tampered}.json`);
    const bytes = readFileSync(tampered);
    bytes[bytes.length - 100] = bytes[bytes.length - 100]! ^ 0x01;
    writeFileSync(tampered, bytes);
    await expectRestoreError(restoreBackup(opts(tampered)), 'manifest_mismatch');
    rmSync(`${tampered}.json`);
    await expectRestoreError(restoreBackup(opts(tampered)), 'decrypt_failed');

    // Kopf manipuliert (Knoten-ID): Tag-Prüfung schlägt fehl
    const header = join(scratch, 'header.mbk');
    const h = readFileSync(first);
    writeFileSync(
      header,
      Buffer.from(h.toString('latin1').replace(node.nodeId, node.nodeId.replace(/.$/, 'x')), 'latin1'),
    );
    await expectRestoreError(restoreBackup(opts(header, { allowOtherNode: true })), 'decrypt_failed');

    const garbage = join(scratch, 'garbage.mbk');
    writeFileSync(garbage, randomBytes(200));
    await expectRestoreError(restoreBackup(opts(garbage)), 'not_a_backup');
    // keine Klartextreste im temporären Verzeichnis
    expect(readdirSync(scratch).filter((f) => f.startsWith('osp-restore-'))).toEqual([]);
  });

  test('falscher Schlüssel → wrong_key; anderer Knoten → other_node', async () => {
    await expectRestoreError(
      restoreBackup(opts(first, { backupKey: randomBytes(32).toString('base64') })),
      'wrong_key',
    );
    await expectRestoreError(restoreBackup(opts(first, { expectedNodeId: 'anderer-knoten' })), 'other_node');
  });

  test('stellt den Stand der Sicherung wieder her; Audit-Kette gültig, Rechte gesetzt, Sitzungen beendet', async () => {
    const before = await snapshot();
    expect(before.athletes.some((a) => a.last_name === MARKER_NAME)).toBe(true);
    const viewer = await node.user(['analyst']);

    // Änderungen nach der Sicherung
    await node.deps.db.deleteFrom('athlete').where('last_name', '=', MARKER_NAME).execute();
    const created = await node.request<{ id: string }>('POST', '/api/v1/users', {
      as: admin,
      body: {
        email: 'nach.sicherung@example.org',
        displayName: 'Später',
        roles: ['coach'],
        password: 'ein langes passwort',
      },
    });
    expect(created.status).toBe(200);
    expect((await snapshot()).athletes.length).toBe(before.athletes.length - 1);
    // BI-Objekte (von mesh_app angelegt, View hängt an public.data_release) dürfen nicht blockieren
    await createBiObjects();

    // Fehlschlag mitten in der Wiederherstellung (fremde Abhängigkeit) → Datenbank unverändert
    await queryAs(
      node.testDb.urls.owner,
      'create schema blocker; create table blocker.t (a uuid references public.athlete(id))',
    );
    await expect(restoreBackup(opts(first))).rejects.toThrow(/database unchanged/);
    expect((await snapshot()).athletes.length).toBe(before.athletes.length - 1);
    expect(await biObjectCount()).toBe(2);
    expect((await node.request('GET', '/api/v1/auth/me', { as: viewer })).status).toBe(200);
    await queryAs(node.testDb.urls.owner, 'drop schema blocker cascade');

    const result = await restoreBackup(opts(first));
    expect(await biObjectCount()).toBe(0);
    expect(result.manifestVerified).toBe(true);
    expect(result.nodeId).toBe(node.nodeId);
    expect(result.audit.ok).toBe(true);
    expect(result.sessionsEnded).toBeGreaterThan(0);

    const after = await snapshot();
    // Personen, die zwischen Sicherung und Wiederherstellung angelegt wurden, fehlen danach
    expect(after.athletes).toEqual(before.athletes);
    expect(after.users.map((u) => u.email)).not.toContain('nach.sicherung@example.org');
    expect(after.users.map((u) => u.email)).not.toContain(viewer.email);
    expect(after.users.filter((u) => u.email !== viewer.email)).toEqual(
      before.users.filter((u) => u.email !== viewer.email),
    );

    const verify = await sql<{
      first_broken_seq: number | null;
      checked: number;
    }>`select * from audit_verify()`.execute(node.deps.db);
    expect(verify.rows[0]!.first_broken_seq).toBeNull();
    const last = await node.deps.db
      .selectFrom('audit_log')
      .selectAll()
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow();
    expect(last.action).toBe('backup.restore');
    expect(last.object_id).toBe(result.fileName);

    // Rechte: App-Rolle arbeitet normal, Audit-Log weiter nur anhängen; BI-Rolle sieht keine Kerntabellen
    await node.deps.db
      .insertInto('athlete')
      .values({
        last_name: 'Neu',
        first_name: 'Nach',
        date_of_birth: '2001-01-01',
        sport: 'Kanu',
        squad_status: 'none',
      })
      .execute();
    await node.deps.audit.record({ actor: { type: 'system' }, action: 'test.after_restore' });
    await expect(sql`delete from audit_log`.execute(node.deps.db)).rejects.toThrow();
    await expect(sql`delete from schema_migration`.execute(node.deps.db)).rejects.toThrow(
      /permission denied/,
    );
    await expect(queryAs(node.testDb.urls.bi, 'select * from public.athlete')).rejects.toThrow(
      /permission denied/,
    );
    await expect(queryAs(node.testDb.urls.bi, 'select * from public.audit_log')).rejects.toThrow(
      /permission denied/,
    );

    // alte Sitzungen sind beendet, Anmeldung mit Passwort aus dem Sicherungsstand funktioniert
    expect((await node.request('GET', '/api/v1/auth/me', { as: admin })).status).toBe(401);
    const login = await node.request('POST', '/api/v1/auth/login', {
      body: { email: admin.email, password: admin.password },
    });
    expect(login.status).toBe(200);

    const ready = await node.request<{ status: string }>('GET', '/readyz');
    expect(ready.json.status).toBe('ok');
  });
});
