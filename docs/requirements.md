# Anforderungen und Nachverfolgbarkeit

Quelle: Ausschreibung "OSP-Data-Mesh", Landessportverband Baden-Württemberg e. V.
(https://tendigo.de/ausschreibung/osp-data-mesh-44e9d01029).

Status: **getestet** = umgesetzt und durch automatisierte Tests bzw. die Demo (`bun run demo`) belegt ·
**umgesetzt** = umgesetzt und dokumentiert, ohne eigenen automatisierten Test · **nicht verifiziert** =
umgesetzt, aber in der Entwicklungsumgebung nicht lauffähig prüfbar · **teilweise** · **offen**.

Stand der Prüfung: `bun test` (Unit und Integration) bestanden; `bun run test:e2e` 12 Browser-Abläufe
bestanden; `bun run demo` 57 Prüfungen bestanden (3 Knoten, 3 PostgreSQL-Cluster, echtes HTTP);
Neuinstallation nach Dokumentation nativ und mit Docker durchgeführt; `deploy/verify-deployment.sh`
(TLS, Netztrennung, BI-Zugang, Superset) bestanden. Genaue Zahlen im Abschnitt „Interner
Vorabnahme-Durchlauf“ von [Abnahme](abnahme.md).

## Kern und Architektur

| ID | Anforderung | Modul / Artefakt | Nachweis | Status |
|---|---|---|---|---|
| K1 | Modularer Monolith je Node | `src/server/app.ts`, [Architektur](architektur.md), ADR 0001 | `core.test.ts`, `contract.test.ts` | getestet |
| K2 | Containerisiert, reproduzierbar lokal/Dienstleister/Cloud | `deploy/Dockerfile`, `deploy/docker-compose.yml`, Caddy | Docker 29.5 / Compose 5.7 (Colima, arm64): Abbild ohne Cache gebaut (`--frozen-lockfile`, Nutzer uid 1000), Datenbank und Knoten `healthy`, zweites Compose-Projekt auf demselben Host; `deploy/verify-deployment.sh` (alle Prüfungen bestanden); `tests/unit/deploy-config.test.ts`. Nicht geprüft: amd64, öffentliche Domain mit ACME | getestet |
| K3 | PostgreSQL | `migrations/`, `src/server/core/db.ts` | alle Integrationstests | getestet |
| K4 | Athletenkern: Name, Vorname, Geburtsdatum, Sportart, Kaderstatus | Modul `athletes` | `athletes.test.ts`, Demo | getestet |
| K5 | Dokumentiertes Datenmodell | [Datenmodell](datenmodell.md) | – | umgesetzt |
| K6 | Betrieb ohne ursprünglichen Entwickler | Dokumentation, CLI | Neuinstallation nach Doku (siehe AK3) | umgesetzt |

## Datenintegration und Datenprodukte

| ID | Anforderung | Modul / Artefakt | Nachweis | Status |
|---|---|---|---|---|
| D1 | CSV-Uploads | `connectors` (CSV und Excel `.xlsx`, ADR 0015) | `connectors.test.ts`, `connectors-xlsx.test.ts`, `import-xlsx.test.ts` (u. a. ZIP-Bombe, Vervielfachung über gemeinsame Texte), Demo (5 CSV-Dateien, u. a. windows-1252) | getestet |
| D2 | APIs, Messsysteme, Fachanwendungen, Cloud-Quellen | generischer HTTP-API-Connector (Bearer, Header, OAuth2 Client Credentials; Paging; Allowlist), Excel-Dateien, Mock-Messsystem | `connectors.test.ts`, `connectors-oauth2.test.ts`, `fix-connectors-*.test.ts`, Demo | getestet (generisch); herstellerspezifische Connectoren und echte Systeme offen (Zugang/Spezifikation der Hersteller nötig) |
| D3 | Wiederverwendbare Connector- und Mapping-Definitionen | Export/Import, 6 Vorlagen | `connectors.test.ts`, `import-pipeline.test.ts` | getestet |
| D4 | Upload/Abruf, Vorschau, Mapping | `connectors`, Oberfläche (CSV, Excel mit Blattwahl und Kopfzeilenerkennung) | `connectors.test.ts`, `connectors-xlsx.test.ts`, UI-Ablauftest Import | getestet |
| D5 | Plausibilitäts- und Formatprüfung | `connectors/pipeline.ts` | `import-pipeline.test.ts`, `import-validation.test.ts`, `fix-import-limits.test.ts` | getestet |
| D6 | Fehlerprotokoll, Speicherung, Audit-Trail | `connectors`, `audit` | `connectors.test.ts`, `fix-connectors-erasure.test.ts` | getestet |
| D7 | Datenprodukte als Views | `products`, `bi` | `products.test.ts`, `bi.test.ts` | getestet |
| D8 | CSV-, JSON-, XML-Exporte | `access.data` | `products.test.ts`, Demo | getestet |
| D9 | API-Endpunkte | REST `/api/v1`, API-Tokens, OpenAPI | `products.test.ts`, `contract.test.ts` | getestet |
| D10 | Mobil-responsives Frontend für Datenausschnitte | `src/ui` | `bun run test:e2e` (12 Abläufe im Browser gegen echte Knoten, Desktop, 1000 px und 390 px; 5 Läufe in Folge bestanden), [Oberfläche](oberflaeche.md), `ui-i18n.test.ts` | getestet |

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
| B1 | Apache Superset (oder gleichwertig) | Compose-Profil `bi`, `deploy/superset/` | Superset 6.1.0 lokal (venv) und als Compose-Profil `bi` (Docker): `bootstrap_superset.py --verify` – alle 13 Diagramme liefern Daten, auch über Caddy/HTTPS | getestet |
| B2 | 2–3 Referenz-Dashboards | `deploy/superset/bootstrap_superset.py` (3 Dashboards, 13 Diagramme) | alle 13 Diagrammabfragen liefern Daten (venv und Docker); Screenshots 17–19 in [Oberfläche/BI](bi.md) | getestet |
| B3 | Offene Schnittstellen (Excel, Power BI, SAP AC, Tableau, Python) | Schema `bi` (Rolle `mesh_bi`, nur lesend), REST CSV/JSON/XML | `bi.test.ts`, `tool-snippets.test.ts`; mit echten Werkzeugen geprüft: Python/pandas (`deploy/bi/examples/python_bi_example.py`), DuckDB, psql; Power-Query-Code syntaktisch geprüft | getestet (Schnittstellen); Excel, Power BI, Tableau, SAP AC selbst nicht ausgeführt (laufen nicht auf der Entwicklungsmaschine) |

## Rollen, Rechte, Datenschutz, Sicherheit

| ID | Anforderung | Modul / Artefakt | Nachweis | Status |
|---|---|---|---|---|
| R1 | Freigabe mindestens je Datensatz und Empfängerrolle | `releases` | `release-engine.test.ts`, `releases.test.ts` | getestet |
| R2 | Nicht freigegebene Daten standardmäßig ausgeschlossen | `releases/engine.ts` | `release-engine.test.ts` | getestet |
| R3 | Consent außerhalb, optional im System dokumentiert | Einwilligungen (`athletes`) | `athletes.test.ts`, `pep.test.ts`, `fix-consent-delivered-category.test.ts` | getestet |
| R4 | Gesundheitsdaten als besondere Kategorie (Art. 9) | `datasets`, Engine, Neueinstufung | `release-engine.test.ts`, `fix-data-reclassification.test.ts` | getestet |
| R5 | Protokollierung von Zugriffen, Freigaben, Änderungen, Widerrufen, Austausch | Audit-Log (append-only, Hash-Kette), externe Verankerung durch signierte Prüfpunkte bei Partnern, unabhängige Prüfung mit Anker-Profil (ADR 0014) | `audit.test.ts`, `core.test.ts`, `audit-anchors.test.ts`, `audit-chain-recompute.test.ts`, `fix-audit-anchor-bypass.test.ts` (Abschneiden, Umschreiben und Bearbeiten von Einträgen erkannt, auch mit ersetzter Prüffunktion in der Datenbank), `fix-audit-anchor-epochs.test.ts`, `fix-audit-anchor-review2.test.ts` (Ausfall der Verankerung, Profil-Abgleich, eindeutige Digest-Kodierung v2), Demo | getestet |
| S1 | Verschlüsselung bei der Übertragung | TLS über Caddy; Ed25519-Signaturen auf Anfrage und Antwort | `federation-protocol.test.ts`; Docker: HTTPS mit geprüfter Zertifikatskette, HTTP→HTTPS, Sicherheits-Header; Föderation zweier Docker-Knoten über HTTPS mit `MESH_FEDERATION_ALLOW_HTTP=false`; BI-Datenbank nur mit TLS (`verify-deployment.sh`). Nicht geprüft: öffentliche Domain mit ACME | getestet |
| S2 | Sichere Authentifizierung | Argon2id, Sitzungen (`__Host-`), Sperre, CSRF, API-Tokens | `security.test.ts`, `fix-auth-*.test.ts`, `fix-proxy-and-cookie.test.ts` | getestet |
| S3 | Rollen- und Rechteverwaltung | `auth`, `core/http.ts` | `security.test.ts`, `contract.test.ts` | getestet |
| S4 | Schlüsselverwaltung | AES-256-GCM, Master-Key-Rotation (CLI), Wechsel des Knotenschlüssels mit signierter Partnerbenachrichtigung und Übergangsfrist (ADR 0013) | `crypto.test.ts`, `federation-key-rotation.test.ts`, `federation-keys-anchors.test.ts`, `fix-key-rotation-replaced-key.test.ts`; im Demo-Netz geprüft (Wechsel bei osp-nord, Abruf durch osp-mitte danach) | getestet |
| S5 | Trennung externer und interner Dienste | DB-Rollen, Compose-Netze (`internal`, ohne Host-Zugang), nur Caddy veröffentlicht Ports, Proxy-Vertrauensliste, BI-Port mit `pg_hba`-Regeln | `core.test.ts`, `client-ip.test.ts`; Docker: `verify-deployment.sh` (Datenbank aus Frontend-Netz, fremdem Netz und vom Host unerreichbar, kein Ausgang; X-Forwarded-For-Fälschung ignoriert; BI-Port nur `mesh_bi` mit TLS) | getestet |
| S6 | Backup und Wiederherstellung | verschlüsselte Sicherungen, CLI `restore`, Knotensperre | `backup.test.ts`, `fix-cli-operations.test.ts`, `fix-node-lock.test.ts`, `fix-audit-anchor-epochs.test.ts` (Wiederherstellung beginnt eine neue Ketten-Epoche), Neuinstallation nativ und mit Docker (Sicherung, Wiederherstellung, Wiederherstellung in einen neuen Stack) | getestet |
| S7 | Schwachstellenmanagement | Prozess in [Sicherheit](sicherheit.md), SBOM, `bun audit` | – | umgesetzt (Prozess) |
| S8 | Updatefähigkeit | versionierte Migrationen mit Prüfsummen, [Betrieb](betrieb.md) | `core.test.ts` | umgesetzt |
| S9 | Incident Response | [Incident Response](incident-response.md) | – | umgesetzt (Konzept) |
| S10 | Sichtbare und protokollierte Fehlerbehandlung | `core/http.ts`, `app_error`, übersetzte Fehlercodes | `errors.test.ts`, `ui-i18n.test.ts` | getestet |
| S11 | Konzept für widerrufene oder weitergegebene Daten | [Widerruf und Weitergabe](widerruf-und-weitergabe.md), signierte Mitteilungen | `federation-exchange.test.ts`, `fix-federation-notices.test.ts`, Demo | getestet |

## Übergabe und Anbieterunabhängigkeit

| ID | Anforderung | Artefakt | Status |
|---|---|---|---|
| U1 | Quellcode, Repository | öffentliches Repository https://github.com/moritzwesemann/osp-data-mesh | umgesetzt |
| U2 | Datenbankschema und Migrationsskripte | `migrations/`, [Datenmodell](datenmodell.md) | umgesetzt |
| U3 | API-Dokumentation | `/api/v1/openapi.json` (aus dem Vertrag erzeugt), [API](api.md) | getestet (`contract.test.ts`) |
| U4 | Deployment-Konfiguration | `deploy/` (Compose, Caddy, Superset, systemd), `deploy/verify-deployment.sh` | getestet (Docker, siehe K2/S1/S5; systemd nicht geprüft) |
| U5 | Testfälle, automatisierte Tests | `tests/` (Unit und Integration, `bun test`) und `tests/e2e/` (Browser, `bun run test:e2e`) | umgesetzt |
| U6 | Architekturentscheidungen (ADRs) | `docs/adr/` (15 ADRs) | umgesetzt |
| U7 | Betriebs- und Installationsdokumentation | [Installation](installation.md), [Betrieb](betrieb.md) | umgesetzt, nativ erprobt |
| U8 | Drittkomponenten und Lizenzen | [Lizenzen](lizenzen.md) | umgesetzt |
| U9 | SBOM CycloneDX (BSI TR-03183-2) | `sbom/osp-data-mesh.cdx.json` (Quellstand), Build-SBOM der Oberfläche, `sbom/osp-data-mesh.image.cdx.json` (Container, `bun run sbom -- image`), Signatur (`scripts/sbom-sign.ts`, Projektschlüssel `sbom/signing-key.pub.pem`, Fingerabdruck `sha256:dc51298d…bad9703`), Angaben in `sbom/sbom.config.json` (Projekt als Hersteller, Repository als Kontakt) | getestet: Quell- und Abbild-SBOM signiert und mit `verify` und `cdx-verify` geprüft, Schema (`cdx-validate --strict`) und TR-Selbstprüfung der Quell-SBOM bestanden, sbomqs 9,9/10, alle 152 Debian-Pakete der Abbild-SBOM mit deklarierter Lizenz, Bun mit Version; `sbom.test.ts`, `sbom-image.test.ts`. Bleibend: Lizenzen im Abbild nur deklariert (teils Debian-eigene Namen als `LicenseRef-Debian-…`), Dateien ohne Paketzuordnung ohne Lizenz, privater Schlüssel als Datei beim Maintainer ([Sicherheit, Offen](sicherheit.md#offen-entscheidung-des-eigentümers-bzw-bewusst-nicht-umgesetzt)) |
| U10 | Deutschsprachige HTML-Webdokumentation | `bun run build:docs` → `/hilfe/` (42 Seiten, davon 8 [Konzepte zum Angebot](konzepte/index.md)) | umgesetzt |
| U11 | Open-Source-Lizenz gemäß openCode | `LICENSE` (EUPL-1.2, [ADR 0012](adr/0012-lizenz-eupl.md)), `CONTRIBUTING.md`, `SECURITY.md` | umgesetzt |
| – | Schulungen, Pflege, Leistungen nach Aufwand | nicht Teil der Software | offen (außerhalb des Umfangs) |

## Abnahmekriterien

| ID | Kriterium | Nachweis | Status |
|---|---|---|---|
| AK1 | ≥ 2 CSV-Quellen und 1 API-Quelle durchgängig verarbeitet | `bun run demo`: Athleten-, Leistungsdiagnostik- und Verletzungs-CSV (osp-nord), Athleten-CSV (osp-mitte, osp-sued), Sprungkraft-API (Mock-Messsystem) bis Freigabe, BI und Austausch | getestet |
| AK2 | ≥ 3 Node-Instanzen | `bun run demo`: 3 Knoten mit je eigenem Cluster, gegenseitigem Vertrauen und Austausch (lokal, nicht an Pilotstandorten) | getestet (lokal) |
| AK3 | Neuinstallation in leerer Umgebung nur nach Doku | nativ: Quellcode-Export in ein leeres Verzeichnis mit neuen Ports (Installation, Import, Freigabe, Token-Abruf, Sicherung, Wiederherstellung, zweiter Knoten mit Vertrauen und Austausch). Docker (Variante B wörtlich nach Doku): `.env` und Schlüssel, Bau, Administration, Anmeldung über HTTPS, Import, Produkt, Freigabe, Token-Abruf, Sicherung und Wiederherstellung; gefundene Mängel in beiden Durchläufen behoben. systemd nicht geprüft | getestet |
| AK4 | Tests für Sicherheit, Backup, Wiederherstellung, Fehlerbehandlung | `security.test.ts`, `fix-*.test.ts`, `backup.test.ts`, `fix-cli-operations.test.ts`, `fix-node-lock.test.ts`, `errors.test.ts`, `audit-anchors.test.ts`, `federation-key-rotation.test.ts`, Browser-Abläufe (`bun run test:e2e`: Anmeldefehler, Sitzungsende, Zugriffsschutz) | getestet |
