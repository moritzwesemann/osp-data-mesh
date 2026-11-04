-- OSP-Data-Mesh: Kernschema (Version 1)
-- Wird als mesh_owner ausgeführt. Rechte für mesh_app / mesh_bi setzt migrations/grants.sql.

create schema if not exists bi;       -- typisierte Views für die BI-Rolle (nur freigegebene Datenprodukte)
create schema if not exists bi_data;  -- materialisierte Daten hinter den BI-Views (nur mesh_app)

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Knoten-Identität (genau eine Zeile)
-- ---------------------------------------------------------------------------------------------
create table node_identity (
  id                  smallint primary key default 1 check (id = 1),
  node_id             text not null check (node_id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  display_name        text not null,
  base_url            text not null,
  public_key          text not null,             -- Ed25519, base64 (32 Byte roh)
  private_key_enc     text not null,             -- mit Master-Key verschlüsselt (AES-256-GCM)
  pseudonym_secret_enc text not null,            -- HMAC-Schlüssel für Pseudonyme im Austausch, verschlüsselt
  previous_public_key text,                      -- nach Schlüsselrotation (Übergangsphase)
  key_created_at      timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger node_identity_updated before update on node_identity for each row execute function set_updated_at();

create table setting (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Benutzer, Sitzungen, API-Tokens
-- ---------------------------------------------------------------------------------------------
create table app_user (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null unique check (email = lower(email)),
  display_name         text not null,
  password_hash        text not null,
  roles                text[] not null default '{}'
                       check (roles <@ array['admin','data_steward','analyst','coach','auditor']::text[]),
  locale               text not null default 'de' check (locale in ('de','en')),
  active               boolean not null default true,
  failed_logins        integer not null default 0,
  locked_until         timestamptz,
  must_change_password boolean not null default false,
  last_login_at        timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger app_user_updated before update on app_user for each row execute function set_updated_at();

create table user_session (
  id           text primary key,                 -- SHA-256 des Sitzungstokens (Token selbst wird nie gespeichert)
  user_id      uuid not null references app_user(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  ip           text,
  user_agent   text
);
create index user_session_user on user_session(user_id);

create table api_token (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_user(id) on delete cascade,
  name         text not null,
  token_hash   text not null unique,             -- SHA-256 des Tokens
  prefix       text not null,                    -- erste Zeichen zur Wiedererkennung
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index api_token_user on api_token(user_id);

-- ---------------------------------------------------------------------------------------------
-- Zwecke (Vokabular für Zweckbindung)
-- ---------------------------------------------------------------------------------------------
create table purpose (
  code        text primary key check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  label_de    text not null,
  label_en    text not null,
  description text not null default '',
  active      boolean not null default true
);
insert into purpose (code, label_de, label_en, description) values
  ('training_steering',        'Trainingssteuerung',        'Training steering',        'Planung und Steuerung des Trainings durch das Betreuungsteam'),
  ('performance_diagnostics',  'Leistungsdiagnostik',       'Performance diagnostics',  'Auswertung leistungsdiagnostischer Tests'),
  ('medical_care',             'Medizinische Betreuung',    'Medical care',             'Sportmedizinische und physiotherapeutische Betreuung'),
  ('talent_development',       'Talententwicklung',         'Talent development',       'Nachwuchs- und Kaderentwicklung'),
  ('reporting',                'Berichtswesen',             'Reporting',                'Aggregierte Auswertungen und Berichte (BI)'),
  ('research',                 'Forschung',                 'Research',                 'Wissenschaftliche Auswertung mit gesonderter Einwilligung');

-- ---------------------------------------------------------------------------------------------
-- Personen-/Athletenkern
-- ---------------------------------------------------------------------------------------------
create table athlete (
  id            uuid primary key default gen_random_uuid(),
  last_name     text not null check (length(trim(last_name)) > 0),
  first_name    text not null check (length(trim(first_name)) > 0),
  date_of_birth date not null,
  sport         text not null check (length(trim(sport)) > 0),
  squad_status  text not null check (squad_status in ('OK','PK','EK','NK1','NK2','LK','none')),
  sex           text check (sex in ('f','m','d')),
  club          text,
  discipline    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references app_user(id) on delete set null,
  unique (last_name, first_name, date_of_birth)
);
create trigger athlete_updated before update on athlete for each row execute function set_updated_at();
create index athlete_sport on athlete(sport);

-- Externe Kennungen je Quellsystem (z. B. ID im Messsystem)
create table athlete_identifier (
  athlete_id uuid not null references athlete(id) on delete cascade,
  system     text not null,
  value      text not null,
  primary key (system, value)
);
create index athlete_identifier_athlete on athlete_identifier(athlete_id);

-- Einwilligungen (werden außerhalb des Systems eingeholt, hier optional dokumentiert)
create table consent_record (
  id            uuid primary key default gen_random_uuid(),
  athlete_id    uuid not null references athlete(id) on delete cascade,
  purpose       text not null,                   -- Zweck-Code oder '*'
  data_category text not null default '*',       -- Datensatz-Kategorie oder '*'
  status        text not null check (status in ('granted','withdrawn')),
  valid_from    date not null,
  valid_until   date,
  evidence_note text not null default '',
  recorded_by   uuid references app_user(id) on delete set null,
  recorded_at   timestamptz not null default now(),
  withdrawn_at  timestamptz,
  withdrawn_by  uuid references app_user(id) on delete set null,
  check (valid_until is null or valid_until >= valid_from)
);
create index consent_record_athlete on consent_record(athlete_id);

-- ---------------------------------------------------------------------------------------------
-- Datensätze (Strukturen) und Datensatz-Einträge
-- ---------------------------------------------------------------------------------------------
create table dataset (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique check (slug ~ '^[a-z][a-z0-9_]{1,50}$'),
  name              text not null,
  description       text not null default '',
  category          text not null check (category in ('master','performance','training','health','competition','other')),
  special_category  boolean not null default false,  -- besondere Kategorie nach Art. 9 DSGVO (z. B. Gesundheit)
  shareability      text not null default 'on_request' check (shareability in ('internal','on_request')),
  version           integer not null default 1,
  fields            jsonb not null,                  -- FieldDef[]
  key_fields        text[] not null default '{}',    -- fachlicher Schlüssel (zusätzlich zur Person)
  observed_at_field text,                            -- Feld mit dem Beobachtungs-/Messdatum
  owner_contact     text not null default '',
  created_by        uuid references app_user(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (category <> 'health' or special_category)
);
create trigger dataset_updated before update on dataset for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Connectoren, Importläufe, Fehlerprotokoll
-- ---------------------------------------------------------------------------------------------
create table connector (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique check (slug ~ '^[a-z][a-z0-9_-]{1,50}$'),
  name              text not null,
  description       text not null default '',
  kind              text not null check (kind in ('csv_upload','http_api')),
  target_type       text not null check (target_type in ('athletes','dataset')),
  target_dataset_id uuid references dataset(id) on delete restrict,
  config            jsonb not null,                -- CsvConfig | HttpApiConfig (ohne Geheimnisse)
  mapping           jsonb not null,                -- FieldMapping[]
  athlete_match     jsonb not null default '{"strategy":"natural_key"}',
  secret_enc        text,                          -- verschlüsseltes Zugangsgeheimnis (API-Token)
  on_error          text not null default 'skip_row' check (on_error in ('skip_row','abort')),
  version           integer not null default 1,
  active            boolean not null default true,
  created_by        uuid references app_user(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((target_type = 'dataset') = (target_dataset_id is not null))
);
create trigger connector_updated before update on connector for each row execute function set_updated_at();

create table import_run (
  id                uuid primary key default gen_random_uuid(),
  connector_id      uuid not null references connector(id) on delete cascade,
  connector_version integer not null,
  status            text not null check (status in ('previewed','committed','discarded','failed')),
  source_name       text not null,
  source_sha256     text not null,
  source_size       integer not null,
  staged            jsonb,                         -- validierte, gemappte Zeilen bis Übernahme/Verwerfen
  preview           jsonb not null default '{}',   -- Vorschau (Auszug Roh- und Zielzeilen)
  total_rows        integer not null default 0,
  valid_rows        integer not null default 0,
  error_rows        integer not null default 0,
  warning_rows      integer not null default 0,
  inserted_rows     integer not null default 0,
  updated_rows      integer not null default 0,
  failure_code      text,
  started_by        uuid references app_user(id) on delete set null,
  committed_by      uuid references app_user(id) on delete set null,
  created_at        timestamptz not null default now(),
  finished_at       timestamptz
);
create index import_run_connector on import_run(connector_id, created_at desc);

create table import_error (
  id         bigserial primary key,
  run_id     uuid not null references import_run(id) on delete cascade,
  row_number integer not null,                     -- 1-basiert, ohne Kopfzeile
  field      text,
  code       text not null,                        -- übersetzbarer Fehlercode
  severity   text not null check (severity in ('error','warning')),
  raw_value  text,
  params     jsonb not null default '{}'
);
create index import_error_run on import_error(run_id, row_number);

create table dataset_record (
  id            uuid primary key default gen_random_uuid(),
  dataset_id    uuid not null references dataset(id) on delete cascade,
  athlete_id    uuid not null references athlete(id) on delete cascade,
  record_key    text not null,
  observed_at   timestamptz,
  data          jsonb not null,
  import_run_id uuid references import_run(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (dataset_id, athlete_id, record_key)
);
create trigger dataset_record_updated before update on dataset_record for each row execute function set_updated_at();
create index dataset_record_dataset on dataset_record(dataset_id, observed_at);
create index dataset_record_athlete on dataset_record(athlete_id);

-- ---------------------------------------------------------------------------------------------
-- Datenprodukte und Freigaben
-- ---------------------------------------------------------------------------------------------
create table data_product (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z][a-z0-9_]{1,50}$'),
  name         text not null,
  description  text not null default '',
  source_type  text not null check (source_type in ('athletes','dataset')),
  dataset_id   uuid references dataset(id) on delete restrict,
  columns      jsonb not null,                    -- ProductColumn[]
  filters      jsonb not null default '[]',       -- Condition[] (Basisfilter des Produkts)
  shareability text not null default 'on_request' check (shareability in ('internal','on_request')),
  version      integer not null default 1,
  status       text not null default 'active' check (status in ('active','retired')),
  created_by   uuid references app_user(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((source_type = 'dataset') = (dataset_id is not null))
);
create trigger data_product_updated before update on data_product for each row execute function set_updated_at();

create table peer (
  id            uuid primary key default gen_random_uuid(),
  node_id       text not null unique,
  display_name  text not null,
  base_url      text not null,
  public_key    text not null,
  fingerprint   text not null,
  status        text not null default 'pending' check (status in ('pending','trusted','suspended')),
  created_by    uuid references app_user(id) on delete set null,
  created_at    timestamptz not null default now(),
  trusted_at    timestamptz,
  trusted_by    uuid references app_user(id) on delete set null,
  last_seen_at  timestamptz,
  last_error    text,
  updated_at    timestamptz not null default now()
);
create trigger peer_updated before update on peer for each row execute function set_updated_at();

create table data_release (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references data_product(id) on delete restrict,
  product_version   integer not null,
  recipient_type    text not null check (recipient_type in ('role','peer')),
  recipient_role    text check (recipient_role in ('analyst','coach','data_steward','auditor','bi')),
  recipient_peer_id uuid references peer(id) on delete restrict,
  purposes          text[] not null check (cardinality(purposes) > 0),
  columns           text[] not null check (cardinality(columns) > 0),
  row_filter        jsonb not null default '[]',   -- Condition[]
  data_from         date,
  data_until        date,
  valid_from        timestamptz not null default now(),
  valid_until       timestamptz,
  requires_consent  boolean not null,
  legal_basis       text not null default '',
  note              text not null default '',
  created_by        uuid references app_user(id) on delete set null,
  created_at        timestamptz not null default now(),
  revoked_at        timestamptz,
  revoked_by        uuid references app_user(id) on delete set null,
  revocation_reason text,
  check ((recipient_type = 'role') = (recipient_role is not null)),
  check ((recipient_type = 'peer') = (recipient_peer_id is not null)),
  check (valid_until is null or valid_until > valid_from),
  check (data_until is null or data_from is null or data_until >= data_from)
);
create index data_release_product on data_release(product_id);
create index data_release_peer on data_release(recipient_peer_id);

-- ---------------------------------------------------------------------------------------------
-- Föderation: Replay-Schutz, Ausgangspostfach, Austauschprotokoll, empfangene Daten
-- ---------------------------------------------------------------------------------------------
create table federation_nonce (
  node_id text not null,
  nonce   text not null,
  seen_at timestamptz not null default now(),
  primary key (node_id, nonce)
);

create table outbox_message (
  id              uuid primary key default gen_random_uuid(),
  peer_id         uuid not null references peer(id) on delete cascade,
  type            text not null,
  body            jsonb not null,
  status          text not null default 'pending' check (status in ('pending','delivered','failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index outbox_pending on outbox_message(status, next_attempt_at);

create table exchange_log (
  id                uuid primary key default gen_random_uuid(),
  direction         text not null check (direction in ('outgoing','incoming')),
  peer_id           uuid references peer(id) on delete set null,
  peer_node_id      text not null,
  release_id        uuid,                           -- lokale Freigabe (outgoing)
  remote_release_id text,                           -- Freigabe beim Partner (incoming)
  product_ref       text,
  purpose           text,
  outcome           text not null check (outcome in ('delivered','denied','error')),
  deny_reason       text,
  row_count         integer not null default 0,
  columns           text[] not null default '{}',
  subjects          text[] not null default '{}',   -- übermittelte Pseudonyme (nur outgoing)
  payload_sha256    text,
  request_id        text,
  at                timestamptz not null default now()
);
create index exchange_log_release on exchange_log(release_id);
create index exchange_log_at on exchange_log(at desc);

create table received_product (
  id                  uuid primary key default gen_random_uuid(),
  peer_id             uuid not null references peer(id) on delete cascade,
  remote_release_id   text not null,
  remote_product_id   text not null,
  remote_product_slug text not null,
  title               text not null,
  description         text not null default '',
  purpose             text not null,
  columns             jsonb not null,               -- ColumnDef[]
  product_version     integer not null,
  special_category    boolean not null default false,
  release_valid_until timestamptz,
  status              text not null default 'active' check (status in ('active','revoked','expired','deleted')),
  row_count           integer not null default 0,
  payload_sha256      text,
  response_signature  text,
  last_pulled_at      timestamptz,
  status_changed_at   timestamptz,
  status_reason       text,
  created_at          timestamptz not null default now(),
  unique (peer_id, remote_release_id, purpose)
);

create table received_row (
  id                  bigserial primary key,
  received_product_id uuid not null references received_product(id) on delete cascade,
  subject             text not null,
  data                jsonb not null
);
create index received_row_product on received_row(received_product_id);
create index received_row_subject on received_row(subject);

-- ---------------------------------------------------------------------------------------------
-- BI-Materialisierung
-- ---------------------------------------------------------------------------------------------
create table bi_view (
  release_id   uuid primary key references data_release(id) on delete cascade,
  view_name    text not null unique,
  table_name   text not null unique,
  status       text not null check (status in ('ok','error','dropped')),
  row_count    integer not null default 0,
  error_code   text,
  refreshed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Betrieb: Fehlerprotokoll, Sicherungen
-- ---------------------------------------------------------------------------------------------
create table app_error (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  request_id text,
  method     text,
  path       text,
  status     integer not null,
  code       text not null,
  message    text not null,
  user_id    uuid,
  details    jsonb not null default '{}'
);
create index app_error_at on app_error(at desc);

create table backup_run (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null check (status in ('running','ok','failed')),
  file_name   text,
  size_bytes  bigint,
  sha256      text,
  trigger     text not null check (trigger in ('manual','schedule','cli')),
  error_code  text,
  created_by  uuid references app_user(id) on delete set null
);

-- ---------------------------------------------------------------------------------------------
-- Audit-Log: nur anhängen (Update/Delete/Truncate per Trigger gesperrt), Hash-Kette
-- ---------------------------------------------------------------------------------------------
create table audit_log (
  id          bigserial primary key,
  seq         bigint unique,                        -- Position in der Hash-Kette (im Trigger vergeben)
  at          timestamptz not null default clock_timestamp(),
  actor_type  text not null check (actor_type in ('user','peer','system','anonymous')),
  actor_id    text,
  actor_label text,
  action      text not null,
  object_type text,
  object_id   text,
  outcome     text not null check (outcome in ('success','denied','error')),
  details     jsonb not null default '{}',
  ip          text,
  request_id  text,
  prev_hash   text not null default '',
  hash        text not null default ''
);
create index audit_log_at on audit_log(at desc);
create index audit_log_action on audit_log(action);
create index audit_log_object on audit_log(object_type, object_id);

create or replace function audit_digest_input(r audit_log) returns text language sql stable as $$
  select concat_ws('|',
    r.seq::text,
    to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.actor_type, coalesce(r.actor_id, ''), coalesce(r.actor_label, ''),
    r.action, coalesce(r.object_type, ''), coalesce(r.object_id, ''),
    r.outcome, r.details::text, coalesce(r.ip, ''), coalesce(r.request_id, ''),
    r.prev_hash)
$$;

create or replace function audit_log_chain() returns trigger language plpgsql as $$
declare
  last_seq  bigint;
  last_hash text;
begin
  -- Serialisiert alle Audit-Einträge, damit die Kette nicht verzweigt.
  perform pg_advisory_xact_lock(7212001);
  select seq, hash into last_seq, last_hash from audit_log order by seq desc limit 1;
  new.seq := coalesce(last_seq, 0) + 1;
  new.prev_hash := coalesce(last_hash, repeat('0', 64));
  new.at := clock_timestamp();
  new.hash := encode(sha256(convert_to(audit_digest_input(new), 'UTF8')), 'hex');
  return new;
end $$;

create or replace function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'insufficient_privilege';
end $$;

create trigger audit_log_chain before insert on audit_log for each row execute function audit_log_chain();
create trigger audit_log_no_update before update or delete on audit_log for each row execute function audit_log_immutable();
create trigger audit_log_no_truncate before truncate on audit_log for each statement execute function audit_log_immutable();

-- Prüft die Hash-Kette. Liefert die erste fehlerhafte Position (oder null) und die Anzahl geprüfter Einträge.
create or replace function audit_verify(out checked bigint, out first_broken_seq bigint) language plpgsql stable as $$
declare
  r audit_log;
  expected_prev text := repeat('0', 64);
  expected_seq bigint := 1;
begin
  checked := 0;
  first_broken_seq := null;
  for r in select * from audit_log order by seq loop
    if r.seq <> expected_seq
       or r.prev_hash <> expected_prev
       or r.hash <> encode(sha256(convert_to(audit_digest_input(r), 'UTF8')), 'hex') then
      first_broken_seq := r.seq;
      return;
    end if;
    expected_prev := r.hash;
    expected_seq := expected_seq + 1;
    checked := checked + 1;
  end loop;
end $$;
