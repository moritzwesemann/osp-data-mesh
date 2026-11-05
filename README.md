<img src="assets/icon.svg" width="64" height="64" alt="">

# OSP-Data-Mesh

Föderiertes Netz autonomer Datenknoten für Olympiastützpunkte (OSP) – entwickelt für die Ausschreibung
„OSP-Data-Mesh“ des Landessportverbands Baden-Württemberg e. V.

Jeder Stützpunkt betreibt einen eigenen **Knoten** mit eigener PostgreSQL-Datenbank. Daten aus
CSV- und Excel-Dateien und Messsystemen (HTTP-APIs, auch mit OAuth2) werden geprüft importiert, als
**Datenprodukte** beschrieben und
nur über ausdrückliche **Freigaben** weitergegeben – beschränkt nach Spalten, Zeilen, Zeitraum, Zweck und
Einwilligung. Knoten tauschen Daten direkt und signiert aus (Ed25519, Pull-Prinzip, freigabebezogene
Pseudonyme); es gibt keine zentrale Datenhaltung. Jeder Zugriff landet in einem manipulationsgeschützten
Audit-Log. BI-Werkzeuge greifen über eine nur lesende Datenbankrolle oder die REST-API zu.

> **Status: Prototyp (0.1.0).** Von KI-Agenten erstellt und nicht für den Produktivbetrieb
> zertifiziert. Vor einem Echtbetrieb sind ein externer Sicherheitstest, die rechtliche Prüfung
> (Datenschutz, Lizenz), ein Pilot an echten Standorten und eine Abnahme nach `docs/abnahme.md`
> erforderlich. Geprüft sind die native und die Docker-Installation (TLS, Netztrennung, Superset);
> nicht geprüft sind amd64-Hosts, eine öffentliche Domain mit ACME, systemd und echte Fremdsysteme.

## Schnellstart (Entwicklungsrechner)

Voraussetzungen: [Bun](https://bun.sh) **1.4.3** (getestete Version; genau diese installieren mit
`curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"`), PostgreSQL 18 (Programme `initdb`,
`pg_ctl`, `psql`, `pg_dump`). Gesucht werden sie unter `/opt/homebrew/opt/postgresql@18/bin`,
`/opt/homebrew/bin`, `/usr/local/opt/postgresql@18/bin`, `/usr/lib/postgresql/18/bin`, `/usr/local/bin`
und `/usr/bin`; liegen sie anderswo, das Verzeichnis mit `MESH_PG_BIN=…` angeben (die Demo bricht sonst
ab; `bun test` nutzt ersatzweise den `PATH`).

```sh
bun install
bun run build      # Web-Oberfläche (dist/ui) und deutsche Hilfe (dist/docs)
bun run demo       # drei Knoten osp-nord/-mitte/-sued auf Port 4401–4403, Mock-Messsystem auf 4410
bun test           # automatisierte Tests (eigener PostgreSQL-Testcluster auf Port 55434)
bun run test:e2e   # Oberflächen-Ablauftests im Browser (eigene Knoten auf 4451–4452, Cluster auf 55471)
```

Die Demo beginnt immer mit einem leeren Stand unter `.local/demo/`, legt je Knoten einen eigenen
PostgreSQL-Cluster an (Ports 55431–55433), importiert Beispieldaten aus CSV-Dateien und einer API-Quelle,
stellt das Vertrauen zwischen den Knoten her, erteilt Freigaben und prüft Austausch, Widerrufe, offene
Schnittstellen (API-Token, JSON/CSV/XML), BI-Zugang (als Datenbankrolle `mesh_bi`), Audit und Sicherungen
über die echten Schnittstellen (Abbruch mit Exit-Code 1 bei jeder Abweichung).
Danach stoppt sie alles. Mit `bun run demo -- --keep-running` laufen die Knoten weiter (Zugangsdaten gibt
die Demo aus); beenden mit `bun run demo:stop`.

Die Oberflächen-Ablauftests (`bun run test:e2e`, Ordner `tests/e2e/`) steuern die echte Web-Oberfläche
mit Chromium (über `playwright-core`) gegen zwei eigens gestartete Knoten: eigener PostgreSQL-Cluster in
einem temporären Verzeichnis (Port 55471, abweichend `MESH_E2E_PG_PORT`), Knoten auf 4451–4452, Oberfläche
einmal frisch in dieses Verzeichnis gebaut, Testdaten aus `fixtures/` über CLI und API. Geprüft werden
Anmeldung und Abmeldung, CSV-Import mit Fehlerprotokoll, Athletenseite mit Verlauf, Freigabe mit
„Wirkung prüfen“, Meine Daten mit CSV-Download, Abruf und Widerruf zwischen zwei Knoten, Audit-Integrität,
Zugriffsschutz und die Smartphone-Ansicht; jeder Test schlägt außerdem bei Konsolenfehlern oder unerwarteten
API-Fehlern fehl. Einmalig vorher: `bun x playwright-core install chromium`. Die Dateien heißen `*.e2e.ts`
und laufen daher nicht mit `bun test`. Nach dem Lauf – auch bei Fehlschlag oder Strg+C – ist alles gestoppt
und gelöscht; Bildschirmfotos fehlgeschlagener Tests und die Server-Logs liegen in `.local/e2e/artefakte/`.
Einzelne Abläufe: `bun run test:e2e partner`; mit `--keep` bleibt die Umgebung zum Nachsehen offen.

## Installation und Betrieb

- Neuinstallation (nativ auf Linux – Debian/Ubuntu – mit Bun + PostgreSQL + Caddy, oder mit Docker
  Compose; macOS nur für Testinstallationen; **ein eigener PostgreSQL-Cluster je Knoten**):
  [docs/installation.md](docs/installation.md)
- Betrieb, Sicherung/Wiederherstellung, Schlüsselrotation, Updates: [docs/betrieb.md](docs/betrieb.md)
- Container-Dateien: [`deploy/`](deploy/) (`Dockerfile`, `docker-compose.yml`, `Caddyfile`,
  PostgreSQL-Initialisierung, optional Superset)
- Konfiguration: [`.env.example`](.env.example) (alle Variablen mit Erläuterung), für Docker
  [`deploy/.env.example`](deploy/.env.example)
- Kommandozeile: `bun run cli help`

## Dokumentation

Die deutsche HTML-Dokumentation wird mit `bun run build:docs` erzeugt und vom Knoten unter `/hilfe/`
ausgeliefert. Quellen in [`docs/`](docs/):

| Thema | Datei |
|---|---|
| Überblick | [docs/index.md](docs/index.md) |
| Oberfläche (Rundgang mit Bildschirmfotos) | [docs/oberflaeche.md](docs/oberflaeche.md) |
| Architektur, Module, Konventionen | [docs/architektur.md](docs/architektur.md) |
| Freigabe- und Einwilligungsregeln | [docs/freigaberegeln.md](docs/freigaberegeln.md) |
| Föderationsprotokoll | [docs/protokoll.md](docs/protokoll.md) |
| Datenmodell | [docs/datenmodell.md](docs/datenmodell.md) |
| Rollen und Rechte | [docs/rollen.md](docs/rollen.md) |
| Sicherheitskonzept, SBOM | [docs/sicherheit.md](docs/sicherheit.md) |
| Datenschutzkonzept | [docs/datenschutz.md](docs/datenschutz.md) |
| Widerruf und Weitergabe | [docs/widerruf-und-weitergabe.md](docs/widerruf-und-weitergabe.md) |
| Incident Response | [docs/incident-response.md](docs/incident-response.md) |
| REST-API (OpenAPI unter `/api/v1/openapi.json`) | [docs/api.md](docs/api.md) |
| BI-Anbindung, Superset | [docs/bi.md](docs/bi.md) |
| Anforderungen und Nachverfolgbarkeit | [docs/requirements.md](docs/requirements.md) |
| Abnahme-Checkliste | [docs/abnahme.md](docs/abnahme.md) |
| Drittkomponenten und Lizenzen | [docs/lizenzen.md](docs/lizenzen.md) |
| Architekturentscheidungen (ADR) | [docs/adr/](docs/adr/) |

Software-Stückliste (CycloneDX 1.6, angereichert für BSI TR-03183-2):
[`sbom/osp-data-mesh.cdx.json`](sbom/osp-data-mesh.cdx.json), erzeugt mit `bun run sbom`.
Lizenzseite neu erzeugen: `bun scripts/licenses.ts`.

## Technik

Bun · TypeScript · Hono · Kysely + pg · zod (ein Vertrag für Validierung, Client und OpenAPI) ·
PostgreSQL 18 · React + Vite · Caddy (TLS) · optional Apache Superset.

## Lizenz

Vorläufig **EUPL-1.2** (siehe [`LICENSE`](LICENSE) und
[ADR 0012](docs/adr/0012-lizenz-eupl.md)). Die endgültige Lizenzwahl trifft Moritz vor jeder
Veröffentlichung; bis dahin ist der Code nicht zur Veröffentlichung freigegeben.

---

## English summary

OSP-Data-Mesh is a federated network of autonomous data nodes for German elite-sport training centres
(Olympiastützpunkte). Each centre runs its own node (Bun/TypeScript server + PostgreSQL 18) that imports
CSV, Excel and API data with validation, describes it as data products and shares it only through explicit,
fine-grained releases (columns, rows, time, purpose, consent). Nodes exchange data peer-to-peer with
Ed25519-signed requests and responses, release-scoped pseudonyms and signed revocation notices; there is
no central data store. All access is recorded in an append-only, hash-chained audit log. BI tools read
through a read-only database role (schema `bi`) or the REST API (CSV/JSON/XML, OpenAPI).

**Status:** prototype built in one night by AI agents; not production-certified. Docker deployment and
Superset are not locally verified. Quick start: `bun install && bun run build && bun run demo`; tests:
`bun test`; browser end-to-end tests of the UI: `bun run test:e2e`. Documentation (German) in `docs/`, served at `/hilfe/`. Licence: EUPL-1.2 for now – the final
licence is Moritz's decision before any publication.
