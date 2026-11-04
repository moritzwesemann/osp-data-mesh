/**
 * Datenprodukte: Auflösung der Spalten (Typ/Einheit) und Laden der Produktzeilen.
 *
 * Wird vom Policy Enforcement Point (releases/pep.ts) genutzt. Liefert ungefilterte Produktzeilen
 * (nur Basisfilter des Produkts); Freigabe- und Einwilligungsregeln wendet ausschließlich die Engine an.
 */
import { sql } from 'kysely';
import type {
  ColumnDef,
  Condition,
  DataCategory,
  FieldType,
  Scalar,
  Shareability,
} from '../../../shared/contract/common.ts';
import type { FieldDef } from '../../../shared/contract/datasets.ts';
import { ATHLETE_SOURCE_FIELDS, type ProductColumn } from '../../../shared/contract/products.ts';
import type { DbOrTx } from '../../core/db.ts';
import type { ServedProduct } from '../../core/deps.ts';
import { dateInZone, matchesAll, type ProductRow } from '../releases/engine.ts';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DatasetInfo {
  id: string;
  slug: string;
  name: string;
  category: DataCategory;
  specialCategory: boolean;
  shareability: Shareability;
  fields: FieldDef[];
  observedAtField: string | null;
  version: number;
}

export interface ResolvedColumn extends ProductColumn {
  type: FieldType;
  unit?: string;
}

/** Vollständig aufgelöstes Produkt (Metadaten für Engine und API) */
export interface LoadedProduct extends ServedProduct {
  sourceType: 'athletes' | 'dataset';
  datasetId: string | null;
  dataset: DatasetInfo | null;
  /** gespeicherte Teilbarkeit (vor Übersteuerung durch einen internen Datensatz) */
  storedShareability: Shareability;
  /** Spalten mit Quelle; nicht (mehr) auflösbare Spalten fehlen hier (deny by default) */
  columnSpecs: ResolvedColumn[];
  filters: Condition[];
  createdAt: Date;
  updatedAt: Date;
}

export type ColumnIssue = 'invalid_source' | 'unknown_field';

const ATHLETE_FIELDS = new Map<string, { label: string; type: FieldType }>(
  ATHLETE_SOURCE_FIELDS.map((f) => [f.source, { label: f.label, type: f.type }]),
);

/** Typ des Beobachtungsdatums: 'date', wenn das Datumsfeld des Datensatzes ein Datum ist, sonst 'datetime'. */
export function observedAtType(dataset: DatasetInfo): 'date' | 'datetime' {
  const f = dataset.observedAtField ? dataset.fields.find((x) => x.name === dataset.observedAtField) : null;
  return f?.type === 'date' ? 'date' : 'datetime';
}

/** Löst Typ und Einheit einer Produktspalte auf oder liefert den Fehlercode. */
export function resolveColumn(
  col: ProductColumn,
  sourceType: 'athletes' | 'dataset',
  dataset: DatasetInfo | null,
): ResolvedColumn | ColumnIssue {
  const athlete = ATHLETE_FIELDS.get(col.source);
  if (athlete) return { ...col, type: athlete.type };
  if (sourceType !== 'dataset' || !dataset) return 'invalid_source';
  if (col.source === 'record.observed_at') return { ...col, type: observedAtType(dataset) };
  if (col.source.startsWith('data.')) {
    const name = col.source.slice(5);
    const field = dataset.fields.find((f) => f.name === name);
    if (!field) return 'unknown_field';
    return field.unit ? { ...col, type: field.type, unit: field.unit } : { ...col, type: field.type };
  }
  return 'invalid_source';
}

export function toColumnDef(c: ResolvedColumn): ColumnDef {
  return c.unit
    ? { key: c.key, label: c.label, type: c.type, unit: c.unit }
    : { key: c.key, label: c.label, type: c.type };
}

export async function loadDataset(db: DbOrTx, id: string): Promise<DatasetInfo | null> {
  if (!UUID_RE.test(id)) return null;
  const d = await db.selectFrom('dataset').selectAll().where('id', '=', id).executeTakeFirst();
  return d ? datasetInfo(d) : null;
}

export function datasetInfo(d: {
  id: string;
  slug: string;
  name: string;
  category: string;
  special_category: boolean;
  shareability: string;
  fields: unknown;
  observed_at_field: string | null;
  version: number;
}): DatasetInfo {
  return {
    id: d.id,
    slug: d.slug,
    name: d.name,
    category: d.category as DataCategory,
    // Gesundheitsdaten sind immer besondere Kategorie (auch die Datenbank erzwingt das)
    specialCategory: d.special_category || d.category === 'health',
    shareability: d.shareability as Shareability,
    fields: Array.isArray(d.fields) ? (d.fields as FieldDef[]) : [],
    observedAtField: d.observed_at_field,
    version: d.version,
  };
}

/** Lädt ein Produkt mit Datensatz-Metadaten. null, wenn es nicht existiert. */
export async function productMeta(db: DbOrTx, id: string): Promise<LoadedProduct | null> {
  if (!UUID_RE.test(id)) return null;
  const p = await db.selectFrom('data_product').selectAll().where('id', '=', id).executeTakeFirst();
  if (!p) return null;
  const dataset = p.dataset_id ? await loadDataset(db, p.dataset_id) : null;
  return buildLoadedProduct(p, dataset);
}

export function buildLoadedProduct(
  p: {
    id: string;
    slug: string;
    name: string;
    description: string;
    source_type: string;
    dataset_id: string | null;
    columns: unknown;
    filters: unknown;
    shareability: string;
    version: number;
    status: string;
    created_at: Date;
    updated_at: Date;
  },
  dataset: DatasetInfo | null,
): LoadedProduct {
  const sourceType = p.source_type === 'dataset' ? 'dataset' : 'athletes';
  const stored = (Array.isArray(p.columns) ? p.columns : []) as ProductColumn[];
  const columnSpecs: ResolvedColumn[] = [];
  for (const c of stored) {
    const r = resolveColumn(c, sourceType, dataset);
    if (typeof r !== 'string') columnSpecs.push(r);
  }
  const storedShareability = p.shareability as Shareability;
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    version: p.version,
    status: p.status === 'active' ? 'active' : 'retired',
    category: dataset ? dataset.category : 'master',
    specialCategory: dataset ? dataset.specialCategory : false,
    // Ein Produkt eines internen Datensatzes ist immer intern (auch wenn der Datensatz später intern wird)
    shareability: dataset?.shareability === 'internal' ? 'internal' : storedShareability,
    columns: columnSpecs.map(toColumnDef),
    sourceType,
    datasetId: p.dataset_id,
    dataset,
    storedShareability,
    columnSpecs,
    filters: (Array.isArray(p.filters) ? p.filters : []) as Condition[],
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

/** Nur die Felder von ServedProduct (z. B. für ServeResult) */
export function servedProduct(p: LoadedProduct): ServedProduct {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    version: p.version,
    status: p.status,
    category: p.category,
    specialCategory: p.specialCategory,
    shareability: p.shareability,
    columns: p.columns,
  };
}

/**
 * Bringt Bedingungswerte auf Zeitstempel-Spalten in die kanonische Form (ISO, UTC, "…Z"), wie sie auch die
 * Produktzeilen liefern. Die Engine vergleicht Zeitstempel als Text; ohne Normalisierung würden Werte mit
 * Zeitzonenversatz (z. B. "+01:00") falsch eingeordnet.
 */
export function normalizeConditions(
  conditions: readonly Condition[],
  types: ReadonlyMap<string, FieldType>,
): Condition[] {
  const norm = <T>(x: T): T | string =>
    typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? new Date(Date.parse(x)).toISOString() : x;
  return conditions.map((c) => {
    if (types.get(c.column) !== 'datetime' || c.value === undefined || c.value === null) return c;
    return { ...c, value: Array.isArray(c.value) ? c.value.map(norm) : norm(c.value) };
  });
}

/** Wandelt einen gespeicherten Wert in den Spaltentyp um; Unpassendes wird null (deny by default). */
export function coerceScalar(v: unknown, type: FieldType): Scalar {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'integer': {
      const n = toNumber(v);
      return n !== null && Number.isInteger(n) ? n : null;
    }
    case 'number':
      return toNumber(v);
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return null;
    case 'date':
      if (typeof v !== 'string') return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) return v.slice(0, 10);
      return null;
    case 'datetime': {
      if (typeof v !== 'string') return null;
      const t = Date.parse(v);
      return Number.isNaN(t) ? null : new Date(t).toISOString();
    }
    default:
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return null;
  }
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

interface AthleteCore {
  athlete_id: string;
  last_name: string;
  first_name: string;
  date_of_birth: string;
  sport: string;
  squad_status: string;
  sex: string | null;
  club: string | null;
  discipline: string | null;
}

function athleteValue(a: AthleteCore, field: string): Scalar {
  switch (field) {
    case 'birth_year': {
      const y = Number.parseInt(a.date_of_birth.slice(0, 4), 10);
      return Number.isFinite(y) ? y : null;
    }
    case 'last_name':
      return a.last_name;
    case 'first_name':
      return a.first_name;
    case 'date_of_birth':
      return a.date_of_birth;
    case 'sport':
      return a.sport;
    case 'squad_status':
      return a.squad_status;
    case 'sex':
      return a.sex;
    case 'club':
      return a.club;
    case 'discipline':
      return a.discipline;
    default:
      return null;
  }
}

export interface LoadRowsOptions {
  /** Zeitzone für Datumswerte des Beobachtungszeitpunkts (Standard Europe/Berlin) */
  timeZone?: string;
}

/**
 * Lädt alle Zeilen eines Produkts (alle Produktspalten, Basisfilter angewandt).
 *  - sourceType 'athletes': eine Zeile je Person (ohne Beobachtungsdatum)
 *  - sourceType 'dataset': eine Zeile je Datensatz-Eintrag (mit Personenkern)
 * observedAt ist das Beobachtungsdatum (YYYY-MM-DD) in der Knotenzeitzone, damit der Datenzeitraum
 * dasselbe Datum prüft, das Empfänger in der Spalte record.observed_at sehen.
 */
export async function loadProductRows(
  db: DbOrTx,
  product: LoadedProduct,
  opts: LoadRowsOptions = {},
): Promise<ProductRow[]> {
  const tz = opts.timeZone ?? 'Europe/Berlin';
  const specs = product.columnSpecs;
  const rows: ProductRow[] = [];

  const athleteCols = [
    'a.id as athlete_id',
    'a.last_name',
    'a.first_name',
    'a.date_of_birth',
    'a.sport',
    'a.squad_status',
    'a.sex',
    'a.club',
    'a.discipline',
  ] as const;

  if (product.sourceType === 'athletes') {
    const list = await db
      .selectFrom('athlete as a')
      .select(athleteCols)
      .orderBy('a.last_name')
      .orderBy('a.first_name')
      .orderBy('a.id')
      .execute();
    for (const a of list) {
      const values: Record<string, Scalar> = {};
      for (const c of specs) {
        values[c.key] = c.source.startsWith('athlete.') ? athleteValue(a, c.source.slice(8)) : null;
      }
      rows.push({ athleteId: a.athlete_id, observedAt: null, values });
    }
  } else {
    if (!product.datasetId || !product.dataset) return [];
    const list = await db
      .selectFrom('dataset_record as r')
      .innerJoin('athlete as a', 'a.id', 'r.athlete_id')
      .select([...athleteCols, 'r.observed_at', 'r.data', 'r.record_key'])
      .where('r.dataset_id', '=', product.datasetId)
      .orderBy(sql`r.observed_at asc nulls last`)
      .orderBy('a.last_name')
      .orderBy('a.first_name')
      .orderBy('r.record_key')
      .execute();
    const obsType = observedAtType(product.dataset);
    for (const r of list) {
      const data = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
      const observed = r.observed_at ? new Date(r.observed_at) : null;
      const values: Record<string, Scalar> = {};
      for (const c of specs) {
        if (c.source.startsWith('athlete.')) values[c.key] = athleteValue(r, c.source.slice(8));
        else if (c.source === 'record.observed_at') {
          values[c.key] = observed
            ? obsType === 'date'
              ? dateInZone(observed, tz)
              : observed.toISOString()
            : null;
        } else if (c.source.startsWith('data.')) {
          const name = c.source.slice(5);
          values[c.key] = Object.hasOwn(data, name) ? coerceScalar(data[name], c.type) : null;
        } else values[c.key] = null;
      }
      rows.push({
        athleteId: r.athlete_id,
        observedAt: observed ? dateInZone(observed, tz) : null,
        values,
      });
    }
  }
  return product.filters.length ? rows.filter((r) => matchesAll(r.values, product.filters)) : rows;
}
