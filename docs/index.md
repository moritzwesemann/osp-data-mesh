# OSP-Data-Mesh – Dokumentation

OSP-Data-Mesh ist ein föderiertes Netz autonomer Datenknoten für Olympiastützpunkte (OSP). Jeder
Stützpunkt betreibt einen eigenen **Knoten** mit eigener Datenbank. Daten werden lokal importiert,
geprüft und als **Datenprodukte** beschrieben; andere Knoten, lokale Rollen und BI-Werkzeuge erhalten
ausschließlich, was eine **Freigabe** ausdrücklich erlaubt – beschränkt nach Spalten, Zeilen, Zeitraum und
Zweck. Es gibt keine zentrale Datenhaltung und keine Gesamtsynchronisation.

> **Status:** Prototyp (Version 0.1). Nicht für den Produktivbetrieb zertifiziert. Rechtliche Bewertung
> (Datenschutz, Lizenz) und ein Sicherheitsaudit stehen vor einem Echtbetrieb noch aus.

## Für wen ist welche Seite?

| Sie sind … | Lesen Sie zuerst |
|---|---|
| IT-Betrieb eines OSP (Installation, Betrieb, Updates) | [Installation](installation.md), [Betrieb](betrieb.md), [Sicherheitskonzept](sicherheit.md) |
| Datenschutzbeauftragte, Revision | [Datenschutzkonzept](datenschutz.md), [Widerruf und Weitergabe](widerruf-und-weitergabe.md), [Rollen und Rechte](rollen.md), [Freigaberegeln](freigaberegeln.md) |
| Datenverantwortliche (Data Stewards) | [Freigaberegeln](freigaberegeln.md), [Datenmodell](datenmodell.md), [Rollen und Rechte](rollen.md) |
| Analyse, BI, Wissenschaft | [BI-Anbindung](bi.md), [REST-API](api.md) |
| Entwicklung, Weiterentwicklung | [Architektur](architektur.md), [Föderationsprotokoll](protokoll.md), [Architekturentscheidungen](adr/index.md) |
| Vergabestelle, Abnahme | [Anforderungen und Nachverfolgbarkeit](requirements.md), [Abnahme](abnahme.md), [Lizenzen](lizenzen.md) |

## Bausteine eines Knotens

- **Server** (Bun, Hono): Web-Oberfläche unter `/`, REST-API unter `/api/v1/` (OpenAPI unter
  `/api/v1/openapi.json`), Föderationsprotokoll unter `/federation/v1/`, diese Hilfe unter `/hilfe/`,
  Betriebsprüfungen `/healthz` und `/readyz`.
- **PostgreSQL 18** mit drei getrennten Rollen: `mesh_owner` (Schema, nur Kommandozeile),
  `mesh_app` (Server), `mesh_bi` (nur lesend, nur Schema `bi`).
- **Caddy** als TLS-Reverse-Proxy vor dem Server; einziger von außen erreichbarer Dienst.
- **Kommandozeile** `bun run cli …` für Migrationen, Erstadministration, Sicherung und
  Wiederherstellung, Schlüsselrotation und Prüfung des Audit-Logs.
- Optional **Apache Superset** mit drei Referenz-Dashboards (siehe [BI-Anbindung](bi.md)).

## Wichtige Begriffe

| Begriff | Bedeutung |
|---|---|
| Knoten (Node) | Installation eines OSP: Server + Datenbank, eindeutige Kennung (`MESH_NODE_ID`) und Ed25519-Schlüssel |
| Partner | anderer Knoten, dem nach Abgleich des Fingerprints vertraut wird |
| Datensatz | Struktur (Felder mit Typen und Prüfregeln) für Messwerte, z. B. Sprungkraft |
| Connector | wiederverwendbare Definition einer Quelle (CSV-Upload oder HTTP-API) samt Feldzuordnung |
| Datenprodukt | definierte Sicht (Spalten, Basisfilter) auf einen Datensatz oder den Athletenkern |
| Freigabe | Erlaubnis für genau einen Empfänger (Rolle, BI oder Partner) mit Beschränkungen |
| PEP | Policy Enforcement Point: einzige Stelle, über die Daten den Knoten verlassen |
| Audit-Log | nur anhängbares Protokoll aller relevanten Vorgänge mit Hash-Kette |

## Schnellzugriff

- Neuinstallation: [Installation](installation.md)
- Sicherung und Wiederherstellung: [Betrieb › Sicherungen](betrieb.md#sicherungen)
- Sicherheitsvorfall: [Incident Response](incident-response.md)
- API-Zugriff mit Token: [REST-API](api.md)
