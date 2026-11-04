#!/usr/bin/env bash
# OSP-Data-Mesh: Initialisierung der Datenbank im postgres-Container.
#
# Das offizielle postgres-Abbild führt Skripte in /docker-entrypoint-initdb.d/ nur beim allerersten
# Start mit leerem Datenverzeichnis aus (als Superuser, über den Unix-Socket). Dieses Skript ruft
# deploy/postgres/bootstrap.sql auf (eingebunden unter /opt/osp-data-mesh/bootstrap.sql), das die Rollen
# mesh_owner, mesh_app, mesh_bi und die Datenbank "mesh" anlegt. Das Schema selbst legt danach der
# Dienst "migrate" an (bun run cli migrate).
#
# Passwörter kommen aus der Umgebung des db-Dienstes (deploy/.env). Spätere Passwortänderungen:
# bootstrap.sql erneut ausführen (idempotent), siehe docs/betrieb.md.
set -euo pipefail

: "${MESH_DB_OWNER_PASSWORD:?MESH_DB_OWNER_PASSWORD fehlt}"
: "${MESH_DB_APP_PASSWORD:?MESH_DB_APP_PASSWORD fehlt}"
: "${MESH_DB_BI_PASSWORD:?MESH_DB_BI_PASSWORD fehlt}"

psql -v ON_ERROR_STOP=1 --no-psqlrc -q \
  --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v db_name=mesh \
  -v owner_password="$MESH_DB_OWNER_PASSWORD" \
  -v app_password="$MESH_DB_APP_PASSWORD" \
  -v bi_password="$MESH_DB_BI_PASSWORD" \
  -f /opt/osp-data-mesh/bootstrap.sql

echo "osp-data-mesh: Rollen und Datenbank 'mesh' angelegt"
