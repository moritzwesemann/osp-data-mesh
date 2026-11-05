-- Excel-Dateien (.xlsx) als weitere Quellart neben CSV-Upload und HTTP-API.
-- Die Konfiguration (jsonb) hat dafür den Typ "xlsx"; OAuth2 für API-Quellen braucht keine
-- Schemaänderung (Konfiguration in connector.config, Client-Geheimnis in connector.secret_enc).
alter table connector drop constraint connector_kind_check;
alter table connector add constraint connector_kind_check
  check (kind in ('csv_upload', 'xlsx_upload', 'http_api'));
