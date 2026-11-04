/**
 * Modul "connectors": Datenquellen (CSV-Upload, HTTP-API), Feldzuordnungen, portable Definitionen und
 * Vorlagen, Importläufe mit Vorschau, Fehlerprotokoll und Übernahme.
 *
 * Schreibt: connector, import_run, import_error, dataset_record, athlete/athlete_identifier (Import),
 * dataset (nur beim Import einer Definition mit Datensatz-Struktur, über das Modul datasets).
 * Ereignis nach jeder Übernahme: data.changed. Reagiert auf athlete.deleted (Person aus offenen
 * Importläufen entfernen); Hintergrundaufgabe: Ablauf nicht übernommener Vorschauen (retention.ts).
 *
 * Zugangsgeheimnisse von API-Quellen sind an das gespeicherte Ziel (Origin und Authentifizierung)
 * gebunden: Ändert sich das Ziel, wird das Geheimnis verworfen; die Analyse mit connectorId nutzt nur
 * das gespeicherte Ziel.
 */
import {
  ConnectorConfig,
  type ConnectorConfig as ConnectorConfigT,
  type ConnectorDefinition,
  type ConnectorInput,
  CsvConfig,
} from '../../../shared/contract/connectors.ts';
import { pgCode } from '../../core/db.ts';
import type { Module } from '../../core/deps.ts';
import { AppError, conflict, invalid, notFound } from '../../core/errors.ts';
import { registerRoutes, zodFields } from '../../core/http.ts';
import { createDataset, datasetInputOf } from '../datasets/index.ts';
import { validateConnectorInput } from './definition.ts';
import { presentPatch } from './patch.ts';
import { decodeText, parseCsv, SAMPLE_ROWS, tableFromItems } from './pipeline.ts';
import { connectorInputOf, loadConnectors, loadDataset, toImportRun, toTargetDataset } from './repo.ts';
import { eraseSubjectFromRuns, startRetention, stopRetention } from './retention.ts';
import {
  commitRun,
  discardRun,
  loadRunDetail,
  MAX_UPLOAD_BYTES,
  type RequestContext,
  secretAad,
  sourceDenied,
  startRun,
} from './runs.ts';
import { checkSource, fetchApiItems, hostOf, secretTarget } from './source-http.ts';
import { type ConnectorTemplate, loadTemplates } from './templates.ts';

export { secretAad };

function isFile(v: unknown): v is File {
  return typeof v === 'object' && v !== null && typeof (v as Blob).arrayBuffer === 'function';
}

function slugConflict(err: unknown): never {
  if (pgCode(err) === '23505') throw conflict('slug_exists');
  throw err;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseConfigField(raw: FormDataEntryValue | null): ConnectorConfigT | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid({ 'body.config': 'invalid_json' });
  }
  const parsed = ConnectorConfig.safeParse(json);
  if (!parsed.success) throw invalid(zodFields(parsed.error, 'body.config'));
  return parsed.data;
}

export const connectorsModule: Module = {
  name: 'connectors',
  init(deps) {
    // Recht auf Löschung: Person atomar mit der Löschung aus offenen Importläufen entfernen
    deps.events.onTx('athlete.deleted', (e, trx) => eraseSubjectFromRuns(deps, trx, e.athleteId));
  },
  start(deps) {
    return startRetention(deps);
  },
  stop() {
    stopRetention();
  },
  routes(app, deps) {
    let templates: ConnectorTemplate[] | null = null;
    const getConnector = async (id: string) => (await loadConnectors(deps.db, id))[0] ?? null;

    registerRoutes(app, deps, {
      'connectors.list': async () => ({ items: await loadConnectors(deps.db) }),

      'connectors.templates': async () => {
        templates ??= loadTemplates(undefined, deps.log);
        return { items: templates };
      },

      'connectors.get': async ({ params }) => {
        const c = await getConnector(params.id);
        if (!c) throw notFound();
        return c;
      },

      'connectors.create': async ({ body, user, actor, ip, requestId }) => {
        const dataset =
          body.targetType === 'dataset' && body.targetDatasetId
            ? await loadDataset(deps.db, body.targetDatasetId)
            : null;
        const input = validateConnectorInput(body, dataset);
        const id = await deps.db
          .transaction()
          .execute(async (trx) => {
            const row = await insertConnector(trx, input, user.id);
            await deps.audit.record(
              {
                actor,
                action: 'connector.create',
                objectType: 'connector',
                objectId: row.id,
                details: { slug: input.slug, kind: input.kind, targetType: input.targetType },
                ip,
                requestId,
              },
              trx,
            );
            return row.id;
          })
          .catch(slugConflict);
        return (await getConnector(id))!;
      },

      'connectors.update': async ({ params, body, c, actor, ip, requestId }) => {
        const patch = await presentPatch(c, body);
        await deps.db.transaction().execute(async (trx) => {
          const existing = await trx
            .selectFrom('connector')
            .selectAll()
            .where('id', '=', params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!existing) throw notFound();
          const before = connectorInputOf(existing);
          const merged: ConnectorInput = { ...before, ...patch, slug: before.slug };
          if (patch.targetType === 'athletes' && !('targetDatasetId' in patch)) merged.targetDatasetId = null;
          const dataset =
            merged.targetType === 'dataset' && merged.targetDatasetId
              ? await loadDataset(trx, merged.targetDatasetId)
              : null;
          const input = validateConnectorInput(merged, dataset);
          const changed = (Object.keys(input) as (keyof ConnectorInput)[]).filter(
            (k) => JSON.stringify(input[k]) !== JSON.stringify(before[k]),
          );
          if (changed.length === 0) return;
          // Geheimnis gilt nur für das Ziel, für das es gesetzt wurde (sonst könnte es umgeleitet werden)
          const clearSecret =
            existing.secret_enc !== null && secretTarget(input.config) !== secretTarget(before.config);
          const updated = await trx
            .updateTable('connector')
            .set({
              name: input.name,
              description: input.description,
              kind: input.kind,
              target_type: input.targetType,
              target_dataset_id: input.targetDatasetId,
              config: JSON.stringify(input.config),
              mapping: JSON.stringify(input.mapping),
              athlete_match: JSON.stringify(input.athleteMatch),
              on_error: input.onError,
              active: input.active,
              version: existing.version + 1,
              ...(clearSecret ? { secret_enc: null } : {}),
            })
            .where('id', '=', params.id)
            .returning('version')
            .executeTakeFirstOrThrow();
          if (clearSecret) {
            await deps.audit.record(
              {
                actor,
                action: 'connector.secret_cleared',
                objectType: 'connector',
                objectId: params.id,
                details: { reason: 'target_changed', version: updated.version },
                ip,
                requestId,
              },
              trx,
            );
          }
          await deps.audit.record(
            {
              actor,
              action: 'connector.update',
              objectType: 'connector',
              objectId: params.id,
              details: { changed, version: updated.version },
              ip,
              requestId,
            },
            trx,
          );
        });
        return (await getConnector(params.id))!;
      },

      'connectors.setSecret': async ({ params, body, actor, ip, requestId }) => {
        await deps.db.transaction().execute(async (trx) => {
          const existing = await trx
            .selectFrom('connector')
            .select(['id', 'kind'])
            .where('id', '=', params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!existing) throw notFound();
          if (existing.kind !== 'http_api') throw invalid({ 'body.secret': 'not_supported' });
          await trx
            .updateTable('connector')
            .set({
              secret_enc: body.secret === null ? null : deps.box.seal(body.secret, secretAad(existing.id)),
            })
            .where('id', '=', existing.id)
            .execute();
          await deps.audit.record(
            {
              actor,
              action: 'connector.secret_set',
              objectType: 'connector',
              objectId: existing.id,
              details: { removed: body.secret === null },
              ip,
              requestId,
            },
            trx,
          );
        });
        return { ok: true as const };
      },

      'connectors.export': async ({ params, actor, ip, requestId }) => {
        const row = await deps.db
          .selectFrom('connector')
          .selectAll()
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (!row) throw notFound();
        const ds = row.target_dataset_id
          ? await deps.db
              .selectFrom('dataset')
              .selectAll()
              .where('id', '=', row.target_dataset_id)
              .executeTakeFirst()
          : undefined;
        const { targetDatasetId: _id, ...connector } = connectorInputOf(row);
        const definition: ConnectorDefinition = {
          format: 'osp-data-mesh/connector@1',
          connector: { ...connector, targetDatasetSlug: ds?.slug ?? null },
          dataset: ds ? datasetInputOf(ds) : null,
        };
        await deps.audit.record({
          actor,
          action: 'connector.export',
          objectType: 'connector',
          objectId: row.id,
          details: { slug: row.slug },
          ip,
          requestId,
        });
        return definition;
      },

      'connectors.import': async ({ body, user, actor, ip, requestId }) => {
        const { definition } = body;
        const def = definition.connector;
        const id = await deps.db
          .transaction()
          .execute(async (trx) => {
            let datasetId: string | null = null;
            let datasetCreated = false;
            let dataset = null;
            if (def.targetType === 'dataset') {
              const slug = def.targetDatasetSlug ?? definition.dataset?.slug ?? null;
              if (!slug) throw invalid({ 'body.definition.connector.targetDatasetSlug': 'required' });
              if (definition.dataset && definition.dataset.slug !== slug) {
                throw invalid({ 'body.definition.dataset.slug': 'mismatch' });
              }
              let row = await trx
                .selectFrom('dataset')
                .selectAll()
                .where('slug', '=', slug)
                .executeTakeFirst();
              if (!row) {
                if (!body.createDataset || !definition.dataset) {
                  throw invalid({ 'body.definition.connector.targetDatasetSlug': 'not_found' });
                }
                row = await createDataset(
                  trx,
                  definition.dataset,
                  { audit: deps.audit, actor, userId: user.id, ip, requestId },
                  'body.definition.dataset',
                );
                datasetCreated = true;
              }
              datasetId = row.id;
              dataset = toTargetDataset(row);
            }
            const { targetDatasetSlug: _slug, ...rest } = def;
            const input = validateConnectorInput(
              { ...rest, targetDatasetId: datasetId },
              dataset,
              'body.definition.connector',
            );
            const row = await insertConnector(trx, input, user.id);
            await deps.audit.record(
              {
                actor,
                action: 'connector.import',
                objectType: 'connector',
                objectId: row.id,
                details: { slug: input.slug, kind: input.kind, datasetId, datasetCreated },
                ip,
                requestId,
              },
              trx,
            );
            return row.id;
          })
          .catch(slugConflict);
        return (await getConnector(id))!;
      },

      'connectors.inspect': async ({ body: form, actor, ip, requestId }) => {
        let config = parseConfigField(form.get('config'));
        const file = form.get('file');
        if (isFile(file)) {
          if (config && config.type !== 'csv') throw invalid({ 'body.config.type': 'kind_mismatch' });
          if (file.size > MAX_UPLOAD_BYTES) throw new AppError('payload_too_large');
          const csv = config ?? CsvConfig.parse({ type: 'csv' });
          const decoded = decodeText(new Uint8Array(await file.arrayBuffer()), csv.encoding);
          // für die Zuordnung genügen die Beispielzeilen; die Datei wird nicht weiter gelesen
          const table = parseCsv(decoded.text, csv.delimiter, { maxRows: SAMPLE_ROWS });
          if (table.limit === 'too_many_columns') {
            throw new AppError('payload_too_large', { reason: 'too_many_columns' });
          }
          await deps.audit.record({
            actor,
            action: 'connector.inspect',
            objectType: 'source',
            details: {
              kind: 'csv',
              columns: table.columns.length,
              rows: table.rows.length,
              truncated: table.limit === 'too_many_rows',
            },
            ip,
            requestId,
          });
          return {
            columns: table.columns,
            sampleRows: table.rows.slice(0, SAMPLE_ROWS).map((r) => r.raw),
            detectedDelimiter: table.delimiter,
          };
        }
        // Gespeichertes Geheimnis eines Connectors: nur an dessen gespeichertes Ziel (URL und
        // Authentifizierung aus der Anfrage werden ignoriert), sonst könnte es an andere Hosts gehen
        let secret: string | null = null;
        const connectorId = form.get('connectorId');
        if (typeof connectorId === 'string' && connectorId !== '') {
          if (!UUID_RE.test(connectorId)) throw invalid({ 'body.connectorId': 'invalid' });
          const stored = await deps.db
            .selectFrom('connector')
            .select(['id', 'config', 'secret_enc'])
            .where('id', '=', connectorId)
            .executeTakeFirst();
          if (!stored) throw notFound();
          const storedConfig = stored.config as ConnectorConfigT;
          if (storedConfig.type !== 'http_api') throw invalid({ 'body.connectorId': 'kind_mismatch' });
          if (!config) config = storedConfig;
          else if (config.type === 'http_api') {
            config = { ...config, url: storedConfig.url, auth: storedConfig.auth };
          }
          if (stored.secret_enc) secret = deps.box.open(stored.secret_enc, secretAad(stored.id));
        }
        // einmalig mitgegebenes Geheimnis (nicht gespeichert)
        const formSecret = form.get('secret');
        if (typeof formSecret === 'string' && formSecret !== '') secret = formSecret;
        if (config?.type !== 'http_api') throw invalid({ 'body.file': 'required' });
        const denial = checkSource(config, secret, deps.config);
        if (denial) {
          await deps.audit.record({
            actor,
            action: 'connector.inspect',
            outcome: 'denied',
            objectType: 'source',
            details: {
              reason: denial,
              host: hostOf(config.url),
              ...(typeof connectorId === 'string' && connectorId !== '' ? { connectorId } : {}),
            },
            ip,
            requestId,
          });
          throw sourceDenied(denial);
        }
        const res = await fetchApiItems(deps.fetch, config, secret, {
          maxPages: 1,
          allowInsecureHttp: deps.config.MESH_SOURCE_ALLOW_INSECURE_HTTP,
        });
        await deps.audit.record({
          actor,
          action: 'connector.inspect',
          outcome: res.ok ? 'success' : 'error',
          objectType: 'source',
          details: {
            kind: 'http_api',
            host: hostOf(config.url),
            ...(res.ok ? { rows: res.items.length } : { code: res.code }),
          },
          ip,
          requestId,
        });
        if (!res.ok) {
          const reason = res.params.status
            ? `http_${res.params.status}`
            : String(res.params.reason ?? res.code);
          throw new AppError(res.code === 'source_unreachable' ? 'source_unreachable' : 'import_failed', {
            reason,
          });
        }
        const table = tableFromItems(res.items.slice(0, SAMPLE_ROWS));
        if (table.limit) throw new AppError('payload_too_large', { reason: table.limit });
        return { columns: table.columns, sampleRows: table.rows.map((r) => r.raw), detectedDelimiter: null };
      },

      'imports.start': async ({ params, body, user, actor, ip, requestId }) => {
        const connector = await deps.db
          .selectFrom('connector')
          .selectAll()
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (!connector) throw notFound();
        return startRun(ctxOf(deps, user.id, actor, ip, requestId), connector, body);
      },

      'imports.list': async ({ params }) => {
        const connector = await deps.db
          .selectFrom('connector')
          .select('name')
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (!connector) throw notFound();
        const runs = await deps.db
          .selectFrom('import_run')
          .selectAll()
          .where('connector_id', '=', params.id)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(200)
          .execute();
        return { items: runs.map((r) => toImportRun(r, connector.name)) };
      },

      'imports.get': async ({ params, actor, ip, requestId }) => {
        const detail = await loadRunDetail(deps.db, params.id);
        if (!detail) throw notFound();
        await deps.audit.record({
          actor,
          action: 'import.read',
          objectType: 'import_run',
          objectId: params.id,
          details: { part: 'preview', rows: detail.preview.rows.length },
          ip,
          requestId,
        });
        return detail;
      },

      'imports.errors': async ({ params, query, actor, ip, requestId }) => {
        const run = await deps.db
          .selectFrom('import_run')
          .select('id')
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (!run) throw notFound();
        const { total } = await deps.db
          .selectFrom('import_error')
          .select((eb) => eb.fn.countAll<number>().as('total'))
          .where('run_id', '=', params.id)
          .executeTakeFirstOrThrow();
        const rows = await deps.db
          .selectFrom('import_error')
          .selectAll()
          .where('run_id', '=', params.id)
          .orderBy('row_number')
          .orderBy('id')
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize)
          .execute();
        await deps.audit.record({
          actor,
          action: 'import.read',
          objectType: 'import_run',
          objectId: params.id,
          details: { part: 'errors', page: query.page, count: rows.length },
          ip,
          requestId,
        });
        return {
          items: rows.map((r) => ({
            rowNumber: r.row_number,
            field: r.field,
            code: r.code,
            severity: r.severity,
            rawValue: r.raw_value,
            params: (r.params ?? {}) as Record<string, string | number>,
          })),
          total: Number(total),
          page: query.page,
          pageSize: query.pageSize,
        };
      },

      'imports.commit': async ({ params, user, actor, ip, requestId }) =>
        commitRun(ctxOf(deps, user.id, actor, ip, requestId), params.id),

      'imports.discard': async ({ params, user, actor, ip, requestId }) =>
        discardRun(ctxOf(deps, user.id, actor, ip, requestId), params.id),
    });
  },
};

function ctxOf(
  deps: RequestContext['deps'],
  userId: string,
  actor: RequestContext['actor'],
  ip: string | null,
  requestId: string,
): RequestContext {
  return { deps, userId, actor, ip, requestId };
}

async function insertConnector(
  trx: Parameters<typeof loadConnectors>[0],
  input: ConnectorInput,
  userId: string,
) {
  return trx
    .insertInto('connector')
    .values({
      slug: input.slug,
      name: input.name,
      description: input.description,
      kind: input.kind,
      target_type: input.targetType,
      target_dataset_id: input.targetDatasetId,
      config: JSON.stringify(input.config),
      mapping: JSON.stringify(input.mapping),
      athlete_match: JSON.stringify(input.athleteMatch),
      on_error: input.onError,
      active: input.active,
      created_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
}
