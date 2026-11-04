/**
 * Datenprodukte: Anlegen, Ändern (Versionierung), Stilllegen, Abbildung auf den Vertrag.
 */
import type { Condition } from '../../../shared/contract/common.ts';
import type {
  Product,
  ProductColumn,
  ProductInput,
  ProductUpdateInput,
} from '../../../shared/contract/products.ts';
import { type Actor, SYSTEM_ACTOR } from '../../core/audit.ts';
import { type DbOrTx, isoReq, pgCode } from '../../core/db.ts';
import type { Deps } from '../../core/deps.ts';
import { AppError, conflict, notFound } from '../../core/errors.ts';
import type { DomainEvents } from '../../core/events.ts';
import { conditionValueFits } from '../releases/engine.ts';
import { statusOf } from '../releases/rules.ts';
import {
  buildLoadedProduct,
  type DatasetInfo,
  datasetInfo,
  type LoadedProduct,
  loadDataset,
  normalizeConditions,
  productMeta,
  type ResolvedColumn,
  resolveColumn,
} from './rows.ts';

export interface RequestMeta {
  actor: Actor;
  userId: string | null;
  ip: string | null;
  requestId: string;
}

/**
 * Prüft Spalten und Basisfilter gegen die Quelle. Liefert aufgelöste Spalten oder wirft validation_failed
 * mit Feldfehlern (Pfad → Code).
 */
export function validateDefinition(
  sourceType: 'athletes' | 'dataset',
  dataset: DatasetInfo | null,
  columns: readonly ProductColumn[],
  filters: readonly Condition[],
): { columns: ResolvedColumn[]; filters: Condition[] } {
  const fields: Record<string, string> = {};
  const resolved: ResolvedColumn[] = [];
  const seen = new Set<string>();
  columns.forEach((col, i) => {
    if (seen.has(col.key)) fields[`body.columns.${i}.key`] = 'duplicate';
    seen.add(col.key);
    const r = resolveColumn(col, sourceType, dataset);
    if (typeof r === 'string') fields[`body.columns.${i}.source`] = r;
    else resolved.push(r);
  });
  const byKey = new Map(resolved.map((c) => [c.key, c]));
  filters.forEach((f, i) => {
    const col = byKey.get(f.column);
    if (!col) {
      if (!fields[`body.filters.${i}.column`] && !seen.has(f.column))
        fields[`body.filters.${i}.column`] = 'unknown_column';
      return;
    }
    if (!conditionValueFits(f, col.type)) fields[`body.filters.${i}.value`] = 'invalid_value';
  });
  if (Object.keys(fields).length) throw new AppError('validation_failed', { fields });
  return {
    columns: resolved,
    filters: normalizeConditions(filters, new Map(resolved.map((c) => [c.key, c.type]))),
  };
}

/** Anzahl aktuell aktiver Freigaben je Produkt */
export async function activeReleaseCounts(
  db: DbOrTx,
  products: readonly { id: string; version: number }[],
  at: Date,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (products.length === 0) return counts;
  const versions = new Map(products.map((p) => [p.id, p.version]));
  const rows = await db
    .selectFrom('data_release')
    .selectAll()
    .where(
      'product_id',
      'in',
      products.map((p) => p.id),
    )
    .where('revoked_at', 'is', null)
    .execute();
  for (const r of rows) {
    if (statusOf(r, versions.get(r.product_id) ?? -1, at) === 'active')
      counts.set(r.product_id, (counts.get(r.product_id) ?? 0) + 1);
  }
  return counts;
}

export function toProductApi(p: LoadedProduct, activeReleaseCount: number): Product {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    sourceType: p.sourceType,
    datasetId: p.datasetId,
    datasetName: p.dataset?.name ?? null,
    category: p.category,
    specialCategory: p.specialCategory,
    shareability: p.shareability,
    columns: p.columnSpecs.map((c) =>
      c.unit
        ? { key: c.key, label: c.label, source: c.source, type: c.type, unit: c.unit }
        : { key: c.key, label: c.label, source: c.source, type: c.type },
    ),
    filters: p.filters,
    version: p.version,
    status: p.status,
    activeReleaseCount,
    createdAt: isoReq(p.createdAt),
    updatedAt: isoReq(p.updatedAt),
  };
}

export async function getProductApi(deps: Deps, id: string, db: DbOrTx = deps.db): Promise<Product> {
  const p = await productMeta(db, id);
  if (!p) throw notFound();
  const counts = await activeReleaseCounts(db, [p], deps.now());
  return toProductApi(p, counts.get(p.id) ?? 0);
}

export async function listProducts(deps: Deps): Promise<Product[]> {
  const rows = await deps.db.selectFrom('data_product').selectAll().orderBy('name').orderBy('slug').execute();
  const datasetIds = [...new Set(rows.map((r) => r.dataset_id).filter((x): x is string => !!x))];
  const datasets = new Map<string, DatasetInfo>();
  if (datasetIds.length) {
    const list = await deps.db.selectFrom('dataset').selectAll().where('id', 'in', datasetIds).execute();
    for (const d of list) datasets.set(d.id, datasetInfo(d));
  }
  const loaded = rows.map((r) =>
    buildLoadedProduct(r, r.dataset_id ? (datasets.get(r.dataset_id) ?? null) : null),
  );
  const counts = await activeReleaseCounts(deps.db, loaded, deps.now());
  return loaded.map((p) => toProductApi(p, counts.get(p.id) ?? 0));
}

export async function createProduct(deps: Deps, input: ProductInput, meta: RequestMeta): Promise<Product> {
  let dataset: DatasetInfo | null = null;
  if (input.sourceType === 'dataset') {
    if (!input.datasetId)
      throw new AppError('validation_failed', { fields: { 'body.datasetId': 'required' } });
    dataset = await loadDataset(deps.db, input.datasetId);
    if (!dataset) throw new AppError('validation_failed', { fields: { 'body.datasetId': 'not_found' } });
  } else if (input.datasetId) {
    throw new AppError('validation_failed', { fields: { 'body.datasetId': 'not_allowed' } });
  }
  const { filters } = validateDefinition(input.sourceType, dataset, input.columns, input.filters);
  const shareability = dataset?.shareability === 'internal' ? 'internal' : input.shareability;

  const existing = await deps.db
    .selectFrom('data_product')
    .select('id')
    .where('slug', '=', input.slug)
    .executeTakeFirst();
  if (existing) throw conflict('slug_taken');

  try {
    return await deps.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('data_product')
        .values({
          slug: input.slug,
          name: input.name,
          description: input.description,
          source_type: input.sourceType,
          dataset_id: dataset?.id ?? null,
          columns: JSON.stringify(input.columns.map(({ key, label, source }) => ({ key, label, source }))),
          filters: JSON.stringify(filters),
          shareability,
          created_by: meta.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await deps.audit.record(
        {
          actor: meta.actor,
          action: 'product.create',
          objectType: 'product',
          objectId: row.id,
          details: {
            slug: input.slug,
            sourceType: input.sourceType,
            datasetId: dataset?.id ?? null,
            columns: input.columns.map((c) => c.key),
            filterCount: filters.length,
            shareability,
          },
          ip: meta.ip,
          requestId: meta.requestId,
        },
        trx,
      );
      return getProductApi(deps, row.id, trx);
    });
  } catch (err) {
    if (pgCode(err) === '23505') throw conflict('slug_taken');
    throw err;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function updateProduct(
  deps: Deps,
  id: string,
  input: ProductUpdateInput,
  meta: RequestMeta,
): Promise<Product> {
  const result = await deps.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('data_product')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== 'active') throw conflict('product_retired');
    const dataset = row.dataset_id ? await loadDataset(trx, row.dataset_id) : null;
    const sourceType = row.source_type === 'dataset' ? 'dataset' : 'athletes';
    if (sourceType === 'dataset' && !dataset) throw conflict('dataset_missing');

    const oldColumns = (Array.isArray(row.columns) ? row.columns : []) as ProductColumn[];
    const oldFilters = (Array.isArray(row.filters) ? row.filters : []) as Condition[];
    const columns = input.columns
      ? input.columns.map(({ key, label, source }) => ({ key, label, source }))
      : oldColumns;
    let filters = input.filters ?? oldFilters;
    // Nur bei geänderten Spalten oder Filtern neu prüfen (bestehende Definition bleibt sonst unangetastet)
    if (input.columns || input.filters)
      filters = validateDefinition(sourceType, dataset, columns, filters).filters;

    const definitionChanged = !sameJson(columns, oldColumns) || !sameJson(filters, oldFilters);
    const shareability =
      dataset?.shareability === 'internal' ? 'internal' : (input.shareability ?? row.shareability);
    const version = definitionChanged ? row.version + 1 : row.version;
    const changed: string[] = [];
    if (input.name !== undefined && input.name !== row.name) changed.push('name');
    if (input.description !== undefined && input.description !== row.description) changed.push('description');
    if (!sameJson(columns, oldColumns)) changed.push('columns');
    if (!sameJson(filters, oldFilters)) changed.push('filters');
    if (shareability !== row.shareability) changed.push('shareability');

    await trx
      .updateTable('data_product')
      .set({
        name: input.name ?? row.name,
        description: input.description ?? row.description,
        columns: JSON.stringify(columns),
        filters: JSON.stringify(filters),
        shareability,
        version,
      })
      .where('id', '=', id)
      .execute();
    await deps.audit.record(
      {
        actor: meta.actor,
        action: 'product.update',
        objectType: 'product',
        objectId: id,
        details: { changed, version, previousVersion: row.version, versionChanged: definitionChanged },
        ip: meta.ip,
        requestId: meta.requestId,
      },
      trx,
    );
    await deps.events.inTx(trx, 'product.changed', { productId: id, retired: false });
    return getProductApi(deps, id, trx);
  });
  await deps.events.after('product.changed', { productId: id, retired: false });
  return result;
}

type ProductChanged = DomainEvents['product.changed'];
type DatasetChanged = DomainEvents['dataset.changed'];

/**
 * Partnerfreigaben enden, wenn bereits gelieferte Kopien nach der neuen Einstufung nicht hätten geliefert
 * werden dürfen: neu besondere Kategorie (Art. 9; auch Kategoriewechsel einer besonderen Kategorie, weil die
 * Einwilligung je Kategorie gilt) oder neu intern.
 */
export function peerReleasesEnd(e: DatasetChanged): boolean {
  const special =
    e.after.specialCategory && (!e.before.specialCategory || e.before.category !== e.after.category);
  const internal = e.after.shareability === 'internal' && e.before.shareability !== 'internal';
  return special || internal;
}

/** true, wenn die Datensatzänderung dieses Produkt betrifft (Einstufung, Beobachtungsdatum oder genutzte Felder) */
function productAffected(e: DatasetChanged, columns: readonly ProductColumn[]): boolean {
  if (e.classificationChanged || e.observedAtChanged) return true;
  return columns.some((c) => c.source.startsWith('data.') && e.changedFields.includes(c.source.slice(5)));
}

/**
 * Datensatzänderung wie eine Produktänderung behandeln (in der Transaktion der Datensatzänderung):
 * jedes betroffene aktive Produkt erhält eine neue Version (bestehende Freigaben veralten mit
 * product_changed; BI-Views prüfen die Version in SQL und liefern sofort keine Zeilen mehr), wird bei einem
 * internen Datensatz intern gespeichert, die Änderung wird protokolliert und 'product.changed' ausgelöst.
 * Bei Hochstufung (peerReleasesEnd) widerruft das Modul releases zusätzlich alle Partnerfreigaben.
 */
export function registerDatasetChangeHandler(deps: Deps): void {
  const pending = new Map<string, ProductChanged[]>();
  deps.events.onTx('dataset.changed', async (e, trx) => {
    const rows = await trx
      .selectFrom('data_product')
      .selectAll()
      .where('dataset_id', '=', e.datasetId)
      .where('status', '=', 'active')
      .orderBy('id')
      .forUpdate()
      .execute();
    const revokePeerReleases = peerReleasesEnd(e);
    const payloads: ProductChanged[] = [];
    for (const row of rows) {
      const columns = (Array.isArray(row.columns) ? row.columns : []) as ProductColumn[];
      if (!productAffected(e, columns)) continue;
      const shareability = e.after.shareability === 'internal' ? 'internal' : row.shareability;
      const version = row.version + 1;
      await trx.updateTable('data_product').set({ version, shareability }).where('id', '=', row.id).execute();
      await deps.audit.record(
        {
          actor: SYSTEM_ACTOR,
          action: 'product.update',
          objectType: 'product',
          objectId: row.id,
          details: {
            cause: 'dataset_changed',
            datasetId: e.datasetId,
            changed: shareability !== row.shareability ? ['shareability'] : [],
            version,
            previousVersion: row.version,
            versionChanged: true,
            classificationChanged: e.classificationChanged,
            observedAtChanged: e.observedAtChanged,
            changedFields: e.changedFields,
            peerReleasesRevoked: revokePeerReleases,
          },
          ip: null,
          requestId: null,
        },
        trx,
      );
      const payload: ProductChanged = revokePeerReleases
        ? { productId: row.id, retired: false, revokePeerReleases: 'dataset_reclassified' }
        : { productId: row.id, retired: false };
      await deps.events.inTx(trx, 'product.changed', payload);
      payloads.push(payload);
    }
    pending.set(e.datasetId, payloads);
  });
  deps.events.onAfter('dataset.changed', async (e) => {
    const payloads = pending.get(e.datasetId) ?? [];
    pending.delete(e.datasetId);
    for (const p of payloads) await deps.events.after('product.changed', p);
  });
}

export async function retireProduct(deps: Deps, id: string, meta: RequestMeta): Promise<Product> {
  const result = await deps.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('data_product')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== 'active') throw conflict('product_retired');
    await trx.updateTable('data_product').set({ status: 'retired' }).where('id', '=', id).execute();
    await deps.audit.record(
      {
        actor: meta.actor,
        action: 'product.retire',
        objectType: 'product',
        objectId: id,
        details: { version: row.version },
        ip: meta.ip,
        requestId: meta.requestId,
      },
      trx,
    );
    // Freigaben werden im Handler des Moduls releases in dieser Transaktion widerrufen
    await deps.events.inTx(trx, 'product.changed', { productId: id, retired: true });
    return getProductApi(deps, id, trx);
  });
  await deps.events.after('product.changed', { productId: id, retired: true });
  return result;
}
