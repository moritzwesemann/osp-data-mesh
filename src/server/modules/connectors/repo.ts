/**
 * Datenbankzugriffe und Abbildungen DB → API für Connectoren und Importläufe.
 */
import type {
  AthleteMatch,
  Connector,
  ConnectorConfig,
  ConnectorInput,
  FieldMapping,
  ImportRun,
} from '../../../shared/contract/connectors.ts';
import type { FieldDef } from '../../../shared/contract/datasets.ts';
import { type DbOrTx, iso, isoReq } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import type { DatasetShape } from './pipeline.ts';

type LastRun = Connector['lastRun'];

export function toConnector(r: Row<'connector'>, datasetName: string | null, lastRun: LastRun): Connector {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    kind: r.kind as Connector['kind'],
    targetType: r.target_type as Connector['targetType'],
    targetDatasetId: r.target_dataset_id,
    targetDatasetName: datasetName,
    config: r.config as ConnectorConfig,
    mapping: r.mapping as FieldMapping[],
    athleteMatch: r.athlete_match as AthleteMatch,
    onError: r.on_error as Connector['onError'],
    version: r.version,
    active: r.active,
    hasSecret: r.secret_enc !== null,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
    lastRun,
  };
}

/** Eingabeform eines gespeicherten Connectors (für PATCH-Zusammenführung und Export) */
export function connectorInputOf(r: Row<'connector'>): ConnectorInput {
  return {
    slug: r.slug,
    name: r.name,
    description: r.description,
    kind: r.kind as ConnectorInput['kind'],
    targetType: r.target_type as ConnectorInput['targetType'],
    targetDatasetId: r.target_dataset_id,
    config: r.config as ConnectorConfig,
    mapping: r.mapping as FieldMapping[],
    athleteMatch: r.athlete_match as AthleteMatch,
    onError: r.on_error as ConnectorInput['onError'],
    active: r.active,
  };
}

/** Connectoren inkl. Zieldatensatz-Name und letztem Lauf */
export async function loadConnectors(db: DbOrTx, id?: string): Promise<Connector[]> {
  let q = db
    .selectFrom('connector as c')
    .leftJoin('dataset as d', 'd.id', 'c.target_dataset_id')
    .selectAll('c')
    .select('d.name as dataset_name');
  if (id) q = q.where('c.id', '=', id);
  const rows = await q.orderBy('c.name').orderBy('c.slug').execute();
  if (rows.length === 0) return [];
  const runs = await db
    .selectFrom('import_run')
    .distinctOn('connector_id')
    .select(['id', 'connector_id', 'status', 'created_at'])
    .where(
      'connector_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('connector_id')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const last = new Map(runs.map((r) => [r.connector_id, r]));
  return rows.map((r) => {
    const run = last.get(r.id);
    return toConnector(
      r,
      r.dataset_name ?? null,
      run
        ? { id: run.id, status: run.status as ImportRun['status'], createdAt: isoReq(run.created_at) }
        : null,
    );
  });
}

export function toImportRun(r: Row<'import_run'>, connectorName: string): ImportRun {
  return {
    id: r.id,
    connectorId: r.connector_id,
    connectorName,
    connectorVersion: r.connector_version,
    status: r.status as ImportRun['status'],
    sourceName: r.source_name,
    sourceSha256: r.source_sha256,
    sourceSize: r.source_size,
    totalRows: r.total_rows,
    validRows: r.valid_rows,
    errorRows: r.error_rows,
    warningRows: r.warning_rows,
    insertedRows: r.inserted_rows,
    updatedRows: r.updated_rows,
    failureCode: r.failure_code,
    createdAt: isoReq(r.created_at),
    finishedAt: iso(r.finished_at),
  };
}

export interface TargetDataset extends DatasetShape {
  id: string;
  slug: string;
  name: string;
  version: number;
}

export async function loadDataset(db: DbOrTx, id: string): Promise<TargetDataset | null> {
  const r = await db.selectFrom('dataset').selectAll().where('id', '=', id).executeTakeFirst();
  return r ? toTargetDataset(r) : null;
}

export function toTargetDataset(r: Row<'dataset'>): TargetDataset {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    version: r.version,
    fields: r.fields as FieldDef[],
    keyFields: r.key_fields,
    observedAtField: r.observed_at_field,
  };
}
