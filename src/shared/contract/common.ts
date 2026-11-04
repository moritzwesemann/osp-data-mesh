/**
 * Gemeinsame Typen des HTTP-Vertrags. Wird von Server und Web-Oberfläche genutzt.
 * Änderungen hier sind Vertragsänderungen: abwärtskompatibel halten.
 */
import { z } from 'zod';

export const ROLES = ['admin', 'data_steward', 'analyst', 'coach', 'auditor'] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/** Empfängerrollen für lokale Freigaben. "bi" ist die technische Rolle der BI-Schnittstelle. */
export const RECIPIENT_ROLES = ['analyst', 'coach', 'data_steward', 'auditor', 'bi'] as const;
export const RecipientRole = z.enum(RECIPIENT_ROLES);
export type RecipientRole = z.infer<typeof RecipientRole>;

export const SQUAD_STATUSES = ['OK', 'PK', 'EK', 'NK1', 'NK2', 'LK', 'none'] as const;
export const SquadStatus = z.enum(SQUAD_STATUSES);
export type SquadStatus = z.infer<typeof SquadStatus>;

export const DATA_CATEGORIES = [
  'master',
  'performance',
  'training',
  'health',
  'competition',
  'other',
] as const;
export const DataCategory = z.enum(DATA_CATEGORIES);
export type DataCategory = z.infer<typeof DataCategory>;

export const Shareability = z.enum(['internal', 'on_request']);
export type Shareability = z.infer<typeof Shareability>;

export const Uuid = z.uuid();
export const IsoDate = z.iso.date(); // YYYY-MM-DD
export const IsoDateTime = z.iso.datetime({ offset: true });
export const Slug = z.string().regex(/^[a-z][a-z0-9_]{1,50}$/);
export const PurposeCode = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);

/** Skalarer Wert in Datenprodukten und Datensätzen. Datumswerte als ISO-String. */
export const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof Scalar>;

export const FIELD_TYPES = ['string', 'integer', 'number', 'date', 'datetime', 'boolean', 'enum'] as const;
export const FieldType = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof FieldType>;

/** Spaltenbeschreibung, wie sie Empfänger (lokal oder Partner) sehen. */
export const ColumnDef = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  type: FieldType,
  unit: z.string().max(32).optional(),
});
export type ColumnDef = z.infer<typeof ColumnDef>;

/** Zeilenbedingung (UND-verknüpft) für Basisfilter von Produkten und Zeilenbeschränkungen von Freigaben. */
export const ConditionOp = z.enum([
  'eq',
  'neq',
  'in',
  'nin',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_null',
  'not_null',
]);
export type ConditionOp = z.infer<typeof ConditionOp>;
export const Condition = z.object({
  column: z.string().min(1).max(64),
  op: ConditionOp,
  value: z.union([Scalar, z.array(z.union([z.string(), z.number(), z.boolean()]))]).optional(),
});
export type Condition = z.infer<typeof Condition>;

export const Pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});

export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  });
}

export const IdParam = z.object({ id: Uuid });
export const Ok = z.object({ ok: z.literal(true) });

export const ExportFormat = z.enum(['json', 'csv', 'xml']);
export type ExportFormat = z.infer<typeof ExportFormat>;

/**
 * Fehlercodes der API. Die Oberfläche übersetzt ausschließlich diese Codes (nie Server-Freitext).
 */
export const ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'csrf_failed',
  'not_found',
  'conflict',
  'rate_limited',
  'account_locked',
  'invalid_credentials',
  'password_too_weak',
  'payload_too_large',
  'unsupported_format',
  'import_failed',
  'source_unreachable',
  'source_not_allowed',
  'release_invalid',
  'access_denied',
  'peer_unreachable',
  'peer_rejected',
  'peer_untrusted',
  'signature_invalid',
  'backup_failed',
  'internal_error',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    requestId: z.string(),
    /** Optionaler maschinenlesbarer Detailgrund, z. B. Ablehnungsgrund einer Freigabeprüfung. */
    reason: z.string().optional(),
    /** Feldfehler bei validation_failed (Pfad → Code). */
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
