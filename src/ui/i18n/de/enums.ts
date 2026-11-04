import type {
  ConditionOp,
  DataCategory,
  FieldType,
  RecipientRole,
  ReleaseStatus,
  Role,
  Shareability,
  SquadStatus,
} from '../../../shared/contract/index.ts';

/** Übersetzungen für Aufzählungen des Vertrags (Rollen, Kategorien, Status …). */
export const enums = {
  roles: {
    admin: 'Administration',
    data_steward: 'Datenverantwortung',
    analyst: 'Analyse',
    coach: 'Trainer/in',
    auditor: 'Revision',
  } satisfies Record<Role, string>,
  roleDescriptions: {
    admin: 'Benutzer, Partnerknoten, System und Sicherungen; kein Zugriff auf Fachdaten.',
    data_steward:
      'Athleten, Einwilligungen, Quellen, Importe, Datensätze, Datenprodukte, Freigaben und Abrufe bei Partnern.',
    analyst: 'Nutzt für Analyse freigegebene Datenprodukte, den Partnerkatalog und empfangene Daten.',
    coach: 'Nutzt für Trainer/innen freigegebene Datenprodukte.',
    auditor: 'Liest Audit-Log, Austauschprotokoll und Freigaben (Datenschutz, Revision).',
  } satisfies Record<Role, string>,
  recipientRoles: {
    analyst: 'Analyse',
    coach: 'Trainer/in',
    data_steward: 'Datenverantwortung',
    auditor: 'Revision',
    bi: 'BI-Schnittstelle',
  } satisfies Record<RecipientRole, string>,
  categories: {
    master: 'Stammdaten',
    performance: 'Leistungsdiagnostik',
    training: 'Training',
    health: 'Gesundheit',
    competition: 'Wettkampf',
    other: 'Sonstiges',
  } satisfies Record<DataCategory, string>,
  squad: {
    OK: 'Olympiakader',
    PK: 'Perspektivkader',
    EK: 'Ergänzungskader',
    NK1: 'Nachwuchskader 1',
    NK2: 'Nachwuchskader 2',
    LK: 'Landeskader',
    none: 'Kein Kader',
  } satisfies Record<SquadStatus, string>,
  sex: {
    f: 'weiblich',
    m: 'männlich',
    d: 'divers',
    unknown: 'nicht angegeben',
  },
  shareability: {
    internal: 'Nur intern',
    on_request: 'Teilbar auf Anfrage',
  } satisfies Record<Shareability, string>,
  fieldTypes: {
    string: 'Text',
    integer: 'Ganzzahl',
    number: 'Zahl',
    date: 'Datum',
    datetime: 'Zeitpunkt',
    boolean: 'Ja/Nein',
    enum: 'Auswahlliste',
  } satisfies Record<FieldType, string>,
  conditionOps: {
    eq: 'ist gleich',
    neq: 'ist ungleich',
    in: 'ist einer von',
    nin: 'ist keiner von',
    gt: 'größer als',
    gte: 'größer oder gleich',
    lt: 'kleiner als',
    lte: 'kleiner oder gleich',
    is_null: 'ist leer',
    not_null: 'ist nicht leer',
  } satisfies Record<ConditionOp, string>,
  releaseStatus: {
    active: 'Aktiv',
    scheduled: 'Geplant',
    expired: 'Abgelaufen',
    revoked: 'Widerrufen',
    outdated: 'Veraltet',
  } satisfies Record<ReleaseStatus, string>,
  importStatus: {
    previewed: 'Vorschau',
    committed: 'Übernommen',
    discarded: 'Verworfen',
    failed: 'Fehlgeschlagen',
  },
  peerStatus: {
    pending: 'Ausstehend',
    trusted: 'Vertrauenswürdig',
    suspended: 'Gesperrt',
  },
  receivedStatus: {
    active: 'Aktiv',
    revoked: 'Widerrufen',
    expired: 'Abgelaufen',
    deleted: 'Gelöscht',
  },
  consentStatus: {
    granted: 'Erteilt',
    withdrawn: 'Widerrufen',
  },
  outboxStatus: {
    pending: 'Ausstehend',
    delivered: 'Zugestellt',
    failed: 'Fehlgeschlagen',
  },
  backupStatus: {
    running: 'Läuft',
    ok: 'Erfolgreich',
    failed: 'Fehlgeschlagen',
  },
  backupTrigger: {
    manual: 'Manuell',
    schedule: 'Zeitplan',
    cli: 'Kommandozeile',
  },
  biViewStatus: {
    ok: 'Aktuell',
    error: 'Fehler',
    dropped: 'Entfernt',
  },
  auditOutcome: {
    success: 'Erfolgreich',
    denied: 'Abgelehnt',
    error: 'Fehler',
  },
  actorType: {
    user: 'Person',
    peer: 'Partnerknoten',
    system: 'System',
    anonymous: 'Anonym',
  },
  exchangeOutcome: {
    delivered: 'Geliefert',
    denied: 'Abgelehnt',
    error: 'Fehler',
  },
  exchangeDirection: {
    outgoing: 'An Partner geliefert',
    incoming: 'Von Partner empfangen',
  },
  discoveryStatus: {
    ok: 'Erreichbar',
    unreachable: 'Nicht erreichbar',
    rejected: 'Abgelehnt',
    error: 'Fehler',
  },
  connectorKind: {
    csv_upload: 'CSV-Upload',
    http_api: 'HTTP-API',
  },
  targetType: {
    athletes: 'Athletenkern',
    dataset: 'Datensatz',
  },
  catalogKind: {
    source: 'Quelle',
    dataset: 'Datensatz',
    product: 'Datenprodukt',
  },
  rowStatus: {
    valid: 'Gültig',
    warning: 'Warnung',
    error: 'Fehler',
  },
  severity: {
    error: 'Fehler',
    warning: 'Warnung',
  },
  transform: {
    none: 'Unverändert',
    trim: 'Leerzeichen entfernen',
    upper: 'Großbuchstaben',
    lower: 'Kleinbuchstaben',
  },
  onError: {
    skip_row: 'Fehlerhafte Zeilen überspringen',
    abort: 'Gesamten Import abbrechen',
  },
  productStatus: {
    active: 'Aktiv',
    retired: 'Stillgelegt',
  },
  matchStrategy: {
    natural_key: 'Nachname, Vorname und Geburtsdatum',
    external_id: 'Kennung im Quellsystem',
  },
  activeState: {
    active: 'Aktiv',
    inactive: 'Inaktiv',
    locked: 'Gesperrt',
  },
  /** Gründe für den Status einer empfangenen Kopie (ReceivedProduct.statusReason) */
  receivedReasons: {
    revoked: 'Die Freigabe wurde vom Datenhalter widerrufen.',
    product_retired: 'Das Datenprodukt wurde vom Datenhalter stillgelegt.',
    dataset_reclassified:
      'Der Datenhalter hat den zugrunde liegenden Datensatz neu eingestuft (besondere Kategorie oder nur intern); die Freigabe wurde deshalb widerrufen.',
    product_inactive: 'Das Datenprodukt ist beim Datenhalter stillgelegt.',
    release_expired: 'Die Freigabe ist abgelaufen; die Daten wurden gelöscht.',
    expired: 'Die Freigabe ist abgelaufen.',
  },
};
