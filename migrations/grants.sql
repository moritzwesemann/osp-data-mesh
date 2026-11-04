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
