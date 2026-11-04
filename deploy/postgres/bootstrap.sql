-- OSP-Data-Mesh: einmalige Datenbank-Initialisierung (als Superuser ausführen).
-- Legt die drei Rollen und die Knoten-Datenbank an. Idempotent.
--
-- Aufruf:
--   psql "<superuser-url>" -v ON_ERROR_STOP=1 \
--     -v db_name=mesh -v owner_password=... -v app_password=... -v bi_password=... \
--     -f deploy/postgres/bootstrap.sql
--
-- Rollen:
--   mesh_owner  besitzt das Schema, führt Migrationen und Wiederherstellungen aus (nur CLI, nie der Server-Prozess)
--   mesh_app    Laufzeitrolle des Servers; darf das Audit-Log nur lesen und anhängen
--   mesh_bi     rein lesende BI-Rolle; sieht ausschließlich das Schema "bi"

\set ON_ERROR_STOP on

select format('create role mesh_owner login password %L', :'owner_password')
  where not exists (select 1 from pg_roles where rolname = 'mesh_owner') \gexec
select format('create role mesh_app login password %L', :'app_password')
  where not exists (select 1 from pg_roles where rolname = 'mesh_app') \gexec
select format('create role mesh_bi login password %L', :'bi_password')
  where not exists (select 1 from pg_roles where rolname = 'mesh_bi') \gexec

-- Passwörter bei erneutem Aufruf angleichen (Rotation)
select format('alter role mesh_owner password %L', :'owner_password') \gexec
select format('alter role mesh_app password %L', :'app_password') \gexec
select format('alter role mesh_bi password %L', :'bi_password') \gexec

alter role mesh_bi set default_transaction_read_only = on;
alter role mesh_bi set statement_timeout = '60s';
alter role mesh_app set statement_timeout = '120s';

select format('create database %I owner mesh_owner encoding ''UTF8''', :'db_name')
  where not exists (select 1 from pg_database where datname = :'db_name') \gexec

select format('revoke all on database %I from public', :'db_name') \gexec
select format('grant connect, temporary on database %I to mesh_app', :'db_name') \gexec
select format('grant connect on database %I to mesh_bi', :'db_name') \gexec

\connect :db_name
revoke create on schema public from public;
