import { z } from 'zod';
import {
  DataCategory,
  FieldType,
  IdParam,
  IsoDateTime,
  Pagination,
  paginated,
  Scalar,
  Shareability,
  Slug,
  Uuid,
} from './common.ts';
import { route } from './route.ts';

export const FieldName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);

/** Felddefinition eines Datensatzes inkl. Format- und Plausibilitätsregeln. */
export const FieldDef = z.object({
  name: FieldName,
  label: z.string().min(1).max(200),
  type: FieldType,
  unit: z.string().max(32).optional(),
  required: z.boolean().default(false),
  /** Plausibilitätsgrenzen für integer/number (inklusive) */
  min: z.number().optional(),
  max: z.number().optional(),
  /** zulässige Werte bei type = enum */
  enumValues: z.array(z.string().min(1).max(100)).optional(),
  description: z.string().max(1000).optional(),
});
export type FieldDef = z.infer<typeof FieldDef>;

export const DatasetInput = z.object({
  slug: Slug,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  category: DataCategory,
  /** Besondere Kategorie personenbezogener Daten (Art. 9 DSGVO); bei category=health immer true */
  specialCategory: z.boolean().default(false),
  shareability: Shareability.default('on_request'),
  fields: z.array(FieldDef).min(1).max(100),
  /** Fachlicher Schlüssel (zusätzlich zur Person) für Aktualisierung statt Duplikat */
  keyFields: z.array(FieldName).default([]),
  /** Feld mit Mess-/Beobachtungsdatum (date oder datetime) */
  observedAtField: FieldName.nullable().default(null),
  ownerContact: z.string().max(200).default(''),
});
export type DatasetInput = z.infer<typeof DatasetInput>;

export const Dataset = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  category: DataCategory,
  specialCategory: z.boolean(),
  shareability: Shareability,
  version: z.number().int(),
  fields: z.array(FieldDef),
  keyFields: z.array(z.string()),
  observedAtField: z.string().nullable(),
  ownerContact: z.string(),
  recordCount: z.number().int(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Dataset = z.infer<typeof Dataset>;

export const DatasetRecord = z.object({
  id: Uuid,
  athleteId: Uuid,
  athleteName: z.string(),
  observedAt: IsoDateTime.nullable(),
  data: z.record(z.string(), Scalar),
  importRunId: Uuid.nullable(),
  updatedAt: IsoDateTime,
});

export const datasetRoutes = {
  'datasets.list': route({
    method: 'GET',
    path: '/api/v1/datasets',
    auth: ['data_steward'],
    summary: 'Datensätze (Strukturen) auflisten',
    tag: 'Datensätze',
    response: z.object({ items: z.array(Dataset) }),
  }),
  'datasets.get': route({
    method: 'GET',
    path: '/api/v1/datasets/:id',
    auth: ['data_steward'],
    summary: 'Datensatz mit Feldern',
    tag: 'Datensätze',
    params: IdParam,
    response: Dataset,
  }),
  'datasets.create': route({
    method: 'POST',
    path: '/api/v1/datasets',
    auth: ['data_steward'],
    summary: 'Datensatz anlegen',
    tag: 'Datensätze',
    body: DatasetInput,
    response: Dataset,
  }),
  'datasets.update': route({
    method: 'PATCH',
    path: '/api/v1/datasets/:id',
    auth: ['data_steward'],
    summary: 'Datensatz ändern (Feldänderungen erhöhen die Version)',
    tag: 'Datensätze',
    params: IdParam,
    body: DatasetInput.omit({ slug: true }).partial(),
    response: Dataset,
  }),
  'datasets.records': route({
    method: 'GET',
    path: '/api/v1/datasets/:id/records',
    auth: ['data_steward'],
    summary: 'Einträge eines Datensatzes (Zugriff wird protokolliert)',
    tag: 'Datensätze',
    params: IdParam,
    query: Pagination,
    response: paginated(DatasetRecord),
  }),
} as const;
