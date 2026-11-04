/**
 * Aufbewahrung und Löschung personenbezogener Importdaten.
 *
 * Personenbezogene Daten hält ein Importlauf nur im Status "previewed": vorgemerkte Zeilen
 * (import_run.staged), Vorschauzeilen (import_run.preview.rows) und Rohwerte im Fehlerprotokoll
 * (import_error.raw_value). Entfernt werden sie
 *  - vollständig bei Übernahme, Verwerfen und Ablauf (nach PREVIEW_RETENTION_DAYS Tagen; Hintergrundaufgabe),
 *  - für eine Person, sobald sie gelöscht wird (Ereignis athlete.deleted, in derselben Transaktion).
 * Danach bleiben Zähler, Prüfsumme, Spaltennamen und das Fehlerprotokoll aus Zeile, Feld und Code.
 *
 * Damit die Zeilen einer Person auch nach der Vorschau gefunden werden, speichert der Lauf in
 * staged.subjects je Zeile den Personenbezug: die zugeordnete Personen-ID oder – für noch unbekannte
 * Personen – gekürzte SHA-256-Werte von natürlichem Schlüssel und Kennung (keine Klartexte).
 */
import { sql } from 'kysely';
import type { Scalar } from '../../../shared/contract/common.ts';
import { SYSTEM_ACTOR } from '../../core/audit.ts';
import { sha256Hex } from '../../core/crypto.ts';
import type { DbOrTx, Tx } from '../../core/db.ts';
import type { Deps } from '../../core/deps.ts';
import { type MappedRow, naturalKeyOf, type RowStatus } from './pipeline.ts';

/** Nicht übernommene Vorschauen werden nach dieser Frist verworfen */
export const PREVIEW_RETENTION_DAYS = 7;
const RETENTION_INTERVAL_MS = 60 * 60_000;
const EXPIRE_BATCH = 200;
const CHUNK = 500;

export interface PreviewData {
  sourceColumns: string[];
  rows: {
    rowNumber: number;
    raw: Record<string, string | null>;
    mapped: Record<string, Scalar>;
    status: RowStatus;
  }[];
}

/** Personenbezug einer Quellzeile: r = Zeile, a = Personen-ID, k/e = Hash von natürlichem Schlüssel/Kennung */
export interface RowSubject {
  r: number;
  a?: string;
  k?: string;
  e?: string;
}

/** Inhalt von import_run.staged */
export interface StagedRun<T> {
  rows: T[];
  subjects: RowSubject[];
}

interface StagedRowBase {
  rowNumber: number;
  athleteId: string | null;
}

/** Vorschauzeilen (Rohwerte mit Personenbezug) entfernen; Spaltennamen bleiben */
export const CLEARED_PREVIEW = sql`jsonb_set(coalesce(preview, '{}'::jsonb), '{rows}', '[]'::jsonb)`;

const subjectHash = (kind: 'n' | 'e', value: string) => sha256Hex(`${kind}\u0000${value}`).slice(0, 32);
export const naturalSubjectKey = (naturalKey: string) => subjectHash('n', naturalKey);
export const externalSubjectKey = (system: string, value: string) =>
  subjectHash('e', `${system}\u0000${value}`);

/** Personenbezug aller Zeilen (auch fehlerhafter) für die spätere Löschung einzelner Personen */
export function subjectsOf(rows: readonly MappedRow[], identifierSystem: string): RowSubject[] {
  const out: RowSubject[] = [];
  for (const row of rows) {
    if (row.athleteId) {
      out.push({ r: row.rowNumber, a: row.athleteId });
      continue;
    }
    const s: RowSubject = { r: row.rowNumber };
    if (row.naturalKey) s.k = naturalSubjectKey(row.naturalKey);
    if (row.externalId) s.e = externalSubjectKey(identifierSystem, row.externalId);
    if (s.k || s.e) out.push(s);
  }
  return out;
}

/** Personenbezug einer vorgemerkten Zeile im früheren Format (ohne subjects) */
function legacySubject(row: StagedRowBase): RowSubject | null {
  if (row.athleteId) return { r: row.rowNumber, a: row.athleteId };
  // neue Person (Ziel Athletenkern): natürlicher Schlüssel und Kennung aus den vorgemerkten Werten
  const { values, identifier } = row as StagedRowBase & {
    values?: Record<string, unknown>;
    identifier?: { system: string; value: string } | null;
  };
  const s: RowSubject = { r: row.rowNumber };
  const [last, first, dob] = [values?.last_name, values?.first_name, values?.date_of_birth];
  if (typeof last === 'string' && typeof first === 'string' && typeof dob === 'string') {
    s.k = naturalSubjectKey(naturalKeyOf(last, first, dob));
  }
  if (identifier) s.e = externalSubjectKey(identifier.system, identifier.value);
  return s.k || s.e ? s : null;
}

/** import_run.staged lesen (auch das frühere Format: nur das Array der vorgemerkten Zeilen) */
export function readStaged<T extends StagedRowBase>(raw: unknown): StagedRun<T> {
  if (raw === null || raw === undefined) return { rows: [], subjects: [] };
  if (Array.isArray(raw)) {
    const rows = raw as T[];
    return { rows, subjects: rows.map(legacySubject).filter((x): x is RowSubject => x !== null) };
  }
  const o = raw as Partial<StagedRun<T>>;
  return { rows: o.rows ?? [], subjects: o.subjects ?? [] };
}

/** Zeilen aus vorgemerkten Zeilen, Personenbezug und Vorschau entfernen (rein, ohne Datenbank) */
export function withoutRows<T extends StagedRowBase>(
  staged: StagedRun<T>,
  preview: PreviewData['rows'],
  rows: ReadonlySet<number>,
): { staged: StagedRun<T>; preview: PreviewData['rows']; removedStaged: number[] } {
  return {
    staged: {
      rows: staged.rows.filter((s) => !rows.has(s.rowNumber)),
      subjects: staged.subjects.filter((s) => !rows.has(s.r)),
    },
    preview: preview.filter((p) => !rows.has(p.rowNumber)),
    removedStaged: staged.rows.filter((s) => rows.has(s.rowNumber)).map((s) => s.rowNumber),
  };
}

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Rohwerte im Fehlerprotokoll leeren (ganze Läufe oder einzelne Zeilen eines Laufs) */
export async function clearRawValues(db: DbOrTx, runIds: readonly string[], rowNumbers?: readonly number[]) {
  if (runIds.length === 0) return;
  if (rowNumbers) {
    for (const chunk of chunks(rowNumbers)) {
      await db
        .updateTable('import_error')
        .set({ raw_value: null })
        .where('run_id', 'in', runIds)
        .where('row_number', 'in', chunk)
        .where('raw_value', 'is not', null)
        .execute();
    }
    return;
  }
  for (const chunk of chunks(runIds)) {
    await db
      .updateTable('import_error')
      .set({ raw_value: null })
      .where('run_id', 'in', chunk)
      .where('raw_value', 'is not', null)
      .execute();
  }
}

/** Hinweis im Fehlerprotokoll: vorgemerkte Zeilen, die vor der Übernahme entfallen (Person gelöscht) */
export async function recordVanished(
  db: DbOrTx,
  runId: string,
  rowNumbers: readonly number[],
  phase: string,
) {
  for (const chunk of chunks(rowNumbers, 1000)) {
    await db
      .insertInto('import_error')
      .values(
        chunk.map((rowNumber) => ({
          run_id: runId,
          row_number: rowNumber,
          field: null,
          code: 'athlete_not_found',
          severity: 'warning' as const,
          raw_value: null,
          params: JSON.stringify({ phase }),
        })),
      )
      .execute();
  }
}

// ---------------------------------------------------------------------------------------------
// Löschung einer Person (Art. 17 DSGVO)
// ---------------------------------------------------------------------------------------------

/**
 * Entfernt eine Person aus allen offenen Importläufen: vorgemerkte Zeilen (keine Übernahme mehr),
 * Vorschauzeilen und Rohwerte ihrer Zeilen im Fehlerprotokoll. Läuft in der Transaktion der Löschung,
 * solange Person und Kennungen noch vorhanden sind.
 */
export async function eraseSubjectFromRuns(deps: Deps, trx: Tx, athleteId: string): Promise<void> {
  const person = await trx
    .selectFrom('athlete')
    .select(['last_name', 'first_name', 'date_of_birth'])
    .where('id', '=', athleteId)
    .executeTakeFirst();
  const identifiers = await trx
    .selectFrom('athlete_identifier')
    .select(['system', 'value'])
    .where('athlete_id', '=', athleteId)
    .execute();
  const naturalKeys = new Set(
    person
      ? [naturalSubjectKey(naturalKeyOf(person.last_name, person.first_name, person.date_of_birth))]
      : [],
  );
  const externalKeys = new Set(identifiers.map((i) => externalSubjectKey(i.system, i.value)));
  const patterns = [
    { a: athleteId },
    ...[...naturalKeys].map((k) => ({ k })),
    ...[...externalKeys].map((e) => ({ e })),
  ].map((p) => JSON.stringify([p]));

  const runs = await trx
    .selectFrom('import_run')
    .select(['id', 'connector_id', 'staged', 'preview'])
    .where('status', '=', 'previewed')
    .where((eb) =>
      eb.or([
        sql<boolean>`jsonb_typeof(staged) = 'array'`,
        ...patterns.map((p) => sql<boolean>`staged->'subjects' @> ${p}::jsonb`),
      ]),
    )
    .orderBy('id')
    .forUpdate()
    .execute();

  const matches = (s: RowSubject) =>
    s.a === athleteId ||
    (s.k !== undefined && naturalKeys.has(s.k)) ||
    (s.e !== undefined && externalKeys.has(s.e));

  for (const run of runs) {
    // früheres Format ohne Personenbezug je Zeile: Fehler- und Vorschauzeilen sind nicht zuzuordnen,
    // daher vorsorglich die ganze Vorschau und alle Rohwerte leeren (vorgemerkte Zeilen bleiben)
    const legacy = Array.isArray(run.staged);
    const staged = readStaged<StagedRowBase>(run.staged);
    const rows = new Set(staged.subjects.filter(matches).map((s) => s.r));
    if (rows.size === 0 && !legacy) continue;
    const stored = (run.preview ?? {}) as Partial<PreviewData>;
    const next = withoutRows(staged, legacy ? [] : (stored.rows ?? []), rows);
    await trx
      .updateTable('import_run')
      .set({
        staged: JSON.stringify(next.staged),
        preview: JSON.stringify({ ...stored, rows: next.preview }),
      })
      .where('id', '=', run.id)
      .execute();
    await clearRawValues(trx, [run.id], legacy ? undefined : [...rows]);
    await recordVanished(trx, run.id, next.removedStaged, 'erasure');
    await deps.audit.record(
      {
        actor: SYSTEM_ACTOR,
        action: 'import.erase',
        objectType: 'import_run',
        objectId: run.id,
        details: {
          connectorId: run.connector_id,
          athleteId,
          rows: rows.size,
          staged: next.removedStaged.length,
          ...(legacy ? { legacy: true } : {}),
        },
      },
      trx,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Ablauf nicht übernommener Vorschauen
// ---------------------------------------------------------------------------------------------

async function expireBatch(deps: Deps): Promise<number> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - PREVIEW_RETENTION_DAYS * 86_400_000);
  return deps.db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom('import_run')
      .select(['id', 'connector_id'])
      .where('status', '=', 'previewed')
      .where('created_at', '<', cutoff)
      .orderBy('created_at')
      .limit(EXPIRE_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    if (due.length === 0) return 0;
    const ids = due.map((r) => r.id);
    await trx
      .updateTable('import_run')
      .set({ status: 'discarded', staged: null, preview: CLEARED_PREVIEW, finished_at: now })
      .where('id', 'in', ids)
      .execute();
    await clearRawValues(trx, ids);
    for (const r of due) {
      await deps.audit.record(
        {
          actor: SYSTEM_ACTOR,
          action: 'import.expire',
          objectType: 'import_run',
          objectId: r.id,
          details: { connectorId: r.connector_id, retentionDays: PREVIEW_RETENTION_DAYS },
        },
        trx,
      );
    }
    return due.length;
  });
}

/** Verwirft Vorschauen, die älter als PREVIEW_RETENTION_DAYS sind (leert Zeilen, Vorschau, Rohwerte). */
export async function expireStalePreviews(deps: Deps): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await expireBatch(deps);
    total += n;
    if (n < EXPIRE_BATCH) return total;
  }
}

const timers = new Set<ReturnType<typeof setInterval>>();

/** Hintergrundaufgabe: sofort und danach stündlich */
export async function startRetention(deps: Deps): Promise<void> {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const expired = await expireStalePreviews(deps);
      if (expired > 0) deps.log.info('import previews expired', { count: expired });
    } catch (err) {
      deps.log.error('import retention failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), RETENTION_INTERVAL_MS);
  t.unref?.();
  timers.add(t);
  await tick();
}

export function stopRetention(): void {
  for (const t of timers) clearInterval(t);
  timers.clear();
}
