import { z } from 'zod';
import {
  ColumnDef,
  Condition,
  DataCategory,
  ExportFormat,
  FieldType,
  IdParam,
  IsoDate,
  IsoDateTime,
  PurposeCode,
  RecipientRole,
  Scalar,
  Shareability,
  Slug,
  Uuid,
} from './common.ts';
import { route } from './route.ts';

/** Felder des Athletenkerns, die in Datenprodukten verwendet werden können. */
export const ATHLETE_SOURCE_FIELDS = [
  { source: 'athlete.last_name', label: 'Nachname', type: 'string' },
  { source: 'athlete.first_name', label: 'Vorname', type: 'string' },
  { source: 'athlete.date_of_birth', label: 'Geburtsdatum', type: 'date' },
  { source: 'athlete.birth_year', label: 'Geburtsjahr', type: 'integer' },
  { source: 'athlete.sport', label: 'Sportart', type: 'string' },
  { source: 'athlete.squad_status', label: 'Kaderstatus', type: 'string' },
  { source: 'athlete.sex', label: 'Geschlecht', type: 'string' },
  { source: 'athlete.club', label: 'Verein', type: 'string' },
  { source: 'athlete.discipline', label: 'Disziplin', type: 'string' },
] as const satisfies readonly { source: string; label: string; type: z.infer<typeof FieldType> }[];

/**
 * Quelle einer Produktspalte:
 *  - athlete.<feld>        Athletenkern (siehe ATHLETE_SOURCE_FIELDS)
 *  - record.observed_at    Mess-/Beobachtungsdatum des Eintrags (nur bei sourceType=dataset)
 *  - data.<feld>           Feld des Datensatzes (nur bei sourceType=dataset)
 */
export const ColumnSource = z
  .string()
  .regex(
    /^(athlete\.(last_name|first_name|date_of_birth|birth_year|sport|squad_status|sex|club|discipline)|record\.observed_at|data\.[a-z][a-z0-9_]{0,40})$/,
  );

export const ProductColumn = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  label: z.string().min(1).max(200),
  source: ColumnSource,
});
export type ProductColumn = z.infer<typeof ProductColumn>;

export const ProductInput = z.object({
  slug: Slug,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  sourceType: z.enum(['athletes', 'dataset']),
  datasetId: Uuid.nullable().default(null),
  columns: z.array(ProductColumn).min(1).max(100),
  /** Basisfilter des Produkts (UND-verknüpft, auf Produktspalten) */
  filters: z.array(Condition).max(20).default([]),
  shareability: Shareability.default('on_request'),
});
export type ProductInput = z.infer<typeof ProductInput>;

/**
 * Änderbare Felder eines Produkts. Bewusst ohne Defaults: fehlende Felder bleiben unverändert
 * (ProductInput.partial() würde Defaults wie filters=[] einsetzen und so Filter stillschweigend entfernen).
 */
export const ProductUpdateInput = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000),
    columns: z.array(ProductColumn).min(1).max(100),
    filters: z.array(Condition).max(20),
    shareability: Shareability,
  })
  .partial();
export type ProductUpdateInput = z.infer<typeof ProductUpdateInput>;

export const Product = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  sourceType: z.enum(['athletes', 'dataset']),
  datasetId: Uuid.nullable(),
  datasetName: z.string().nullable(),
  category: DataCategory,
  specialCategory: z.boolean(),
  shareability: Shareability,
  /** Spalten mit aufgelöstem Typ/Einheit */
  columns: z.array(ProductColumn.extend({ type: FieldType, unit: z.string().optional() })),
  filters: z.array(Condition),
  version: z.number().int(),
  status: z.enum(['active', 'retired']),
  activeReleaseCount: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Product = z.infer<typeof Product>;

/**
 * Vollständige Statistik (nur für Datenverantwortliche: products.preview, releases.preview). Enthält
 * Angaben über Zeilen außerhalb der Freigabe, z. B. wie viele Personen keine Einwilligung haben.
 */
export const DataStats = z.object({
  /** Zeilen des Produkts vor Anwendung der Freigabe */
  total: z.number().int(),
  returned: z.number().int(),
  excludedByFilter: z.number().int(),
  excludedByTime: z.number().int(),
  excludedByConsent: z.number().int(),
});

/** Ergebnis der Vorschau für Datenverantwortliche (mit vollständiger Statistik) */
export const DataResult = z.object({
  columns: z.array(ColumnDef),
  rows: z.array(z.record(z.string(), Scalar)),
  stats: DataStats,
});
export type DataResult = z.infer<typeof DataResult>;

/**
 * Ergebnis eines Datenabrufs durch Empfänger (access.data): nur die gelieferten Zeilen und deren Anzahl.
 * Keine Angaben über Zeilen außerhalb der Freigabe (Gesamtzahl, Ausschlüsse nach Filter, Zeitraum oder
 * fehlender Einwilligung) – sie verrieten etwa, für wie viele Personen keine Einwilligung vorliegt.
 */
export const AccessDataResult = z.object({
  columns: z.array(ColumnDef),
  rows: z.array(z.record(z.string(), Scalar)),
  stats: z.object({ returned: z.number().int() }),
});
export type AccessDataResult = z.infer<typeof AccessDataResult>;

export const AccessGrant = z.object({
  releaseId: Uuid,
  recipientRole: RecipientRole,
  product: z.object({
    id: Uuid,
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    category: DataCategory,
    specialCategory: z.boolean(),
  }),
  purposes: z.array(PurposeCode),
  columns: z.array(ColumnDef),
  validFrom: IsoDateTime,
  validUntil: IsoDateTime.nullable(),
  dataFrom: IsoDate.nullable(),
  dataUntil: IsoDate.nullable(),
  requiresConsent: z.boolean(),
});
export type AccessGrant = z.infer<typeof AccessGrant>;

export const productRoutes = {
  'products.list': route({
    method: 'GET',
    path: '/api/v1/products',
    auth: ['data_steward'],
    summary: 'Datenprodukte auflisten',
    tag: 'Datenprodukte',
    response: z.object({ items: z.array(Product) }),
  }),
  'products.get': route({
    method: 'GET',
    path: '/api/v1/products/:id',
    auth: ['data_steward'],
    summary: 'Datenprodukt',
    tag: 'Datenprodukte',
    params: IdParam,
    response: Product,
  }),
  'products.create': route({
    method: 'POST',
    path: '/api/v1/products',
    auth: ['data_steward'],
    summary: 'Datenprodukt definieren',
    tag: 'Datenprodukte',
    body: ProductInput,
    response: Product,
  }),
  'products.update': route({
    method: 'PATCH',
    path: '/api/v1/products/:id',
    auth: ['data_steward'],
    summary:
      'Datenprodukt ändern (Änderung an Spalten/Filtern erhöht die Version; bestehende Freigaben müssen neu bestätigt werden)',
    tag: 'Datenprodukte',
    params: IdParam,
    body: ProductUpdateInput,
    response: Product,
  }),
  'products.retire': route({
    method: 'POST',
    path: '/api/v1/products/:id/retire',
    auth: ['data_steward'],
    summary: 'Datenprodukt stilllegen (alle Zugriffe enden)',
    tag: 'Datenprodukte',
    params: IdParam,
    response: Product,
  }),
  'products.preview': route({
    method: 'GET',
    path: '/api/v1/products/:id/preview',
    auth: ['data_steward'],
    summary: 'Vorschau des ungefilterten Produkts für Datenverantwortliche (protokolliert)',
    tag: 'Datenprodukte',
    params: IdParam,
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
    response: DataResult,
  }),
  'access.list': route({
    method: 'GET',
    path: '/api/v1/access',
    auth: 'authenticated',
    summary: 'Für die eigenen Rollen freigegebene Datenprodukte',
    tag: 'Datenzugriff',
    response: z.object({ items: z.array(AccessGrant) }),
  }),
  'access.data': route({
    method: 'GET',
    path: '/api/v1/access/:id/data',
    auth: 'authenticated',
    summary:
      'Daten eines freigegebenen Produkts abrufen (JSON, CSV oder XML); Zweck ist Pflicht; nur freigegebene Zeilen und Spalten',
    tag: 'Datenzugriff',
    params: IdParam,
    query: z.object({
      purpose: PurposeCode,
      format: ExportFormat.default('json'),
      limit: z.coerce.number().int().min(1).max(100000).optional(),
    }),
    response: AccessDataResult,
    download: true,
  }),
} as const;
