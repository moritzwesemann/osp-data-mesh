/**
 * Kysely-Typen für das Datenbankschema (migrations/*.sql). Spaltennamen wie in der Datenbank (snake_case).
 * Bei Schemaänderungen: Migration UND diese Datei anpassen.
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** jsonb: beim Lesen geparst, beim Schreiben als JSON-String oder Objekt */
export type Json<T = unknown> = ColumnType<T, string | T, string | T>;
/** timestamptz mit Default */
export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** timestamptz ohne Default */
export type TimestampReq = ColumnType<Date, Date | string, Date | string>;
/** date: als 'YYYY-MM-DD' (Typ-Parser in db.ts) */
export type DateStr = string;

export interface NodeIdentityTable {
  id: Generated<number>;
  node_id: string;
  display_name: string;
  base_url: string;
  public_key: string;
  private_key_enc: string;
  pseudonym_secret_enc: string;
  previous_public_key: string | null;
  key_created_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SettingTable {
  key: string;
  value: Json;
  updated_at: Timestamp;
}

export interface AppUserTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  password_hash: string;
  roles: string[];
  locale: Generated<string>;
  active: Generated<boolean>;
  failed_logins: Generated<number>;
  locked_until: Date | null;
  must_change_password: Generated<boolean>;
  last_login_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UserSessionTable {
  id: string;
  user_id: string;
  created_at: Timestamp;
  expires_at: TimestampReq;
  last_seen_at: Timestamp;
  ip: string | null;
  user_agent: string | null;
}

export interface ApiTokenTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  created_at: Timestamp;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export interface PurposeTable {
  code: string;
  label_de: string;
  label_en: string;
  description: Generated<string>;
  active: Generated<boolean>;
}

export interface AthleteTable {
  id: Generated<string>;
  last_name: string;
  first_name: string;
  date_of_birth: DateStr;
  sport: string;
  squad_status: string;
  sex: string | null;
  club: string | null;
  discipline: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string | null;
}

export interface AthleteIdentifierTable {
  athlete_id: string;
  system: string;
  value: string;
}

export interface ConsentRecordTable {
  id: Generated<string>;
  athlete_id: string;
  purpose: string;
  data_category: Generated<string>;
  status: 'granted' | 'withdrawn';
  valid_from: DateStr;
  valid_until: DateStr | null;
  evidence_note: Generated<string>;
  recorded_by: string | null;
  recorded_at: Timestamp;
  withdrawn_at: Date | null;
  withdrawn_by: string | null;
}

export interface DatasetTable {
  id: Generated<string>;
  slug: string;
  name: string;
  description: Generated<string>;
  category: string;
  special_category: Generated<boolean>;
  shareability: Generated<string>;
  version: Generated<number>;
  fields: Json;
  key_fields: Generated<string[]>;
  observed_at_field: string | null;
  owner_contact: Generated<string>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ConnectorTable {
  id: Generated<string>;
  slug: string;
  name: string;
  description: Generated<string>;
  kind: string;
  target_type: string;
  target_dataset_id: string | null;
  config: Json;
  mapping: Json;
  athlete_match: Json;
  secret_enc: string | null;
  on_error: Generated<string>;
  version: Generated<number>;
  active: Generated<boolean>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ImportRunTable {
  id: Generated<string>;
  connector_id: string;
  connector_version: number;
  status: string;
  source_name: string;
  source_sha256: string;
  source_size: number;
  staged: Json | null;
  preview: Json;
  total_rows: Generated<number>;
  valid_rows: Generated<number>;
  error_rows: Generated<number>;
  warning_rows: Generated<number>;
  inserted_rows: Generated<number>;
  updated_rows: Generated<number>;
  failure_code: string | null;
  started_by: string | null;
  committed_by: string | null;
  created_at: Timestamp;
  finished_at: Date | null;
}

export interface ImportErrorTable {
  id: Generated<number>;
  run_id: string;
  row_number: number;
  field: string | null;
  code: string;
  severity: 'error' | 'warning';
  raw_value: string | null;
  params: Json;
}

export interface DatasetRecordTable {
  id: Generated<string>;
  dataset_id: string;
  athlete_id: string;
  record_key: string;
  observed_at: Date | null;
  data: Json;
  import_run_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DataProductTable {
  id: Generated<string>;
  slug: string;
  name: string;
  description: Generated<string>;
  source_type: string;
  dataset_id: string | null;
  columns: Json;
  filters: Json;
  shareability: Generated<string>;
  version: Generated<number>;
  status: Generated<string>;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PeerTable {
  id: Generated<string>;
  node_id: string;
  display_name: string;
  base_url: string;
  public_key: string;
  fingerprint: string;
  status: Generated<string>;
  created_by: string | null;
  created_at: Timestamp;
  trusted_at: Date | null;
  trusted_by: string | null;
  last_seen_at: Date | null;
  last_error: string | null;
  updated_at: Timestamp;
}

export interface DataReleaseTable {
  id: Generated<string>;
  product_id: string;
  product_version: number;
  recipient_type: 'role' | 'peer';
  recipient_role: string | null;
  recipient_peer_id: string | null;
  purposes: string[];
  columns: string[];
  row_filter: Json;
  data_from: DateStr | null;
  data_until: DateStr | null;
  valid_from: Timestamp;
  valid_until: Date | null;
  requires_consent: boolean;
  legal_basis: Generated<string>;
  note: Generated<string>;
  created_by: string | null;
  created_at: Timestamp;
  revoked_at: Date | null;
  revoked_by: string | null;
  revocation_reason: string | null;
}

export interface FederationNonceTable {
  node_id: string;
  nonce: string;
  seen_at: Timestamp;
}

export interface OutboxMessageTable {
  id: Generated<string>;
  peer_id: string;
  type: string;
  body: Json;
  status: Generated<string>;
  attempts: Generated<number>;
  next_attempt_at: Timestamp;
  last_error: string | null;
  created_at: Timestamp;
  delivered_at: Date | null;
}

export interface ExchangeLogTable {
  id: Generated<string>;
  direction: 'outgoing' | 'incoming';
  peer_id: string | null;
  peer_node_id: string;
  release_id: string | null;
  remote_release_id: string | null;
  product_ref: string | null;
  purpose: string | null;
  outcome: 'delivered' | 'denied' | 'error';
  deny_reason: string | null;
  row_count: Generated<number>;
  columns: Generated<string[]>;
  subjects: Generated<string[]>;
  payload_sha256: string | null;
  request_id: string | null;
  at: Timestamp;
}

export interface ReceivedProductTable {
  id: Generated<string>;
  peer_id: string;
  remote_release_id: string;
  remote_product_id: string;
  remote_product_slug: string;
  title: string;
  description: Generated<string>;
  purpose: string;
  columns: Json;
  product_version: number;
  special_category: Generated<boolean>;
  release_valid_until: Date | null;
  status: Generated<string>;
  row_count: Generated<number>;
  payload_sha256: string | null;
  response_signature: string | null;
  last_pulled_at: Date | null;
  status_changed_at: Date | null;
  status_reason: string | null;
  created_at: Timestamp;
}

export interface ReceivedRowTable {
  id: Generated<number>;
  received_product_id: string;
  subject: string;
  data: Json;
}

export interface BiViewTable {
  release_id: string;
  view_name: string;
  table_name: string;
  status: 'ok' | 'error' | 'dropped';
  row_count: Generated<number>;
  error_code: string | null;
  refreshed_at: Timestamp;
}

export interface AppErrorTable {
  id: Generated<number>;
  at: Timestamp;
  request_id: string | null;
  method: string | null;
  path: string | null;
  status: number;
  code: string;
  message: string;
  user_id: string | null;
  details: Json;
}

export interface BackupRunTable {
  id: Generated<string>;
  started_at: Timestamp;
  finished_at: Date | null;
  status: 'running' | 'ok' | 'failed';
  file_name: string | null;
  size_bytes: ColumnType<number | null, number | null | undefined, number | null>;
  sha256: string | null;
  trigger: 'manual' | 'schedule' | 'cli';
  error_code: string | null;
  created_by: string | null;
}

export interface AuditLogTable {
  id: Generated<number>;
  seq: Generated<number>;
  at: Timestamp;
  actor_type: 'user' | 'peer' | 'system' | 'anonymous';
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  object_type: string | null;
  object_id: string | null;
  outcome: 'success' | 'denied' | 'error';
  details: Json;
  ip: string | null;
  request_id: string | null;
  prev_hash: Generated<string>;
  hash: Generated<string>;
}

export interface SchemaMigrationTable {
  version: string;
  name: string;
  sha256: string;
  applied_at: Timestamp;
}

export interface DB {
  node_identity: NodeIdentityTable;
  setting: SettingTable;
  app_user: AppUserTable;
  user_session: UserSessionTable;
  api_token: ApiTokenTable;
  purpose: PurposeTable;
  athlete: AthleteTable;
  athlete_identifier: AthleteIdentifierTable;
  consent_record: ConsentRecordTable;
  dataset: DatasetTable;
  connector: ConnectorTable;
  import_run: ImportRunTable;
  import_error: ImportErrorTable;
  dataset_record: DatasetRecordTable;
  data_product: DataProductTable;
  peer: PeerTable;
  data_release: DataReleaseTable;
  federation_nonce: FederationNonceTable;
  outbox_message: OutboxMessageTable;
  exchange_log: ExchangeLogTable;
  received_product: ReceivedProductTable;
  received_row: ReceivedRowTable;
  bi_view: BiViewTable;
  app_error: AppErrorTable;
  backup_run: BackupRunTable;
  audit_log: AuditLogTable;
  schema_migration: SchemaMigrationTable;
}

export type Row<T extends keyof DB> = Selectable<DB[T]>;
export type NewRow<T extends keyof DB> = Insertable<DB[T]>;
export type RowUpdate<T extends keyof DB> = Updateable<DB[T]>;
