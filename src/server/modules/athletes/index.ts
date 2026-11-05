/**
 * Modul "athletes": Athletenkern (Stammdaten), externe Kennungen, Einwilligungen, Zweck-Vokabular.
 *
 * Löschen einer Person ist die Umsetzung des Rechts auf Löschung (Art. 17 DSGVO): alle zugehörigen
 * Einträge (Datensätze, Einwilligungen, Kennungen) werden per Fremdschlüssel-Kaskade entfernt; das
 * Ereignis "athlete.deleted" läuft in derselben Transaktion, solange Person und Kennungen noch lesbar
 * sind (Löschmitteilungen an Partner, BI-Zeilen, Zeilen der Person in offenen Importvorschauen).
 */
import { sql } from 'kysely';
import { pgCode } from '../../core/db.ts';
import type { RowUpdate } from '../../core/db-types.ts';
import type { Module } from '../../core/deps.ts';
import { conflict, invalid, notFound } from '../../core/errors.ts';
import { registerRoutes } from '../../core/http.ts';
import { lockDeliveries } from '../../core/locks.ts';
import { writeTx } from '../../core/tx.ts';
import { likeEscape, toAthlete, toConsent } from './mappers.ts';

const ATHLETE_COLUMNS = {
  lastName: 'last_name',
  firstName: 'first_name',
  dateOfBirth: 'date_of_birth',
  sport: 'sport',
  squadStatus: 'squad_status',
  sex: 'sex',
  club: 'club',
  discipline: 'discipline',
} as const;

function uniqueViolation(err: unknown): never {
  if (pgCode(err) === '23505') throw conflict('athlete_exists');
  throw err;
}

export const athletesModule: Module = {
  name: 'athletes',
  routes(app, deps) {
    registerRoutes(app, deps, {
      'athletes.list': async ({ query, actor, ip, requestId }) => {
        let base = deps.db.selectFrom('athlete');
        const terms = (query.q ?? '')
          .split(/[\s,]+/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 5);
        for (const term of terms) {
          const pattern = `%${likeEscape(term)}%`;
          base = base.where((eb) =>
            eb.or([
              eb('athlete.last_name', 'ilike', pattern),
              eb('athlete.first_name', 'ilike', pattern),
              eb.exists(
                eb
                  .selectFrom('athlete_identifier as ai')
                  .select(sql<number>`1`.as('one'))
                  .whereRef('ai.athlete_id', '=', 'athlete.id')
                  .where('ai.value', 'ilike', pattern),
              ),
            ]),
          );
        }
        if (query.sport) base = base.where('athlete.sport', '=', query.sport);
        if (query.squadStatus) base = base.where('athlete.squad_status', '=', query.squadStatus);
        const ids = query.ids ? [...new Set(query.ids.toLowerCase().split(','))] : null;
        if (ids) base = base.where('athlete.id', 'in', ids);

        const { total } = await base
          .select((eb) => eb.fn.countAll<number>().as('total'))
          .executeTakeFirstOrThrow();
        const rows = await base
          .selectAll('athlete')
          .orderBy('athlete.last_name')
          .orderBy('athlete.first_name')
          .orderBy('athlete.date_of_birth')
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize)
          .execute();
        await deps.audit.record({
          actor,
          action: 'athlete.list',
          objectType: 'athlete',
          details: {
            count: rows.length,
            total: Number(total),
            page: query.page,
            filtered: terms.length > 0 || ids !== null,
            // bei gezielter Abfrage nach IDs: welche Personen tatsächlich geliefert (angezeigt) wurden
            ...(ids ? { ids: rows.map((r) => r.id) } : {}),
          },
          ip,
          requestId,
        });
        return {
          items: rows.map(toAthlete),
          total: Number(total),
          page: query.page,
          pageSize: query.pageSize,
        };
      },

      'athletes.sports': async () => {
        const rows = await deps.db
          .selectFrom('athlete')
          .select('sport')
          .distinct()
          .orderBy('sport')
          .execute();
        return { items: rows.map((r) => r.sport) };
      },

      'athletes.get': async ({ params, actor, ip, requestId }) => {
        const row = await deps.db
          .selectFrom('athlete')
          .selectAll()
          .where('id', '=', params.id)
          .executeTakeFirst();
        if (!row) throw notFound();
        const [identifiers, consents, counts] = await Promise.all([
          deps.db
            .selectFrom('athlete_identifier')
            .select(['system', 'value'])
            .where('athlete_id', '=', params.id)
            .orderBy('system')
            .orderBy('value')
            .execute(),
          deps.db
            .selectFrom('consent_record')
            .selectAll()
            .where('athlete_id', '=', params.id)
            .orderBy('recorded_at', 'desc')
            .execute(),
          deps.db
            .selectFrom('dataset_record as r')
            .innerJoin('dataset as d', 'd.id', 'r.dataset_id')
            .select((eb) => ['d.id', 'd.name', eb.fn.countAll<number>().as('count')])
            .where('r.athlete_id', '=', params.id)
            .groupBy(['d.id', 'd.name'])
            .orderBy('d.name')
            .execute(),
        ]);
        await deps.audit.record({
          actor,
          action: 'athlete.read',
          objectType: 'athlete',
          objectId: params.id,
          ip,
          requestId,
        });
        return {
          ...toAthlete(row),
          identifiers,
          consents: consents.map(toConsent),
          recordCounts: counts.map((c) => ({ datasetId: c.id, datasetName: c.name, count: Number(c.count) })),
        };
      },

      'athletes.create': async ({ body, user, actor, ip, requestId }) => {
        const row = await writeTx(deps, async (trx) => {
          const created = await trx
            .insertInto('athlete')
            .values({
              last_name: body.lastName,
              first_name: body.firstName,
              date_of_birth: body.dateOfBirth,
              sport: body.sport,
              squad_status: body.squadStatus,
              sex: body.sex ?? null,
              club: body.club ?? null,
              discipline: body.discipline ?? null,
              created_by: user.id,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await deps.audit.record(
            { actor, action: 'athlete.create', objectType: 'athlete', objectId: created.id, ip, requestId },
            trx,
          );
          return created;
        }).catch(uniqueViolation);
        await deps.events.after('data.changed', { datasetId: null });
        return toAthlete(row);
      },

      'athletes.update': async ({ params, body, actor, ip, requestId }) => {
        const set: RowUpdate<'athlete'> = {};
        const changed: string[] = [];
        for (const [key, column] of Object.entries(ATHLETE_COLUMNS) as [
          keyof typeof ATHLETE_COLUMNS,
          (typeof ATHLETE_COLUMNS)[keyof typeof ATHLETE_COLUMNS],
        ][]) {
          const value = body[key];
          if (value === undefined) continue;
          (set as Record<string, unknown>)[column] = value;
          changed.push(key);
        }
        const row = await writeTx(deps, async (trx) => {
          if (changed.length === 0) {
            return trx.selectFrom('athlete').selectAll().where('id', '=', params.id).executeTakeFirst();
          }
          const updated = await trx
            .updateTable('athlete')
            .set(set)
            .where('id', '=', params.id)
            .returningAll()
            .executeTakeFirst();
          if (!updated) return undefined;
          await deps.audit.record(
            {
              actor,
              action: 'athlete.update',
              objectType: 'athlete',
              objectId: params.id,
              details: { fields: changed },
              ip,
              requestId,
            },
            trx,
          );
          return updated;
        }).catch(uniqueViolation);
        if (!row) throw notFound();
        if (changed.length > 0) await deps.events.after('data.changed', { datasetId: null });
        return toAthlete(row);
      },

      'athletes.delete': async ({ params, actor, ip, requestId }) => {
        await writeTx(deps, async (trx) => {
          // Sperrreihenfolge (core/locks.ts): Liefersperre vor der Personenzeile und allen Folgen
          await lockDeliveries(trx, 'exclusive');
          const existing = await trx
            .selectFrom('athlete')
            .select('id')
            .where('id', '=', params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!existing) throw notFound();
          const counts = await trx
            .selectNoFrom((eb) => [
              eb
                .selectFrom('dataset_record')
                .select(eb.fn.countAll<number>().as('n'))
                .where('athlete_id', '=', params.id)
                .as('records'),
              eb
                .selectFrom('consent_record')
                .select(eb.fn.countAll<number>().as('n'))
                .where('athlete_id', '=', params.id)
                .as('consents'),
              eb
                .selectFrom('athlete_identifier')
                .select(eb.fn.countAll<number>().as('n'))
                .where('athlete_id', '=', params.id)
                .as('identifiers'),
            ])
            .executeTakeFirstOrThrow();
          // Folgen (z. B. Löschmitteilungen an Partner) atomar mit der Löschung
          await deps.events.inTx(trx, 'athlete.deleted', { athleteId: params.id });
          await trx.deleteFrom('athlete').where('id', '=', params.id).execute();
          await deps.audit.record(
            {
              actor,
              action: 'athlete.delete',
              objectType: 'athlete',
              objectId: params.id,
              details: {
                records: Number(counts.records ?? 0),
                consents: Number(counts.consents ?? 0),
                identifiers: Number(counts.identifiers ?? 0),
              },
              ip,
              requestId,
            },
            trx,
          );
        });
        await deps.events.after('data.changed', { datasetId: null });
        return { ok: true as const };
      },

      'consents.create': async ({ params, body, user, actor, ip, requestId }) => {
        if (body.purpose !== '*') {
          const purpose = await deps.db
            .selectFrom('purpose')
            .select('code')
            .where('code', '=', body.purpose)
            .where('active', '=', true)
            .executeTakeFirst();
          if (!purpose) throw invalid({ 'body.purpose': 'unknown_purpose' });
        }
        if (body.validUntil && body.validUntil < body.validFrom) {
          throw invalid({ 'body.validUntil': 'before_valid_from' });
        }
        const row = await writeTx(deps, async (trx) => {
          const athlete = await trx
            .selectFrom('athlete')
            .select('id')
            .where('id', '=', params.id)
            .forShare()
            .executeTakeFirst();
          if (!athlete) throw notFound();
          const created = await trx
            .insertInto('consent_record')
            .values({
              athlete_id: params.id,
              purpose: body.purpose,
              data_category: body.dataCategory,
              status: 'granted',
              valid_from: body.validFrom,
              valid_until: body.validUntil ?? null,
              evidence_note: body.evidenceNote,
              recorded_by: user.id,
              recorded_at: deps.now(),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await deps.audit.record(
            {
              actor,
              action: 'consent.create',
              objectType: 'consent',
              objectId: created.id,
              details: { athleteId: params.id, purpose: body.purpose, dataCategory: body.dataCategory },
              ip,
              requestId,
            },
            trx,
          );
          return created;
        });
        await deps.events.after('data.changed', { datasetId: null });
        return toConsent(row);
      },

      'consents.withdraw': async ({ params, body, user, actor, ip, requestId }) => {
        const row = await writeTx(deps, async (trx) => {
          // Sperrreihenfolge (core/locks.ts): Liefersperre vor der Einwilligung und allen Folgen
          await lockDeliveries(trx, 'exclusive');
          const existing = await trx
            .selectFrom('consent_record')
            .selectAll()
            .where('id', '=', params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!existing) throw notFound();
          if (existing.status === 'withdrawn') throw conflict('already_withdrawn');
          const note = body.note.trim();
          const updated = await trx
            .updateTable('consent_record')
            .set({
              status: 'withdrawn',
              withdrawn_at: deps.now(),
              withdrawn_by: user.id,
              ...(note
                ? {
                    evidence_note: existing.evidence_note
                      ? `${existing.evidence_note}\nWiderruf: ${note}`
                      : `Widerruf: ${note}`,
                  }
                : {}),
            })
            .where('id', '=', params.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await deps.events.inTx(trx, 'consent.withdrawn', {
            athleteId: updated.athlete_id,
            consentId: updated.id,
            purpose: updated.purpose,
            dataCategory: updated.data_category,
          });
          await deps.audit.record(
            {
              actor,
              action: 'consent.withdraw',
              objectType: 'consent',
              objectId: updated.id,
              details: {
                athleteId: updated.athlete_id,
                purpose: updated.purpose,
                dataCategory: updated.data_category,
              },
              ip,
              requestId,
            },
            trx,
          );
          return updated;
        });
        await deps.events.after('data.changed', { datasetId: null });
        return toConsent(row);
      },

      'purposes.list': async () => {
        const rows = await deps.db.selectFrom('purpose').selectAll().orderBy('label_de').execute();
        return {
          items: rows.map((r) => ({
            code: r.code,
            labelDe: r.label_de,
            labelEn: r.label_en,
            description: r.description,
            active: r.active,
          })),
        };
      },
    });
  },
};
