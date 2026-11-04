/**
 * BI-Materialisierung: Für jede aktive Freigabe an die Rolle "bi" werden die freigegebenen Zeilen über den
 * Policy Enforcement Point geholt, in bi_data.r_<id> geschrieben und als typisierte View bi.<produkt>
 * für die Datenbankrolle mesh_bi bereitgestellt.
 *
 * Schutzschichten:
 *  - Daten kommen ausschließlich aus services.pep.serve (Freigabe, Spalten, Zeilen, Einwilligungen).
 *  - Jede View prüft bei jeder Abfrage in SQL, ob die Freigabe noch gilt (nicht widerrufen, im
 *    Gültigkeitszeitraum, Produkt aktiv und unverändert). Widerruf und Ablauf wirken so sofort, auch vor
 *    der nächsten Aktualisierung.
 *  - Widerruf entfernt die View in der Widerrufstransaktion; Einwilligungswiderruf und Löschung einer Person
 *    entfernen deren Zeilen in der auslösenden Transaktion (verborgene Spalte _subject, nie in der View).
 *  - Liefersperre (core/locks.ts): Materialisierung hält sie geteilt vom PEP-Aufruf bis zum Commit, die
 *    Bereinigung bei Einwilligungswiderruf/Löschung nimmt sie exklusiv vor dem Löschen. So kann keine
 *    Materialisierung eine eben entfernte Person aus einem älteren Datenstand zurückbringen.
 *  - mesh_bi darf nur Views im Schema bi lesen (grants.sql), nie bi_data oder public.
 */
import { sql } from 'kysely';
import type { FieldType } from '../../../shared/contract/common.ts';
import { type Actor, SYSTEM_ACTOR } from '../../core/audit.ts';
import type { DbOrTx, Tx } from '../../core/db.ts';
import type { BiService, Deps, ServeResult } from '../../core/deps.ts';
import { lockDeliveries } from '../../core/locks.ts';
import { UUID_RE } from '../products/rows.ts';
import { type ReleaseRow, statusOf } from '../releases/rules.ts';

export const BI_SCHEMA = 'bi';
export const BI_DATA_SCHEMA = 'bi_data';
export const BI_ROLE = 'mesh_bi';
const SUBJECT_COLUMN = '_subject';
const DEBOUNCE_MS = 500;
const PERIOD_MS = 10 * 60 * 1000;

const PG_TYPES: Record<FieldType, string> = {
  string: 'text',
  enum: 'text',
  integer: 'bigint',
  number: 'double precision',
  date: 'date',
  datetime: 'timestamptz',
  boolean: 'boolean',
};

export function tableNameFor(releaseId: string): string {
  return `r_${releaseId.replace(/-/g, '').slice(0, 12).toLowerCase()}`;
}

const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;

function assertIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`invalid identifier ${JSON.stringify(name)}`);
  return name;
}

interface RunOptions {
  actor: Actor;
  ip?: string | null;
  requestId?: string | null;
  /** Audit-Eintrag auch ohne Änderungen schreiben (manuelle Aktualisierung) */
  alwaysAudit?: boolean;
}

type BiReleaseRow = ReleaseRow & {
  product_slug: string;
  product_current_version: number;
  product_status: string;
};

export class BiMaterializer implements BiService {
  private chain: Promise<unknown> = Promise.resolve();
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: Deps) {}

  refreshAll(): Promise<{ refreshed: number; errors: number }> {
    return this.refresh({ actor: SYSTEM_ACTOR });
  }

  /** Serialisiert: läuft nie parallel zu einer anderen Aktualisierung dieses Knotens. */
  refresh(opts: RunOptions): Promise<{ refreshed: number; errors: number }> {
    const run = this.chain.then(() => this.run(opts));
    this.chain = run.catch(() => {});
    return run;
  }

  requestRefresh(): void {
    if (!this.deps.config.MESH_WORKERS || this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.refreshAll().catch((err) =>
        this.deps.log.error('bi refresh failed', { error: (err as Error).message }),
      );
    }, DEBOUNCE_MS);
  }

  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this.refreshAll();
    } catch (err) {
      this.deps.log.error('bi refresh failed', { error: (err as Error).message });
    }
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => {
      this.refreshAll().catch((err) =>
        this.deps.log.error('bi refresh failed', { error: (err as Error).message }),
      );
    }, PERIOD_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.interval) clearInterval(this.interval);
    this.debounce = null;
    this.interval = null;
  }

  private async run(opts: RunOptions): Promise<{ refreshed: number; errors: number }> {
    const { db, log } = this.deps;
    const at = this.deps.now();
    const rows = (await db
      .selectFrom('data_release as r')
      .innerJoin('data_product as p', 'p.id', 'r.product_id')
      .selectAll('r')
      .select([
        'p.slug as product_slug',
        'p.version as product_current_version',
        'p.status as product_status',
      ])
      .where('r.recipient_type', '=', 'role')
      .where('r.recipient_role', '=', 'bi')
      .where('r.revoked_at', 'is', null)
      .orderBy('r.created_at', 'desc')
      .execute()) as BiReleaseRow[];

    // je Produkt höchstens eine View: die neueste aktive BI-Freigabe
    const chosen = new Map<string, BiReleaseRow>();
    for (const r of rows) {
      if (r.product_status !== 'active') continue;
      if (statusOf(r, r.product_current_version, at) !== 'active') continue;
      if (!chosen.has(r.product_id)) chosen.set(r.product_id, r);
    }
    const activeIds = new Set([...chosen.values()].map((r) => r.id));

    let refreshed = 0;
    let errors = 0;
    let dropped = 0;
    const views: { releaseId: string; viewName: string; rowCount: number }[] = [];
    const failed: { releaseId: string; code: string }[] = [];

    // 1. Views nicht (mehr) aktiver Freigaben entfernen
    const live = await db.selectFrom('bi_view').selectAll().where('status', '<>', 'dropped').execute();
    for (const v of live) {
      if (activeIds.has(v.release_id)) continue;
      try {
        await db.transaction().execute((trx) => this.dropForRelease(trx, v.release_id));
        dropped++;
      } catch (err) {
        errors++;
        log.error('bi drop failed', { releaseId: v.release_id, error: (err as Error).message });
      }
    }

    // 2. aktive Freigaben (neu) materialisieren
    for (const r of chosen.values()) {
      const viewName = r.product_slug;
      const purpose = r.purposes[0];
      let code = 'refresh_failed';
      try {
        if (!purpose) {
          code = 'no_purpose';
          throw new Error('bi release without purpose');
        }
        const count = await db.transaction().execute(async (trx) => {
          // Liefersperre (geteilt) vom PEP-Aufruf bis zum Commit der neuen Tabelle (core/locks.ts): Ein
          // Einwilligungswiderruf oder eine Löschung (exklusiv) ist entweder vorher abgeschlossen – dann sieht
          // der PEP ihn – oder wartet, bis die neue Tabelle steht, und bereinigt dann diese (removeSubject).
          // Der PEP liest in eigener Transaktion, ohne Zeilensperren und ohne zu schreiben.
          await lockDeliveries(trx, 'shared');
          const result = await this.deps.services.pep.serve({
            releaseId: r.id,
            requester: { type: 'bi' },
            purpose,
          });
          if (!result.allowed) {
            code = result.reason;
            throw new Error(`pep denied: ${result.reason}`);
          }
          return this.materialize(trx, r.id, viewName, result);
        });
        if (count === null) continue; // zwischenzeitlich widerrufen
        refreshed++;
        views.push({ releaseId: r.id, viewName, rowCount: count });
      } catch (err) {
        errors++;
        failed.push({ releaseId: r.id, code });
        log.error('bi materialization failed', { releaseId: r.id, code, error: (err as Error).message });
        await this.recordError(r.id, viewName, code);
      }
    }

    if (opts.alwaysAudit || refreshed || errors || dropped) {
      await this.deps.audit.record({
        actor: opts.actor,
        action: 'bi.refresh',
        outcome: errors ? 'error' : 'success',
        objectType: 'bi',
        objectId: null,
        details: { refreshed, errors, dropped, views, failed },
        ip: opts.ip ?? null,
        requestId: opts.requestId ?? null,
      });
    }
    return { refreshed, errors };
  }

  /**
   * Schreibt Tabelle und View einer Freigabe neu (in einer Transaktion). Liefert die Zeilenzahl oder null,
   * wenn die Freigabe inzwischen widerrufen wurde.
   */
  private async materialize(
    trx: Tx,
    releaseId: string,
    viewName: string,
    result: Extract<ServeResult, { allowed: true }>,
  ): Promise<number | null> {
    if (!UUID_RE.test(releaseId)) throw new Error('invalid release id');
    assertIdent(viewName);
    const table = assertIdent(tableNameFor(releaseId));
    // Sperre auf der Freigabe: serialisiert mit einem gleichzeitigen Widerruf
    const locked = await trx
      .selectFrom('data_release')
      .select(['revoked_at'])
      .where('id', '=', releaseId)
      .forUpdate()
      .executeTakeFirst();
    if (!locked || locked.revoked_at) return null;

    // Andere (nicht entfernte) Views mit demselben Namen gehören zu älteren Freigaben desselben Produkts
    const others = await trx
      .selectFrom('bi_view')
      .select('release_id')
      .where('view_name', '=', viewName)
      .where('status', '<>', 'dropped')
      .where('release_id', '<>', releaseId)
      .execute();
    for (const o of others) await this.dropForRelease(trx, o.release_id);

    const tableId = sql.id(BI_DATA_SCHEMA, table);
    const viewId = sql.id(BI_SCHEMA, viewName);
    await sql`drop table if exists ${tableId} cascade`.execute(trx);
    await sql`drop view if exists ${viewId}`.execute(trx);

    const columns = result.columns.map((c) => ({
      key: assertIdent(c.key),
      pgType: PG_TYPES[c.type] ?? 'text',
    }));
    const columnDdl = columns.map((c) => sql`${sql.id(c.key)} ${sql.raw(c.pgType)}`);
    await sql`create table ${tableId} (${sql.id(SUBJECT_COLUMN)} uuid, ${sql.join(columnDdl)})`.execute(trx);

    const perRow = columns.length + 1;
    const batch = Math.max(1, Math.floor(30000 / perRow));
    for (let i = 0; i < result.rows.length; i += batch) {
      const chunk = result.rows.slice(i, i + batch);
      const values = chunk.map(
        (row) =>
          sql`(${sql.join([
            sql`cast(${row.athleteId} as uuid)`,
            ...columns.map((c) => sql`cast(${row.values[c.key] ?? null} as ${sql.raw(c.pgType)})`),
          ])})`,
      );
      await sql`insert into ${tableId} (${sql.join([sql.id(SUBJECT_COLUMN), ...columns.map((c) => sql.id(c.key))])}) values ${sql.join(values)}`.execute(
        trx,
      );
    }

    // Die View prüft bei jeder Abfrage, ob die Freigabe noch gilt (Widerruf/Ablauf/Produktänderung wirken sofort)
    await sql`create view ${viewId} as select ${sql.join(columns.map((c) => sql.id('t', c.key)))}
      from ${tableId} as t
      where exists (
        select 1 from public.data_release r
        join public.data_product p on p.id = r.product_id
        where r.id = ${sql.lit(releaseId)}::uuid
          and r.revoked_at is null
          and r.valid_from <= now()
          and (r.valid_until is null or r.valid_until > now())
          and p.status = 'active'
          and p.version = r.product_version
      )`.execute(trx);
    await sql`grant select on ${viewId} to ${sql.id(BI_ROLE)}`.execute(trx);

    const now = this.deps.now();
    await trx
      .insertInto('bi_view')
      .values({
        release_id: releaseId,
        view_name: viewName,
        table_name: table,
        status: 'ok',
        row_count: result.rows.length,
        error_code: null,
        refreshed_at: now,
      })
      .onConflict((oc) =>
        oc.column('release_id').doUpdateSet({
          view_name: viewName,
          table_name: table,
          status: 'ok',
          row_count: result.rows.length,
          error_code: null,
          refreshed_at: now,
        }),
      )
      .execute();
    return result.rows.length;
  }

  /** Entfernt View und Tabelle einer Freigabe (falls vorhanden) und markiert sie als entfernt. */
  async dropForRelease(trx: DbOrTx, releaseId: string): Promise<boolean> {
    const v = await trx
      .selectFrom('bi_view')
      .selectAll()
      .where('release_id', '=', releaseId)
      .where('status', '<>', 'dropped')
      .executeTakeFirst();
    if (!v) return false;
    // cascade entfernt genau die View, die auf dieser Tabelle aufbaut
    await sql`drop table if exists ${sql.id(BI_DATA_SCHEMA, assertIdent(v.table_name))} cascade`.execute(trx);
    await trx
      .updateTable('bi_view')
      .set({ status: 'dropped', row_count: 0, error_code: null, refreshed_at: this.deps.now() })
      .where('release_id', '=', releaseId)
      .execute();
    return true;
  }

  /** Fehler einer Freigabe: vorhandene Daten entfernen (deny by default), Status 'error' setzen. */
  private async recordError(releaseId: string, viewName: string, code: string): Promise<void> {
    try {
      await this.deps.db.transaction().execute(async (trx) => {
        const table = tableNameFor(releaseId);
        await sql`drop table if exists ${sql.id(BI_DATA_SCHEMA, assertIdent(table))} cascade`.execute(trx);
        const now = this.deps.now();
        await trx
          .insertInto('bi_view')
          .values({
            release_id: releaseId,
            view_name: viewName,
            table_name: table,
            status: 'error',
            row_count: 0,
            error_code: code.slice(0, 100),
            refreshed_at: now,
          })
          .onConflict((oc) =>
            oc.column('release_id').doUpdateSet({
              status: 'error',
              row_count: 0,
              error_code: code.slice(0, 100),
              refreshed_at: now,
            }),
          )
          .execute();
      });
    } catch (err) {
      this.deps.log.error('bi error status could not be recorded', {
        releaseId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Entfernt die Zeilen einer Person aus materialisierten Tabellen (in der auslösenden Transaktion).
   * onlyConsentBound: nur Freigaben mit Einwilligungspflicht bzw. Produkte besonderer Kategorie.
   * Fehler brechen die auslösende Transaktion nicht ab (Savepoint); die nächste Aktualisierung baut neu auf.
   */
  async removeSubject(trx: Tx, athleteId: string, onlyConsentBound: boolean): Promise<void> {
    if (!UUID_RE.test(athleteId)) return;
    // Zuerst die Liefersperre (exklusiv, außerhalb des Savepoints): wartet auf eine laufende Materialisierung
    // und bereinigt danach deren neue Tabelle; spätere Materialisierungen sehen den Widerruf im PEP.
    await lockDeliveries(trx, 'exclusive');
    await sql`savepoint bi_remove_subject`.execute(trx);
    try {
      const views = await trx
        .selectFrom('bi_view as v')
        .innerJoin('data_release as r', 'r.id', 'v.release_id')
        .innerJoin('data_product as p', 'p.id', 'r.product_id')
        .leftJoin('dataset as d', 'd.id', 'p.dataset_id')
        .select(['v.table_name', 'r.requires_consent', 'd.special_category', 'd.category'])
        .where('v.status', '=', 'ok')
        .execute();
      for (const v of views) {
        const consentBound = v.requires_consent || v.special_category === true || v.category === 'health';
        if (onlyConsentBound && !consentBound) continue;
        const reg = await sql<{
          t: string | null;
        }>`select to_regclass(${`${BI_DATA_SCHEMA}.${v.table_name}`})::text as t`.execute(trx);
        if (!reg.rows[0]?.t) continue;
        await sql`delete from ${sql.id(BI_DATA_SCHEMA, assertIdent(v.table_name))} where ${sql.id(SUBJECT_COLUMN)} = ${athleteId}::uuid`.execute(
          trx,
        );
      }
      await sql`release savepoint bi_remove_subject`.execute(trx);
    } catch (err) {
      await sql`rollback to savepoint bi_remove_subject`.execute(trx);
      this.deps.log.error('bi subject removal failed', { error: (err as Error).message });
    }
  }

  /** Entfernt die View einer widerrufenen Freigabe in der Widerrufstransaktion. */
  async dropInRevocation(trx: Tx, releaseId: string): Promise<void> {
    await sql`savepoint bi_drop_view`.execute(trx);
    try {
      await this.dropForRelease(trx, releaseId);
      await sql`release savepoint bi_drop_view`.execute(trx);
    } catch (err) {
      // Die View liefert nach dem Widerruf ohnehin keine Zeilen mehr (SQL-Prüfung); nächste Aktualisierung räumt auf
      await sql`rollback to savepoint bi_drop_view`.execute(trx);
      this.deps.log.error('bi view drop on revocation failed', { releaseId, error: (err as Error).message });
    }
  }
}

/** Verbindungsdaten für BI-Werkzeuge (ohne Passwort) */
export function biConnectionInfo(cfg: Deps['config']): {
  schema: string;
  role: string;
  database: string | null;
  host: string | null;
  port: number | null;
} {
  let host: string | null = null;
  let port: number | null = null;
  let database: string | null = null;
  try {
    const u = new URL(cfg.MESH_DB_URL);
    host = u.hostname || u.searchParams.get('host') || null;
    port = u.port ? Number(u.port) : 5432;
    database = decodeURIComponent(u.pathname.replace(/^\//, '')) || null;
  } catch {
    // ungültige URL: nur konfigurierte Werte anzeigen
  }
  return {
    schema: BI_SCHEMA,
    role: BI_ROLE,
    database: cfg.MESH_BI_DB_NAME ?? database,
    host: cfg.MESH_BI_DB_HOST ?? host,
    port: cfg.MESH_BI_DB_PORT ?? port,
  };
}
