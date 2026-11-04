/**
 * Modul "datasets": Datensatz-Strukturen (Felder mit Format- und Plausibilitätsregeln, fachlicher
 * Schlüssel, Beobachtungsdatum) und Einsicht in die Einträge (jeder Lesezugriff wird protokolliert).
 *
 * Öffentliche Schnittstelle für andere Module (connectors): createDataset, datasetInputOf, validateDatasetInput.
 */
import { sql } from 'kysely';
import type { DatasetInput, FieldDef } from '../../../shared/contract/datasets.ts';
import { iso, isoReq } from '../../core/db.ts';
import type { Row, RowUpdate } from '../../core/db-types.ts';
import type { Module } from '../../core/deps.ts';
import { conflict, notFound } from '../../core/errors.ts';
import { registerRoutes } from '../../core/http.ts';
import {
  createDataset,
  datasetInputOf,
  isCompatibleFieldChange,
  structureChanged,
  toDataset,
  validateDatasetInput,
} from './definition.ts';
import { presentPatch } from './patch.ts';

export { createDataset, datasetInputOf, validateDatasetInput };

export const datasetsModule: Module = {
  name: 'datasets',
  routes(app, deps) {
    const withCounts = () =>
      deps.db
        .selectFrom('dataset as d')
        .selectAll('d')
        .select((eb) =>
          eb
            .selectFrom('dataset_record as r')
            .select(eb.fn.countAll<number>().as('n'))
            .whereRef('r.dataset_id', '=', 'd.id')
            .as('record_count'),
        );

    registerRoutes(app, deps, {
      'datasets.list': async () => {
        const rows = await withCounts().orderBy('d.name').execute();
        return { items: rows.map((r) => toDataset(r, Number(r.record_count ?? 0))) };
      },

      'datasets.get': async ({ params }) => {
        const row = await withCounts().where('d.id', '=', params.id).executeTakeFirst();
        if (!row) throw notFound();
        return toDataset(row, Number(row.record_count ?? 0));
      },

      'datasets.create': async ({ body, user, actor, ip, requestId }) => {
        const row = await deps.db
          .transaction()
          .execute((trx) =>
            createDataset(trx, body, { audit: deps.audit, actor, userId: user.id, ip, requestId }),
          );
        return toDataset(row, 0);
      },

      'datasets.update': async ({ params, body, c, actor, ip, requestId }) => {
        const patch = await presentPatch(c, body);
        const result = await deps.db.transaction().execute(async (trx) => {
          const existing = await trx
            .selectFrom('dataset')
            .selectAll()
            .where('id', '=', params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!existing) throw notFound();
          const before = datasetInputOf(existing);
          const merged = validateDatasetInput({ ...before, ...patch } as DatasetInput);
          const changedKeys = (Object.keys(patch) as (keyof DatasetInput)[]).filter(
            (k) => JSON.stringify(before[k]) !== JSON.stringify(merged[k]),
          );
          if (merged.specialCategory !== before.specialCategory && !changedKeys.includes('specialCategory')) {
            changedKeys.push('specialCategory');
          }
          const { n } = await trx
            .selectFrom('dataset_record')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('dataset_id', '=', params.id)
            .executeTakeFirstOrThrow();
          const recordCount = Number(n);
          const structural = structureChanged(before, merged);
          if (structural && recordCount > 0) {
            const keysChanged =
              JSON.stringify(before.keyFields) !== JSON.stringify(merged.keyFields) ||
              before.observedAtField !== merged.observedAtField;
            if (keysChanged || !isCompatibleFieldChange(before.fields, merged.fields as FieldDef[])) {
              throw conflict('dataset_in_use');
            }
          }
          if (changedKeys.length === 0) return { row: existing, recordCount };
          const set: RowUpdate<'dataset'> = {
            name: merged.name,
            description: merged.description,
            category: merged.category,
            special_category: merged.specialCategory,
            shareability: merged.shareability,
            fields: JSON.stringify(merged.fields),
            key_fields: merged.keyFields,
            observed_at_field: merged.observedAtField,
            owner_contact: merged.ownerContact,
          };
          if (structural) set.version = existing.version + 1;
          const row = await trx
            .updateTable('dataset')
            .set(set)
            .where('id', '=', params.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await deps.audit.record(
            {
              actor,
              action: 'dataset.update',
              objectType: 'dataset',
              objectId: params.id,
              details: { changed: changedKeys, version: row.version },
              ip,
              requestId,
            },
            trx,
          );
          return { row, recordCount };
        });
        return toDataset(result.row, result.recordCount);
      },

      'datasets.records': async ({ params, query, actor, ip, requestId }) => {
        const dataset = await deps.db
          .selectFrom('dataset')
          .select(['id', 'slug'])
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (!dataset) throw notFound();
        const { total } = await deps.db
          .selectFrom('dataset_record')
          .select((eb) => eb.fn.countAll<number>().as('total'))
          .where('dataset_id', '=', params.id)
          .executeTakeFirstOrThrow();
        const rows = await deps.db
          .selectFrom('dataset_record as r')
          .innerJoin('athlete as a', 'a.id', 'r.athlete_id')
          .select([
            'r.id',
            'r.athlete_id',
            'r.observed_at',
            'r.data',
            'r.import_run_id',
            'r.updated_at',
            'a.last_name',
            'a.first_name',
          ])
          .where('r.dataset_id', '=', params.id)
          .orderBy(sql`r.observed_at desc nulls last`)
          .orderBy('a.last_name')
          .orderBy('a.first_name')
          .orderBy('r.id')
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize)
          .execute();
        await deps.audit.record({
          actor,
          action: 'dataset.read',
          objectType: 'dataset',
          objectId: params.id,
          details: { count: rows.length, total: Number(total), page: query.page },
          ip,
          requestId,
        });
        return {
          items: rows.map((r) => toRecord(r)),
          total: Number(total),
          page: query.page,
          pageSize: query.pageSize,
        };
      },
    });
  },
};

type RecordRow = Pick<
  Row<'dataset_record'>,
  'id' | 'athlete_id' | 'observed_at' | 'data' | 'import_run_id' | 'updated_at'
> & { last_name: string; first_name: string };

function toRecord(r: RecordRow) {
  return {
    id: r.id,
    athleteId: r.athlete_id,
    athleteName: `${r.last_name}, ${r.first_name}`,
    observedAt: iso(r.observed_at),
    data: (r.data ?? {}) as Record<string, string | number | boolean | null>,
    importRunId: r.import_run_id,
    updatedAt: isoReq(r.updated_at),
  };
}
