-- Wechsel des Ed25519-Knotenschlüssels mit Benachrichtigung der Partner (ADR 0013) und externe Verankerung
-- der Audit-Hash-Kette durch signierte Prüfpunkte bei den Partnern (ADR 0014).
-- Keine personenbezogenen Daten: nur Schlüssel, Signaturen, Laufnummern und Hashwerte.

-- ---------------------------------------------------------------------------------------------
-- Eigener Schlüsselwechsel (Verlauf). Während der Übergangszeit (bis grace_until) bleibt der bisherige
-- private Schlüssel verschlüsselt erhalten, damit Partner, die die Mitteilung noch nicht bestätigt haben,
-- weiter mit ihm signierte Nachrichten erhalten; danach wird er gelöscht (old_private_key_enc = null).
-- node_identity.previous_public_key zeigt den bisherigen Schlüssel während der Übergangszeit.
-- ---------------------------------------------------------------------------------------------
create table node_key_rotation (
  id                  uuid primary key,
  mode                text not null check (mode in ('routine','compromised')),
  old_public_key      text not null,
  new_public_key      text not null unique,
  old_private_key_enc text,                       -- AAD node_key_rotation.old_private_key:<id>
  statement           text,                       -- exakt signierte Rotationsaussage (JSON), nur 'routine'
  signature_old       text,                       -- Signatur der Aussage mit dem bisherigen Schlüssel
  signature_new       text,                       -- Signatur der Aussage mit dem neuen Schlüssel
  rotated_at          timestamptz not null,
  grace_until         timestamptz not null,
  finished_at         timestamptz,
  rotated_by          uuid references app_user(id) on delete set null,
  check ((mode = 'routine') = (statement is not null and signature_old is not null and signature_new is not null)),
  check (mode = 'routine' or old_private_key_enc is null),
  check (finished_at is not null or old_private_key_enc is not null)
);
-- höchstens ein laufender Wechsel
create unique index node_key_rotation_running on node_key_rotation ((true)) where finished_at is null;

-- Benachrichtigung je Partner und Bestätigung (signierte Antwort des Partners auf die Mitteilung)
create table node_key_rotation_peer (
  rotation_id       uuid not null references node_key_rotation(id) on delete cascade,
  peer_id           uuid not null references peer(id) on delete cascade,
  outbox_message_id uuid references outbox_message(id) on delete set null,
  confirmed_at      timestamptz,
  primary key (rotation_id, peer_id)
);
create index node_key_rotation_peer_open on node_key_rotation_peer(peer_id) where confirmed_at is null;

-- ---------------------------------------------------------------------------------------------
-- Schlüsselwechsel eines Partners: bisheriger Schlüssel wird nur bis previous_key_valid_until angenommen
-- ---------------------------------------------------------------------------------------------
alter table peer
  add column previous_public_key      text,
  add column previous_key_valid_until timestamptz,
  add column key_rotated_at           timestamptz,
  add constraint peer_previous_key_pair
    check ((previous_public_key is null) = (previous_key_valid_until is null));

-- ---------------------------------------------------------------------------------------------
-- Prüfpunkte der Audit-Kette: eigene (signiert, an Partner gesendet) und von Partnern verwahrte
-- Nur anhängen (grants.sql: kein UPDATE/DELETE für mesh_app).
-- ---------------------------------------------------------------------------------------------
create table audit_checkpoint (
  id          uuid primary key default gen_random_uuid(),
  seq         bigint not null unique,             -- Laufnummer des Kopfes der Audit-Kette
  hash        text not null,                      -- dessen Hash
  at          timestamptz not null,               -- Zeitpunkt des Prüfpunkts
  statement   text not null,                      -- exakt signierte Aussage (JSON)
  signature   text not null,                      -- Ed25519 des Knotens über statement
  public_key  text not null,                      -- signierender Schlüssel
  trigger     text not null check (trigger in ('schedule','manual','cli')),
  peers       integer not null default 0,         -- Anzahl benachrichtigter Partner
  created_at  timestamptz not null default now()
);

create table peer_audit_checkpoint (
  id            uuid primary key default gen_random_uuid(),
  peer_id       uuid not null references peer(id) on delete restrict,
  seq           bigint not null,
  hash          text not null,
  checkpoint_at timestamptz not null,
  statement     text not null,                    -- exakt signierte Aussage des Partners (JSON)
  signature     text not null,
  public_key    text not null,                    -- Schlüssel des Partners, mit dem die Signatur geprüft wurde
  message_id    uuid,                             -- Umschlag-id der Mitteilung
  received_at   timestamptz not null default now(),
  unique (peer_id, seq)
);
