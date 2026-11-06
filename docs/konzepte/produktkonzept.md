# Produktkonzept

Dieses Konzept beschreibt die Lösung und ihre technische Umsetzung: Architektur, Containerisierung,
Datenintegration, Datenprodukte, Austausch zwischen den Knoten, BI-Anbindung und Übergabe. Es folgt der
Gliederung der Ausschreibung (Abschnitte 1 bis 6 der Leistungsbeschreibung).

## Ziel und Leitgedanken

Die Olympiastützpunkte sollen Daten aus vielen Quellen zusammenführen, auswerten und gezielt mit anderen
Stützpunkten teilen können, **ohne ihre Datenhoheit abzugeben**. Daraus folgen vier Leitgedanken:

1. **Jeder OSP behält seine Daten.** Ein eigener Knoten je Standort, keine zentrale Datenbank, kein
   zentraler Server.
2. **Nichts verlässt den Knoten ohne Freigabe** (*deny by default*). Eine Freigabe legt Empfänger, Spalten,
   Zeilen, Zeitraum, Zweck und Gültigkeit fest.
3. **Alles ist nachvollziehbar.** Jeder Zugriff auf Personendaten, jede Freigabe und jeder Austausch wird
   protokolliert.
4. **Keine Bindung an einen Anbieter.** Offene Standards, offene Schnittstellen, Open-Source-Lizenz,
   vollständige Dokumentation und Übergabe.

## Architektur

### Modularer Monolith je Knoten

Ein Knoten ist **ein Server-Prozess** (Bun, Hono, TypeScript) mit **eigener PostgreSQL-Datenbank** in einem
eigenen Cluster. Der Prozess liefert Web-Oberfläche, REST-API, Föderationsprotokoll und die deutsche
HTML-Hilfe aus. Intern ist er in Fachmodule mit festen Grenzen geteilt; jedes Modul schreibt nur seine
eigenen Tabellen und spricht andere Module über Dienste oder Ereignisse an
([ADR 0001](../adr/0001-modularer-monolith.md)).

| Modul | Aufgabe |
|---|---|
| `auth` | Anmeldung, Sitzungen, Benutzer, API-Tokens |
| `athletes` | Athletenkern, Kennungen aus Quellsystemen, Einwilligungen |
| `datasets` | Strukturen für Mess- und Fachdaten (Felder, Typen, Einheiten, Prüfregeln, Kategorie) |
| `connectors` | Quellen (CSV, Excel, HTTP-API), Feldzuordnung, Prüfung, Vorschau, Import, Fehlerprotokoll |
| `products` | Datenprodukte (Sichten), Abruf und Export |
| `releases` | Freigaben und der **Policy Enforcement Point** – die einzige Stelle, über die Daten den Knoten verlassen |
| `catalog` | lokaler Metadatenkatalog |
| `federation` | Austausch mit Partnerknoten, Discovery, Mitteilungen, Schlüsselwechsel, Verankerung des Audit-Logs |
| `bi` | BI-Schnittstelle (nur lesende Datenbanksichten je Freigabe) |
| `audit`, `system` | Audit-Log, Betriebszustand, Sicherungen, Fehlerprotokoll |

Ein **HTTP-Vertrag** (zod-Schemas in `src/shared/contract/`) ist die einzige Quelle für Eingabeprüfung,
Ausgabefilterung, den Client der Oberfläche und das OpenAPI-Dokument. Server, Oberfläche und
API-Dokumentation können so nicht auseinanderlaufen ([ADR 0002](../adr/0002-stack-bun-hono-kysely-react.md)).

**Warum ein Monolith und kein Microservice-Verbund?** Ein OSP soll seinen Knoten mit wenig IT-Personal
betreiben können: ein Prozess, eine Datenbank, ein Reverse Proxy. Die Modulgrenzen halten den Code trotzdem
wartbar und erlauben später eine Aufteilung, falls sie nötig wird.

### Bausteine eines Knotens

| Baustein | Technik | Aufgabe |
|---|---|---|
| Server | Bun 1.4, Hono, Kysely | Oberfläche, REST-API `/api/v1`, Föderation `/federation/v1`, Hilfe `/hilfe/`, Betriebsprüfungen `/healthz`, `/readyz` |
| Datenbank | **PostgreSQL 18** | Fach- und Metadaten, Audit-Log, Schlüssel (verschlüsselt); drei getrennte Rollen (Schema, Anwendung, BI nur lesend) |
| Reverse Proxy | Caddy 2 | TLS, einziger von außen erreichbarer Dienst |
| BI (optional) | **Apache Superset 6.1** | drei Referenz-Dashboards |
| Kommandozeile | `bun run cli …` | Migrationen, Erstadministration, Sicherung, Wiederherstellung, Schlüsselwechsel, Prüfung des Audit-Logs |

Ausführlich: [Architektur](../architektur.md), [Datenmodell](../datenmodell.md).

### Netz ohne Mitte

Die Knoten bilden ein **Netz gleichberechtigter Partner**. Vertrauen entsteht paarweise und manuell: Zwei
OSP tauschen ihre Knotenkarten aus, gleichen den Fingerabdruck des Schlüssels über einen zweiten Kanal ab
(z. B. Telefon) und bestätigen das Vertrauen. Es gibt keine zentrale Registrierungsstelle und keinen
zentralen Katalog; jeder Knoten fragt die Kataloge seiner Partner direkt ab.

## Containerisierung und Bereitstellung

- **Container:** `deploy/Dockerfile` baut ein schlankes Abbild (mehrstufig, unprivilegierter Benutzer,
  Abhängigkeiten nur aus der festgeschriebenen `bun.lock`). `deploy/docker-compose.yml` startet Datenbank,
  Migration, Knoten und Caddy; Superset kommt als Profil `bi` hinzu.
- **Netztrennung:** Die Datenbank liegt in einem internen Netz ohne Verbindung nach außen; nur Caddy
  veröffentlicht Ports.
- **Reproduzierbar an jedem Ort:** dieselbe Konfiguration läuft **lokal beim OSP**, **bei einem
  Dienstleister** oder **in einer Cloud** (beliebiger Anbieter mit Docker bzw. Linux-Server). Alternativ
  ist eine **native Installation** (Debian 13 / Ubuntu 24.04 mit systemd) beschrieben.
- **Geprüft:** Abbild ohne Cache gebaut, zwei Knoten über HTTPS verbunden, Prüfskript
  `deploy/verify-deployment.sh` für TLS, Netztrennung, Proxy-Vertrauen und BI-Zugang; Neuinstallation nur
  nach Dokumentation nativ und mit Docker.

Ausführlich: [Installation](../installation.md), [Betriebskonzept](betriebskonzept.md).

## Datenhaltung: Athletenkern und Fachdaten

- **Athletenkern** mit den geforderten Feldern **Name, Vorname, Geburtsdatum, Sportart, Kaderstatus**,
  optional Geschlecht, Verein, Disziplin; dazu Kennungen der Person in Quellsystemen (für die Zuordnung
  beim Import) und Einwilligungen.
- **Datensätze** beschreiben Mess- und Fachdaten (z. B. Sprungkraft, Laktat, Verletzungen): Felder mit Typ,
  Einheit und Prüfregeln, eine **Kategorie** (Stammdaten, Leistung, Training, Wettkampf, Gesundheit, Sonstiges), eine
  Markierung als **besondere Kategorie** nach Art. 9 DSGVO und die **Teilbarkeit** (intern oder teilbar).
  Neue Datensätze legt die Datenverantwortung in der Oberfläche an – ohne Programmierung und ohne
  Schemaänderung ([ADR 0003](../adr/0003-jsonb-datensaetze.md)).
- Das **Datenmodell** ist vollständig dokumentiert ([Datenmodell](../datenmodell.md)); das Schema entsteht
  aus versionierten SQL-Migrationen mit Prüfsummen.

## Datenintegration

### Quellen

| Quelle | Umsetzung |
|---|---|
| CSV-Uploads | UTF-8 und Windows-1252 (typischer Excel-Export), Trennzeichen einstellbar, bis 20 MB je Datei |
| Excel-Dateien (`.xlsx`) | Blattwahl, Erkennung der Kopfzeile; eigener, gegen ZIP-Bomben und XML-Angriffe gehärteter Leser ([ADR 0015](../adr/0015-excel-import-eigener-leser.md)) |
| Messsysteme, Fachanwendungen, Cloud-Quellen über HTTP-APIs | generischer Connector: JSON-Antworten, Seitenabruf (Paging), Authentifizierung per Token, eigenem Header oder **OAuth2 Client Credentials**; nur Ziele aus einer Positivliste (Schutz vor SSRF) |

Für konkrete Messsysteme einzelner Hersteller (z. B. Kraftmessplatten, Laktatanalysatoren,
Trainingsplattformen) wird der generische Connector mit einer **Vorlage** konfiguriert. Herstellerspezifische
Anpassungen sind erst mit Zugang und Schnittstellenbeschreibung des Herstellers möglich (siehe
[Mitwirkung](mitwirkung.md)).

### Wiederverwendbare Connector- und Mapping-Definitionen

Ein Connector bündelt Quelle, Feldzuordnung (Mapping) mit einfachen Umformungen, Lese-Einstellungen (Trennzeichen, Kodierung, Dezimal- und Datumsformat) und die Zuordnung der Personen. Connectoren
lassen sich als Datei **exportieren und bei einem anderen OSP importieren** (ohne Geheimnisse); sechs
Vorlagen erleichtern den Einstieg. So muss jede Quelle nur einmal im Netz beschrieben werden.

### Ablauf eines Imports

1. **Hochladen bzw. Abrufen** der Daten.
2. **Zuordnen** der Spalten zu Feldern des Datensatzes bzw. des Athletenkerns.
3. **Prüfen**: Format (Zahl, Datum, Auswahlwerte), Plausibilität (Wertebereiche, Pflichtfelder),
   Zuordnung der Person (eindeutig, nicht gefunden, mehrdeutig).
4. **Vorschau** mit Fehlerprotokoll je Zeile und Feld, mit Prüfcode. Gültige Zeilen können übernommen
   werden, fehlerhafte nicht.
5. **Speichern** in einer Transaktion; jeder Lauf mit Prüfsumme der Quelle, Zählern und Ergebnis im
   **Audit-Log**. Die Quelldatei selbst wird nicht gespeichert.

## Datenprodukte

Ein **Datenprodukt** ist eine definierte Sicht auf einen Datensatz oder den Athletenkern: ausgewählte Spalten
(auch abgeleitete, z. B. *Geburtsjahr* statt Geburtsdatum) und Grundfilter. Datenprodukte werden
ausgeliefert als

- Ansicht in der Oberfläche (mobil nutzbar),
- **Export als CSV, JSON oder XML**,
- **REST-Endpunkt** (`/api/v1/access/{id}/data`, Zugang per API-Token, OpenAPI-Dokument unter
  `/api/v1/openapi.json`),
- **BI-Sicht** in der Datenbank (nur lesende Rolle) und
- **Angebot an Partner-OSP** im Katalog.

Jede dieser Ausgaben läuft durch denselben **Policy Enforcement Point** und liefert nur, was eine gültige
Freigabe erlaubt. Ändert sich ein Produkt, verlieren seine Freigaben ihre Wirkung, bis sie neu erteilt
werden – eine Ausweitung kann nicht unbemerkt geschehen ([ADR 0010](../adr/0010-produktaenderung-invalidiert-freigaben.md)).

## Austausch zwischen Knoten

- **Pull statt Synchronisation:** Ein Partner ruft ein freigegebenes Produkt gezielt ab; eine
  Gesamtsynchronisation gibt es nicht. Jeder Abruf ersetzt die bisherige Kopie vollständig.
- **Signiert:** Anfrage und Antwort tragen Ed25519-Signaturen über die genauen Bytes; Zeitstempel und
  Einmaligkeit schützen vor Wiederholung. Transport zusätzlich über TLS.
- **Pseudonyme:** Partner erhalten statt interner Personen-IDs freigabebezogene Pseudonyme; Namen nur, wenn
  das Produkt sie ausdrücklich enthält.
- **Beidseitig protokolliert:** Datenhalter und Empfänger halten jeden Abruf (geliefert oder abgelehnt) im
  Austauschprotokoll und im Audit-Log fest; der Empfänger speichert den Herkunftsnachweis (Signatur,
  Prüfsumme).
- **Widerruf reicht bis zum Partner:** Widerruf einer Freigabe, Widerruf einer Einwilligung und Löschung
  einer Person erzeugen signierte Mitteilungen; der Empfänger löscht seine Kopie automatisch. Empfangene
  Daten lassen sich im System nicht erneut freigeben; Exporte zur Auswertung sind protokolliert, ihre
  Weitergabe ist vertraglich untersagt ([ADR 0011](../adr/0011-widerruf-mitteilung-keine-weitergabe.md)).

Ausführlich: [Föderationsprotokoll](../protokoll.md), [Widerruf und Weitergabe](../widerruf-und-weitergabe.md).

## Metadatenkatalog und Discovery

- Jeder Knoten führt einen **lokalen Katalog** mit Quellen, Strukturen, Feldern, Connectoren, Mappings und
  Datenprodukten, jeweils mit **Version, Kategorie und Teilbarkeit**.
- **Discovery ohne zentrale Stelle:** Die Suche fragt die Kataloge aller vertrauenswürdigen Partner
  parallel und direkt ab (Ergebnisse werden nicht gespeichert). Partner sehen nur **Metadaten** der als
  teilbar markierten Produkte und die für sie gültigen Freigaben – keine Fachdaten. Interne Produkte
  erscheinen nicht.

## Oberfläche

Eine deutschsprachige Web-Oberfläche (React) für alle Rollen, **mobil nutzbar** (geprüft auf Desktop,
1000 px und 390 px Breite): Startseite mit Aufgaben und zuletzt Geöffnetem, Katalog, Quellen und Importe mit
Vorschau, Datensätze, Datenprodukte, Freigaben mit Vorschau der Wirkung, Partner, empfangene Daten, Audit
und Betrieb. Fehlermeldungen sind übersetzt und nennen eine Request-ID. Rundgang mit Bildschirmfotos:
[Oberfläche](../oberflaeche.md).

## BI-Anbindung

- **Apache Superset 6.1** mit drei fertigen Referenz-Dashboards (13 Diagramme), installierbar als
  Compose-Profil oder getrennt.
- **Keine proprietäre Zugriffsschicht:** BI-Werkzeuge lesen über eine **nur lesende PostgreSQL-Rolle**
  Sichten, die genau den BI-Freigaben entsprechen, oder über die **REST-API** (CSV, JSON, XML). Darüber
  können sich Excel (Power Query), Power BI, Tableau, SAP Analytics Cloud, Python, R und jeder SQL-Client
  mit Standardtreibern verbinden; Anleitungen und Beispielcode liegen bei. Mit echten Werkzeugen geprüft:
  Superset, Python/pandas, DuckDB und psql.

Ausführlich: [BI-Anbindung](../bi.md).

## Übergabe und Anbieterunabhängigkeit

| Gefordert | Geliefert |
|---|---|
| Quellcode und Repository | öffentliches Git-Repository mit vollständiger Historie |
| Datenbankschemata und Migrationsskripte | `migrations/` (versioniert, mit Prüfsummen), [Datenmodell](../datenmodell.md) |
| API-Dokumentation | OpenAPI aus dem Vertrag erzeugt, [REST-API](../api.md) |
| Deployment-Konfiguration | `deploy/` (Dockerfile, Compose, Caddy, Superset, systemd, Prüfskript) |
| Testfälle und automatisierte Tests | `tests/` (Unit, Integration, Browser) |
| Architekturentscheidungen | 15 ADRs ([Übersicht](../adr/index.md)) |
| Betriebs- und Installationsdokumentation | [Installation](../installation.md), [Betrieb](../betrieb.md) |
| Drittkomponenten und Lizenzen | [Lizenzen](../lizenzen.md) |
| SBOM nach BSI TR-03183-2 (CycloneDX) | `sbom/` (Quellcode, Build, Container-Abbild), signiert mit dem Projektschlüssel, siehe [Sicherheit](../sicherheit.md#sbom-und-bsi-tr-03183-2) |
| Deutschsprachige HTML-Webdokumentation | diese Hilfe, vom Knoten unter `/hilfe/` ausgeliefert |
| Open-Source-Lizenz gemäß openCode | **EUPL-1.2** ([ADR 0012](../adr/0012-lizenz-eupl.md)) |
| volle Nutzungs-, Änderungs-, Weiterentwicklungs-, Betriebs- und Weitergaberechte | durch die EUPL-1.2 für jedermann gewährt; keine proprietären Bestandteile, keine Lizenzschlüssel, keine Cloud-Dienste des Auftragnehmers |

Für den **Wechsel des Dienstleisters** ist nichts weiter nötig als Repository und Dokumentation: Die
Software verwendet nur verbreitete Open-Source-Komponenten (Bun, PostgreSQL, Caddy, Superset, React) und
Kenntnisse in TypeScript und SQL.

## Abdeckung der Ausschreibung

Alle 52 Anforderungen sind einzeln mit Modul und Nachweis belegt:
[Anforderungen und Nachverfolgbarkeit](../requirements.md). Stand: 39 umgesetzt und durch Tests belegt,
13 umgesetzt (Dokumentation, Prozesse, Lizenz). Offene Punkte für den Echtbetrieb:
[Annahmen](annahmen.md#was-vor-einem-echtbetrieb-noch-zu-tun-ist).
