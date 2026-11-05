import { z } from 'zod';
import {
  DataCategory,
  IdParam,
  IsoDate,
  IsoDateTime,
  Ok,
  Pagination,
  PurposeCode,
  paginated,
  SquadStatus,
  Uuid,
} from './common.ts';
import { route } from './route.ts';

const UUID_RE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** Bis zu 20 UUIDs, durch Komma getrennt (Abfrageparameter ids) */
const UUID_LIST = new RegExp(`^${UUID_RE}(,${UUID_RE}){0,19}$`);

export const Sex = z.enum(['f', 'm', 'd']);

export const AthleteInput = z.object({
  lastName: z.string().trim().min(1).max(100),
  firstName: z.string().trim().min(1).max(100),
  dateOfBirth: IsoDate,
  sport: z.string().trim().min(1).max(100),
  squadStatus: SquadStatus,
  sex: Sex.nullable().optional(),
  club: z.string().trim().max(200).nullable().optional(),
  discipline: z.string().trim().max(200).nullable().optional(),
});

export const Athlete = z.object({
  id: Uuid,
  lastName: z.string(),
  firstName: z.string(),
  dateOfBirth: IsoDate,
  sport: z.string(),
  squadStatus: SquadStatus,
  sex: Sex.nullable(),
  club: z.string().nullable(),
  discipline: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Athlete = z.infer<typeof Athlete>;

export const ConsentStatus = z.enum(['granted', 'withdrawn']);
export const Consent = z.object({
  id: Uuid,
  athleteId: Uuid,
  /** Zweck-Code oder '*' (alle Zwecke) */
  purpose: z.union([PurposeCode, z.literal('*')]),
  /** Datensatz-Kategorie oder '*' (alle Kategorien) */
  dataCategory: z.union([DataCategory, z.literal('*')]),
  status: ConsentStatus,
  validFrom: IsoDate,
  validUntil: IsoDate.nullable(),
  evidenceNote: z.string(),
  recordedAt: IsoDateTime,
  withdrawnAt: IsoDateTime.nullable(),
});
export type Consent = z.infer<typeof Consent>;

export const ConsentInput = z.object({
  purpose: z.union([PurposeCode, z.literal('*')]),
  dataCategory: z.union([DataCategory, z.literal('*')]).default('*'),
  validFrom: IsoDate,
  validUntil: IsoDate.nullable().optional(),
  evidenceNote: z.string().max(1000).default(''),
});

export const Purpose = z.object({
  code: PurposeCode,
  labelDe: z.string(),
  labelEn: z.string(),
  description: z.string(),
  active: z.boolean(),
});
export type Purpose = z.infer<typeof Purpose>;

export const AthleteDetail = Athlete.extend({
  identifiers: z.array(z.object({ system: z.string(), value: z.string() })),
  consents: z.array(Consent),
  recordCounts: z.array(z.object({ datasetId: Uuid, datasetName: z.string(), count: z.number().int() })),
});

export const athleteRoutes = {
  'athletes.list': route({
    method: 'GET',
    path: '/api/v1/athletes',
    auth: ['data_steward'],
    summary: 'Athletinnen und Athleten suchen',
    tag: 'Athleten',
    query: Pagination.extend({
      q: z.string().max(100).optional(),
      sport: z.string().max(100).optional(),
      squadStatus: SquadStatus.optional(),
      /** Nur diese Personen: bis zu 20 IDs, durch Komma getrennt (z. B. „Zuletzt geöffnet“ auf der Startseite) */
      ids: z.string().regex(UUID_LIST, 'Bis zu 20 UUIDs, durch Komma getrennt').optional(),
    }),
    response: paginated(Athlete),
  }),
  'athletes.sports': route({
    method: 'GET',
    path: '/api/v1/athletes/sports',
    auth: ['data_steward'],
    summary: 'Vorhandene Sportarten (für Filter)',
    tag: 'Athleten',
    response: z.object({ items: z.array(z.string()) }),
  }),
  'athletes.get': route({
    method: 'GET',
    path: '/api/v1/athletes/:id',
    auth: ['data_steward'],
    summary: 'Athletin/Athlet mit Kennungen, Einwilligungen und Datenbestand',
    tag: 'Athleten',
    params: IdParam,
    response: AthleteDetail,
  }),
  'athletes.create': route({
    method: 'POST',
    path: '/api/v1/athletes',
    auth: ['data_steward'],
    summary: 'Athletin/Athlet anlegen',
    tag: 'Athleten',
    body: AthleteInput,
    response: Athlete,
  }),
  'athletes.update': route({
    method: 'PATCH',
    path: '/api/v1/athletes/:id',
    auth: ['data_steward'],
    summary: 'Stammdaten ändern',
    tag: 'Athleten',
    params: IdParam,
    body: AthleteInput.partial(),
    response: Athlete,
  }),
  'athletes.delete': route({
    method: 'DELETE',
    path: '/api/v1/athletes/:id',
    auth: ['data_steward'],
    summary: 'Person und alle zugehörigen Daten löschen (Recht auf Löschung); Partner werden benachrichtigt',
    tag: 'Athleten',
    params: IdParam,
    response: Ok,
  }),
  'consents.create': route({
    method: 'POST',
    path: '/api/v1/athletes/:id/consents',
    auth: ['data_steward'],
    summary: 'Außerhalb des Systems eingeholte Einwilligung dokumentieren',
    tag: 'Einwilligungen',
    params: IdParam,
    body: ConsentInput,
    response: Consent,
  }),
  'consents.withdraw': route({
    method: 'POST',
    path: '/api/v1/consents/:id/withdraw',
    auth: ['data_steward'],
    summary: 'Widerruf einer Einwilligung erfassen; betroffene Partner werden benachrichtigt',
    tag: 'Einwilligungen',
    params: IdParam,
    body: z.object({ note: z.string().max(1000).default('') }),
    response: Consent,
  }),
  'purposes.list': route({
    method: 'GET',
    path: '/api/v1/purposes',
    auth: 'authenticated',
    summary: 'Zweck-Vokabular für Zweckbindung',
    tag: 'Einwilligungen',
    response: z.object({ items: z.array(Purpose) }),
  }),
} as const;
