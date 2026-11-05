/**
 * Unabhängige Prüfung der Audit-Hash-Kette im Programm (nicht mit audit_verify() der Datenbank).
 *
 * Hintergrund (ADR 0014, Nachtrag): audit_verify() und audit_digest_input() liegen in der Datenbank. Wer sie
 * besitzt (mesh_owner, Superuser), kann Trigger abschalten, Inhalte ändern, die Spalte hash stehen lassen und
 * audit_verify() durch eine Funktion ersetzen, die immer „intakt“ meldet. Ein Vergleich der Prüfpunkte der
 * Partner mit der gespeicherten Spalte hash bemerkte das nicht.
 *
 * Deshalb berechnet diese Prüfung jeden Hash aus den Rohspalten neu – Byte für Byte wie
 * audit_digest_input() (Version je Eintrag in digest_version, Migration 0620):
 *
 *   Version 1 (Einträge vor Migration 0620):
 *     concat_ws('|', seq::text, to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
 *               actor_type, coalesce(actor_id,''), coalesce(actor_label,''), action,
 *               coalesce(object_type,''), coalesce(object_id,''), outcome, details::text,
 *               coalesce(ip,''), coalesce(request_id,''), prev_hash)
 *     Mehrdeutig: ein '|' in einem Feld lässt sich auf das Nachbarfeld verschieben, null = ''.
 *   Version 2 (alle neuen Einträge):
 *     'osp-audit-digest@2' und je Feld (gleiche Reihenfolge) '|' + ('~' für null, sonst
 *     <UTF-8-Byte-Länge>:<Wert>) – eindeutig zerlegbar; die Kennung bindet die Version.
 *   hash = hex(sha256(utf8(input)))
 *
 * Die Datenbank liefert nur die Textform der Spalten (Zahl und jsonb über die eingebauten Typumwandlungen,
 * Zeitstempel über pg_catalog.to_char/timezone mit vollem Schemanamen, damit eigene Funktionen gleichen
 * Namens im Suchpfad nichts ändern; Typumwandlungen eingebauter Typen kann nur ein Superuser ändern).
 * Zusammensetzen und SHA-256 erfolgen hier. Geprüft wird:
 *  - Aufbau der Tabelle (pg_attribute): Spalten mit den eingebauten Typen und NOT NULL wie in Migration
 *    0001/0620 – sonst ließe sich z. B. über eine NULL in actor_type (concat_ws überspringt sie) oder einen
 *    anderen Spaltentyp die Textform verschieben
 *  - je Eintrag: Laufnummer lückenlos ab 1, actor_type/outcome aus den erlaubten Werten, Version 1 oder 2 und
 *    nie kleiner als die des Vorgängers, prev_hash = neu berechneter Hash des Vorgängers, hash = neu
 *    berechneter Hash
 * Für den Abgleich mit Prüfpunkten zählen nur die neu berechneten Hashes, nie die gespeicherte Spalte.
 *
 * Restrisiko Version 1: Bei alten Einträgen, deren Felder selbst '|' enthalten, kann der Eigentümer der
 * Datenbank Text zwischen benachbarten Feldern verschieben, ohne dass sich der Hash ändert. Ihre Zahl wird
 * gemeldet (digest.ambiguousV1).
 */
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { DbOrTx } from '../../core/db.ts';

/** Textform einer Zeile wie in audit_digest_input() */
export interface AuditDigestRow {
  seq: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  outcome: string;
  details: string;
  ip: string | null;
  request_id: string | null;
  prev_hash: string;
  /** Version der Hash-Eingabe (Migration 0620); fehlt = 1 */
  digest_version?: number;
}

export const GENESIS_HASH = '0'.repeat(64);
export const DIGEST_V2_TAG = 'osp-audit-digest@2';
export const ACTOR_TYPES: ReadonlySet<string> = new Set(['user', 'peer', 'system', 'anonymous']);
export const OUTCOMES: ReadonlySet<string> = new Set(['success', 'denied', 'error']);

/** Feld der Version 2: null → '~', sonst Byte-Länge (UTF-8), ':' und Wert (wie audit_digest_field()) */
export function digestFieldV2(v: string | null): string {
  return v === null ? '~' : `${Buffer.byteLength(v, 'utf8')}:${v}`;
}

function fields(r: AuditDigestRow, prevHash: string): (string | null)[] {
  return [
    r.seq,
    r.at,
    r.actor_type,
    r.actor_id,
    r.actor_label,
    r.action,
    r.object_type,
    r.object_id,
    r.outcome,
    r.details,
    r.ip,
    r.request_id,
    prevHash,
  ];
}

/** Eingabe des Hashes, identisch zu audit_digest_input() der jeweiligen Version */
export function auditDigestInput(r: AuditDigestRow, prevHash: string): string {
  const f = fields(r, prevHash);
  if ((r.digest_version ?? 1) === 2) return DIGEST_V2_TAG + f.map((v) => `|${digestFieldV2(v)}`).join('');
  return f.map((v) => v ?? '').join('|');
}

export function auditRowHash(r: AuditDigestRow, prevHash: string): string {
  return createHash('sha256').update(auditDigestInput(r, prevHash), 'utf8').digest('hex');
}

export type ChainBreak =
  /** Laufnummer fehlt oder ist doppelt/außer der Reihe */
  | 'seq_gap'
  /** prev_hash ist nicht der Hash des Vorgängers */
  | 'prev_hash_mismatch'
  /** gespeicherter Hash passt nicht zum Inhalt (Inhalt geändert) */
  | 'hash_mismatch'
  /** Einträge ohne Laufnummer (außerhalb der Kette eingefügt) */
  | 'unsequenced'
  /** public.audit_log ist keine gewöhnliche Tabelle (z. B. View) oder hat Zeilensicherheit */
  | 'not_a_table'
  /** Spalte fehlt, hat einen anderen Typ oder kein NOT NULL mehr (Aufbau verändert) */
  | 'column_changed'
  /** actor_type oder outcome außerhalb der erlaubten Werte */
  | 'invalid_value'
  /** unbekannte Version der Hash-Eingabe oder Rückfall auf eine ältere */
  | 'digest_version';

export interface ChainCheck {
  ok: boolean;
  /** geprüfte Einträge bis zum ersten Bruch */
  checked: number;
  firstBrokenSeq: number | null;
  breakKind: ChainBreak | null;
  /** letzte Laufnummer und deren neu berechneter Hash */
  headSeq: number | null;
  headHash: string | null;
  /** neu berechnete Hashes der angefragten Laufnummern (`want`) */
  hashes: Map<number, string>;
  /** Einträge je Version; ambiguousV1 = Einträge der Version 1 mit '|' in einem frei belegten Feld */
  digest: { v1: number; v2: number; ambiguousV1: number };
}

const BATCH = 5000;

/** Erwarteter Aufbau (Migration 0001/0620): eingebauter Typ, NOT NULL, keine berechnete Spalte */
const EXPECTED_COLUMNS: Record<string, { type: string; notNull: boolean }> = {
  seq: { type: 'int8', notNull: false },
  at: { type: 'timestamptz', notNull: true },
  actor_type: { type: 'text', notNull: true },
  actor_id: { type: 'text', notNull: false },
  actor_label: { type: 'text', notNull: false },
  action: { type: 'text', notNull: true },
  object_type: { type: 'text', notNull: false },
  object_id: { type: 'text', notNull: false },
  outcome: { type: 'text', notNull: true },
  details: { type: 'jsonb', notNull: true },
  ip: { type: 'text', notNull: false },
  request_id: { type: 'text', notNull: false },
  prev_hash: { type: 'text', notNull: true },
  hash: { type: 'text', notNull: true },
};
/** fehlt vor Migration 0620 (dann gelten alle Einträge als Version 1) */
const VERSION_COLUMN = { type: 'int2', notNull: true };

interface ColumnInfo {
  name: string;
  type: string;
  type_schema: string;
  typmod: number;
  not_null: boolean;
  generated: string;
}

/**
 * Prüft den Aufbau von public.audit_log über pg_attribute. null = passt (hasVersion: Spalte digest_version
 * vorhanden), sonst der Name der ersten abweichenden Spalte.
 */
export async function auditLogShape(
  db: DbOrTx,
): Promise<{ ok: true; hasVersion: boolean } | { ok: false; column: string }> {
  const r = await sql<ColumnInfo>`
    select a.attname::text as name, t.typname::text as type, tn.nspname::text as type_schema,
           a.atttypmod as typmod, a.attnotnull as not_null, a.attgenerated::text as generated
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_type t on t.oid = a.atttypid
      join pg_catalog.pg_namespace tn on tn.oid = t.typnamespace
     where n.nspname = 'public' and c.relname = 'audit_log' and a.attnum > 0 and not a.attisdropped`.execute(
    db,
  );
  const cols = new Map(r.rows.map((c) => [c.name, c]));
  const matches = (c: ColumnInfo | undefined, want: { type: string; notNull: boolean }) =>
    !!c &&
    c.type_schema === 'pg_catalog' &&
    c.type === want.type &&
    c.typmod === -1 &&
    c.generated === '' &&
    (!want.notNull || c.not_null);
  for (const [name, want] of Object.entries(EXPECTED_COLUMNS)) {
    if (!matches(cols.get(name), want)) return { ok: false, column: name };
  }
  const version = cols.get('digest_version');
  if (version && !matches(version, VERSION_COLUMN)) return { ok: false, column: 'digest_version' };
  return { ok: true, hasVersion: !!version };
}

/**
 * Einträge mit Laufnummer > afterSeq in der Textform von audit_digest_input() (aufsteigend). Eingebaute
 * Funktionen mit Schemanamen; Typumwandlungen wie in audit_digest_input(). hasVersion: Spalte
 * digest_version vorhanden (sonst ermittelt).
 */
export async function readAuditDigestRows(
  db: DbOrTx,
  afterSeq: number,
  limit: number,
  hasVersion?: boolean,
): Promise<(AuditDigestRow & { hash: string; digest_version: number })[]> {
  let withVersion = hasVersion;
  if (withVersion === undefined) {
    const shape = await auditLogShape(db);
    withVersion = shape.ok ? shape.hasVersion : false;
  }
  const version = withVersion ? sql`a.digest_version::int` : sql`1`;
  const r = await sql<AuditDigestRow & { hash: string; digest_version: number }>`
    select a.seq::text as seq,
           pg_catalog.to_char(pg_catalog.timezone('UTC'::text, a.at),
                              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'::text) as at,
           a.actor_type, a.actor_id, a.actor_label, a.action, a.object_type, a.object_id, a.outcome,
           a.details::text as details,
           a.ip, a.request_id, a.prev_hash, a.hash, ${version} as digest_version
      from public.audit_log a
     where a.seq > ${afterSeq}
     order by a.seq
     limit ${limit}`.execute(db);
  return r.rows;
}

/** Felder, die bei Version 1 frei belegten Text enthalten (Verschieben über '|' möglich) */
function ambiguousV1(r: AuditDigestRow): boolean {
  return [
    r.actor_id,
    r.actor_label,
    r.action,
    r.object_type,
    r.object_id,
    r.details,
    r.ip,
    r.request_id,
  ].some((v) => v?.includes('|'));
}

/**
 * Liest die Kette seitenweise und berechnet sie neu. `want`: Laufnummern, deren neu berechneter Hash
 * gebraucht wird (Prüfpunkte); nach einem Bruch werden weiter Hashes berechnet (Vorgänger = neu
 * berechneter Hash), damit Prüfpunkte hinter dem Bruch ebenfalls abweichen statt zu passen.
 */
export async function recomputeAuditChain(db: DbOrTx, want: Iterable<number> = []): Promise<ChainCheck> {
  const wanted = new Set(want);
  const out: ChainCheck = {
    ok: true,
    checked: 0,
    firstBrokenSeq: null,
    breakKind: null,
    headSeq: null,
    headHash: null,
    hashes: new Map(),
    digest: { v1: 0, v2: 0, ambiguousV1: 0 },
  };
  const broken = (seq: number, kind: ChainBreak) => {
    if (!out.ok) return;
    out.ok = false;
    out.firstBrokenSeq = seq;
    out.breakKind = kind;
  };

  const rel = await sql<{ relkind: string; relrowsecurity: boolean }>`
    select c.relkind::text as relkind, c.relrowsecurity
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'audit_log'`.execute(db);
  const kind = rel.rows[0];
  if (kind?.relkind !== 'r' || kind.relrowsecurity) {
    broken(0, 'not_a_table');
    return out;
  }
  const shape = await auditLogShape(db);
  if (!shape.ok) {
    broken(0, 'column_changed');
    return out;
  }

  let expectedSeq = 1;
  let prev = GENESIS_HASH;
  let lastVersion = 1;
  let after = 0;
  for (;;) {
    const page = await readAuditDigestRows(db, after, BATCH, shape.hasVersion);
    for (const r of page) {
      const seq = Number(r.seq);
      if (seq !== expectedSeq) {
        broken(seq, 'seq_gap');
        // weiter mit der vorgefundenen Laufnummer (spätere Prüfpunkte weichen ohnehin ab)
        expectedSeq = seq;
      }
      const version = Number(r.digest_version);
      if (version === 2) out.digest.v2++;
      else {
        out.digest.v1++;
        if (ambiguousV1(r)) out.digest.ambiguousV1++;
      }
      const hash = auditRowHash(r, prev);
      if ((version !== 1 && version !== 2) || version < lastVersion) broken(seq, 'digest_version');
      else if (!ACTOR_TYPES.has(r.actor_type) || !OUTCOMES.has(r.outcome)) broken(seq, 'invalid_value');
      else if (r.prev_hash !== prev) broken(seq, 'prev_hash_mismatch');
      else if (r.hash !== hash) broken(seq, 'hash_mismatch');
      if (out.ok) out.checked++;
      if (wanted.has(seq)) out.hashes.set(seq, hash);
      out.headSeq = seq;
      out.headHash = hash;
      prev = hash;
      lastVersion = Math.max(lastVersion, version);
      expectedSeq++;
    }
    if (page.length < BATCH) break;
    after = Number(page.at(-1)!.seq);
  }

  const stray = await sql<{ n: number }>`
    select count(*)::int as n from public.audit_log where seq is null`.execute(db);
  if ((stray.rows[0]?.n ?? 0) > 0) broken(out.headSeq ?? 0, 'unsequenced');
  return out;
}
