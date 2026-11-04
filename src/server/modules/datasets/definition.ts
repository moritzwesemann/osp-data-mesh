/**
 * Datensatz-Strukturen: Prüfung von Definitionen (reine Funktionen), Abbildung DB → API und Anlage
 * (auch vom Modul "connectors" beim Import einer Connector-Definition genutzt).
 */
import type { Dataset, DatasetInput, FieldDef } from '../../../shared/contract/datasets.ts';
import type { Actor, AuditWriter } from '../../core/audit.ts';
import { type DbOrTx, isoReq, pgCode } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';
import { conflict, invalid } from '../../core/errors.ts';

/**
 * Prüft eine Datensatz-Definition. Liefert die normalisierte Definition (Gesundheitsdaten sind immer
 * besondere Kategorie) oder wirft validation_failed mit Feldcodes.
 */
export function validateDatasetInput(input: DatasetInput, prefix = 'body'): DatasetInput {
  const errors: Record<string, string> = {};
  const p = (path: string) => (prefix ? `${prefix}.${path}` : path);
  const byName = new Map<string, FieldDef>();
  input.fields.forEach((f, i) => {
    if (byName.has(f.name)) errors[p(`fields.${i}.name`)] = 'duplicate';
    else byName.set(f.name, f);
    if (f.type === 'enum') {
      if (!f.enumValues || f.enumValues.length === 0) errors[p(`fields.${i}.enumValues`)] = 'required';
      else if (new Set(f.enumValues).size !== f.enumValues.length) {
        errors[p(`fields.${i}.enumValues`)] = 'duplicate';
      }
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      errors[p(`fields.${i}.min`)] = 'greater_than_max';
    }
  });
  const seenKeys = new Set<string>();
  input.keyFields.forEach((k, i) => {
    if (!byName.has(k)) errors[p(`keyFields.${i}`)] = 'unknown_field';
    else if (seenKeys.has(k)) errors[p(`keyFields.${i}`)] = 'duplicate';
    seenKeys.add(k);
  });
  if (input.observedAtField) {
    const f = byName.get(input.observedAtField);
    if (!f) errors[p('observedAtField')] = 'unknown_field';
    else if (f.type !== 'date' && f.type !== 'datetime') errors[p('observedAtField')] = 'invalid_type';
  }
  if (Object.keys(errors).length > 0) throw invalid(errors);
  return { ...input, specialCategory: input.category === 'health' ? true : input.specialCategory };
}

/**
 * Sobald Einträge existieren, dürfen Felder nur ergänzt oder umbenannt (Label/Beschreibung) bzw. in ihren
 * Prüfregeln (Pflicht, Grenzen) angepasst werden. Entfernen, Typ- oder Einheitenwechsel und das Streichen
 * von Enum-Werten würden vorhandene Einträge ungültig machen.
 */
export function isCompatibleFieldChange(
  oldFields: readonly FieldDef[],
  newFields: readonly FieldDef[],
): boolean {
  for (const before of oldFields) {
    const after = newFields.find((f) => f.name === before.name);
    if (!after) return false;
    if (after.type !== before.type) return false;
    if ((after.unit ?? '') !== (before.unit ?? '')) return false;
    if (before.type === 'enum' && !(before.enumValues ?? []).every((v) => after.enumValues?.includes(v))) {
      return false;
    }
  }
  return true;
}

/** true, wenn sich die Struktur (Felder, Schlüssel, Beobachtungsdatum) geändert hat → neue Version */
export function structureChanged(
  before: Pick<DatasetInput, 'fields' | 'keyFields' | 'observedAtField'>,
  after: Pick<DatasetInput, 'fields' | 'keyFields' | 'observedAtField'>,
): boolean {
  return (
    canonicalJson(before.fields) !== canonicalJson(after.fields) ||
    canonicalJson(before.keyFields) !== canonicalJson(after.keyFields) ||
    (before.observedAtField ?? null) !== (after.observedAtField ?? null)
  );
}

/** JSON mit sortierten Objektschlüsseln (ohne undefined) für deterministische Vergleiche */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function toDataset(r: Row<'dataset'>, recordCount: number): Dataset {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    category: r.category as Dataset['category'],
    specialCategory: r.special_category,
    shareability: r.shareability as Dataset['shareability'],
    version: r.version,
    fields: r.fields as FieldDef[],
    keyFields: r.key_fields,
    observedAtField: r.observed_at_field,
    ownerContact: r.owner_contact,
    recordCount,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

/** Portable Definition eines vorhandenen Datensatzes (für Connector-Export) */
export function datasetInputOf(r: Row<'dataset'>): DatasetInput {
  return {
    slug: r.slug,
    name: r.name,
    description: r.description,
    category: r.category as DatasetInput['category'],
    specialCategory: r.special_category,
    shareability: r.shareability as DatasetInput['shareability'],
    fields: r.fields as FieldDef[],
    keyFields: r.key_fields,
    observedAtField: r.observed_at_field,
    ownerContact: r.owner_contact,
  };
}

export interface AuditContext {
  audit: AuditWriter;
  actor: Actor;
  userId: string | null;
  ip: string | null;
  requestId: string | null;
}

/** Legt einen Datensatz an (innerhalb der Transaktion des Aufrufers, inkl. Audit-Eintrag). */
export async function createDataset(
  trx: DbOrTx,
  raw: DatasetInput,
  ctx: AuditContext,
  prefix = 'body',
): Promise<Row<'dataset'>> {
  const input = validateDatasetInput(raw, prefix);
  const row = await trx
    .insertInto('dataset')
    .values({
      slug: input.slug,
      name: input.name,
      description: input.description,
      category: input.category,
      special_category: input.specialCategory,
      shareability: input.shareability,
      fields: JSON.stringify(input.fields),
      key_fields: input.keyFields,
      observed_at_field: input.observedAtField,
      owner_contact: input.ownerContact,
      created_by: ctx.userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
    .catch((err) => {
      if (pgCode(err) === '23505') throw conflict('slug_exists');
      throw err;
    });
  await ctx.audit.record(
    {
      actor: ctx.actor,
      action: 'dataset.create',
      objectType: 'dataset',
      objectId: row.id,
      details: {
        slug: row.slug,
        category: row.category,
        specialCategory: row.special_category,
        fields: input.fields.length,
      },
      ip: ctx.ip,
      requestId: ctx.requestId,
    },
    trx,
  );
  return row;
}
