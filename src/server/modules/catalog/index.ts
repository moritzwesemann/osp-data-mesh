import type { z } from 'zod';
import type { ColumnDef, DataCategory, Shareability } from '../../../shared/contract/common.ts';
import type { federationRoutes } from '../../../shared/contract/federation.ts';
import { ATHLETE_SOURCE_FIELDS } from '../../../shared/contract/products.ts';
import { isoReq } from '../../core/db.ts';
import type { Deps, Module } from '../../core/deps.ts';
import { registerRoutes } from '../../core/http.ts';
import { buildLoadedProduct, type DatasetInfo, datasetInfo } from '../products/rows.ts';

type CatalogResponse = z.infer<(typeof federationRoutes)['catalog.local']['response']>;
type CatalogItem = CatalogResponse['items'][number];
type Kind = CatalogItem['kind'];

const ATHLETE_TARGETS = new Map<string, { label: string; type: ColumnDef['type'] }>([
  ...ATHLETE_SOURCE_FIELDS.map((f) => [f.source, { label: f.label, type: f.type }] as const),
  ['athlete.external_id', { label: 'Externe Kennung', type: 'string' }],
]);

function fieldColumns(d: DatasetInfo): ColumnDef[] {
  return d.fields.map((f) =>
    f.unit
      ? { key: f.name, label: f.label, type: f.type, unit: f.unit }
      : { key: f.name, label: f.label, type: f.type },
  );
}

function targetColumn(target: string, dataset: DatasetInfo | null): ColumnDef {
  const athlete = ATHLETE_TARGETS.get(target);
  if (athlete) return { key: target, label: athlete.label, type: athlete.type };
  if (target.startsWith('data.') && dataset) {
    const f = dataset.fields.find((x) => x.name === target.slice(5));
    if (f)
      return f.unit
        ? { key: target, label: f.label, type: f.type, unit: f.unit }
        : { key: target, label: f.label, type: f.type };
  }
  return { key: target, label: target, type: 'string' };
}

function matchesQuery(item: CatalogItem, q: string): boolean {
  const needle = q.toLocaleLowerCase('de');
  return [item.name, item.slug, item.description].some((s) => s.toLocaleLowerCase('de').includes(needle));
}

/** Lokaler Metadatenkatalog (nur Metadaten, keine Daten) */
export async function localCatalog(deps: Deps, query: { q?: string; kind?: Kind }): Promise<CatalogItem[]> {
  const { db } = deps;
  const datasetRows = await db.selectFrom('dataset').selectAll().orderBy('name').execute();
  const datasets = new Map<string, DatasetInfo & { description: string; updatedAt: Date }>();
  for (const r of datasetRows) {
    datasets.set(r.id, { ...datasetInfo(r), description: r.description, updatedAt: r.updated_at });
  }
  const connectors = await db.selectFrom('connector').selectAll().orderBy('name').execute();
  const products = (
    await db.selectFrom('data_product').selectAll().where('status', '=', 'active').orderBy('name').execute()
  ).map((p) => buildLoadedProduct(p, p.dataset_id ? (datasets.get(p.dataset_id) ?? null) : null));

  const items: CatalogItem[] = [];

  for (const c of connectors) {
    const dataset = c.target_dataset_id ? (datasets.get(c.target_dataset_id) ?? null) : null;
    const mapping = (Array.isArray(c.mapping) ? c.mapping : []) as { source?: unknown; target?: unknown }[];
    const mappings = mapping
      .filter((m) => typeof m.source === 'string' && typeof m.target === 'string')
      .map((m) => ({ source: m.source as string, target: m.target as string }));
    const seen = new Set<string>();
    const fields: ColumnDef[] = [];
    for (const m of mappings) {
      if (seen.has(m.target)) continue;
      seen.add(m.target);
      fields.push(targetColumn(m.target, dataset));
    }
    items.push({
      kind: 'source',
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      category: (dataset?.category ?? 'master') as DataCategory,
      version: c.version,
      shareability: (dataset?.shareability ?? 'on_request') as Shareability,
      specialCategory: dataset?.specialCategory ?? false,
      fields,
      mappings,
      related: dataset ? [{ kind: 'dataset', id: dataset.id, name: dataset.name }] : [],
      updatedAt: isoReq(c.updated_at),
    });
  }

  for (const d of datasets.values()) {
    items.push({
      kind: 'dataset',
      id: d.id,
      slug: d.slug,
      name: d.name,
      description: d.description,
      category: d.category,
      version: d.version,
      shareability: d.shareability,
      specialCategory: d.specialCategory,
      fields: fieldColumns(d),
      mappings: [],
      related: [
        ...connectors
          .filter((c) => c.target_dataset_id === d.id)
          .map((c) => ({ kind: 'source' as const, id: c.id, name: c.name })),
        ...products
          .filter((p) => p.datasetId === d.id)
          .map((p) => ({ kind: 'product' as const, id: p.id, name: p.name })),
      ],
      updatedAt: isoReq(d.updatedAt),
    });
  }

  for (const p of products) {
    items.push({
      kind: 'product',
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      category: p.category,
      version: p.version,
      shareability: p.shareability,
      specialCategory: p.specialCategory,
      fields: [...p.columns],
      mappings: [],
      related: p.dataset ? [{ kind: 'dataset', id: p.dataset.id, name: p.dataset.name }] : [],
      updatedAt: isoReq(p.updatedAt),
    });
  }

  const q = query.q?.trim();
  return items.filter((i) => (!query.kind || i.kind === query.kind) && (!q || matchesQuery(i, q)));
}

/** Modul "catalog": lokaler Metadatenkatalog für alle angemeldeten Personen */
export const catalogModule: Module = {
  name: 'catalog',
  routes(app, deps) {
    registerRoutes(app, deps, {
      'catalog.local': async ({ query }) => ({ items: await localCatalog(deps, query) }),
    });
  },
};
