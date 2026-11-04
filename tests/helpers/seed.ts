/**
 * Synthetische Testdaten direkt in die Datenbank (ohne Umweg über die Module), wiederverwendbar für alle
 * Integrationstests: Athleten, Einwilligungen, Datensätze, Einträge, Partner, Produkte, Freigaben, API-Tokens.
 * Alle Namen und Werte sind erfunden.
 */
import { fingerprint, generateEd25519 } from '../../src/server/core/crypto.ts';
import type { DbOrTx } from '../../src/server/core/db.ts';
import { newApiToken } from '../../src/server/modules/auth/sessions.ts';
import type { Condition, DataCategory, FieldType, RecipientRole } from '../../src/shared/contract/common.ts';

// ---------------------------------------------------------------------------------------------
// Einzelne Objekte
// ---------------------------------------------------------------------------------------------

export interface AthleteSeed {
  lastName: string;
  firstName: string;
  dateOfBirth: string;
  sport: string;
  squadStatus: 'OK' | 'PK' | 'EK' | 'NK1' | 'NK2' | 'LK' | 'none';
  sex: 'f' | 'm' | 'd' | null;
  club: string | null;
  discipline: string | null;
}

let athleteCounter = 0;

export async function seedAthlete(db: DbOrTx, a: Partial<AthleteSeed> = {}): Promise<string> {
  athleteCounter++;
  const row = await db
    .insertInto('athlete')
    .values({
      last_name: a.lastName ?? `Test${athleteCounter}`,
      first_name: a.firstName ?? 'Person',
      date_of_birth: a.dateOfBirth ?? '2005-01-01',
      sport: a.sport ?? 'Rudern',
      squad_status: a.squadStatus ?? 'none',
      sex: a.sex ?? null,
      club: a.club ?? null,
      discipline: a.discipline ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface FieldSeed {
  name: string;
  label?: string;
  type: FieldType;
  unit?: string;
  required?: boolean;
  enumValues?: string[];
}

export interface DatasetSeed {
  slug: string;
  name?: string;
  description?: string;
  category: DataCategory;
  specialCategory?: boolean;
  shareability?: 'internal' | 'on_request';
  fields: FieldSeed[];
  keyFields?: string[];
  observedAtField?: string | null;
}

export async function seedDataset(db: DbOrTx, d: DatasetSeed): Promise<string> {
  const row = await db
    .insertInto('dataset')
    .values({
      slug: d.slug,
      name: d.name ?? d.slug,
      description: d.description ?? '',
      category: d.category,
      special_category: d.specialCategory ?? d.category === 'health',
      shareability: d.shareability ?? 'on_request',
      fields: JSON.stringify(
        d.fields.map((f) => ({
          name: f.name,
          label: f.label ?? f.name,
          type: f.type,
          required: f.required ?? false,
          ...(f.unit ? { unit: f.unit } : {}),
          ...(f.enumValues ? { enumValues: f.enumValues } : {}),
        })),
      ),
      key_fields: d.keyFields ?? [],
      observed_at_field: d.observedAtField ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

let recordCounter = 0;

export async function seedRecord(
  db: DbOrTx,
  r: {
    datasetId: string;
    athleteId: string;
    recordKey?: string;
    /** ISO-Zeitstempel oder YYYY-MM-DD (wird als 12:00 UTC gespeichert) */
    observedAt?: string | Date | null;
    data: Record<string, unknown>;
  },
): Promise<string> {
  recordCounter++;
  const observed =
    r.observedAt === undefined || r.observedAt === null
      ? null
      : r.observedAt instanceof Date
        ? r.observedAt
        : /^\d{4}-\d{2}-\d{2}$/.test(r.observedAt)
          ? new Date(`${r.observedAt}T12:00:00Z`)
          : new Date(r.observedAt);
  const row = await db
    .insertInto('dataset_record')
    .values({
      dataset_id: r.datasetId,
      athlete_id: r.athleteId,
      record_key: r.recordKey ?? `k${recordCounter}`,
      observed_at: observed,
      data: JSON.stringify(r.data),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function seedConsent(
  db: DbOrTx,
  c: {
    athleteId: string;
    purpose?: string;
    dataCategory?: string;
    status?: 'granted' | 'withdrawn';
    validFrom?: string;
    validUntil?: string | null;
  },
): Promise<string> {
  const status = c.status ?? 'granted';
  const row = await db
    .insertInto('consent_record')
    .values({
      athlete_id: c.athleteId,
      purpose: c.purpose ?? '*',
      data_category: c.dataCategory ?? '*',
      status,
      valid_from: c.validFrom ?? '2025-01-01',
      valid_until: c.validUntil ?? null,
      withdrawn_at: status === 'withdrawn' ? new Date() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface SeededPeer {
  id: string;
  nodeId: string;
  publicKey: string;
  privateKey: string;
}

let peerCounter = 0;

export async function seedPeer(
  db: DbOrTx,
  p: {
    nodeId?: string;
    displayName?: string;
    baseUrl?: string;
    status?: 'pending' | 'trusted' | 'suspended';
  } = {},
): Promise<SeededPeer> {
  peerCounter++;
  const kp = generateEd25519();
  const nodeId = p.nodeId ?? `peer-${peerCounter}-${crypto.randomUUID().slice(0, 6)}`;
  const status = p.status ?? 'trusted';
  const row = await db
    .insertInto('peer')
    .values({
      node_id: nodeId,
      display_name: p.displayName ?? `Partner ${nodeId}`,
      base_url: p.baseUrl ?? `http://${nodeId}.mesh.test`,
      public_key: kp.publicKey,
      fingerprint: fingerprint(kp.publicKey),
      status,
      trusted_at: status === 'trusted' ? new Date() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, nodeId, publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export interface ProductSeed {
  slug: string;
  name?: string;
  description?: string;
  sourceType?: 'athletes' | 'dataset';
  datasetId?: string | null;
  columns: { key: string; label?: string; source: string }[];
  filters?: Condition[];
  shareability?: 'internal' | 'on_request';
  version?: number;
  status?: 'active' | 'retired';
}

export async function seedProduct(db: DbOrTx, p: ProductSeed): Promise<string> {
  const row = await db
    .insertInto('data_product')
    .values({
      slug: p.slug,
      name: p.name ?? p.slug,
      description: p.description ?? '',
      source_type: p.sourceType ?? (p.datasetId ? 'dataset' : 'athletes'),
      dataset_id: p.datasetId ?? null,
      columns: JSON.stringify(
        p.columns.map((c) => ({ key: c.key, label: c.label ?? c.key, source: c.source })),
      ),
      filters: JSON.stringify(p.filters ?? []),
      shareability: p.shareability ?? 'on_request',
      version: p.version ?? 1,
      status: p.status ?? 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export interface ReleaseSeed {
  productId: string;
  /** Standard: aktuelle Produktversion */
  productVersion?: number;
  recipient: { type: 'role'; role: RecipientRole } | { type: 'peer'; peerId: string };
  purposes: string[];
  columns: string[];
  rowFilter?: Condition[];
  dataFrom?: string | null;
  dataUntil?: string | null;
  validFrom?: Date;
  validUntil?: Date | null;
  requiresConsent?: boolean;
  revokedAt?: Date | null;
}

export async function seedRelease(db: DbOrTx, r: ReleaseSeed): Promise<string> {
  const version =
    r.productVersion ??
    (
      await db
        .selectFrom('data_product')
        .select('version')
        .where('id', '=', r.productId)
        .executeTakeFirstOrThrow()
    ).version;
  const row = await db
    .insertInto('data_release')
    .values({
      product_id: r.productId,
      product_version: version,
      recipient_type: r.recipient.type,
      recipient_role: r.recipient.type === 'role' ? r.recipient.role : null,
      recipient_peer_id: r.recipient.type === 'peer' ? r.recipient.peerId : null,
      purposes: r.purposes,
      columns: r.columns,
      row_filter: JSON.stringify(r.rowFilter ?? []),
      data_from: r.dataFrom ?? null,
      data_until: r.dataUntil ?? null,
      valid_from: r.validFrom ?? new Date('2025-01-01T00:00:00Z'),
      valid_until: r.validUntil ?? null,
      requires_consent: r.requiresConsent ?? false,
      revoked_at: r.revokedAt ?? null,
      revocation_reason: r.revokedAt ? 'test' : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Connector (Datenquelle) direkt anlegen; Standard: CSV-Upload mit Standardkonfiguration */
export async function seedConnector(
  db: DbOrTx,
  c: {
    slug: string;
    name?: string;
    description?: string;
    kind?: 'csv_upload' | 'http_api';
    targetDatasetId?: string | null;
    mapping: { source: string; target: string }[];
    version?: number;
    active?: boolean;
  },
): Promise<string> {
  const kind = c.kind ?? 'csv_upload';
  const row = await db
    .insertInto('connector')
    .values({
      slug: c.slug,
      name: c.name ?? c.slug,
      description: c.description ?? '',
      kind,
      target_type: c.targetDatasetId ? 'dataset' : 'athletes',
      target_dataset_id: c.targetDatasetId ?? null,
      config: JSON.stringify(
        kind === 'csv_upload'
          ? {
              type: 'csv',
              delimiter: 'auto',
              encoding: 'utf-8',
              decimalSeparator: '.',
              dateFormat: 'YYYY-MM-DD',
            }
          : {
              type: 'http_api',
              url: 'http://measure.mesh.test/api',
              itemsPath: '',
              auth: { type: 'none' },
              pagination: { type: 'none' },
              query: {},
              dateFormat: 'ISO_DATETIME',
              timeoutMs: 15000,
            },
      ),
      mapping: JSON.stringify(
        c.mapping.map((m) => ({ source: m.source, target: m.target, transform: 'trim' })),
      ),
      version: c.version ?? 1,
      active: c.active ?? true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** API-Token für eine Person anlegen (Header: Authorization: Bearer <token>) */
export async function seedApiToken(
  db: DbOrTx,
  userId: string,
  opts: { name?: string; expiresAt?: Date | null; revoked?: boolean } = {},
): Promise<{ id: string; token: string }> {
  const t = newApiToken();
  const row = await db
    .insertInto('api_token')
    .values({
      user_id: userId,
      name: opts.name ?? 'test',
      token_hash: t.hash,
      prefix: t.prefix,
      expires_at: opts.expiresAt ?? null,
      revoked_at: opts.revoked ? new Date() : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, token: t.token };
}

// ---------------------------------------------------------------------------------------------
// Standard-Szenario
// ---------------------------------------------------------------------------------------------

export interface StandardSeed {
  athletes: { anna: string; ben: string; carla: string; dario: string; eva: string };
  /** Leistungsdiagnostik (performance, teilbar auf Anfrage), Beobachtungsdatum test_date */
  performance: string;
  /** Gesundheit (health = besondere Kategorie), Beobachtungsdatum check_date */
  health: string;
  peers: { trusted: SeededPeer; suspended: SeededPeer; pending: SeededPeer };
}

/**
 * Fünf Personen mit unterschiedlichen Einwilligungen, ein Leistungs- und ein Gesundheitsdatensatz mit Einträgen,
 * je ein vertrauenswürdiger, gesperrter und ausstehender Partner.
 *
 * Einwilligungen:
 *  - anna:  erteilt, Zweck *, Kategorie *, unbefristet
 *  - ben:   erteilt für training_steering/performance und medical_care/health
 *  - carla: widerrufen (training_steering/*)
 *  - dario: erteilt nur für research/*
 *  - eva:   erteilt training_steering/*, aber nur bis 2025-12-31 (abgelaufen)
 *
 * Leistungstest-Einträge: je Person am 2026-01-15 und 2026-03-15 (12:00 UTC).
 * Gesundheits-Einträge: anna, ben, carla am 2026-02-01.
 */
export async function seedStandard(db: DbOrTx): Promise<StandardSeed> {
  const anna = await seedAthlete(db, {
    lastName: 'Adler',
    firstName: 'Anna',
    dateOfBirth: '2004-03-15',
    sport: 'Rudern',
    squadStatus: 'OK',
    sex: 'f',
    club: 'RC Teststadt',
  });
  const ben = await seedAthlete(db, {
    lastName: 'Berg',
    firstName: 'Ben',
    dateOfBirth: '2006-07-01',
    sport: 'Rudern',
    squadStatus: 'NK1',
    sex: 'm',
    club: 'RC Teststadt',
  });
  const carla = await seedAthlete(db, {
    lastName: 'Clausen',
    firstName: 'Carla',
    dateOfBirth: '2003-11-20',
    sport: 'Kanu',
    squadStatus: 'PK',
    sex: 'f',
    club: 'KC Beispielhausen',
  });
  const dario = await seedAthlete(db, {
    lastName: 'Dorn',
    firstName: 'Dario',
    dateOfBirth: '2008-01-05',
    sport: 'Kanu',
    squadStatus: 'NK2',
    sex: 'm',
  });
  const eva = await seedAthlete(db, {
    lastName: 'Eck',
    firstName: 'Eva',
    dateOfBirth: '2005-05-05',
    sport: 'Rudern',
    squadStatus: 'EK',
    sex: 'd',
  });

  await seedConsent(db, { athleteId: anna, purpose: '*', dataCategory: '*' });
  await seedConsent(db, { athleteId: ben, purpose: 'training_steering', dataCategory: 'performance' });
  await seedConsent(db, { athleteId: ben, purpose: 'medical_care', dataCategory: 'health' });
  await seedConsent(db, { athleteId: carla, purpose: 'training_steering', status: 'withdrawn' });
  await seedConsent(db, { athleteId: dario, purpose: 'research' });
  await seedConsent(db, { athleteId: eva, purpose: 'training_steering', validUntil: '2025-12-31' });

  const performance = await seedDataset(db, {
    slug: 'leistungstest',
    name: 'Leistungsdiagnostik',
    description: 'Sprung- und Sprinttests',
    category: 'performance',
    fields: [
      { name: 'test_date', label: 'Testdatum', type: 'date', required: true },
      { name: 'cmj_cm', label: 'Sprunghöhe CMJ', type: 'number', unit: 'cm' },
      { name: 'sprint_s', label: 'Sprint 30 m', type: 'number', unit: 's' },
      { name: 'reps', label: 'Wiederholungen', type: 'integer' },
      { name: 'valid', label: 'Gültig', type: 'boolean' },
      { name: 'protocol', label: 'Protokoll', type: 'enum', enumValues: ['A', 'B'] },
      { name: 'note', label: 'Bemerkung', type: 'string' },
    ],
    keyFields: ['test_date'],
    observedAtField: 'test_date',
  });
  const perf: [string, string, number, number, number, boolean, string, string][] = [
    [anna, '2026-01-15', 41.5, 4.21, 10, true, 'A', '=1+1'],
    [anna, '2026-03-15', 43.0, 4.15, 12, true, 'A', 'gut'],
    [ben, '2026-01-15', 38.2, 4.4, 8, true, 'B', 'A&B <x> "q"'],
    [ben, '2026-03-15', 39.9, 4.35, 9, false, 'B', ''],
    [carla, '2026-01-15', 35.1, 4.6, 7, true, 'A', ''],
    [carla, '2026-03-15', 36.0, 4.55, 7, true, 'A', ''],
    [dario, '2026-01-15', 33.3, 4.8, 6, true, 'B', ''],
    [dario, '2026-03-15', 34.4, 4.75, 6, true, 'B', ''],
    [eva, '2026-01-15', 37.7, 4.5, 9, true, 'A', ''],
    [eva, '2026-03-15', 38.8, 4.45, 10, true, 'A', ''],
  ];
  for (const [athleteId, date, cmj, sprint, reps, valid, protocol, note] of perf) {
    await seedRecord(db, {
      datasetId: performance,
      athleteId,
      recordKey: date,
      observedAt: date,
      data: { test_date: date, cmj_cm: cmj, sprint_s: sprint, reps, valid, protocol, note },
    });
  }

  const health = await seedDataset(db, {
    slug: 'gesundheit',
    name: 'Gesundheitscheck',
    description: 'Sportmedizinische Untersuchungen',
    category: 'health',
    specialCategory: true,
    fields: [
      { name: 'check_date', label: 'Untersuchungsdatum', type: 'date', required: true },
      { name: 'resting_hr', label: 'Ruhepuls', type: 'integer', unit: 'bpm' },
      { name: 'injured', label: 'Verletzt', type: 'boolean' },
    ],
    keyFields: ['check_date'],
    observedAtField: 'check_date',
  });
  for (const [athleteId, hr, injured] of [
    [anna, 52, false],
    [ben, 58, true],
    [carla, 61, false],
  ] as const) {
    await seedRecord(db, {
      datasetId: health,
      athleteId,
      recordKey: '2026-02-01',
      observedAt: '2026-02-01',
      data: { check_date: '2026-02-01', resting_hr: hr, injured },
    });
  }

  const trusted = await seedPeer(db, { status: 'trusted' });
  const suspended = await seedPeer(db, { status: 'suspended' });
  const pending = await seedPeer(db, { status: 'pending' });

  return {
    athletes: { anna, ben, carla, dario, eva },
    performance,
    health,
    peers: { trusted, suspended, pending },
  };
}
