/**
 * Regression: Die BI-Materialisierung rief den PEP vor bzw. außerhalb ihrer Transaktion auf. Committete
 * dazwischen ein Einwilligungswiderruf oder eine Löschung, bereinigte dessen Handler die alte Tabelle, und
 * die neue Tabelle wurde aus dem älteren Stand gefüllt – die Person war wieder in der View.
 *
 * Jetzt hält die Materialisierung die Liefersperre geteilt vom PEP-Aufruf bis zum Commit; die BI-Bereinigung
 * nimmt sie exklusiv, bevor sie löscht. Die Tests halten die Materialisierung genau im kritischen Fenster an
 * (PEP-Ergebnis liegt vor, Tabelle noch nicht geschrieben) und prüfen Reihenfolge und Ergebnis.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'kysely';
import { DELIVERY_LOCK } from '../../src/server/core/locks.ts';
import type { Product } from '../../src/shared/contract/products.ts';
import type { Release } from '../../src/shared/contract/releases.ts';
import { queryAs } from '../helpers/db.ts';
import { createTestNode, type TestNode, type TestUser } from '../helpers/node.ts';
import { type StandardSeed, seedStandard } from '../helpers/seed.ts';

let node: TestNode;
let seed: StandardSeed;
let steward: TestUser;
let health: Product;
let release: Release;

async function biRows(view: string) {
  return (await queryAs<{ last_name: string }>(node.testDb.urls.bi, `select * from bi.${view}`)).rows;
}

/** Liefert, sobald eine Transaktion dieser Datenbank auf die Liefersperre wartet. */
async function deliveryLockWaiter(): Promise<'waiting'> {
  for (;;) {
    const r = await sql<{ n: number }>`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and objid = ${DELIVERY_LOCK} and not granted
        and database = (select oid from pg_database where datname = current_database())`.execute(
      node.deps.db,
    );
    if ((r.rows[0]?.n ?? 0) > 0) return 'waiting';
    await Bun.sleep(5);
  }
}

/**
 * Hält die nächste Materialisierung an, nachdem der PEP sein Ergebnis geliefert hat (das kritische
 * Fenster), führt währenddessen `action` aus und gibt die Materialisierung frei, sobald `action` entweder
 * fertig ist oder auf die Liefersperre wartet. Liefert, was zuerst eintrat.
 */
async function duringMaterialization<T>(action: () => Promise<T>) {
  const base = node.deps.services.pep;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let entered = false;
  node.deps.services.pep = {
    async serve(req) {
      const result = await base.serve(req);
      if (!entered) {
        entered = true;
        await gate;
      }
      return result;
    },
  };
  try {
    const refreshing = node.request<{ refreshed: number; errors: number }>('POST', '/api/v1/bi/refresh', {
      as: steward,
    });
    while (!entered) await Bun.sleep(5);
    const acting = action();
    const first = await Promise.race([acting.then(() => 'finished' as const), deliveryLockWaiter()]);
    open();
    const refreshed = await refreshing;
    return { first, refreshed, result: await acting };
  } finally {
    open();
    node.deps.services.pep = base;
  }
}

beforeAll(async () => {
  node = await createTestNode();
  seed = await seedStandard(node.deps.db);
  steward = await node.user(['data_steward']);
  const p = await node.request<Product>('POST', '/api/v1/products', {
    as: steward,
    body: {
      slug: 'gesundheit',
      name: 'Gesundheit',
      sourceType: 'dataset',
      datasetId: seed.health,
      columns: [
        { key: 'last_name', label: 'Nachname', source: 'athlete.last_name' },
        { key: 'hr', label: 'Ruhepuls', source: 'data.resting_hr' },
      ],
    },
  });
  expect(p.status).toBe(200);
  health = p.json;
  const r = await node.request<Release>('POST', '/api/v1/releases', {
    as: steward,
    body: {
      productId: health.id,
      recipient: { type: 'role', role: 'bi' },
      purposes: ['medical_care'],
      columns: ['last_name', 'hr'],
      requiresConsent: true,
    },
  });
  expect(r.status).toBe(200);
  release = r.json;
  const first = await node.request('POST', '/api/v1/bi/refresh', { as: steward });
  expect(first.status).toBe(200);
  expect((await biRows('gesundheit')).map((x) => x.last_name).sort()).toEqual(['Adler', 'Berg']);
});
afterAll(async () => {
  await node?.close();
});

describe('BI-Materialisierung und Liefersperre', () => {
  test('Einwilligungswiderruf während der Materialisierung: wartet und bereinigt die neue Tabelle', async () => {
    const consent = await node.deps.db
      .selectFrom('consent_record')
      .select('id')
      .where('athlete_id', '=', seed.athletes.ben)
      .where('purpose', '=', 'medical_care')
      .executeTakeFirstOrThrow();
    const { first, refreshed, result } = await duringMaterialization(() =>
      node.request('POST', `/api/v1/consents/${consent.id}/withdraw`, { as: steward, body: { note: '' } }),
    );
    // Der Widerruf wartet auf die laufende Materialisierung, statt die alte Tabelle zu bereinigen
    expect(first).toBe('waiting');
    expect(result.status).toBe(200);
    expect(refreshed.json).toEqual({ refreshed: 1, errors: 0 });
    // Die neue Tabelle (aus dem PEP-Stand vor dem Widerruf) wurde danach bereinigt
    expect((await biRows('gesundheit')).map((x) => x.last_name)).toEqual(['Adler']);
    const table = (
      await node.deps.db
        .selectFrom('bi_view')
        .select('table_name')
        .where('release_id', '=', release.id)
        .executeTakeFirstOrThrow()
    ).table_name;
    const subjects = await sql<{
      s: string;
    }>`select _subject::text as s from ${sql.id('bi_data', table)}`.execute(node.deps.db);
    expect(subjects.rows.map((r) => r.s)).toEqual([seed.athletes.anna]);
  });

  test('Löschung einer Person während der Materialisierung: wartet und bereinigt die neue Tabelle', async () => {
    const { first, refreshed, result } = await duringMaterialization(() =>
      node.request('DELETE', `/api/v1/athletes/${seed.athletes.anna}`, { as: steward }),
    );
    expect(first).toBe('waiting');
    expect(result.status).toBe(200);
    expect(refreshed.json).toEqual({ refreshed: 1, errors: 0 });
    expect(await biRows('gesundheit')).toEqual([]);
  });

  test('Stilllegung während der Materialisierung: keine Verklemmung (erst Liefersperre, dann Freigabe)', async () => {
    const { first, refreshed, result } = await duringMaterialization(() =>
      node.request('POST', `/api/v1/products/${health.id}/retire`, { as: steward }),
    );
    expect(first).toBe('waiting');
    expect(result.status).toBe(200);
    expect(refreshed.json).toEqual({ refreshed: 1, errors: 0 });
    await expect(biRows('gesundheit')).rejects.toThrow(/does not exist/);
    const view = await node.deps.db
      .selectFrom('bi_view')
      .select('status')
      .where('release_id', '=', release.id)
      .executeTakeFirstOrThrow();
    expect(view.status).toBe('dropped');
  });
});
