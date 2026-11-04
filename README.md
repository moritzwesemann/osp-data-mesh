<img src="assets/icon.svg" width="64" height="64" alt="">

# OSP-Data-Mesh

Föderiertes Netz autonomer Datenknoten für Olympiastützpunkte (OSP) – entwickelt für die Ausschreibung
„OSP-Data-Mesh“ des Landessportverbands Baden-Württemberg e. V.

Jeder Stützpunkt betreibt einen eigenen **Knoten** mit eigener PostgreSQL-Datenbank. Daten aus
CSV-Dateien und Messsystemen (HTTP-APIs) werden geprüft importiert, als **Datenprodukte** beschrieben und
nur über ausdrückliche **Freigaben** weitergegeben – beschränkt nach Spalten, Zeilen, Zeitraum, Zweck und
Einwilligung. Knoten tauschen Daten direkt und signiert aus (Ed25519, Pull-Prinzip, freigabebezogene
Pseudonyme); es gibt keine zentrale Datenhaltung. Jeder Zugriff landet in einem manipulationsgeschützten
Audit-Log. BI-Werkzeuge greifen über eine nur lesende Datenbankrolle oder die REST-API zu.

> **Status: Prototyp (0.1.0).** In einer Nacht von KI-Agenten erstellt und nicht für den
> Produktivbetrieb zertifiziert. Vor einem Echtbetrieb sind Sicherheitsaudit, rechtliche Prüfung
> (Datenschutz, Lizenz) und eine Abnahme nach `docs/abnahme.md` erforderlich. Nicht lokal verifiziert
> sind insbesondere die Container-Bereitstellung (Docker) und Apache Superset.

## Schnellstart (Entwicklungsrechner)

Voraussetzungen: [Bun](https://bun.sh) 1.4, PostgreSQL 18 (Programme `initdb`, `pg_ctl`, `psql`,
`pg_dump` im `PATH` oder per Homebrew unter `/opt/homebrew/opt/postgresql@18/bin`).

```sh
bun install
bun run build      # Web-Oberfläche (dist/ui) und deutsche Hilfe (dist/docs)
bun run demo       # drei Knoten osp-nord/-mitte/-sued auf Port 4401–4403, Mock-Messsystem auf 4410
bun test           # automatisierte Tests (eigener PostgreSQL-Testcluster auf Port 55434)
```

Die Demo beginnt immer mit einem leeren Stand unter `.local/demo/`, legt je Knoten einen eigenen
PostgreSQL-Cluster an (Ports 55431–55433), importiert Beispieldaten aus CSV-Dateien und einer API-Quelle,
stellt das Vertrauen zwischen den Knoten her, erteilt Freigaben und prüft Austausch, Widerrufe, BI-Zugang,
Audit und Sicherungen über die echten HTTP-Schnittstellen (Abbruch mit Exit-Code 1 bei jeder Abweichung).
Danach stoppt sie alles. Mit `bun run demo -- --keep-running` laufen die Knoten weiter (Zugangsdaten gibt
die Demo aus); beenden mit `bun run demo:stop`.

## Installation und Betrieb

- Neuinstallation (nativ mit Bun + PostgreSQL + Caddy oder mit Docker Compose):
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
CSV and API data with validation, describes it as data products and shares it only through explicit,
fine-grained releases (columns, rows, time, purpose, consent). Nodes exchange data peer-to-peer with
Ed25519-signed requests and responses, release-scoped pseudonyms and signed revocation notices; there is
no central data store. All access is recorded in an append-only, hash-chained audit log. BI tools read
through a read-only database role (schema `bi`) or the REST API (CSV/JSON/XML, OpenAPI).

**Status:** prototype built in one night by AI agents; not production-certified. Docker deployment and
Superset are not locally verified. Quick start: `bun install && bun run build && bun run demo`; tests:
`bun test`. Documentation (German) in `docs/`, served at `/hilfe/`. Licence: EUPL-1.2 for now – the final
licence is Moritz's decision before any publication.
