-- Rechtevergabe. Wird nach jedem Migrationslauf und nach jeder Wiederherstellung erneut ausgeführt (idempotent).
-- Prinzip: mesh_app erhält nur, was der Server braucht; das Audit-Log darf er ausschließlich lesen und anhängen.

grant usage on schema public to mesh_app;
grant select, insert, update, delete on all tables in schema public to mesh_app;
grant usage, select on all sequences in schema public to mesh_app;
grant execute on all functions in schema public to mesh_app;

-- Audit-Log: nur lesen und anhängen
revoke update, delete, truncate on audit_log from mesh_app;
-- Migrationshistorie: nur lesen
revoke insert, update, delete, truncate on schema_migration from mesh_app;

-- BI-Schemata: mesh_app legt dort Tabellen/Views an; mesh_bi liest nur Views im Schema bi
grant usage, create on schema bi to mesh_app;
grant usage, create on schema bi_data to mesh_app;
grant usage on schema bi to mesh_bi;
revoke usage on schema public from public;
grant usage on schema public to mesh_app;
revoke all on schema bi_data from mesh_bi;
revoke all on all tables in schema public from mesh_bi;

-- Schlüsselwechsel und Prüfpunkte der Audit-Kette (Migration 0600). Bedingt, weil grants.sql auch für
-- Datenbanken mit älterem Schemastand ausgeführt wird (Tests einzelner Migrationen, Wiederherstellung).
do $$
begin
  if to_regclass('public.audit_checkpoint') is not null then
    -- eigene und von Partnern verwahrte Prüfpunkte: nur lesen und anhängen
    revoke update, delete, truncate on audit_checkpoint, peer_audit_checkpoint from mesh_app;
    -- Verlauf der eigenen Schlüsselwechsel bleibt erhalten
    revoke delete, truncate on node_key_rotation, node_key_rotation_peer from mesh_app;
  end if;
  -- Epochen der Audit-Kette (Migration 0610): schreibt nur mesh_owner (Migration, restore)
  if to_regclass('public.audit_chain_epoch') is not null then
    revoke insert, update, delete, truncate on audit_chain_epoch from mesh_app;
  end if;
  -- Migration 0630: eigene Prüfpunkte nur über audit_checkpoint_append() (prüft Epoche, Laufnummer und
  -- Hash, setzt created_at); Schlüsselverlauf nur Ende der Übergangszeit und Neuverschlüsselung.
  -- REVOKE auf Tabellenebene entfernt auch Spaltenrechte; deshalb danach erneut vergeben (idempotent).
  if to_regprocedure('public.audit_checkpoint_append(uuid,bigint,text,timestamptz,text,text,text,text,integer)')
     is not null then
    revoke insert on audit_checkpoint from mesh_app;
    revoke all on function
      audit_checkpoint_append(uuid, bigint, text, timestamptz, text, text, text, text, integer) from public;
    grant execute on function
      audit_checkpoint_append(uuid, bigint, text, timestamptz, text, text, text, text, integer) to mesh_app;
    revoke update on node_key_rotation from mesh_app;
    grant update (finished_at, old_private_key_enc) on node_key_rotation to mesh_app;
  end if;
end $$;
