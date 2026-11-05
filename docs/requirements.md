# Anforderungen und Nachverfolgbarkeit

Quelle: Ausschreibung "OSP-Data-Mesh", Landessportverband Baden-Württemberg e. V.
(https://tendigo.de/ausschreibung/osp-data-mesh-44e9d01029).

Status: **getestet** = umgesetzt und durch automatisierte Tests bzw. die Demo (`bun run demo`) belegt ·
**umgesetzt** = umgesetzt und dokumentiert, ohne eigenen automatisierten Test · **nicht verifiziert** =
umgesetzt, aber in der Entwicklungsumgebung nicht lauffähig prüfbar (kein Docker) · **teilweise** · **offen**.

Stand der Prüfung: `bun test` 637 Tests in 42 Dateien bestanden; `bun run demo` 57 Prüfungen bestanden
(3 Knoten, 3 PostgreSQL-Cluster, echtes HTTP); Neuinstallation nach Dokumentation (nativ) durchgeführt.

## Kern und Architektur

| ID | Anforderung | Modul / Artefakt | Nachweis | Status |
|---|---|---|---|---|
| K1 | Modularer Monolith je Node | `src/server/app.ts`, [Architektur](architektur.md), ADR 0001 | `core.test.ts`, `contract.test.ts` | getestet |
| K2 | Containerisiert, reproduzierbar lokal/Dienstleister/Cloud | `deploy/Dockerfile`, `deploy/docker-compose.yml`, Caddy | statisch geprüft (hadolint, `caddy validate`, Compose-Prüfskript) | nicht verifiziert |
| K3 | PostgreSQL | `migrations/`, `src/server/core/db.ts` | alle Integrationstests | getestet |
| K4 | Athletenkern: Name, Vorname, Geburtsdatum, Sportart, Kaderstatus | Modul `athletes` | `athletes.test.ts`, Demo | getestet |
| K5 | Dokumentiertes Datenmodell | [Datenmodell](datenmodell.md) | – | umgesetzt |
| K6 | Betrieb ohne ursprünglichen Entwickler | Dokumentation, CLI | Neuinstallation nach Doku (siehe AK3) | umgesetzt |

## Datenintegration und Datenprodukte

| ID | Anforderung | Modul / Artefakt | Nachweis | Status |
|---|---|---|---|---|
| D1 | CSV-Uploads | `connectors` | `connectors.test.ts`, Demo (5 CSV-Dateien, u. a. windows-1252) | getestet |
| D2 | APIs, Messsysteme, Fachanwendungen, Cloud-Quellen | generischer HTTP-API-Connector (Bearer/Header, Paging, Allowlist), Mock-Messsystem | `connectors.test.ts`, `fix-connectors-*.test.ts`, Demo | teilweise (generisch; keine herstellerspezifischen Connectoren) |
| D3 | Wiederverwendbare Connector- und Mapping-Definitionen | Export/Import, 4 Vorlagen | `connectors.test.ts` | getestet |
| D4 | Upload/Abruf, Vorschau, Mapping | `connectors`, Oberfläche | `connectors.test.ts`, Screenshots | getestet |
| D5 | Plausibilitäts- und Formatprüfung | `connectors/pipeline.ts` | `import-pipeline.test.ts`, `import-validation.test.ts`, `fix-import-limits.test.ts` | getestet |
| D6 | Fehlerprotokoll, Speicherung, Audit-Trail | `connectors`, `audit` | `connectors.test.ts`, `fix-connectors-erasure.test.ts` | getestet |
| D7 | Datenprodukte als Views | `products`, `bi` | `products.test.ts`, `bi.test.ts` | getestet |
| D8 | CSV-, JSON-, XML-Exporte | `access.data` | `products.test.ts`, Demo | getestet |
| D9 | API-Endpunkte | REST `/api/v1`, API-Tokens, OpenAPI | `products.test.ts`, `contract.test.ts` | getestet |
| D10 | Mobil-responsives Frontend für Datenausschnitte | `src/ui` | Browser-Durchlauf aller Rollen (Desktop/Mobil), [Oberfläche](oberflaeche.md), `ui-i18n.test.ts` | umgesetzt (keine automatisierten UI-Ablauftests) |

## Austausch und Metadaten

| ID | Anforderung | Modul / Artefakt | Nachweis | Status |
|---|---|---|---|---|
| A1 | Kontrollierter, protokollierter Austausch, keine Gesamtsynchronisation | `federation` (Pull, beidseitig protokolliert) | `federation-protocol.test.ts`, `federation-exchange.test.ts`, Demo | getestet |
| A2 | Austausch nur mit Berechtigung und Freigabe | PEP `releases/pep.ts` | `pep.test.ts`, Demo | getestet |
| A3 | Beschränkung nach Zeilen/Spalten, Zeit, Zweck | `releases/engine.ts` | `release-engine.test.ts` (inkl. Zufallsinvarianten), Demo | getestet |
| M1 | Lokaler Metadatenkatalog (Quellen, Strukturen, Felder, Connectoren, Mappings, Produkte) | `catalog` | `catalog.test.ts` | getestet |
| M2 | Katalogattribute Version, Kategorie, Teilbarkeit | `catalog` | `catalog.test.ts` | getestet |
| M3 | Discovery ohne zentrale Datensammelstelle | `discovery.search` (paralleler Abruf je Partner) | `federation-exchange.test.ts`, Demo | getestet |

## BI

| ID | Anforderung | Modul / Artefakt | Nachweis | Status |
|---|---|---|---|---|
| B1 | Apache Superset (oder gleichwertig) | Compose-Profil `bi`, `deploy/superset/` | – | nicht verifiziert |
| B2 | 2–3 Referenz-Dashboards | `deploy/superset/bootstrap_superset.py` (3 Dashboards) | zugrunde liegende Views in der Demo geprüft | nicht verifiziert |
| B3 | Offene Schnittstellen (Excel, Power BI, SAP AC, Tableau, Python) | Schema `bi` (Rolle `mesh_bi`, nur lesend), REST CSV/JSON/XML | `bi.test.ts`, Demo (Zugriff als `mesh_bi`) | getestet (Schnittstellen); Werkzeuge selbst nicht getestet |

## Rollen, Rechte, Datenschutz, Sicherheit

| ID | Anforderung | Modul / Artefakt | Nachweis | Status |
|---|---|---|---|---|
| R1 | Freigabe mindestens je Datensatz und Empfängerrolle | `releases` | `release-engine.test.ts`, `releases.test.ts` | getestet |
| R2 | Nicht freigegebene Daten standardmäßig ausgeschlossen | `releases/engine.ts` | `release-engine.test.ts` | getestet |
| R3 | Consent außerhalb, optional im System dokumentiert | Einwilligungen (`athletes`) | `athletes.test.ts`, `pep.test.ts`, `fix-consent-delivered-category.test.ts` | getestet |
| R4 | Gesundheitsdaten als besondere Kategorie (Art. 9) | `datasets`, Engine, Neueinstufung | `release-engine.test.ts`, `fix-data-reclassification.test.ts` | getestet |
| R5 | Protokollierung von Zugriffen, Freigaben, Änderungen, Widerrufen, Austausch | Audit-Log (append-only, Hash-Kette) | `audit.test.ts`, `core.test.ts`, Demo | getestet |
| S1 | Verschlüsselung bei der Übertragung | TLS über Caddy; Ed25519-Signaturen auf Anfrage und Antwort | Signaturen: `federation-protocol.test.ts`; TLS: nicht verifiziert | teilweise |
| S2 | Sichere Authentifizierung | Argon2id, Sitzungen (`__Host-`), Sperre, CSRF, API-Tokens | `security.test.ts`, `fix-auth-*.test.ts`, `fix-proxy-and-cookie.test.ts` | getestet |
| S3 | Rollen- und Rechteverwaltung | `auth`, `core/http.ts` | `security.test.ts`, `contract.test.ts` | getestet |
| S4 | Schlüsselverwaltung | AES-256-GCM, Master-Key-Rotation (CLI), Knotenschlüssel | `crypto.test.ts`; Rotation des Knoten-Signaturschlüssels nicht umgesetzt | teilweise |
| S5 | Trennung externer und interner Dienste | DB-Rollen, Compose-Netze, Proxy-Vertrauensliste | `core.test.ts`, `client-ip.test.ts`; Netze nicht verifiziert | teilweise |
| S6 | Backup und Wiederherstellung | verschlüsselte Sicherungen, CLI `restore`, Knotensperre | `backup.test.ts`, `fix-cli-operations.test.ts`, `fix-node-lock.test.ts`, Neuinstallation | getestet |
| S7 | Schwachstellenmanagement | Prozess in [Sicherheit](sicherheit.md), SBOM, `bun audit` | – | umgesetzt (Prozess) |
| S8 | Updatefähigkeit | versionierte Migrationen mit Prüfsummen, [Betrieb](betrieb.md) | `core.test.ts` | umgesetzt |
| S9 | Incident Response | [Incident Response](incident-response.md) | – | umgesetzt (Konzept) |
| S10 | Sichtbare und protokollierte Fehlerbehandlung | `core/http.ts`, `app_error`, übersetzte Fehlercodes | `errors.test.ts`, `ui-i18n.test.ts` | getestet |
| S11 | Konzept für widerrufene oder weitergegebene Daten | [Widerruf und Weitergabe](widerruf-und-weitergabe.md), signierte Mitteilungen | `federation-exchange.test.ts`, `fix-federation-notices.test.ts`, Demo | getestet |

## Übergabe und Anbieterunabhängigkeit

| ID | Anforderung | Artefakt | Status |
|---|---|---|---|
| U1 | Quellcode, Repository | dieses Repository (lokal, nicht veröffentlicht) | umgesetzt |
| U2 | Datenbankschema und Migrationsskripte | `migrations/`, [Datenmodell](datenmodell.md) | umgesetzt |
| U3 | API-Dokumentation | `/api/v1/openapi.json` (aus dem Vertrag erzeugt), [API](api.md) | getestet (`contract.test.ts`) |
| U4 | Deployment-Konfiguration | `deploy/` | nicht verifiziert (kein Docker) |
| U5 | Testfälle, automatisierte Tests | `tests/` (637 Tests) | umgesetzt |
| U6 | Architekturentscheidungen (ADRs) | `docs/adr/` (12 ADRs) | umgesetzt |
| U7 | Betriebs- und Installationsdokumentation | [Installation](installation.md), [Betrieb](betrieb.md) | umgesetzt, nativ erprobt |
| U8 | Drittkomponenten und Lizenzen | [Lizenzen](lizenzen.md) | umgesetzt |
| U9 | SBOM CycloneDX (BSI TR-03183-2) | `sbom/osp-data-mesh.cdx.json`, `bun run sbom` | teilweise (Lücken zu TR-03183-2 dokumentiert) |
| U10 | Deutschsprachige HTML-Webdokumentation | `bun run build:docs` → `/hilfe/` (31 Seiten) | umgesetzt |
| U11 | Open-Source-Lizenz gemäß openCode | `LICENSE` (EUPL-1.2, vorläufig; endgültige Wahl vor Veröffentlichung) | umgesetzt (vorläufig) |
| – | Schulungen, Pflege, Leistungen nach Aufwand | nicht Teil der Software | offen (außerhalb des Umfangs) |

## Abnahmekriterien

| ID | Kriterium | Nachweis | Status |
|---|---|---|---|
| AK1 | ≥ 2 CSV-Quellen und 1 API-Quelle durchgängig verarbeitet | `bun run demo`: Athleten-, Leistungsdiagnostik- und Verletzungs-CSV (osp-nord), Athleten-CSV (osp-mitte, osp-sued), Sprungkraft-API (Mock-Messsystem) bis Freigabe, BI und Austausch | getestet |
| AK2 | ≥ 3 Node-Instanzen | `bun run demo`: 3 Knoten mit je eigenem Cluster, gegenseitigem Vertrauen und Austausch (lokal, nicht an Pilotstandorten) | getestet (lokal) |
| AK3 | Neuinstallation in leerer Umgebung nur nach Doku | nativer Durchlauf aus `git archive` in ein leeres Verzeichnis mit neuen Ports: Installation, Import, Freigabe, Token-Abruf, Sicherung, Wiederherstellung, zweiter Knoten mit Vertrauen und Austausch bestanden; gefundene Dokumentationsmängel danach behoben. Docker-Variante, systemd und Caddy nicht geprüft | teilweise (nativ bestanden; Docker offen) |
| AK4 | Tests für Sicherheit, Backup, Wiederherstellung, Fehlerbehandlung | `security.test.ts`, `fix-*.test.ts`, `backup.test.ts`, `fix-cli-operations.test.ts`, `fix-node-lock.test.ts`, `errors.test.ts` | getestet |
