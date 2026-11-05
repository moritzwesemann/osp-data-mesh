-- Härtung der externen Verankerung der Audit-Kette (ADR 0014, Nachtrag): Epochen der Kette nach einer
-- Wiederherstellung, Prüfpunkte je (Epoche, Laufnummer), Grundlage der Ratenbegrenzung beim Partner.
-- Keine personenbezogenen Daten.

-- ---------------------------------------------------------------------------------------------
-- Epochen der Audit-Kette. Eine Wiederherstellung setzt die Kette auf den Stand der Sicherung zurück; danach
-- vergibt der Trigger Laufnummern erneut, die Hashes unterscheiden sich von denen vor der Wiederherstellung.
-- Jede Wiederherstellung beginnt deshalb eine neue Epoche (restore, src/server/modules/system/restore.ts):
-- die Einträge 1..restored_seq stammen aus der vorigen Epoche, alles danach ist neu. Prüfpunkte nennen ihre
-- Epoche; Partner verwahren sie je (Epoche, Laufnummer).
-- Die aktuelle Epoche ist die mit der höchsten Nummer n. Eine wiederhergestellte Datenbank bringt den
-- Epochenverlauf der Sicherung mit; restore trägt danach die neue Epoche ein.
-- Nur mesh_owner (Migration, restore) schreibt; mesh_app liest nur (grants.sql).
-- ---------------------------------------------------------------------------------------------
create table audit_chain_epoch (
  n                 integer primary key check (n >= 1),
  epoch             uuid not null unique,
  started_at        timestamptz not null default clock_timestamp(),
  reason            text not null check (reason in ('initial','restore')),
  previous_epoch    uuid,                         -- vorige Epoche (bei restore; null nur ohne bekannten Verlauf)
  restored_seq      bigint check (restored_seq >= 0), -- höchste aus der Sicherung übernommene Laufnummer
  backup_sha256     text,
  backup_created_at timestamptz,
  check ((reason = 'restore') = (restored_seq is not null)),
  check (reason = 'restore' or previous_epoch is null)
);

insert into audit_chain_epoch (n, epoch, reason) values (1, gen_random_uuid(), 'initial');

-- ---------------------------------------------------------------------------------------------
-- Eigene Prüfpunkte: Epoche (bisherige Prüfpunkte gehören zur ersten Epoche), eindeutig je (Epoche, seq)
-- ---------------------------------------------------------------------------------------------
alter table audit_checkpoint add column epoch uuid;
update audit_checkpoint set epoch = (select epoch from audit_chain_epoch where n = 1);
alter table audit_checkpoint alter column epoch set not null;
alter table audit_checkpoint drop constraint audit_checkpoint_seq_key;
alter table audit_checkpoint add constraint audit_checkpoint_epoch_seq_key unique (epoch, seq);

-- ---------------------------------------------------------------------------------------------
-- Von Partnern verwahrte Prüfpunkte: Epoche aus der signierten Aussage (null nur bei Aussagen ohne Epoche,
-- d. h. von Knoten vor dieser Migration); je Partner und Epoche nur steigende Laufnummern (anchors.ts)
-- ---------------------------------------------------------------------------------------------
alter table peer_audit_checkpoint add column epoch uuid;
alter table peer_audit_checkpoint drop constraint peer_audit_checkpoint_peer_id_seq_key;
alter table peer_audit_checkpoint
  add constraint peer_audit_checkpoint_peer_epoch_seq_key unique nulls not distinct (peer_id, epoch, seq);
-- Ratenbegrenzung je Partner (Prüfpunkte der letzten 24 Stunden)
create index peer_audit_checkpoint_received on peer_audit_checkpoint (peer_id, received_at);
