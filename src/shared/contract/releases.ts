import { z } from 'zod';
import {
  ColumnDef,
  Condition,
  IdParam,
  IsoDate,
  IsoDateTime,
  PurposeCode,
  RecipientRole,
  Scalar,
  Uuid,
} from './common.ts';
import { DataStats } from './products.ts';
import { route } from './route.ts';

export const RecipientInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('role'), role: RecipientRole }),
  z.object({ type: z.literal('peer'), peerId: Uuid }),
]);

export const ReleaseInput = z.object({
  productId: Uuid,
  recipient: RecipientInput,
  /** Zulässige Zwecke (Zweckbindung); Anfragen müssen einen davon angeben */
  purposes: z.array(PurposeCode).min(1).max(10),
  /** Freigegebene Spalten (Teilmenge der Produktspalten) */
  columns: z.array(z.string().min(1).max(64)).min(1).max(100),
  /** Zeilenbeschränkung (UND-verknüpft) */
  rowFilter: z.array(Condition).max(20).default([]),
  /** Zeitliche Beschränkung der Daten (Beobachtungsdatum) */
  dataFrom: IsoDate.nullable().default(null),
  dataUntil: IsoDate.nullable().default(null),
  /** Zeitliche Gültigkeit der Freigabe; Standard: ab sofort */
  validFrom: IsoDateTime.nullable().default(null),
  validUntil: IsoDateTime.nullable().default(null),
  /** Nur Personen mit gültiger, dokumentierter Einwilligung für den Zweck; bei besonderen Kategorien Pflicht */
  requiresConsent: z.boolean(),
  legalBasis: z.string().max(500).default(''),
  note: z.string().max(2000).default(''),
});
export type ReleaseInput = z.infer<typeof ReleaseInput>;

export const ReleaseStatus = z.enum(['active', 'scheduled', 'expired', 'revoked', 'outdated']);
export type ReleaseStatus = z.infer<typeof ReleaseStatus>;

export const Release = z.object({
  id: Uuid,
  productId: Uuid,
  productName: z.string(),
  productSlug: z.string(),
  productVersion: z.number().int(),
  currentProductVersion: z.number().int(),
  recipient: z.discriminatedUnion('type', [
    z.object({ type: z.literal('role'), role: RecipientRole }),
    z.object({ type: z.literal('peer'), peerId: Uuid, peerNodeId: z.string(), peerName: z.string() }),
  ]),
  purposes: z.array(PurposeCode),
  columns: z.array(z.string()),
  rowFilter: z.array(Condition),
  dataFrom: IsoDate.nullable(),
  dataUntil: IsoDate.nullable(),
  validFrom: IsoDateTime,
  validUntil: IsoDateTime.nullable(),
  requiresConsent: z.boolean(),
  legalBasis: z.string(),
  note: z.string(),
  status: ReleaseStatus,
  createdAt: IsoDateTime,
  revokedAt: IsoDateTime.nullable(),
  revocationReason: z.string().nullable(),
});
export type Release = z.infer<typeof Release>;

export const ExchangeLogEntry = z.object({
  id: Uuid,
  direction: z.enum(['outgoing', 'incoming']),
  peerNodeId: z.string(),
  releaseId: Uuid.nullable(),
  remoteReleaseId: z.string().nullable(),
  productRef: z.string().nullable(),
  purpose: z.string().nullable(),
  outcome: z.enum(['delivered', 'denied', 'error']),
  denyReason: z.string().nullable(),
  rowCount: z.number().int(),
  columns: z.array(z.string()),
  payloadSha256: z.string().nullable(),
  at: IsoDateTime,
});
export type ExchangeLogEntry = z.infer<typeof ExchangeLogEntry>;

export const Decision = z.object({ allowed: z.boolean(), reason: z.string().nullable() });

export const releaseRoutes = {
  'releases.list': route({
    method: 'GET',
    path: '/api/v1/releases',
    auth: ['data_steward', 'auditor'],
    summary: 'Freigaben auflisten',
    tag: 'Freigaben',
    query: z.object({ productId: Uuid.optional(), status: ReleaseStatus.optional() }),
    response: z.object({ items: z.array(Release) }),
  }),
  'releases.get': route({
    method: 'GET',
    path: '/api/v1/releases/:id',
    auth: ['data_steward', 'auditor'],
    summary: 'Freigabe mit Austauschhistorie',
    tag: 'Freigaben',
    params: IdParam,
    response: Release.extend({ exchanges: z.array(ExchangeLogEntry) }),
  }),
  'releases.create': route({
    method: 'POST',
    path: '/api/v1/releases',
    auth: ['data_steward'],
    summary: 'Freigabe erteilen (Datensatz × Empfänger, beschränkt nach Spalten, Zeilen, Zeit und Zweck)',
    tag: 'Freigaben',
    body: ReleaseInput,
    response: Release,
  }),
  'releases.revoke': route({
    method: 'POST',
    path: '/api/v1/releases/:id/revoke',
    auth: ['data_steward'],
    summary: 'Freigabe widerrufen; Partner erhalten eine signierte Widerrufsmitteilung',
    tag: 'Freigaben',
    params: IdParam,
    body: z.object({ reason: z.string().min(1).max(1000) }),
    response: Release,
  }),
  'releases.preview': route({
    method: 'POST',
    path: '/api/v1/releases/preview',
    auth: ['data_steward'],
    summary: 'Wirkung einer (geplanten) Freigabe prüfen, bevor sie erteilt wird',
    tag: 'Freigaben',
    body: z.object({ release: ReleaseInput, purpose: PurposeCode }),
    response: z.object({
      decision: Decision,
      columns: z.array(ColumnDef),
      rows: z.array(z.record(z.string(), Scalar)),
      stats: DataStats,
    }),
  }),
} as const;
