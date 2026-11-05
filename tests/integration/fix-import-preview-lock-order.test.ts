/**
 * Regression (Review Runde 3): Importvorschau (Lesesperre auf Personen) und Übernahme eines
 * Stammdatenimports (Schreibsperre auf Personen) müssen Personenzeilen in derselben Reihenfolge (nach id)
 * sperren, sonst Verklemmung ("deadlock detected" → 500). Die Verzahnung wird mit einer fremden Zeilensperre
 * deterministisch erzwungen.
 */
import { afterEach, expect, test } from 'bun:test';
import pg from 'pg';
import { fileForm, importTemplate, startImport } from '../helpers/integration.ts';
import { createTestNode, type TestNode } from '../helpers/node.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

async function su(node: TestNode) {
  const c = new pg.Client({
    connectionString: node.testDb.superuserUrl.replace(/\/[^/]*$/, `/${node.testDb.dbName}`),
  });
  await c.connect();
  return c;
}
async function waiters(admin: pg.Client) {
  const r = await admin.query<{ n: number }>(
    `select count(*)::int n from pg_stat_activity where datname=current_database() and usename='mesh_app' and wait_event_type='Lock'`,
  );
  return r.rows[0]!.n;
}
async function waitFor(cond: () => Promise<boolean>, ms = 5000) {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('timeout');
    await Bun.sleep(5);
  }
}

test('Importvorschau und Stammdaten-Übernahme sperren Personen in gleicher Reihenfolge (keine Verklemmung)', async () => {
  const node = await createTestNode();
  cleanup.push(() => node.close());
  const admin = await su(node);
  cleanup.push(async () => {
    await admin.query(
      `select pg_cancel_backend(pid) from pg_stat_activity where datname=current_database() and usename='mesh_app' and wait_event_type='Lock'`,
    );
    await admin.end();
  });
  const steward = await node.user(['data_steward']);

  const N = 40;
  for (let i = 0; i < N; i++) {
    const a = await node.deps.db
      .insertInto('athlete')
      .values({
        last_name: `Name${i}`,
        first_name: 'X',
        date_of_birth: '2004-01-01',
        sport: 'Rudern',
        squad_status: 'PK',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await node.deps.db
      .insertInto('athlete_identifier')
      .values({ athlete_id: a.id, system: 'osp-id', value: `P${String(i).padStart(3, '0')}` })
      .execute();
  }
  const phys = (await admin.query<{ id: string }>('select id from athlete order by ctid')).rows.map(
    (r) => r.id,
  );
  // k (0-based) so that T1 holds phys[0..k-1], blocks on phys[k]; T2 locks some row after k first
  let k = -1;
  for (let j = 1; j < N - 1; j++) {
    const held = phys.slice(0, j + 1).sort()[0]!;
    const after = phys.slice(j + 1).sort()[0]!;
    if (after < held) {
      k = j;
      break;
    }
  }
  expect(k).toBeGreaterThan(0);
  const M = phys[k]!;

  const master = await importTemplate(node, steward, 'athleten-stammdaten-csv');
  const injuries = await importTemplate(node, steward, 'verletzungen-csv');
  const masterCsv = [
    'Athleten-ID;Nachname;Vorname;Geburtsdatum;Geschlecht;Sportart;Disziplin;Kaderstatus;Verein',
    ...Array.from(
      { length: N },
      (_, i) => `P${String(i).padStart(3, '0')};Name${i};X;01.01.2004;w;Rudern;;Perspektivkader;Club`,
    ),
  ].join('\n');
  const prevA = await startImport(node, steward, master.id, fileForm(masterCsv, 'kader.csv'));
  expect(prevA.run.status).toBe('previewed');
  const injCsv = [
    'Athleten-ID;Verletzungsdatum;Körperregion;Verletzungsart;Ausfalltage;Status',
    ...Array.from(
      { length: N },
      (_, i) => `P${String(i).padStart(3, '0')};15.09.2024;Knie;Bänderverletzung;4;akut`,
    ),
  ].join('\n');

  // T0 holds M so the preview's FOR SHARE scan stops in the middle (deterministic interleaving)
  const t0 = await su(node);
  cleanup.push(async () => {
    await t0.end();
  });
  await t0.query('begin');
  await t0.query('select id from athlete where id = $1 for update', [M]);

  const preview = node.request('POST', `/api/v1/connectors/${injuries.id}/runs`, {
    as: steward,
    form: fileForm(injCsv, 'verletzungen.csv'),
  });
  await waitFor(async () => (await waiters(admin)) >= 1);
  const commit = node.request('POST', `/api/v1/import-runs/${prevA.run.id}/commit`, { as: steward });
  await waitFor(async () => (await waiters(admin)) >= 2);
  await t0.query('commit');

  const [p, c] = await Promise.all([preview, commit]);
  const errors = await node.deps.db.selectFrom('app_error').select(['path', 'message']).execute();
  expect(p.status).toBe(200);
  expect(c.status).toBe(200);
  expect(errors.some((e) => /deadlock/i.test(e.message))).toBe(false);
}, 30000);
