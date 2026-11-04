# Anforderungen und Nachverfolgbarkeit

Quelle: Ausschreibung "OSP-Data-Mesh", Landessportverband Baden-Württemberg e. V.
(https://tendigo.de/ausschreibung/osp-data-mesh-44e9d01029). Status: `offen` · `umgesetzt` ·
`umgesetzt, getestet` · `teilweise` · `nicht verifiziert`.

## Kern und Architektur

| ID | Anforderung | Modul / Artefakt | Test | Status |
|---|---|---|---|---|
| K1 | Modularer Monolith je Node | `src/server/app.ts`, `docs/architektur.md` | `tests/integration/core.test.ts` | offen |
| K2 | Containerisiert, reproduzierbar lokal/Dienstleister/Cloud | `deploy/` | – | offen |
| K3 | PostgreSQL | `migrations/`, `src/server/core/db.ts` | alle Integrationstests | offen |
| K4 | Athletenkern: Name, Vorname, Geburtsdatum, Sportart, Kaderstatus | `athletes` | `tests/integration/athletes.test.ts` | offen |
| K5 | Dokumentiertes Datenmodell | `docs/datenmodell.md` | – | offen |
| K6 | Betrieb ohne ursprünglichen Entwickler | `docs/`, CLI | Neuinstallation nach Doku | offen |

## Datenintegration und Datenprodukte

| ID | Anforderung | Modul / Artefakt | Test | Status |
|---|---|---|---|---|
| D1 | CSV-Uploads | `connectors` | `tests/integration/connectors.test.ts` | offen |
| D2 | APIs, Messsysteme, Fachanwendungen, Cloud-Quellen | `connectors` (HTTP-API), Mock-Messsystem | `connectors.test.ts`, Demo | offen |
| D3 | Wiederverwendbare Connector- und Mapping-Definitionen | `connectors` (Export/Import, Vorlagen) | `connectors.test.ts` | offen |
| D4 | Upload/Abruf, Vorschau, Mapping | `connectors`, UI | `connectors.test.ts` | offen |
| D5 | Plausibilitäts- und Formatprüfung | `connectors/validate` | `tests/unit/import-validation.test.ts` | offen |
| D6 | Fehlerprotokoll, Speicherung, Audit-Trail | `connectors`, `audit` | `connectors.test.ts` | offen |
| D7 | Datenprodukte als Views | `products`, `bi` | `products.test.ts`, `bi.test.ts` | offen |
| D8 | CSV-, JSON-, XML-Exporte | `products` (`access.data`) | `products.test.ts` | offen |
| D9 | API-Endpunkte | `access.data`, API-Tokens | `products.test.ts` | offen |
| D10 | Mobil-responsives Frontend für Datenausschnitte | `src/ui` | Screenshots | offen |

## Austausch und Metadaten

| ID | Anforderung | Modul / Artefakt | Test | Status |
|---|---|---|---|---|
| A1 | Kontrollierter, protokollierter Austausch, keine Gesamtsynchronisation | `federation` | `tests/integration/federation.test.ts`, Demo | offen |
| A2 | Austausch nur mit Berechtigung und Freigabe | `releases` (PEP), `federation` | `federation.test.ts` | offen |
| A3 | Beschränkung nach Zeilen/Spalten, Zeit, Zweck | `releases/engine.ts` | `tests/unit/release-engine.test.ts` | umgesetzt, getestet |
| M1 | Lokaler Metadatenkatalog (Quellen, Strukturen, Felder, Connectoren, Mappings, Produkte) | `catalog` | `catalog.test.ts` | offen |
| M2 | Katalogattribute Version, Kategorie, Teilbarkeit | `catalog` | `catalog.test.ts` | offen |
| M3 | Discovery ohne zentrale Datensammelstelle | `federation` (`discovery.search`) | `federation.test.ts` | offen |

## BI

| ID | Anforderung | Modul / Artefakt | Test | Status |
|---|---|---|---|---|
| B1 | Apache Superset (oder gleichwertig) | `deploy/superset` | – | offen |
| B2 | 2–3 Referenz-Dashboards | `deploy/superset/dashboards` | – | offen |
| B3 | Keine proprietäre Zugriffsschicht; Excel, Power BI, SAP AC, Tableau, Python | Schema `bi` (Postgres, read-only), REST/CSV/JSON/XML | `bi.test.ts` | offen |

## Rollen, Rechte, Datenschutz, Sicherheit

| ID | Anforderung | Modul / Artefakt | Test | Status |
|---|---|---|---|---|
| R1 | Freigabe mindestens je Datensatz und Empfängerrolle | `releases` | `release-engine.test.ts`, `releases.test.ts` | offen |
| R2 | Nicht freigegebene Daten standardmäßig ausgeschlossen | `releases/engine.ts` | `release-engine.test.ts` | umgesetzt, getestet |
| R3 | Consent außerhalb, optional im System dokumentiert | `athletes` (Einwilligungen) | `athletes.test.ts`, `release-engine.test.ts` | offen |
| R4 | Gesundheitsdaten als besondere Kategorie (Art. 9) | `datasets`, `releases/engine.ts` | `release-engine.test.ts` | offen |
| R5 | Protokollierung von Zugriffen, Freigaben, Änderungen, Widerrufen, Austausch | `audit` + alle Module | `audit.test.ts`, Demo | offen |
| S1 | Verschlüsselung bei der Übertragung | Caddy (TLS), Signaturen | `federation.test.ts` | offen |
| S2 | Sichere Authentifizierung | `auth` | `tests/integration/security.test.ts` | offen |
| S3 | Rollen- und Rechteverwaltung | `auth`, `core/http.ts` | `security.test.ts` | offen |
| S4 | Schlüsselverwaltung | `core/crypto.ts`, CLI | `tests/unit/crypto.test.ts` | offen |
| S5 | Trennung externer und interner Dienste | `deploy/docker-compose.yml` (Netze), DB-Rollen | `core.test.ts` | offen |
| S6 | Backup und Wiederherstellung | `system`, CLI | `tests/integration/backup.test.ts` | offen |
| S7 | Schwachstellenmanagement | `docs/sicherheit.md`, SBOM | – | offen |
| S8 | Updatefähigkeit | Migrationen, `docs/betrieb.md` | `core.test.ts` | offen |
| S9 | Incident Response | `docs/incident-response.md` | – | offen |
| S10 | Sichtbare und protokollierte Fehlerbehandlung | `core/http.ts`, `app_error`, UI | `tests/integration/errors.test.ts` | offen |
| S11 | Konzept für widerrufene oder weitergegebene Daten | `docs/widerruf-und-weitergabe.md`, `federation` | `federation.test.ts` | offen |

## Übergabe und Anbieterunabhängigkeit

| ID | Anforderung | Artefakt | Status |
|---|---|---|---|
| U1 | Quellcode, Repository | dieses Repository | offen |
| U2 | Datenbankschema und Migrationsskripte | `migrations/`, `docs/datenmodell.md` | offen |
| U3 | API-Dokumentation | `/api/v1/openapi.json`, `docs/api.md` | offen |
| U4 | Deployment-Konfiguration | `deploy/` | offen |
| U5 | Testfälle, automatisierte Tests | `tests/` | offen |
| U6 | Architekturentscheidungen (ADRs) | `docs/adr/` | offen |
| U7 | Betriebs- und Installationsdokumentation | `docs/installation.md`, `docs/betrieb.md` | offen |
| U8 | Drittkomponenten und Lizenzen | `docs/lizenzen.md` | offen |
| U9 | SBOM CycloneDX (BSI TR-03183-2) | `sbom/`, `scripts/sbom.ts` | offen |
| U10 | Deutschsprachige HTML-Webdokumentation | `scripts/build-docs.ts` → `/hilfe` | offen |
| U11 | Open-Source-Lizenz gemäß openCode | `LICENSE` (EUPL-1.2, vorläufig) | offen |

## Abnahmekriterien

| ID | Kriterium | Nachweis | Status |
|---|---|---|---|
| AK1 | ≥ 2 CSV-Quellen und 1 API-Quelle durchgängig verarbeitet | `bun run demo` | offen |
| AK2 | ≥ 3 Node-Instanzen | `bun run demo` (3 Knoten, 3 Cluster) | offen |
| AK3 | Neuinstallation in leerer Umgebung nur nach Doku | Protokoll in `docs/abnahme.md` | offen |
| AK4 | Tests für Sicherheit, Backup, Wiederherstellung, Fehlerbehandlung | `bun test` | offen |
