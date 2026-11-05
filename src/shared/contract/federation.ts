import { z } from 'zod';
import {
  ColumnDef,
  DataCategory,
  ExportFormat,
  IdParam,
  IsoDate,
  IsoDateTime,
  Ok,
  Pagination,
  PurposeCode,
  paginated,
  Scalar,
  Uuid,
} from './common.ts';
import { ExchangeLogEntry } from './releases.ts';
import { route } from './route.ts';

/** Knotenkarte: wird zur Vertrauensaufnahme außerhalb des Systems ausgetauscht (z. B. per E-Mail). */
export const NodeCard = z.object({
  format: z.literal('osp-data-mesh/node-card@1'),
  nodeId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  displayName: z.string().min(1).max(200),
  baseUrl: z.url({ protocol: /^https?$/ }),
  /** Ed25519-Public-Key, base64 (32 Byte) */
  publicKey: z.string().min(40).max(60),
  /** SHA-256 des Public Keys, hex in 4er-Gruppen; muss telefonisch o. ä. abgeglichen werden */
  fingerprint: z.string(),
});
export type NodeCard = z.infer<typeof NodeCard>;

export const PeerStatus = z.enum(['pending', 'trusted', 'suspended']);
export const Peer = z.object({
  id: Uuid,
  nodeId: z.string(),
  displayName: z.string(),
  baseUrl: z.string(),
  publicKey: z.string(),
  fingerprint: z.string(),
  status: PeerStatus,
  createdAt: IsoDateTime,
  trustedAt: IsoDateTime.nullable(),
  lastSeenAt: IsoDateTime.nullable(),
  /** Übersetzbarer Fehlercode des letzten Kontaktversuchs */
  lastError: z.string().nullable(),
  /** Fingerprint des bisherigen Schlüssels nach einem Schlüsselwechsel des Partners (nur in der Übergangszeit) */
  previousFingerprint: z.string().nullable(),
  /** bis dahin wird der bisherige Schlüssel noch angenommen */
  previousKeyValidUntil: IsoDateTime.nullable(),
  /** letzter Schlüsselwechsel (Mitteilung des Partners oder manueller Austausch) */
  keyRotatedAt: IsoDateTime.nullable(),
});
export type Peer = z.infer<typeof Peer>;

export const OfferRelease = z.object({
  releaseId: Uuid,
  purposes: z.array(PurposeCode),
  columns: z.array(z.string()),
  validFrom: IsoDateTime,
  validUntil: IsoDateTime.nullable(),
  dataFrom: IsoDate.nullable(),
  dataUntil: IsoDate.nullable(),
  requiresConsent: z.boolean(),
});

/** Katalogangebot eines Partners: nur Metadaten; Daten nur mit Freigabe. */
export const Offer = z.object({
  productId: Uuid,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  category: DataCategory,
  version: z.number().int(),
  specialCategory: z.boolean(),
  columns: z.array(ColumnDef),
  /** Für den anfragenden Knoten aktuell gültige Freigaben */
  releases: z.array(OfferRelease),
});
export type Offer = z.infer<typeof Offer>;

export const DiscoveryResult = z.object({
  at: IsoDateTime,
  results: z.array(
    z.object({
      peer: z.object({ id: Uuid, nodeId: z.string(), displayName: z.string() }),
      status: z.enum(['ok', 'unreachable', 'rejected', 'error']),
      errorCode: z.string().nullable(),
      offers: z.array(Offer),
    }),
  ),
});

export const ReceivedStatus = z.enum(['active', 'revoked', 'expired', 'deleted']);
export const ReceivedProduct = z.object({
  id: Uuid,
  peer: z.object({ id: Uuid, nodeId: z.string(), displayName: z.string() }),
  remoteReleaseId: z.string(),
  remoteProductId: z.string(),
  remoteProductSlug: z.string(),
  title: z.string(),
  description: z.string(),
  purpose: PurposeCode,
  columns: z.array(ColumnDef),
  productVersion: z.number().int(),
  specialCategory: z.boolean(),
  releaseValidUntil: IsoDateTime.nullable(),
  status: ReceivedStatus,
  rowCount: z.number().int(),
  payloadSha256: z.string().nullable(),
  lastPulledAt: IsoDateTime.nullable(),
  statusChangedAt: IsoDateTime.nullable(),
  statusReason: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type ReceivedProduct = z.infer<typeof ReceivedProduct>;

export const Provenance = z.object({
  sourceNodeId: z.string(),
  sourceNodeName: z.string(),
  sourceFingerprint: z.string(),
  remoteReleaseId: z.string(),
  remoteProductId: z.string(),
  productVersion: z.number().int(),
  purpose: z.string(),
  pulledAt: IsoDateTime.nullable(),
  payloadSha256: z.string().nullable(),
  responseSignature: z.string().nullable(),
});

export const OutboxMessage = z.object({
  id: Uuid,
  peerNodeId: z.string(),
  type: z.string(),
  /** Art der Mitteilung (release_revoked, subjects_withdrawn, key_rotated, audit_checkpoint) */
  kind: z.string().nullable(),
  status: z.enum(['pending', 'delivered', 'failed']),
  attempts: z.number().int(),
  nextAttemptAt: IsoDateTime,
  lastError: z.string().nullable(),
  createdAt: IsoDateTime,
  deliveredAt: IsoDateTime.nullable(),
});

/** Eigener Signaturschlüssel und letzter Schlüsselwechsel (ADR 0013) */
export const NodeKeyStatus = z.object({
  fingerprint: z.string(),
  publicKey: z.string(),
  keyCreatedAt: IsoDateTime,
  rotation: z
    .object({
      id: Uuid,
      mode: z.enum(['routine', 'compromised']),
      rotatedAt: IsoDateTime,
      graceUntil: IsoDateTime,
      finishedAt: IsoDateTime.nullable(),
      /** Übergangszeit läuft: Partner ohne Bestätigung erhalten noch mit dem bisherigen Schlüssel Signiertes */
      running: z.boolean(),
      previousFingerprint: z.string(),
      peers: z.array(
        z.object({
          peerId: Uuid,
          nodeId: z.string(),
          displayName: z.string(),
          confirmedAt: IsoDateTime.nullable(),
          deliveryStatus: z.enum(['pending', 'delivered', 'failed']).nullable(),
          lastError: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
});

/** Eigener signierter Prüfpunkt der Audit-Kette (ADR 0014) */
export const AuditCheckpoint = z.object({
  seq: z.number().int(),
  hash: z.string(),
  at: IsoDateTime,
  /** Epoche der Kette (neu nach jeder Wiederherstellung) */
  epoch: Uuid,
  fingerprint: z.string(),
  trigger: z.enum(['schedule', 'manual', 'cli']),
  peers: z.number().int(),
});

export const AnchorProblem = z.object({
  seq: z.number().int(),
  kind: z.enum([
    'missing',
    'hash_mismatch',
    'inconclusive',
    'lost_by_restore',
    'beyond_pre_restore',
    'unknown_epoch',
  ]),
  epoch: z.string().nullable().optional(),
});

export const AnchorFinding = z.object({
  code: z.enum([
    'insufficient_partners',
    'partner_missing',
    'partner_excused',
    'partner_not_trusted_in_database',
    'partner_differs_from_database',
    'epoch_not_in_profile',
    'epoch_conflict',
    'restore_epoch',
    'lost_by_restore',
    'unknown_epoch',
    'inconclusive',
    'anchor_stale',
    'legacy_digest_ambiguous',
  ]),
  /** fail = nicht ausreichend verankert; review = Klärung nötig; info = Hinweis */
  severity: z.enum(['fail', 'review', 'info']),
  nodeId: z.string().optional(),
  epoch: z.string().optional(),
  count: z.number().int().optional(),
  seq: z.number().int().optional(),
  detail: z.string().optional(),
});

export const AnchorVerification = z.object({
  /**
   * ok = intakt und ausreichend verankert; manipulated = gebrochen, abgeschnitten oder umgeschrieben;
   * unanchored = nicht ausreichend bestätigt; needs_review = Klärung nötig (z. B. durch eine
   * Wiederherstellung verlorene Prüfpunkte)
   */
  result: z.enum(['ok', 'manipulated', 'unanchored', 'needs_review']),
  at: IsoDateTime,
  /** false: Partnerliste und frühere eigene Schlüssel stammen aus der geprüften Datenbank (Oberfläche) */
  independent: z.boolean(),
  source: z.enum(['database', 'profile']),
  profile: z.object({ sha256: z.string(), createdAt: IsoDateTime, minPartners: z.number().int() }).nullable(),
  requiredPartners: z.number().int(),
  anchoredPartners: z.number().int(),
  local: z.object({
    ok: z.boolean(),
    checked: z.number().int(),
    firstBrokenSeq: z.number().int().nullable(),
    breakKind: z
      .enum([
        'seq_gap',
        'prev_hash_mismatch',
        'hash_mismatch',
        'unsequenced',
        'not_a_table',
        'column_changed',
        'invalid_value',
        'digest_version',
      ])
      .nullable(),
    headSeq: z.number().int().nullable(),
    /** Einträge je Version der Hash-Eingabe; ambiguousV1 = Version 1 mit '|' in einem Feld */
    digest: z.object({ v1: z.number().int(), v2: z.number().int(), ambiguousV1: z.number().int() }),
  }),
  /** Stand der Verankerung: letzter von genügend Partnern bestätigter Kopf, danach nicht verankerte Einträge */
  anchoring: z.object({
    lastAnchoredSeq: z.number().int().nullable(),
    lastAnchoredAt: IsoDateTime.nullable(),
    unanchoredEntries: z.number().int(),
    staleAfterHours: z.number().nullable(),
  }),
  epoch: z.object({
    current: z.string(),
    history: z.array(
      z.object({
        epoch: z.string(),
        n: z.number().int().nullable(),
        startedAt: IsoDateTime.nullable(),
        reason: z.enum(['initial', 'restore']),
        previousEpoch: z.string().nullable(),
        restoredSeq: z.number().int().nullable(),
        inDatabase: z.boolean(),
        inProfile: z.boolean(),
      }),
    ),
  }),
  partners: z.array(
    z.object({
      peerId: Uuid.nullable(),
      nodeId: z.string(),
      displayName: z.string(),
      fingerprint: z.string(),
      status: z.enum(['ok', 'mismatch', 'needs_review', 'no_checkpoints', 'unreachable', 'error']),
      errorCode: z.string().nullable(),
      excused: z.boolean(),
      checkpoints: z.number().int(),
      matched: z.number().int(),
      latestSeq: z.number().int().nullable(),
      latestAt: IsoDateTime.nullable(),
      latestMatchedSeq: z.number().int().nullable(),
      latestMatchedAt: IsoDateTime.nullable(),
      invalidSignatures: z.number().int(),
      problems: z.number().int(),
      firstProblem: AnchorProblem.nullable(),
      lostByRestore: z.number().int(),
      inconclusive: z.number().int(),
      unknownEpoch: z.number().int(),
    }),
  ),
  findings: z.array(AnchorFinding),
});

export const federationRoutes = {
  'node.card': route({
    method: 'GET',
    path: '/api/v1/node/card',
    auth: ['admin', 'data_steward'],
    summary: 'Eigene Knotenkarte (Public Key + Fingerprint) zum Austausch mit Partnern',
    tag: 'Partner',
    response: NodeCard,
  }),
  'peers.list': route({
    method: 'GET',
    path: '/api/v1/peers',
    auth: ['admin', 'data_steward'],
    summary: 'Partnerknoten auflisten',
    tag: 'Partner',
    response: z.object({ items: z.array(Peer) }),
  }),
  'peers.add': route({
    method: 'POST',
    path: '/api/v1/peers',
    auth: ['admin'],
    summary: 'Partnerknoten aus Knotenkarte aufnehmen (Status "pending" bis zur Fingerprint-Bestätigung)',
    tag: 'Partner',
    body: z.object({ card: NodeCard }),
    response: Peer,
  }),
  'peers.trust': route({
    method: 'POST',
    path: '/api/v1/peers/:id/trust',
    auth: ['admin'],
    summary:
      'Vertrauen bestätigen: Fingerprint muss mit dem außerhalb des Systems abgeglichenen Wert übereinstimmen',
    tag: 'Partner',
    params: IdParam,
    body: z.object({ fingerprint: z.string().min(16).max(200) }),
    response: Peer,
  }),
  'peers.suspend': route({
    method: 'POST',
    path: '/api/v1/peers/:id/suspend',
    auth: ['admin'],
    summary: 'Partner sperren (alle Anfragen werden abgelehnt)',
    tag: 'Partner',
    params: IdParam,
    response: Peer,
  }),
  'peers.update': route({
    method: 'PATCH',
    path: '/api/v1/peers/:id',
    auth: ['admin'],
    summary: 'Anzeigename oder Adresse eines Partners ändern',
    tag: 'Partner',
    params: IdParam,
    body: z.object({
      displayName: z.string().min(1).max(200).optional(),
      baseUrl: z.url({ protocol: /^https?$/ }).optional(),
    }),
    response: Peer,
  }),
  'peers.replaceKey': route({
    method: 'POST',
    path: '/api/v1/peers/:id/key',
    auth: ['admin'],
    summary:
      'Neuen Schlüssel eines Partners aus seiner Knotenkarte eintragen (z. B. nach verpasster Rotationsmitteilung); Status danach "pending" bis zum erneuten Fingerprint-Abgleich',
    tag: 'Partner',
    params: IdParam,
    body: z.object({ card: NodeCard }),
    response: Peer,
  }),
  'node.keyStatus': route({
    method: 'GET',
    path: '/api/v1/node/key',
    auth: ['admin'],
    summary: 'Eigener Signaturschlüssel und Stand des letzten Schlüsselwechsels',
    tag: 'Partner',
    response: NodeKeyStatus,
  }),
  'node.rotateKey': route({
    method: 'POST',
    path: '/api/v1/node/key/rotate',
    auth: ['admin'],
    summary:
      'Knotenschlüssel wechseln: "routine" benachrichtigt alle Partner signiert (Übergangszeit), "compromised" ohne Benachrichtigung (Partner müssen den neuen Fingerprint abgleichen)',
    tag: 'Partner',
    body: z.object({
      mode: z.enum(['routine', 'compromised']),
      graceDays: z.number().int().min(1).max(30).default(7),
      /** ausdrückliche Bestätigung der gewählten Art */
      confirm: z.literal(true),
    }),
    response: NodeKeyStatus,
  }),
  'peers.ping': route({
    method: 'POST',
    path: '/api/v1/peers/:id/ping',
    auth: ['admin', 'data_steward'],
    summary: 'Signierte Verbindungsprüfung',
    tag: 'Partner',
    params: IdParam,
    response: z.object({
      ok: z.boolean(),
      latencyMs: z.number().nullable(),
      errorCode: z.string().nullable(),
    }),
  }),
  'catalog.local': route({
    method: 'GET',
    path: '/api/v1/catalog',
    auth: 'authenticated',
    summary: 'Lokaler Metadatenkatalog: Quellen, Strukturen, Felder, Connectoren, Mappings, Datenprodukte',
    tag: 'Katalog',
    query: z.object({
      q: z.string().max(100).optional(),
      kind: z.enum(['source', 'dataset', 'product']).optional(),
    }),
    response: z.object({
      items: z.array(
        z.object({
          kind: z.enum(['source', 'dataset', 'product']),
          id: Uuid,
          slug: z.string(),
          name: z.string(),
          description: z.string(),
          category: DataCategory,
          version: z.number().int(),
          shareability: z.enum(['internal', 'on_request']),
          specialCategory: z.boolean(),
          fields: z.array(ColumnDef),
          /** Bei Quellen: Feldzuordnungen (Quelle → Ziel) */
          mappings: z.array(z.object({ source: z.string(), target: z.string() })),
          /** Verknüpfte Objekte (z. B. Quelle → Datensatz → Produkte) */
          related: z.array(
            z.object({ kind: z.enum(['source', 'dataset', 'product']), id: Uuid, name: z.string() }),
          ),
          updatedAt: IsoDateTime,
        }),
      ),
    }),
  }),
  'discovery.search': route({
    method: 'GET',
    path: '/api/v1/discovery',
    auth: ['data_steward', 'analyst'],
    summary: 'Kataloge aller vertrauenswürdigen Partner abfragen (ohne zentrale Datensammelstelle)',
    tag: 'Katalog',
    query: z.object({ q: z.string().max(100).optional() }),
    response: DiscoveryResult,
  }),
  'received.pull': route({
    method: 'POST',
    path: '/api/v1/received/pull',
    auth: ['data_steward'],
    summary: 'Freigegebenes Datenprodukt bei einem Partner abrufen (ersetzt die bisherige Kopie)',
    tag: 'Empfangene Daten',
    body: z.object({ peerId: Uuid, releaseId: Uuid, purpose: PurposeCode }),
    response: ReceivedProduct,
  }),
  'received.list': route({
    method: 'GET',
    path: '/api/v1/received',
    auth: ['data_steward', 'analyst'],
    summary: 'Empfangene Datenprodukte',
    tag: 'Empfangene Daten',
    response: z.object({ items: z.array(ReceivedProduct) }),
  }),
  'received.get': route({
    method: 'GET',
    path: '/api/v1/received/:id',
    auth: ['data_steward', 'analyst'],
    summary: 'Empfangenes Datenprodukt mit Herkunftsnachweis',
    tag: 'Empfangene Daten',
    params: IdParam,
    response: ReceivedProduct.extend({ provenance: Provenance, history: z.array(ExchangeLogEntry) }),
  }),
  'received.rows': route({
    method: 'GET',
    path: '/api/v1/received/:id/rows',
    auth: ['data_steward', 'analyst'],
    summary: 'Zeilen eines empfangenen Produkts (Zugriff wird protokolliert)',
    tag: 'Empfangene Daten',
    params: IdParam,
    query: Pagination.extend({ format: ExportFormat.default('json') }),
    response: z.object({
      columns: z.array(ColumnDef),
      rows: z.array(z.record(z.string(), Scalar)),
      total: z.number().int(),
      page: z.number().int(),
      pageSize: z.number().int(),
    }),
    download: true,
  }),
  'received.delete': route({
    method: 'DELETE',
    path: '/api/v1/received/:id',
    auth: ['data_steward'],
    summary: 'Lokale Kopie löschen',
    tag: 'Empfangene Daten',
    params: IdParam,
    response: Ok,
  }),
  'exchange.log': route({
    method: 'GET',
    path: '/api/v1/exchange-log',
    auth: ['data_steward', 'auditor'],
    summary: 'Austauschprotokoll (gesendet und empfangen)',
    tag: 'Empfangene Daten',
    query: Pagination.extend({ direction: z.enum(['outgoing', 'incoming']).optional() }),
    response: paginated(ExchangeLogEntry),
  }),
  'outbox.list': route({
    method: 'GET',
    path: '/api/v1/outbox',
    auth: ['admin'],
    summary: 'Ausgehende Mitteilungen (Widerrufe) und Zustellstatus',
    tag: 'Partner',
    response: z.object({ items: z.array(OutboxMessage) }),
  }),
  'outbox.flush': route({
    method: 'POST',
    path: '/api/v1/outbox/flush',
    auth: ['admin', 'data_steward'],
    summary: 'Ausstehende Mitteilungen sofort zustellen',
    tag: 'Partner',
    response: z.object({ delivered: z.number().int(), failed: z.number().int() }),
  }),
  'anchors.status': route({
    method: 'GET',
    path: '/api/v1/audit/anchors',
    auth: ['auditor', 'admin'],
    summary:
      'Externe Verankerung der Audit-Kette: letzter eigener Prüfpunkt, Zustellung, für Partner verwahrte Prüfpunkte',
    tag: 'Audit',
    response: z.object({
      intervalHours: z.number(),
      /** aktuelle Epoche der eigenen Kette */
      epoch: Uuid,
      latest: AuditCheckpoint.nullable(),
      pending: z.number().int(),
      failed: z.number().int(),
      heldForPartners: z.array(
        z.object({
          nodeId: z.string(),
          displayName: z.string(),
          count: z.number().int(),
          latestSeq: z.number().int(),
          latestReceivedAt: IsoDateTime,
        }),
      ),
    }),
  }),
  'anchors.create': route({
    method: 'POST',
    path: '/api/v1/audit/anchors',
    auth: ['auditor', 'admin'],
    summary: 'Prüfpunkt der Audit-Kette jetzt signieren und an alle vertrauenswürdigen Partner senden',
    tag: 'Audit',
    response: z.object({ checkpoint: AuditCheckpoint, created: z.boolean() }),
  }),
  'anchors.latest': route({
    method: 'GET',
    path: '/api/v1/audit/anchors/latest',
    auth: ['auditor', 'admin'],
    summary: 'Letzten signierten Prüfpunkt exportieren (Verankerung außerhalb des Netzes)',
    tag: 'Audit',
    response: z.object({
      format: z.literal('osp-data-mesh/audit-checkpoint-export@1'),
      nodeId: z.string(),
      epoch: z.string().nullable().optional(),
      seq: z.number().int(),
      hash: z.string(),
      at: IsoDateTime,
      statement: z.string(),
      signature: z.string(),
      publicKey: z.string(),
      fingerprint: z.string(),
    }),
  }),
  'anchors.verify': route({
    method: 'POST',
    path: '/api/v1/audit/anchors/verify',
    auth: ['auditor', 'admin'],
    summary:
      'Audit-Kette mit den bei Partnern verwahrten Prüfpunkten abgleichen (erkennt Abschneiden und Umschreiben). ' +
      'Läuft im Server mit der Partnerliste der Datenbank und ist daher nicht unabhängig von ihr; unabhängig: ' +
      'CLI verify-audit --with-partners --profile',
    tag: 'Audit',
    response: AnchorVerification,
  }),
} as const;
