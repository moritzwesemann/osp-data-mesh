import type { enums as DeEnums } from '../de/enums.ts';

export const enums: typeof DeEnums = {
  roles: {
    admin: 'Administration',
    data_steward: 'Data stewardship',
    analyst: 'Analysis',
    coach: 'Coach',
    auditor: 'Audit',
  },
  roleDescriptions: {
    admin: 'Users, partner nodes, system and backups; no access to subject data.',
    data_steward:
      'Athletes, consents, sources, imports, datasets, data products, releases and retrieval from partners.',
    analyst: 'Uses data products released for analysis, the partner catalogue and received data.',
    coach: 'Uses data products released for coaches.',
    auditor: 'Reads the audit log, exchange log and releases (data protection, audit).',
  },
  recipientRoles: {
    analyst: 'Analysis',
    coach: 'Coach',
    data_steward: 'Data stewardship',
    auditor: 'Audit',
    bi: 'BI interface',
  },
  categories: {
    master: 'Master data',
    performance: 'Performance diagnostics',
    training: 'Training',
    health: 'Health',
    competition: 'Competition',
    other: 'Other',
  },
  squad: {
    OK: 'Olympic squad',
    PK: 'Perspective squad',
    EK: 'Supplementary squad',
    NK1: 'Junior squad 1',
    NK2: 'Junior squad 2',
    LK: 'State squad',
    none: 'No squad',
  },
  sex: {
    f: 'female',
    m: 'male',
    d: 'diverse',
    unknown: 'not specified',
  },
  shareability: {
    internal: 'Internal only',
    on_request: 'Shareable on request',
  },
  fieldTypes: {
    string: 'Text',
    integer: 'Whole number',
    number: 'Number',
    date: 'Date',
    datetime: 'Point in time',
    boolean: 'Yes/no',
    enum: 'Choice list',
  },
  conditionOps: {
    eq: 'equals',
    neq: 'does not equal',
    in: 'is one of',
    nin: 'is none of',
    gt: 'greater than',
    gte: 'greater than or equal',
    lt: 'less than',
    lte: 'less than or equal',
    is_null: 'is empty',
    not_null: 'is not empty',
  },
  releaseStatus: {
    active: 'Active',
    scheduled: 'Scheduled',
    expired: 'Expired',
    revoked: 'Revoked',
    outdated: 'Outdated',
  },
  importStatus: {
    previewed: 'Preview',
    committed: 'Committed',
    discarded: 'Discarded',
    failed: 'Failed',
  },
  peerStatus: {
    pending: 'Pending',
    trusted: 'Trusted',
    suspended: 'Suspended',
  },
  receivedStatus: {
    active: 'Active',
    revoked: 'Revoked',
    expired: 'Expired',
    deleted: 'Deleted',
  },
  consentStatus: {
    granted: 'Granted',
    withdrawn: 'Withdrawn',
  },
  outboxStatus: {
    pending: 'Pending',
    delivered: 'Delivered',
    failed: 'Failed',
  },
  backupStatus: {
    running: 'Running',
    ok: 'Successful',
    failed: 'Failed',
  },
  backupTrigger: {
    manual: 'Manual',
    schedule: 'Schedule',
    cli: 'Command line',
  },
  biViewStatus: {
    ok: 'Up to date',
    error: 'Error',
    dropped: 'Removed',
  },
  auditOutcome: {
    success: 'Successful',
    denied: 'Denied',
    error: 'Error',
  },
  actorType: {
    user: 'Person',
    peer: 'Partner node',
    system: 'System',
    anonymous: 'Anonymous',
  },
  exchangeOutcome: {
    delivered: 'Delivered',
    denied: 'Denied',
    error: 'Error',
  },
  exchangeDirection: {
    outgoing: 'Delivered to partner',
    incoming: 'Received from partner',
  },
  discoveryStatus: {
    ok: 'Reachable',
    unreachable: 'Unreachable',
    rejected: 'Rejected',
    error: 'Error',
  },
  connectorKind: {
    csv_upload: 'CSV upload',
    http_api: 'HTTP API',
  },
  targetType: {
    athletes: 'Athlete core',
    dataset: 'Dataset',
  },
  catalogKind: {
    source: 'Source',
    dataset: 'Dataset',
    product: 'Data product',
  },
  rowStatus: {
    valid: 'Valid',
    warning: 'Warning',
    error: 'Error',
  },
  severity: {
    error: 'Error',
    warning: 'Warning',
  },
  transform: {
    none: 'Unchanged',
    trim: 'Trim spaces',
    upper: 'Upper case',
    lower: 'Lower case',
  },
  onError: {
    skip_row: 'Skip invalid rows',
    abort: 'Abort the whole import',
  },
  productStatus: {
    active: 'Active',
    retired: 'Retired',
  },
  matchStrategy: {
    natural_key: 'Last name, first name and date of birth',
    external_id: 'Identifier in the source system',
  },
  activeState: {
    active: 'Active',
    inactive: 'Inactive',
    locked: 'Locked',
  },
  receivedReasons: {
    revoked: 'The release was revoked by the data holder.',
    product_retired: 'The data product was retired by the data holder.',
    dataset_reclassified:
      'The data holder reclassified the underlying dataset (special category or internal only); the release was therefore revoked.',
    product_inactive: 'The data product has been retired by the data holder.',
    release_expired: 'The release has expired; the data were deleted.',
    expired: 'The release has expired.',
  },
};
