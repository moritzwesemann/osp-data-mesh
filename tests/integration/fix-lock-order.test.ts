/**
 * Regression: Sperrreihenfolge (core/locks.ts). Vorher nahmen Stilllegung, Neueinstufung und Löschung mit
 * offener Importvorschau die knotenweite Audit-Sperre (Audit-Trigger), bevor sie auf die Liefersperre bzw.
 * Zeilensperren warteten, während Einwilligungswiderruf und Löschung die Liefersperre zuerst nahmen;
 * datasets.update schrieb Audit und sperrte danach Produktzeilen, products.update umgekehrt; die
 * Importübernahme sperrte den Lauf vor den Personen, die Löschung die Person vor dem Lauf. Folgen:
 * "deadlock detected" (500) und knotenweiter Stillstand aller auditierten Anfragen, solange eine Stilllegung
 * auf eine Lieferung wartete.
 *
 * Außerdem belegten liefernde Transaktionen (Liefersperre geteilt) für den PEP eine zweite Pool-Verbindung:
 * Waren alle übrigen Verbindungen von Transaktionen belegt, die auf die Liefersperre warteten, stand der
 * Knoten bis zum statement_timeout.
 *
 * Die Tests treffen die kritischen Fenster deterministisch (Halten an einer Stelle bzw. mit einer externen
 * Sperre) und prüfen, dass beide Seiten gelingen.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import pg from 'pg';
import { SYSTEM_ACTOR } from '../../src/server/core/audit.ts';
import { DELIVERY_LOCK } from '../../src/server/core/locks.ts';
import { writeTx } from '../../src/server/core/tx.ts';
import { onboard } from '../helpers/federation.ts';
import { auditEntries, fileForm, importTemplate, startImport } from '../helpers/integration.ts';
import {
  createTestNode,
  TestMesh,
  type TestNode,
  type TestResponse,
  type TestUser,
} from '../helpers/node.ts';
import { type StandardSeed, seedStandard } from '../helpers/seed.ts';

const AUDIT_LOCK = 7212001;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

interface Fixture {
  node: TestNode;
  seed: StandardSeed;
  steward: TestUser;
  /** Superuser-Verbindung zur Testdatenbank (Beobachtung, Aufräumen) */
  admin: pg.Client;
}

async function superuserClient(node: TestNode): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: node.testDb.superuserUrl.replace(/\/[^/]*$/, `/${node.testDb.dbName}`),
  });
  await client.connect();
  return client;
}

async function fixture(): Promise<Fixture> {
  const node = await createTestNode();
  const admin = await superuserClient(node);
  cleanup.push(async () => node.close());
  cleanup.push(async () => {
    // hängengebliebene Anfragen eines fehlschlagenden Tests lösen, damit der Lauf nicht steht
    await admin.query(
      `select pg_cancel_backend(pid) from pg_stat_activity
        where datname = current_database() and usename = 'mesh_app' and wait_event_type = 'Lock'`,
    );
    await admin.end();
  });
  const seed = await seedStandard(node.deps.db);
  const steward = await node.user(['data_steward']);
  return { node, seed, steward, admin };
}

async function waitFor(what: string, cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** Anfragen dieses Knotens (mesh_app), die auf eine Sperre warten */
async function lockWaiters(admin: pg.Client): Promise<number> {
  const r = await admin.query<{ n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and usename = 'mesh_app' and wait_event_type = 'Lock'`,
  );
  return r.rows[0]!.n;
}

async function advisoryWaiters(admin: pg.Client, key: number): Promise<number> {
  const r = await admin.query<{ n: number }>(
    `select count(*)::int as n from pg_locks
      where locktype = 'advisory' and objid = $1 and not granted
        and database = (select oid from pg_database where datname = current_database())`,
    [key],
  );
  return r.rows[0]!.n;
}

/** Ergebnis innerhalb der Frist oder 'timeout' */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function deadlocks(node: TestNode) {
  return (await node.deps.db.selectFrom('app_error').select(['path', 'message']).execute()).filter((e) =>
    /deadlock/i.test(e.message),
  );
}

async function createProduct(f: Fixture, slug: string): Promise<string> {
  const p = await f.node.request<{ id: string }>('POST', '/api/v1/products', {
    as: f.steward,
    body: {
      slug,
      name: slug,
      sourceType: 'dataset',
      datasetId: f.seed.performance,
      columns: [{ key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' }],
    },
  });
  expect(p.status).toBe(200);
  return p.json.id;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('Globale Sperrreihenfolge (core/locks.ts)', () => {
  test('Einwilligungswiderruf und Stilllegung gleichzeitig: keine Verklemmung, Audit läuft weiter', async () => {
    const f = await fixture();
    const productId = await createProduct(f, 'leistung');

    // Widerruf anhalten, nachdem seine Handler gelaufen sind: Liefersperre exklusiv gehalten
    const g = gate();
    let entered = false;
    f.node.deps.events.onTx('consent.withdrawn', async () => {
      if (entered) return;
      entered = true;
      await g.opened;
    });
    cleanup.push(async () => g.open());

    const consent = await f.node.deps.db
      .selectFrom('consent_record')
      .select('id')
      .where('athlete_id', '=', f.seed.athletes.ben)
      .where('purpose', '=', 'training_steering')
      .executeTakeFirstOrThrow();
    const withdrawing = f.node.request('POST', `/api/v1/consents/${consent.id}/withdraw`, {
      as: f.steward,
      body: { note: '' },
    });
    await waitFor('withdrawal handlers', async () => entered);

    const retiring = f.node.request('POST', `/api/v1/products/${productId}/retire`, { as: f.steward });
    // die Stilllegung wartet auf die Liefersperre – als Erstes, ohne Audit-Sperre oder Zeilensperren
    await waitFor(
      'retire waiting for the delivery lock',
      async () => (await advisoryWaiters(f.admin, DELIVERY_LOCK)) > 0,
    );

    // Auditierte Anfragen laufen währenddessen weiter (vorher hielt die Stilllegung die Audit-Sperre)
    const read = await within(f.node.request('GET', '/api/v1/athletes', { as: f.steward }), 3000);
    expect(read === 'timeout' ? 'timeout' : read.status).toBe(200);

    g.open();
    const [w, r] = await Promise.all([withdrawing, retiring]);
    expect([w.status, r.status]).toEqual([200, 200]);
    expect(await deadlocks(f.node)).toEqual([]);
    expect((await auditEntries(f.node, 'product.retire')).length).toBe(1);
    expect((await auditEntries(f.node, 'consent.withdraw')).length).toBe(1);
  });

  test('Produktänderung und Neueinstufung des Datensatzes gleichzeitig: keine Verklemmung', async () => {
    const f = await fixture();
    const productId = await createProduct(f, 'leistung');

    // Produktänderung anhalten, nachdem sie die Produktzeile gesperrt und geändert hat
    const audit = f.node.deps.audit;
    const original = audit.record.bind(audit);
    const g = gate();
    let entered = false;
    audit.record = async (entry, trx) => {
      if (!entered && entry.action === 'product.update' && entry.actor.type === 'user') {
        entered = true;
        await g.opened;
      }
      return original(entry, trx);
    };
    cleanup.push(async () => {
      g.open();
      audit.record = original;
    });

    const updating = f.node.request('PATCH', `/api/v1/products/${productId}`, {
      as: f.steward,
      body: { name: 'Leistung neu' },
    });
    await waitFor('product update holding the product row', async () => entered);
    const reclassifying = f.node.request('PATCH', `/api/v1/datasets/${f.seed.performance}`, {
      as: f.steward,
      body: { category: 'training' },
    });
    // die Neueinstufung wartet auf die Produktzeile (vorher: mit gehaltener Audit-Sperre)
    await waitFor('dataset update waiting for the product row', async () => (await lockWaiters(f.admin)) > 0);
    g.open();
    const [u, d] = await Promise.all([updating, reclassifying]);
    expect([u.status, d.status]).toEqual([200, 200]);
    expect(await deadlocks(f.node)).toEqual([]);
    const product = await f.node.request<{ name: string; version: number; category: string }>(
      'GET',
      `/api/v1/products/${productId}`,
      { as: f.steward },
    );
    expect(product.json).toMatchObject({ name: 'Leistung neu', version: 2, category: 'training' });
  });

  test('Importübernahme und Löschung derselben Person gleichzeitig: keine Verklemmung (athlete → import_run)', async () => {
    const f = await fixture();
    const injuries = await importTemplate(f.node, f.steward, 'verletzungen-csv', (def) => {
      def.connector.slug = 'verletzungen-name';
      def.connector.athleteMatch = { strategy: 'natural_key' };
      def.connector.mapping = [
        { source: 'Nachname', target: 'athlete.last_name', transform: 'trim' },
        { source: 'Vorname', target: 'athlete.first_name', transform: 'trim' },
        { source: 'Geburtsdatum', target: 'athlete.date_of_birth', transform: 'trim' },
        ...def.connector.mapping.filter((m) => m.target.startsWith('data.')),
      ];
    });
    const created = await f.node.request<{ id: string }>('POST', '/api/v1/athletes', {
      as: f.steward,
      body: {
        lastName: 'Vergessen',
        firstName: 'Otto',
        dateOfBirth: '2003-02-02',
        sport: 'Rudern',
        squadStatus: 'PK',
      },
    });
    expect(created.status).toBe(200);
    const otto = created.json.id;
    const csv = [
      'Nachname;Vorname;Geburtsdatum;Verletzungsdatum;Körperregion;Verletzungsart;Ausfalltage;Status',
      'Vergessen;Otto;02.02.2003;15.09.2024;Knie;Bänderverletzung;46;akut',
    ].join('\n');
    const preview = await startImport(f.node, f.steward, injuries.id, fileForm(csv, 'verletzungen.csv'));
    expect(preview.run).toMatchObject({ status: 'previewed', validRows: 1 });

    // Externe Sperre auf dem Lauf: die Übernahme wartet darauf, die Löschung trifft sie in diesem Fenster
    const holder = await superuserClient(f.node);
    cleanup.push(async () => holder.end());
    await holder.query('begin');
    await holder.query('select id from import_run where id = $1 for update', [preview.run.id]);

    const committing = f.node.request('POST', `/api/v1/import-runs/${preview.run.id}/commit`, {
      as: f.steward,
    });
    await waitFor('commit waiting', async () => (await lockWaiters(f.admin)) >= 1);
    const erasing = f.node.request('DELETE', `/api/v1/athletes/${otto}`, { as: f.steward });
    await waitFor('erasure waiting', async () => (await lockWaiters(f.admin)) >= 2);
    await holder.query('commit');

    const [c, e] = await Promise.all([committing, erasing]);
    expect([c.status, e.status]).toEqual([200, 200]);
    expect(await deadlocks(f.node)).toEqual([]);
    // Übernahme zuerst (sie hielt die Person), danach die Löschung samt der eben übernommenen Einträge
    expect((c as TestResponse<{ status: string }>).json.status).toBe('committed');
    const left = await f.node.deps.db
      .selectFrom('dataset_record')
      .select('id')
      .where('athlete_id', '=', otto)
      .execute();
    expect(left).toEqual([]);
    expect(
      await f.node.deps.db.selectFrom('athlete').select('id').where('id', '=', otto).executeTakeFirst(),
    ).toBeUndefined();
  });

  test('Bereinigende Ereignis-Handler verlangen die Liefersperre der auslösenden Transaktion', async () => {
    const f = await fixture();
    const productId = await createProduct(f, 'leistung');
    await expect(
      f.node.deps.db.transaction().execute((trx) =>
        f.node.deps.events.inTx(trx, 'consent.withdrawn', {
          athleteId: f.seed.athletes.ben,
          consentId: crypto.randomUUID(),
          purpose: 'training_steering',
          dataCategory: 'performance',
        }),
      ),
    ).rejects.toThrow(/lock order violated/);
    await expect(
      f.node.deps.db
        .transaction()
        .execute((trx) =>
          f.node.deps.events.inTx(trx, 'athlete.deleted', { athleteId: f.seed.athletes.ben }),
        ),
    ).rejects.toThrow(/lock order violated/);
    await expect(
      f.node.deps.db
        .transaction()
        .execute((trx) => f.node.deps.events.inTx(trx, 'product.changed', { productId, retired: true })),
    ).rejects.toThrow(/lock order violated/);
  });

  test('writeTx schreibt Audit-Einträge erst unmittelbar vor dem Commit, in Aufrufreihenfolge', async () => {
    const f = await fixture();
    const { deps } = f.node;
    const auditLockHeld = async (pid: number) =>
      (
        await f.admin.query<{ n: number }>(
          `select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1 and pid = $2 and granted`,
          [AUDIT_LOCK, pid],
        )
      ).rows[0]!.n > 0;

    let heldDuring = null as boolean | null;
    await writeTx(deps, async (trx) => {
      const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx)).rows[0]!.pid;
      await deps.audit.record({ actor: SYSTEM_ACTOR, action: 'test.first' }, trx);
      await deps.audit.record({ actor: SYSTEM_ACTOR, action: 'test.second' }, trx);
      heldDuring = await auditLockHeld(pid);
      const visible = await trx
        .selectFrom('audit_log')
        .select('id')
        .where('action', 'in', ['test.first', 'test.second'])
        .execute();
      expect(visible).toEqual([]);
    });
    expect(heldDuring).toBe(false);
    const written = await deps.db
      .selectFrom('audit_log')
      .select(['action', 'seq'])
      .where('action', 'in', ['test.first', 'test.second'])
      .orderBy('seq')
      .execute();
    expect(written.map((w) => w.action)).toEqual(['test.first', 'test.second']);
    expect(written[1]!.seq).toBe(written[0]!.seq! + 1);

    // Fehler in der Transaktion: nichts geschrieben; danach schreibt record wieder sofort
    await expect(
      writeTx(deps, async (trx) => {
        await deps.audit.record({ actor: SYSTEM_ACTOR, action: 'test.rolled_back' }, trx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await auditEntries(f.node, 'test.rolled_back')).toEqual([]);
    await deps.db
      .transaction()
      .execute((trx) => deps.audit.record({ actor: SYSTEM_ACTOR, action: 'test.direct' }, trx));
    expect((await auditEntries(f.node, 'test.direct')).length).toBe(1);
  });
});

describe('Lieferungen belegen keine zweite Pool-Verbindung (Testpool: 5 Verbindungen)', () => {
  test('BI-Aktualisierung und vier Löschungen hinter einer exklusiven Operation: kein Stillstand', async () => {
    const f = await fixture();
    const productId = await createProduct(f, 'leistung');
    const r = await f.node.request('POST', '/api/v1/releases', {
      as: f.steward,
      body: {
        productId,
        recipient: { type: 'role', role: 'bi' },
        purposes: ['reporting'],
        columns: ['cmj'],
        requiresConsent: false,
      },
    });
    expect(r.status).toBe(200);

    // eine laufende exklusive Operation (extern)
    const holder = new pg.Client({ connectionString: f.node.testDb.urls.app });
    await holder.connect();
    cleanup.push(async () => holder.end());
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock($1::bigint)', [DELIVERY_LOCK]);

    const refreshing = f.node.request<{ refreshed: number; errors: number }>('POST', '/api/v1/bi/refresh', {
      as: f.steward,
    });
    await waitFor('refresh waiting', async () => (await advisoryWaiters(f.admin, DELIVERY_LOCK)) >= 1);
    const { anna, ben, dario, eva } = f.seed.athletes;
    const deletions = [anna, ben, dario, eva].map((id) =>
      f.node.request('DELETE', `/api/v1/athletes/${id}`, { as: f.steward }),
    );
    // alle fünf Pool-Verbindungen warten auf die Liefersperre
    await waitFor('deletions waiting', async () => (await advisoryWaiters(f.admin, DELIVERY_LOCK)) >= 5);
    await holder.query('commit');

    const done = await within(Promise.all([refreshing, ...deletions]), 10_000);
    expect(done === 'timeout' ? 'stalled' : done.map((x) => x.status)).toEqual([200, 200, 200, 200, 200]);
    if (done !== 'timeout') expect((done[0] as TestResponse<{ errors: number }>).json.errors).toBe(0);
  });

  test('Stilllegung wartet auf eine Lieferung: auditierte Anfragen und die Lieferung laufen weiter', async () => {
    const f = await fixture();
    const biProduct = await createProduct(f, 'leistung');
    const other = await createProduct(f, 'andere');
    const r = await f.node.request('POST', '/api/v1/releases', {
      as: f.steward,
      body: {
        productId: biProduct,
        recipient: { type: 'role', role: 'bi' },
        purposes: ['reporting'],
        columns: ['cmj'],
        requiresConsent: false,
      },
    });
    expect(r.status).toBe(200);

    const holder = new pg.Client({ connectionString: f.node.testDb.urls.app });
    await holder.connect();
    cleanup.push(async () => holder.end());
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock($1::bigint)', [DELIVERY_LOCK]);

    const refreshing = f.node.request('POST', '/api/v1/bi/refresh', { as: f.steward });
    await waitFor('refresh waiting', async () => (await advisoryWaiters(f.admin, DELIVERY_LOCK)) >= 1);
    const retiring = f.node.request('POST', `/api/v1/products/${other}/retire`, { as: f.steward });
    await waitFor('retire waiting', async () => (await advisoryWaiters(f.admin, DELIVERY_LOCK)) >= 2);

    // Die wartende Stilllegung hält keine Audit-Sperre: auditierte Lesezugriffe gelingen sofort
    const reads = await within(
      Promise.all([1, 2, 3].map(() => f.node.request('GET', '/api/v1/athletes', { as: f.steward }))),
      5000,
    );
    expect(reads === 'timeout' ? 'stalled' : reads.map((x) => x.status)).toEqual([200, 200, 200]);

    await holder.query('commit');
    const done = await within(Promise.all([refreshing, retiring]), 10_000);
    expect(done === 'timeout' ? 'stalled' : done.map((x) => x.status)).toEqual([200, 200]);
  });

  test('Partnerabruf und vier Löschungen hinter einer exklusiven Operation: kein Stillstand', async () => {
    const mesh = new TestMesh();
    cleanup.push(async () => mesh.close());
    const a = await mesh.add({ nodeId: 'osp-a' });
    const b = await mesh.add({ nodeId: 'osp-b' });
    const { bOnA, aOnB } = await onboard(a, b);
    const seed = await seedStandard(a.deps.db);
    const stewardA = await a.user(['data_steward']);
    const stewardB = await b.user(['data_steward']);
    const admin = await superuserClient(a);
    cleanup.push(async () => {
      await admin.query(
        `select pg_cancel_backend(pid) from pg_stat_activity
          where datname = current_database() and usename = 'mesh_app' and wait_event_type = 'Lock'`,
      );
      await admin.end();
    });
    const p = await a.request<{ id: string }>('POST', '/api/v1/products', {
      as: stewardA,
      body: {
        slug: 'leistung',
        name: 'Leistung',
        sourceType: 'dataset',
        datasetId: seed.performance,
        columns: [{ key: 'cmj', label: 'CMJ', source: 'data.cmj_cm' }],
      },
    });
    const r = await a.request<{ id: string }>('POST', '/api/v1/releases', {
      as: stewardA,
      body: {
        productId: p.json.id,
        recipient: { type: 'peer', peerId: bOnA.id },
        purposes: ['training_steering'],
        columns: ['cmj'],
        requiresConsent: false,
      },
    });
    expect(r.status).toBe(200);

    const holder = new pg.Client({ connectionString: a.testDb.urls.app });
    await holder.connect();
    cleanup.push(async () => holder.end());
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock($1::bigint)', [DELIVERY_LOCK]);

    const pulling = b.request('POST', '/api/v1/received/pull', {
      as: stewardB,
      body: { peerId: aOnB.id, releaseId: r.json.id, purpose: 'training_steering' },
    });
    await waitFor('pull waiting', async () => (await advisoryWaiters(admin, DELIVERY_LOCK)) >= 1);
    const { anna, ben, dario, eva } = seed.athletes;
    const deletions = [anna, ben, dario, eva].map((id) =>
      a.request('DELETE', `/api/v1/athletes/${id}`, { as: stewardA }),
    );
    await waitFor('deletions waiting', async () => (await advisoryWaiters(admin, DELIVERY_LOCK)) >= 5);
    await holder.query('commit');

    const done = await within(Promise.all([pulling, ...deletions]), 10_000);
    expect(done === 'timeout' ? 'stalled' : done.map((x) => x.status)).toEqual([200, 200, 200, 200, 200]);
  });
});
