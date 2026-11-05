-- Härtung der externen Verankerung der Audit-Kette (ADR 0014, Nachtrag 2). Keine personenbezogenen Daten.

-- ---------------------------------------------------------------------------------------------
-- Eigene Prüfpunkte nur noch über audit_checkpoint_append() (grants.sql: kein INSERT für mesh_app).
-- Bisher konnte mesh_app beliebige Zeilen anhängen, etwa mit created_at in ferner Zukunft (der Planer
-- erstellte dann nie wieder einen Prüfpunkt) oder für künftige Laufnummern (createCheckpoint fände
-- „bestehende“ Prüfpunkte und sendete nichts). Die Funktion nimmt nur Prüfpunkte der aktuellen Epoche zu
-- einem vorhandenen Eintrag der Kette mit dessen gespeichertem Hash an und setzt created_at selbst. Die
-- Signatur prüft die Datenbank nicht (kein Ed25519); der Planer und der Export werten nur Prüfpunkte aus,
-- deren Signatur zu einem eigenen Schlüssel passt (anchors.ts).
-- ---------------------------------------------------------------------------------------------
create or replace function audit_checkpoint_append(
  p_epoch uuid, p_seq bigint, p_hash text, p_at timestamptz, p_statement text, p_signature text,
  p_public_key text, p_trigger text, p_peers integer
) returns audit_checkpoint
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  cur     uuid;
  stored  text;
  inserted public.audit_checkpoint;
begin
  select e.epoch into cur from public.audit_chain_epoch e order by e.n desc limit 1;
  if cur is null or p_epoch is distinct from cur then
    raise exception 'audit_checkpoint_append: not the current epoch' using errcode = 'check_violation';
  end if;
  select a.hash into stored from public.audit_log a where a.seq = p_seq;
  if stored is null or stored is distinct from p_hash then
    raise exception 'audit_checkpoint_append: seq/hash not in audit_log' using errcode = 'check_violation';
  end if;
  insert into public.audit_checkpoint
    (seq, hash, epoch, at, statement, signature, public_key, trigger, peers, created_at)
  values (p_seq, p_hash, p_epoch, p_at, p_statement, p_signature, p_public_key, p_trigger,
          coalesce(p_peers, 0), clock_timestamp())
  returning * into inserted;
  return inserted;
end $$;
revoke all on function audit_checkpoint_append(uuid, bigint, text, timestamptz, text, text, text, text, integer)
  from public;

-- ---------------------------------------------------------------------------------------------
-- Epochen: Stand unmittelbar vor der Wiederherstellung (Epoche, Laufnummer und gespeicherter Hash des
-- Kopfes). Mit Sicherungsprüfsumme und -zeitpunkt ins Anker-Profil übernommen; Prüfpunkte der damaligen
-- Epoche hinter diesem Kopf kann es bei einer echten Wiederherstellung nicht geben (anchors.ts).
-- null = unbekannt (Wiederherstellung in eine leere Datenbank oder vor dieser Migration).
-- ---------------------------------------------------------------------------------------------
alter table audit_chain_epoch
  add column pre_restore_epoch uuid,
  add column pre_restore_seq   bigint check (pre_restore_seq >= 0),
  add column pre_restore_hash  text,
  add constraint audit_chain_epoch_pre_restore
    check ((pre_restore_seq is null) = (pre_restore_hash is null) and
           (reason = 'restore' or pre_restore_seq is null));
-- Wiederherstellung einer Sicherung vor dieser Migration: restore hat den Kopf davor im Audit-Eintrag
-- backup.restore festgehalten (details.preRestore); hier nachtragen
update audit_chain_epoch e
   set pre_restore_epoch = (a.details->'preRestore'->>'epoch')::uuid,
       pre_restore_seq   = (a.details->'preRestore'->>'seq')::bigint,
       pre_restore_hash  = a.details->'preRestore'->>'hash'
  from audit_log a
 where a.action = 'backup.restore'
   and a.details->>'epoch' = e.epoch::text
   and jsonb_typeof(a.details->'preRestore') = 'object'
   and a.details->'preRestore'->>'seq' is not null
   and a.details->'preRestore'->>'hash' is not null
   and e.reason = 'restore' and e.pre_restore_seq is null;

-- ---------------------------------------------------------------------------------------------
-- Schlüsselverlauf: mesh_app ändert nur noch finished_at und old_private_key_enc (grants.sql,
-- Spaltenrechte; Ende der Übergangszeit, Abbruch bei Kompromittierung, Neuverschlüsselung beim Wechsel des
-- Master-Keys). Gültigkeitszeiträume (mode, rotated_at, grace_until, Schlüssel) bleiben wie geschrieben.
-- Der Trigger verhindert zusätzlich, dass ein beendeter Wechsel wieder geöffnet oder verschoben wird.
-- ---------------------------------------------------------------------------------------------
create or replace function node_key_rotation_guard() returns trigger language plpgsql as $$
begin
  if old.finished_at is not null and new.finished_at is distinct from old.finished_at then
    raise exception 'node_key_rotation: finished_at is final' using errcode = 'check_violation';
  end if;
  if new.finished_at is not null and new.finished_at < old.rotated_at then
    raise exception 'node_key_rotation: finished_at before rotated_at' using errcode = 'check_violation';
  end if;
  if old.old_private_key_enc is null and new.old_private_key_enc is not null then
    raise exception 'node_key_rotation: discarded key cannot return' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger node_key_rotation_guard before update on node_key_rotation
  for each row execute function node_key_rotation_guard();

-- ---------------------------------------------------------------------------------------------
-- Von Partnern verwahrte Prüfpunkte: steigende Laufnummern je Partner, Epoche UND signierendem Schlüssel
-- (anchors.ts). Ein gestohlener, später ersetzter Schlüssel kann so mit einer sehr hohen Laufnummer nicht
-- alle späteren Prüfpunkte der Epoche blockieren.
-- ---------------------------------------------------------------------------------------------
create index peer_audit_checkpoint_key_order
  on peer_audit_checkpoint (peer_id, epoch, public_key, seq desc);
