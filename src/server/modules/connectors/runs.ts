/**
 * Importläufe: Quelle lesen (CSV-Upload oder API), Pipeline ausführen, Vorschau mit Fehlerprotokoll
 * speichern (Status "previewed"), Übernahme (Athletenkern bzw. dataset_record) oder Verwerfen.
 *
 * Datenschutz: Die Rohdatei wird nicht gespeichert (nur SHA-256 und Größe). Vorgemerkte Zeilen
 * (import_run.staged), Vorschauzeilen und Rohwerte im Fehlerprotokoll gibt es nur während der Vorschau;
 * sie werden bei Übernahme, Verwerfen oder Ablauf gelöscht, die Zeilen einer gelöschten Person sofort
 * (siehe retention.ts). Es bleiben Zähler, Prüfsumme und das Fehlerprotokoll (Zeile, Feld, Code).
 * Zuordnungsfehler speichern keine Personenkennungen als Rohwert.
 */
import { sql } from 'kysely';
import type { Scalar } from '../../../shared/contract/common.ts';
import type { ConnectorInput, ImportRun } from '../../../shared/contract/connectors.ts';
import type { Actor } from '../../core/audit.ts';
import { sha256Hex } from '../../core/crypto.ts';
import { type DbOrTx, pgCode } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import type { Deps } from '../../core/deps.ts';
import { AppError, conflict, invalid, notFound } from '../../core/errors.ts';
import { writeTx } from '../../core/tx.ts';
import {
  type AthleteLookup,
  type AthleteValues,
  decodeText,
  emptyLookup,
  existingRecordKey,
  flagRecordUpdates,
  type Issue,
  MAX_SOURCE_COLUMNS,
  MAX_SOURCE_ROWS,
  type MappedRow,
  mapRow,
  markDuplicates,
  missingColumns,
  naturalKeyOf,
  type PipelineContext,
  parseCsv,
  resolveAthletes,
  type SourceTable,
  summarize,
  tableFromItems,
} from './pipeline.ts';
import { connectorInputOf, loadDataset, toImportRun } from './repo.ts';
import {
  CLEARED_PREVIEW,
  clearRawValues,
  type PreviewData,
  type RowSubject,
  readStaged,
  recordVanished,
  type StagedRun,
  subjectsOf,
  withoutRows,
} from './retention.ts';
import { checkSource, fetchApiItems, hostOf, type SourceDenial, sourceNameOf } from './source-http.ts';
import { type ConvertOptions, localDate } from './validate.ts';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const CHUNK = 500;
const MAX_RAW_VALUE = 500;

/** AAD des verschlüsselten Zugangsgeheimnisses (die Schlüsselrotation der CLI verlässt sich darauf) */
export const secretAad = (connectorId: string) => `connector.secret:${connectorId}`;

/** Abweisung einer API-Quelle (Host nicht freigegeben oder Geheimnis über unverschlüsseltes http) */
export function sourceDenied(denial: SourceDenial): AppError {
  return denial === 'insecure_http'
    ? new AppError('source_not_allowed', { reason: 'insecure_http' })
    : new AppError('source_not_allowed');
}

export interface RequestContext {
  deps: Deps;
  userId: string;
  actor: Actor;
  ip: string | null;
  requestId: string;
}

interface StagedAthlete {
  rowNumber: number;
  athleteId: string | null;
  changed: boolean;
  values: Omit<AthleteValues, 'external_id'>;
  identifier: { system: string; value: string } | null;
}

interface StagedRecord {
  rowNumber: number;
  athleteId: string;
  recordKey: string;
  observedAt: string | null;
  data: Record<string, Scalar>;
}

export interface ImportRunDetailOut {
  run: ImportRun;
  preview: PreviewData;
  errorSummary: { code: string; field: string | null; count: number }[];
}

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isFile(v: unknown): v is File {
  return typeof v === 'object' && v !== null && typeof (v as Blob).arrayBuffer === 'function';
}

function safeFileName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? '').slice(0, 200) || 'upload.csv';
}

function summarizeIssues(issues: readonly Pick<Issue, 'code' | 'field'>[]) {
  const counts = new Map<string, { code: string; field: string | null; count: number }>();
  for (const i of issues) {
    const k = `${i.code}\u0000${i.field ?? ''}`;
    const e = counts.get(k);
    if (e) e.count++;
    else counts.set(k, { code: i.code, field: i.field, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------------------------
// Start (Vorschau)
// ---------------------------------------------------------------------------------------------

export async function startRun(
  rc: RequestContext,
  connector: Row<'connector'>,
  form: FormData,
): Promise<ImportRunDetailOut> {
  const { deps } = rc;
  const input = connectorInputOf(connector);
  if (!connector.active) throw conflict('connector_inactive');
  const dataset =
    input.targetType === 'dataset' && input.targetDatasetId
      ? await loadDataset(deps.db, input.targetDatasetId)
      : null;
  const now = deps.now();
  const base = { timeZone: deps.config.MESH_TIMEZONE, today: localDate(now, deps.config.MESH_TIMEZONE) };

  let table: SourceTable;
  let convert: ConvertOptions;
  let source: { name: string; sha256: string; size: number };
  const sourceIssues: Issue[] = [];

  if (input.config.type === 'csv') {
    const file = form.get('file');
    if (!isFile(file)) throw invalid({ 'body.file': 'required' });
    if (file.size > MAX_UPLOAD_BYTES) throw new AppError('payload_too_large');
    const bytes = new Uint8Array(await file.arrayBuffer());
    source = { name: safeFileName(file.name), sha256: sha256Hex(bytes), size: bytes.byteLength };
    const decoded = decodeText(bytes, input.config.encoding);
    if (decoded.fallback) {
      sourceIssues.push({
        rowNumber: 0,
        field: null,
        code: 'encoding_fallback',
        severity: 'warning',
        rawValue: null,
        params: { encoding: decoded.encoding },
      });
    }
    table = parseCsv(decoded.text, input.config.delimiter);
    if (table.limit) return persistLimit(rc, connector, source, table, sourceIssues);
    convert = {
      decimalSeparator: input.config.decimalSeparator,
      dateFormat: input.config.dateFormat,
      ...base,
    };
  } else {
    const cfg = input.config;
    const secret = connector.secret_enc ? deps.box.open(connector.secret_enc, secretAad(connector.id)) : null;
    const denial = checkSource(cfg, secret, deps.config);
    if (denial) {
      await deps.audit.record({
        actor: rc.actor,
        action: 'import.start',
        outcome: 'denied',
        objectType: 'connector',
        objectId: connector.id,
        details: { reason: denial, host: hostOf(cfg.url) },
        ip: rc.ip,
        requestId: rc.requestId,
      });
      throw sourceDenied(denial);
    }
    const res = await fetchApiItems(deps.fetch, cfg, secret, {
      allowInsecureHttp: deps.config.MESH_SOURCE_ALLOW_INSECURE_HTTP,
    });
    source = { name: sourceNameOf(cfg.url), sha256: res.sha256, size: res.size };
    if (!res.ok) {
      return persistRun(rc, connector, {
        status: 'failed',
        failureCode: res.code,
        source,
        columns: [],
        totalRows: 0,
        issues: [
          {
            rowNumber: 0,
            field: null,
            code: res.code,
            severity: 'error',
            rawValue: null,
            params: res.params,
          },
        ],
      });
    }
    if (res.truncated) {
      sourceIssues.push({
        rowNumber: 0,
        field: null,
        code: 'max_pages_reached',
        severity: 'warning',
        rawValue: null,
        params: { pages: res.pages },
      });
    }
    table = tableFromItems(res.items);
    if (table.limit) return persistLimit(rc, connector, source, table, sourceIssues);
    convert = { decimalSeparator: '.', dateFormat: cfg.dateFormat, ...base };
  }

  // Fehlende Quellspalten machen den ganzen Lauf unbrauchbar (bei leerer API-Antwort gibt es keine Spalten)
  const missing =
    input.config.type === 'csv' || table.rows.length > 0 ? missingColumns(table.columns, input.mapping) : [];
  if (missing.length > 0) {
    return persistRun(rc, connector, {
      status: 'failed',
      failureCode: 'missing_column',
      source,
      columns: table.columns,
      totalRows: table.rows.length,
      issues: [
        ...sourceIssues,
        ...missing.map(
          (m): Issue => ({
            rowNumber: 0,
            field: m.target,
            code: 'missing_column',
            severity: 'error',
            rawValue: null,
            params: { column: m.source },
          }),
        ),
      ],
    });
  }

  const ctx: PipelineContext = {
    targetType: input.targetType,
    mapping: input.mapping,
    athleteMatch: input.athleteMatch,
    dataset,
    convert,
  };
  const structural = new Map<number, Issue[]>();
  for (const i of table.issues) structural.set(i.rowNumber, [...(structural.get(i.rowNumber) ?? []), i]);
  const rows = table.rows.map((r) => mapRow(r, ctx, structural.get(r.rowNumber) ?? []));
  resolveAthletes(rows, await loadAthleteLookup(deps.db, rows, ctx), ctx);
  markDuplicates(rows, ctx);
  if (dataset) flagRecordUpdates(rows, await loadExistingRecords(deps.db, dataset.id, rows));
  const summary = summarize(rows, sourceIssues);

  const identifierSystem =
    input.athleteMatch.strategy === 'external_id' ? input.athleteMatch.system : connector.slug;
  const stagedRows: (StagedAthlete | StagedRecord)[] =
    input.targetType === 'athletes'
      ? summary.valid.map((r) => stageAthlete(r, identifierSystem))
      : summary.valid.map((r) => stageRecord(r));
  const staged: StagedRun<StagedAthlete | StagedRecord> = {
    rows: stagedRows,
    subjects: subjectsOf(rows, identifierSystem),
  };

  return persistRun(rc, connector, {
    status: 'previewed',
    failureCode: null,
    source,
    columns: table.columns,
    totalRows: summary.totalRows,
    validRows: summary.validRows,
    errorRows: summary.errorRows,
    warningRows: summary.warningRows,
    issues: summary.issues,
    staged,
    previewRows: summary.preview,
  });
}

function stageAthlete(row: MappedRow, identifierSystem: string): StagedAthlete {
  const { external_id: _ignored, ...values } = row.athlete;
  return {
    rowNumber: row.rowNumber,
    athleteId: row.athleteId,
    changed: row.changed,
    values,
    identifier: row.externalId ? { system: identifierSystem, value: row.externalId } : null,
  };
}

function stageRecord(row: MappedRow): StagedRecord {
  return {
    rowNumber: row.rowNumber,
    athleteId: row.athleteId!,
    recordKey: row.recordKey!,
    observedAt: row.observedAt,
    data: row.data,
  };
}

async function loadAthleteLookup(
  db: DbOrTx,
  rows: MappedRow[],
  ctx: PipelineContext,
): Promise<AthleteLookup> {
  const lookup = emptyLookup();
  if (ctx.athleteMatch.strategy === 'external_id') {
    const system = ctx.athleteMatch.system;
    const values = [...new Set(rows.map((r) => r.externalId).filter((v): v is string => !!v))];
    for (const chunk of chunks(values)) {
      const found = await db
        .selectFrom('athlete_identifier')
        .select(['value', 'athlete_id'])
        .where('system', '=', system)
        .where('value', 'in', chunk)
        .execute();
      for (const f of found) lookup.byExternalId.set(f.value, f.athlete_id);
    }
  }
  const loaded = new Map<string, Row<'athlete'>>();
  const dobs = [...new Set(rows.filter((r) => r.naturalKey).map((r) => r.athlete.date_of_birth!))];
  for (const chunk of chunks(dobs)) {
    for (const a of await db
      .selectFrom('athlete')
      .selectAll()
      .where('date_of_birth', 'in', chunk)
      .execute()) {
      loaded.set(a.id, a);
    }
  }
  const byIdOnly = [...new Set(lookup.byExternalId.values())].filter((id) => !loaded.has(id));
  for (const chunk of chunks(byIdOnly)) {
    for (const a of await db.selectFrom('athlete').selectAll().where('id', 'in', chunk).execute()) {
      loaded.set(a.id, a);
    }
  }
  for (const a of loaded.values()) {
    lookup.athletes.set(a.id, {
      last_name: a.last_name,
      first_name: a.first_name,
      date_of_birth: a.date_of_birth,
      sport: a.sport,
      squad_status: a.squad_status,
      sex: a.sex,
      club: a.club,
      discipline: a.discipline,
    });
    const nk = naturalKeyOf(a.last_name, a.first_name, a.date_of_birth);
    lookup.byNaturalKey.set(nk, [...(lookup.byNaturalKey.get(nk) ?? []), a.id]);
  }
  return lookup;
}

async function loadExistingRecords(
  db: DbOrTx,
  datasetId: string,
  rows: MappedRow[],
): Promise<Map<string, Record<string, Scalar>>> {
  const existing = new Map<string, Record<string, Scalar>>();
  const keys = [...new Set(rows.filter((r) => r.athleteId && r.recordKey).map((r) => r.recordKey!))];
  for (const chunk of chunks(keys)) {
    const found = await db
      .selectFrom('dataset_record')
      .select(['athlete_id', 'record_key', 'data'])
      .where('dataset_id', '=', datasetId)
      .where('record_key', 'in', chunk)
      .execute();
    for (const f of found) {
      existing.set(existingRecordKey(f.athlete_id, f.record_key), (f.data ?? {}) as Record<string, Scalar>);
    }
  }
  return existing;
}

interface PersistInput {
  status: 'previewed' | 'failed';
  failureCode: string | null;
  source: { name: string; sha256: string; size: number };
  columns: string[];
  totalRows: number;
  validRows?: number;
  errorRows?: number;
  warningRows?: number;
  issues: Issue[];
  staged?: StagedRun<StagedAthlete | StagedRecord>;
  previewRows?: PreviewData['rows'];
}

/** Quelle überschreitet eine Obergrenze (Spalten, Zeilen): Lauf schlägt fehl, ohne Zeilen zu verarbeiten */
function persistLimit(
  rc: RequestContext,
  connector: Row<'connector'>,
  source: PersistInput['source'],
  table: SourceTable,
  sourceIssues: Issue[],
): Promise<ImportRunDetailOut> {
  const code = table.limit!;
  return persistRun(rc, connector, {
    status: 'failed',
    failureCode: code,
    source,
    columns: code === 'too_many_columns' ? [] : table.columns,
    totalRows: 0,
    issues: [
      ...sourceIssues,
      {
        rowNumber: 0,
        field: null,
        code,
        severity: 'error',
        rawValue: null,
        params: { max: code === 'too_many_columns' ? MAX_SOURCE_COLUMNS : MAX_SOURCE_ROWS },
      },
    ],
  });
}

/**
 * Personen, die seit dem Nachschlagen gelöscht wurden, nicht in die Vorschau übernehmen. Die
 * Lesesperre sorgt dafür, dass eine gleichzeitige Löschung entweder vorher abgeschlossen ist (Person
 * fehlt hier) oder auf diesen Lauf wartet und ihn danach bereinigt.
 */
async function rowsOfVanishedAthletes(trx: DbOrTx, subjects: readonly RowSubject[]): Promise<Set<number>> {
  const ids = [...new Set(subjects.map((s) => s.a).filter((a): a is string => !!a))];
  const present = new Set<string>();
  for (const chunk of chunks(ids)) {
    const found = await trx.selectFrom('athlete').select('id').where('id', 'in', chunk).forShare().execute();
    for (const f of found) present.add(f.id);
  }
  return new Set(subjects.filter((s) => s.a && !present.has(s.a)).map((s) => s.r));
}

async function persistRun(
  rc: RequestContext,
  connector: Row<'connector'>,
  p: PersistInput,
): Promise<ImportRunDetailOut> {
  const { deps } = rc;
  const now = deps.now();
  const result = await writeTx(deps, async (trx) => {
    let staged = p.staged ?? { rows: [], subjects: [] };
    let previewRows = p.previewRows ?? [];
    let issues = p.issues;
    let vanished: number[] = [];
    if (p.status === 'previewed') {
      const gone = await rowsOfVanishedAthletes(trx, staged.subjects);
      if (gone.size > 0) {
        const next = withoutRows(staged, previewRows, gone);
        staged = next.staged;
        previewRows = next.preview;
        vanished = next.removedStaged;
        issues = issues.map((i) => (gone.has(i.rowNumber) ? { ...i, rawValue: null } : i));
      }
    }
    const preview: PreviewData = { sourceColumns: p.columns, rows: previewRows };
    const created = await trx
      .insertInto('import_run')
      .values({
        connector_id: connector.id,
        connector_version: connector.version,
        status: p.status,
        source_name: p.source.name,
        source_sha256: p.source.sha256,
        source_size: p.source.size,
        staged: p.status === 'previewed' ? JSON.stringify(staged) : null,
        preview: JSON.stringify(preview),
        total_rows: p.totalRows,
        valid_rows: p.validRows ?? 0,
        error_rows: p.errorRows ?? 0,
        warning_rows: p.warningRows ?? 0,
        failure_code: p.failureCode,
        started_by: rc.userId,
        created_at: now,
        finished_at: p.status === 'failed' ? now : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    for (const chunk of chunks(issues, 1000)) {
      await trx
        .insertInto('import_error')
        .values(
          chunk.map((i) => ({
            run_id: created.id,
            row_number: i.rowNumber,
            field: i.field,
            code: i.code,
            severity: i.severity,
            // Rohwerte nur während der Vorschau (zur Korrektur der Quelle)
            raw_value:
              p.status !== 'previewed' || i.rawValue === null ? null : i.rawValue.slice(0, MAX_RAW_VALUE),
            params: JSON.stringify(i.params),
          })),
        )
        .execute();
    }
    await recordVanished(trx, created.id, vanished, 'preview');
    await deps.audit.record(
      {
        actor: rc.actor,
        action: 'import.start',
        outcome: p.status === 'failed' ? 'error' : 'success',
        objectType: 'import_run',
        objectId: created.id,
        details: {
          connectorId: connector.id,
          connectorVersion: connector.version,
          status: p.status,
          failureCode: p.failureCode,
          totalRows: created.total_rows,
          validRows: created.valid_rows,
          errorRows: created.error_rows,
          warningRows: created.warning_rows,
          sourceSha256: p.source.sha256,
          sourceSize: p.source.size,
        },
        ip: rc.ip,
        requestId: rc.requestId,
      },
      trx,
    );
    const vanishedIssues = vanished.map(() => ({ code: 'athlete_not_found' as const, field: null }));
    return { run: created, preview, issues: [...issues, ...vanishedIssues] };
  });
  return {
    run: toImportRun(result.run, connector.name),
    preview: result.preview,
    errorSummary: summarizeIssues(result.issues),
  };
}

// ---------------------------------------------------------------------------------------------
// Abfragen
// ---------------------------------------------------------------------------------------------

export async function loadRunDetail(db: DbOrTx, runId: string): Promise<ImportRunDetailOut | null> {
  const run = await db
    .selectFrom('import_run as r')
    .innerJoin('connector as c', 'c.id', 'r.connector_id')
    .selectAll('r')
    .select('c.name as connector_name')
    .where('r.id', '=', runId)
    .executeTakeFirst();
  if (!run) return null;
  const summary = await db
    .selectFrom('import_error')
    .select((eb) => ['code', 'field', eb.fn.countAll<number>().as('count')])
    .where('run_id', '=', runId)
    .groupBy(['code', 'field'])
    .execute();
  const stored = (run.preview ?? {}) as Partial<PreviewData>;
  return {
    run: toImportRun(run, run.connector_name),
    preview: { sourceColumns: stored.sourceColumns ?? [], rows: stored.rows ?? [] },
    errorSummary: summary
      .map((s) => ({ code: s.code, field: s.field, count: Number(s.count) }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}

// ---------------------------------------------------------------------------------------------
// Übernahme und Verwerfen
// ---------------------------------------------------------------------------------------------

const NATURAL_KEY_COLUMNS = new Set(['last_name', 'first_name', 'date_of_birth']);

export async function commitRun(rc: RequestContext, runId: string): Promise<ImportRun> {
  const { deps } = rc;
  const result = await writeTx(deps, async (trx) => {
    // Sperrreihenfolge (core/locks.ts): erst die berührten Personen, dann der Lauf – wie die Löschung einer
    // Person (athlete → import_run, retention.ts). Dazu die vorgemerkten Zeilen vorab ohne Sperre lesen;
    // bis zur Sperre des Laufs kann eine Löschung sie nur verkleinern (eraseSubjectFromRuns).
    const planned = await trx
      .selectFrom('import_run as r')
      .innerJoin('connector as c', 'c.id', 'r.connector_id')
      .select(['r.staged', 'c.target_type'])
      .where('r.id', '=', runId)
      .executeTakeFirst();
    if (!planned) throw notFound();
    const present = await lockAthletes(
      trx,
      planned.target_type === 'athletes' ? 'update' : 'share',
      athletesOf(readStaged<StagedAthlete | StagedRecord>(planned.staged).rows),
    );
    const run = await trx
      .selectFrom('import_run')
      .selectAll()
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirst();
    if (!run) throw notFound();
    if (run.status !== 'previewed') throw conflict('run_not_previewed');
    const connector = await trx
      .selectFrom('connector')
      .selectAll()
      .where('id', '=', run.connector_id)
      .executeTakeFirstOrThrow();
    if (connector.version !== run.connector_version) throw conflict('connector_changed');
    if (connector.on_error === 'abort' && run.error_rows > 0) throw conflict('import_has_errors');
    const input: ConnectorInput = connectorInputOf(connector);

    const counts =
      input.targetType === 'athletes'
        ? await commitAthletes(trx, rc, readStaged<StagedAthlete>(run.staged).rows, present)
        : await commitRecords(
            trx,
            run,
            input.targetDatasetId!,
            readStaged<StagedRecord>(run.staged).rows,
            present,
          );

    await recordVanished(trx, run.id, counts.vanished, 'commit');
    await clearRawValues(trx, [run.id]);
    const updated = await trx
      .updateTable('import_run')
      .set({
        status: 'committed',
        staged: null,
        preview: CLEARED_PREVIEW,
        inserted_rows: counts.inserted,
        updated_rows: counts.updated,
        committed_by: rc.userId,
        finished_at: deps.now(),
      })
      .where('id', '=', run.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await deps.audit.record(
      {
        actor: rc.actor,
        action: 'import.commit',
        objectType: 'import_run',
        objectId: run.id,
        details: {
          connectorId: connector.id,
          datasetId: connector.target_dataset_id,
          targetType: connector.target_type,
          inserted: counts.inserted,
          updated: counts.updated,
          skipped: counts.vanished.length,
        },
        ip: rc.ip,
        requestId: rc.requestId,
      },
      trx,
    );
    return { run: updated, connector };
  }).catch((err) => {
    if (pgCode(err) === '23505') throw conflict('athlete_conflict');
    throw err;
  });
  await deps.events.after('data.changed', { datasetId: result.connector.target_dataset_id });
  return toImportRun(result.run, result.connector.name);
}

interface CommitCounts {
  inserted: number;
  updated: number;
  vanished: number[];
}

interface CommitAthletes {
  /** vorhandene Personen (zugeordnete Zeilen) */
  ids: string[];
  /** natürliche Schlüssel neuer Personen (Ziel Athletenkern): eine inzwischen angelegte Person wird aktualisiert */
  naturalKeys: { last_name: string; first_name: string; date_of_birth: string }[];
}

function athletesOf(staged: readonly (StagedAthlete | StagedRecord)[]): CommitAthletes {
  const ids = new Set<string>();
  const naturalKeys = new Map<string, CommitAthletes['naturalKeys'][number]>();
  for (const s of staged) {
    if (s.athleteId) {
      ids.add(s.athleteId);
      continue;
    }
    const values = 'values' in s ? s.values : null;
    if (values?.last_name && values.first_name && values.date_of_birth) {
      const key = {
        last_name: values.last_name,
        first_name: values.first_name,
        date_of_birth: values.date_of_birth,
      };
      naturalKeys.set(JSON.stringify(key), key);
    }
  }
  return { ids: [...ids], naturalKeys: [...naturalKeys.values()] };
}

/**
 * Sperrt alle Personen, die eine Übernahme berührt, bevor der Importlauf gesperrt wird (Sperrreihenfolge
 * athlete → import_run, core/locks.ts), in fester Reihenfolge (nach id). share: Einträge eines Datensatzes
 * (die Person darf nicht gelöscht werden); update: Athletenkern (Stammdaten werden geändert). Liefert die
 * ids der vorhandenen Personen; eine inzwischen gelöschte Person fehlt darin und wird nicht übernommen.
 */
async function lockAthletes(
  trx: DbOrTx,
  mode: 'share' | 'update',
  athletes: CommitAthletes,
): Promise<Set<string>> {
  const ids = new Set(athletes.ids);
  for (const chunk of chunks(athletes.naturalKeys)) {
    const found = await trx
      .selectFrom('athlete')
      .select('id')
      .where((eb) =>
        eb(
          eb.refTuple('last_name', 'first_name', 'date_of_birth'),
          'in',
          chunk.map((k) => eb.tuple(k.last_name, k.first_name, k.date_of_birth)),
        ),
      )
      .execute();
    for (const f of found) ids.add(f.id);
  }
  const present = new Set<string>();
  for (const chunk of chunks([...ids].sort())) {
    const query = trx.selectFrom('athlete').select('id').where('id', 'in', chunk).orderBy('id');
    const found = await (mode === 'update' ? query.forUpdate() : query.forShare()).execute();
    for (const f of found) present.add(f.id);
  }
  return present;
}

function athleteColumns(values: StagedAthlete['values']) {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out[k] = v;
  return out;
}

/** present: vorab gesperrte, vorhandene Personen (lockAthletes) */
async function commitAthletes(
  trx: DbOrTx,
  rc: RequestContext,
  staged: StagedAthlete[],
  present: ReadonlySet<string>,
): Promise<CommitCounts> {
  const counts: CommitCounts = { inserted: 0, updated: 0, vanished: [] };
  for (const s of staged) {
    const values = athleteColumns(s.values);
    let athleteId: string;
    if (s.athleteId) {
      // inzwischen gelöschte Person (z. B. Recht auf Löschung) wird nicht wieder angelegt
      if (!present.has(s.athleteId)) {
        counts.vanished.push(s.rowNumber);
        continue;
      }
      athleteId = s.athleteId;
      if (s.changed) await trx.updateTable('athlete').set(values).where('id', '=', athleteId).execute();
      counts.updated++;
    } else {
      const updateSet = Object.fromEntries(
        Object.entries(values).filter(([k]) => !NATURAL_KEY_COLUMNS.has(k)),
      );
      const row = await trx
        .insertInto('athlete')
        .values({
          ...(values as {
            last_name: string;
            first_name: string;
            date_of_birth: string;
            sport: string;
            squad_status: string;
          }),
          created_by: rc.userId,
        })
        .onConflict((oc) => oc.columns(['last_name', 'first_name', 'date_of_birth']).doUpdateSet(updateSet))
        .returning(['id', sql<boolean>`(xmax = 0)`.as('inserted')])
        .executeTakeFirstOrThrow();
      athleteId = row.id;
      if (row.inserted) counts.inserted++;
      else counts.updated++;
    }
    if (s.identifier) {
      await trx
        .insertInto('athlete_identifier')
        .values({ athlete_id: athleteId, system: s.identifier.system, value: s.identifier.value })
        .onConflict((oc) =>
          oc
            .columns(['system', 'value'])
            .doUpdateSet((eb) => ({ athlete_id: eb.ref('excluded.athlete_id') })),
        )
        .execute();
    }
  }
  return counts;
}

/** present: vorab gesperrte, vorhandene Personen (lockAthletes; die Sperre verhindert eine Löschung) */
async function commitRecords(
  trx: DbOrTx,
  run: Row<'import_run'>,
  datasetId: string,
  staged: StagedRecord[],
  present: ReadonlySet<string>,
): Promise<CommitCounts> {
  const counts: CommitCounts = { inserted: 0, updated: 0, vanished: [] };
  const live = staged.filter((s) => {
    if (present.has(s.athleteId)) return true;
    counts.vanished.push(s.rowNumber);
    return false;
  });
  for (const chunk of chunks(live)) {
    const res = await trx
      .insertInto('dataset_record')
      .values(
        chunk.map((s) => ({
          dataset_id: datasetId,
          athlete_id: s.athleteId,
          record_key: s.recordKey,
          observed_at: s.observedAt ? new Date(s.observedAt) : null,
          data: JSON.stringify(s.data),
          import_run_id: run.id,
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(['dataset_id', 'athlete_id', 'record_key'])
          .doUpdateSet((eb) => ({
            data: sql`dataset_record.data || excluded.data`,
            observed_at: eb.ref('excluded.observed_at'),
            import_run_id: eb.ref('excluded.import_run_id'),
          }))
          .where(
            sql<boolean>`(dataset_record.data || excluded.data) is distinct from dataset_record.data
              or dataset_record.observed_at is distinct from excluded.observed_at`,
          ),
      )
      .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
      .execute();
    counts.inserted += res.filter((r) => r.inserted).length;
  }
  // unveränderte vorhandene Einträge zählen als aktualisiert (Quelle bestätigt den Stand)
  counts.updated = live.length - counts.inserted;
  return counts;
}

export async function discardRun(rc: RequestContext, runId: string): Promise<ImportRun> {
  const { deps } = rc;
  const { run, connectorName } = await writeTx(deps, async (trx) => {
    const existing = await trx
      .selectFrom('import_run')
      .selectAll()
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw notFound();
    if (existing.status !== 'previewed') throw conflict('run_not_previewed');
    const updated = await trx
      .updateTable('import_run')
      .set({ status: 'discarded', staged: null, preview: CLEARED_PREVIEW, finished_at: deps.now() })
      .where('id', '=', runId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await clearRawValues(trx, [runId]);
    const c = await trx
      .selectFrom('connector')
      .select('name')
      .where('id', '=', updated.connector_id)
      .executeTakeFirstOrThrow();
    await deps.audit.record(
      {
        actor: rc.actor,
        action: 'import.discard',
        objectType: 'import_run',
        objectId: runId,
        details: { connectorId: updated.connector_id, validRows: updated.valid_rows },
        ip: rc.ip,
        requestId: rc.requestId,
      },
      trx,
    );
    return { run: updated, connectorName: c.name };
  });
  return toImportRun(run, connectorName);
}
