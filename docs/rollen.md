# Rollen und Rechte

Rollen werden Personen von der Administration zugewiesen (eine Person kann mehrere Rollen haben). Jede
Route der REST-API legt im HTTP-Vertrag (`src/shared/contract/`) fest, welche Rollen sie aufrufen dürfen;
der Server prüft das vor jeder Verarbeitung und protokolliert Abweisungen (`access.forbidden`). Die
Tabellen auf dieser Seite sind aus dem Vertrag abgeleitet; maßgeblich ist der Vertrag bzw. das
OpenAPI-Dokument unter `/api/v1/openapi.json`.

## Rollen

| Rolle | Wer | Aufgaben | Fachdaten |
|---|---|---|---|
| `admin` | IT-Administration des OSP | Benutzer, Partner (Vertrauensaufnahme, Sperre), Systemstatus, Sicherungen, BI-Verwaltung | **kein** Zugriff (außer über eine Freigabe, die es für `admin` nicht gibt) |
| `data_steward` | Datenverantwortliche | Athletinnen/Athleten, Einwilligungen, Datensätze, Quellen und Importe, Datenprodukte, Freigaben, Abrufe bei Partnern | Rohdaten des eigenen Knotens zur Pflege (jeder Lesezugriff protokolliert); empfangene Daten |
| `analyst` | Analyse, Wissenschaft | Discovery bei Partnern, Auswertung | nur über Freigaben an `analyst`; empfangene Daten |
| `coach` | Trainerinnen und Trainer | Nutzung freigegebener Datenprodukte | nur über Freigaben an `coach` |
| `auditor` | Datenschutz, Revision | Audit-Log, Austauschprotokoll, Freigaben lesen | nur über Freigaben an `auditor` |
| `bi` (technisch) | BI-Schnittstelle (Datenbankrolle `mesh_bi`) | Empfängerrolle für BI-Freigaben | nur Views im Schema `bi`; keiner Person zuweisbar |

**Fachdaten erhalten Rollen ausschließlich über Freigaben.** Eine Freigabe an die Rolle `coach` gilt für
alle Personen mit dieser Rolle; der Abruf (`access.data`) ist für alle angemeldeten Personen erreichbar,
liefert aber nur Daten, wenn eine gültige Freigabe für eine ihrer Rollen besteht (sonst
`access_denied`). Was eine Freigabe erlaubt, beschreiben die [Freigaberegeln](freigaberegeln.md).

Bei erzwungenem Passwortwechsel (Initialpasswort) sind bis zur Änderung nur Anmelden, Abmelden, „Wer bin
ich“ und der Passwortwechsel erlaubt.

**API-Tokens** haben dieselben Rechte wie die Person (ihre aktuellen Rollen), mit einer Ausnahme: Neue
Tokens lassen sich nur mit einer Sitzung (Anmeldung mit Passwort) erzeugen, nicht mit einem Token (403
`forbidden`, Grund `session_required`). Passwortwechsel, Zurücksetzen und Deaktivierung widerrufen alle
Tokens der Person ([REST-API](api.md#api-token-erzeugen)).

## Übersicht nach Bereichen

✓ = alle Vorgänge des Bereichs, ◐ = einzelne Vorgänge (siehe Detailtabellen), – = keine.

| Bereich | admin | data_steward | analyst | coach | auditor |
|---|:-:|:-:|:-:|:-:|:-:|
| Anmeldung, eigenes Passwort, eigene API-Tokens | ✓ | ✓ | ✓ | ✓ | ✓ |
| Benutzerverwaltung | ✓ | – | – | – | – |
| Athleten und Einwilligungen (Personendaten) | – | ✓ | – | – | – |
| Zweck-Vokabular lesen | ✓ | ✓ | ✓ | ✓ | ✓ |
| Datensätze, Datenquellen, Importe | – | ✓ | – | – | – |
| Datenprodukte definieren | – | ✓ | – | – | – |
| Freigegebene Daten abrufen (`access.*`) | nur mit Freigabe¹ | mit Freigabe | mit Freigabe | mit Freigabe | mit Freigabe |
| Freigaben erteilen, widerrufen, Vorschau | – | ✓ | – | – | – |
| Freigaben lesen | – | ✓ | – | – | ✓ |
| Eigene Knotenkarte, Partnerliste, Verbindung prüfen | ✓ | ✓ | – | – | – |
| Partner aufnehmen, vertrauen, sperren, ändern, neuen Partnerschlüssel eintragen | ✓ | – | – | – | – |
| Eigenen Knotenschlüssel wechseln | ✓ | – | – | – | – |
| Ausgangspostfach anzeigen / sofort zustellen | ✓ / ✓ | – / ✓ | – | – | – |
| Lokaler Metadatenkatalog | ✓ | ✓ | ✓ | ✓ | ✓ |
| Discovery bei Partnern | – | ✓ | ✓ | – | – |
| Bei Partnern abrufen, empfangene Kopie löschen | – | ✓ | – | – | – |
| Empfangene Daten lesen | – | ✓ | ✓ | – | – |
| Austauschprotokoll | – | ✓ | – | – | ✓ |
| Audit-Log durchsuchen, Integrität prüfen | ✓ | – | – | – | ✓ |
| Externe Verankerung: Prüfpunkt senden, mit Partnern abgleichen, exportieren | ✓ | – | – | – | ✓ |
| Audit-Log exportieren | – | – | – | – | ✓ |
| Systemstatus, Fehlerprotokoll, Sicherungen | ✓ | – | – | – | – |
| BI-Views anzeigen, neu aufbauen | ✓ | ✓ | – | – | – |
| `/healthz`, `/readyz`, OpenAPI | öffentlich | | | | |

¹ Freigaben können nicht an `admin` erteilt werden; die Administration erhält daher keine Fachdaten.

## Typische Rollenkombinationen

- Kleiner OSP: eine Person `admin`, zwei Personen `data_steward` (Vertretung), Datenschutzbeauftragte
  `auditor`, Trainerteam `coach`.
- Trennung von Administration und Datenverantwortung beibehalten (keine Person gleichzeitig `admin` und
  `data_steward`), damit Vertrauensaufnahme von Partnern und Freigaben im Vier-Augen-Prinzip erfolgen.

## Detail: alle Vorgänge der REST-API


### Anmeldung

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Anmelden (setzt Sitzungs-Cookie) (`auth.login`) | `POST /api/v1/auth/login` | öffentlich (ohne Anmeldung) |
| Abmelden (`auth.logout`) | `POST /api/v1/auth/logout` | alle angemeldeten Personen |
| Angemeldete Person und Knoten (`auth.me`) | `GET /api/v1/auth/me` | alle angemeldeten Personen |
| Eigenes Passwort ändern (`auth.changePassword`) | `POST /api/v1/auth/password` | alle angemeldeten Personen |
| Eigene API-Tokens (`tokens.list`) | `GET /api/v1/auth/tokens` | alle angemeldeten Personen |
| API-Token für Werkzeuge (Excel, Power BI, Python) erzeugen; Token wird nur einmal angezeigt (`tokens.create`) | `POST /api/v1/auth/tokens` | alle angemeldeten Personen |
| Eigenes API-Token widerrufen (`tokens.revoke`) | `DELETE /api/v1/auth/tokens/:id` | alle angemeldeten Personen |

### Benutzer

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Benutzer auflisten (`users.list`) | `GET /api/v1/users` | `admin` |
| Benutzer anlegen (Initialpasswort muss bei erster Anmeldung geändert werden) (`users.create`) | `POST /api/v1/users` | `admin` |
| Benutzer ändern (Rollen, Status, Sprache); Sperre aufheben (`users.update`) | `PATCH /api/v1/users/:id` | `admin` |
| Passwort zurücksetzen (beendet alle Sitzungen der Person) (`users.resetPassword`) | `POST /api/v1/users/:id/reset-password` | `admin` |

### Athleten

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Athletinnen und Athleten suchen (`athletes.list`) | `GET /api/v1/athletes` | `data_steward` |
| Vorhandene Sportarten (für Filter) (`athletes.sports`) | `GET /api/v1/athletes/sports` | `data_steward` |
| Athletin/Athlet mit Kennungen, Einwilligungen und Datenbestand (`athletes.get`) | `GET /api/v1/athletes/:id` | `data_steward` |
| Athletin/Athlet anlegen (`athletes.create`) | `POST /api/v1/athletes` | `data_steward` |
| Stammdaten ändern (`athletes.update`) | `PATCH /api/v1/athletes/:id` | `data_steward` |
| Person und alle zugehörigen Daten löschen (Recht auf Löschung); Partner werden benachrichtigt (`athletes.delete`) | `DELETE /api/v1/athletes/:id` | `data_steward` |

### Einwilligungen

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Außerhalb des Systems eingeholte Einwilligung dokumentieren (`consents.create`) | `POST /api/v1/athletes/:id/consents` | `data_steward` |
| Widerruf einer Einwilligung erfassen; betroffene Partner werden benachrichtigt (`consents.withdraw`) | `POST /api/v1/consents/:id/withdraw` | `data_steward` |
| Zweck-Vokabular für Zweckbindung (`purposes.list`) | `GET /api/v1/purposes` | alle angemeldeten Personen |

### Datensätze

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Datensätze (Strukturen) auflisten (`datasets.list`) | `GET /api/v1/datasets` | `data_steward` |
| Datensatz mit Feldern (`datasets.get`) | `GET /api/v1/datasets/:id` | `data_steward` |
| Datensatz anlegen (`datasets.create`) | `POST /api/v1/datasets` | `data_steward` |
| Datensatz ändern (Feldänderungen erhöhen die Version) (`datasets.update`) | `PATCH /api/v1/datasets/:id` | `data_steward` |
| Einträge eines Datensatzes (Zugriff wird protokolliert) (`datasets.records`) | `GET /api/v1/datasets/:id/records` | `data_steward` |

### Datenquellen

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Datenquellen/Connectoren auflisten (`connectors.list`) | `GET /api/v1/connectors` | `data_steward` |
| Mitgelieferte Connector-Vorlagen (`connectors.templates`) | `GET /api/v1/connector-templates` | `data_steward` |
| Connector mit Zuordnung (`connectors.get`) | `GET /api/v1/connectors/:id` | `data_steward` |
| Connector anlegen (`connectors.create`) | `POST /api/v1/connectors` | `data_steward` |
| Connector ändern (erhöht die Version) (`connectors.update`) | `PATCH /api/v1/connectors/:id` | `data_steward` |
| Zugangsgeheimnis der API-Quelle (Token, Schlüssel oder OAuth2-Client-Geheimnis) setzen oder entfernen (verschlüsselt gespeichert, nie wieder ausgegeben) (`connectors.setSecret`) | `PUT /api/v1/connectors/:id/secret` | `data_steward` |
| Portable Connector-Definition (ohne Geheimnisse) exportieren (`connectors.export`) | `GET /api/v1/connectors/:id/export` | `data_steward` |
| Connector-Definition importieren (optional mit Datensatz-Struktur) (`connectors.import`) | `POST /api/v1/connectors/import` | `data_steward` |
| Beispieldatei (CSV, Excel) oder API-Antwort analysieren (Spalten, Beispielzeilen, Tabellenblätter) für die Zuordnung (`connectors.inspect`) | `POST /api/v1/connectors/inspect` | `data_steward` |

### Importe

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Import starten: CSV- oder Excel-Datei hochladen (Feld "file") oder API abrufen; erzeugt Vorschau mit Prüfergebnis (`imports.start`) | `POST /api/v1/connectors/:id/runs` | `data_steward` |
| Importläufe eines Connectors (`imports.list`) | `GET /api/v1/connectors/:id/runs` | `data_steward` |
| Importlauf mit Vorschau und Fehlerübersicht (`imports.get`) | `GET /api/v1/import-runs/:id` | `data_steward` |
| Fehlerprotokoll eines Importlaufs (`imports.errors`) | `GET /api/v1/import-runs/:id/errors` | `data_steward` |
| Geprüfte Zeilen übernehmen (`imports.commit`) | `POST /api/v1/import-runs/:id/commit` | `data_steward` |
| Importlauf verwerfen (`imports.discard`) | `POST /api/v1/import-runs/:id/discard` | `data_steward` |

### Datenprodukte

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Datenprodukte auflisten (`products.list`) | `GET /api/v1/products` | `data_steward` |
| Datenprodukt (`products.get`) | `GET /api/v1/products/:id` | `data_steward` |
| Datenprodukt definieren (`products.create`) | `POST /api/v1/products` | `data_steward` |
| Datenprodukt ändern (Änderung an Spalten/Filtern erhöht die Version; bestehende Freigaben müssen neu bestätigt werden) (`products.update`) | `PATCH /api/v1/products/:id` | `data_steward` |
| Datenprodukt stilllegen (alle Zugriffe enden) (`products.retire`) | `POST /api/v1/products/:id/retire` | `data_steward` |
| Vorschau des ungefilterten Produkts für Datenverantwortliche (protokolliert) (`products.preview`) | `GET /api/v1/products/:id/preview` | `data_steward` |

### Datenzugriff

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Für die eigenen Rollen freigegebene Datenprodukte (`access.list`) | `GET /api/v1/access` | alle angemeldeten Personen |
| Daten eines freigegebenen Produkts abrufen (JSON, CSV oder XML); Zweck ist Pflicht; nur freigegebene Zeilen und Spalten (`access.data`) | `GET /api/v1/access/:id/data` | alle angemeldeten Personen |

### Freigaben

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Freigaben auflisten (`releases.list`) | `GET /api/v1/releases` | `data_steward`, `auditor` |
| Freigabe mit Austauschhistorie (`releases.get`) | `GET /api/v1/releases/:id` | `data_steward`, `auditor` |
| Freigabe erteilen (Datensatz × Empfänger, beschränkt nach Spalten, Zeilen, Zeit und Zweck) (`releases.create`) | `POST /api/v1/releases` | `data_steward` |
| Freigabe widerrufen; Partner erhalten eine signierte Widerrufsmitteilung (`releases.revoke`) | `POST /api/v1/releases/:id/revoke` | `data_steward` |
| Wirkung einer (geplanten) Freigabe prüfen, bevor sie erteilt wird (`releases.preview`) | `POST /api/v1/releases/preview` | `data_steward` |

### Partner

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Eigene Knotenkarte (Public Key + Fingerprint) zum Austausch mit Partnern (`node.card`) | `GET /api/v1/node/card` | `admin`, `data_steward` |
| Partnerknoten auflisten (`peers.list`) | `GET /api/v1/peers` | `admin`, `data_steward` |
| Partnerknoten aus Knotenkarte aufnehmen (Status "pending" bis zur Fingerprint-Bestätigung) (`peers.add`) | `POST /api/v1/peers` | `admin` |
| Vertrauen bestätigen: Fingerprint muss mit dem außerhalb des Systems abgeglichenen Wert übereinstimmen (`peers.trust`) | `POST /api/v1/peers/:id/trust` | `admin` |
| Partner sperren (alle Anfragen werden abgelehnt) (`peers.suspend`) | `POST /api/v1/peers/:id/suspend` | `admin` |
| Anzeigename oder Adresse eines Partners ändern (`peers.update`) | `PATCH /api/v1/peers/:id` | `admin` |
| Neuen Schlüssel eines Partners aus seiner Knotenkarte eintragen (z. B. nach verpasster Rotationsmitteilung); Status danach "pending" bis zum erneuten Fingerprint-Abgleich (`peers.replaceKey`) | `POST /api/v1/peers/:id/key` | `admin` |
| Eigener Signaturschlüssel und Stand des letzten Schlüsselwechsels (`node.keyStatus`) | `GET /api/v1/node/key` | `admin` |
| Knotenschlüssel wechseln: planmäßig mit signierter Mitteilung an alle Partner oder bei Verdacht auf Kompromittierung ohne Mitteilung (`node.rotateKey`) | `POST /api/v1/node/key/rotate` | `admin` |
| Signierte Verbindungsprüfung (`peers.ping`) | `POST /api/v1/peers/:id/ping` | `admin`, `data_steward` |
| Ausgehende Mitteilungen (Widerrufe) und Zustellstatus (`outbox.list`) | `GET /api/v1/outbox` | `admin` |
| Ausstehende Mitteilungen sofort zustellen (`outbox.flush`) | `POST /api/v1/outbox/flush` | `admin`, `data_steward` |

### Katalog

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Lokaler Metadatenkatalog: Quellen, Strukturen, Felder, Connectoren, Mappings, Datenprodukte (`catalog.local`) | `GET /api/v1/catalog` | alle angemeldeten Personen |
| Kataloge aller vertrauenswürdigen Partner abfragen (ohne zentrale Datensammelstelle) (`discovery.search`) | `GET /api/v1/discovery` | `data_steward`, `analyst` |

### Empfangene Daten

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Freigegebenes Datenprodukt bei einem Partner abrufen (ersetzt die bisherige Kopie) (`received.pull`) | `POST /api/v1/received/pull` | `data_steward` |
| Empfangene Datenprodukte (`received.list`) | `GET /api/v1/received` | `data_steward`, `analyst` |
| Empfangenes Datenprodukt mit Herkunftsnachweis (`received.get`) | `GET /api/v1/received/:id` | `data_steward`, `analyst` |
| Zeilen eines empfangenen Produkts (Zugriff wird protokolliert) (`received.rows`) | `GET /api/v1/received/:id/rows` | `data_steward`, `analyst` |
| Lokale Kopie löschen (`received.delete`) | `DELETE /api/v1/received/:id` | `data_steward` |
| Austauschprotokoll (gesendet und empfangen) (`exchange.log`) | `GET /api/v1/exchange-log` | `data_steward`, `auditor` |

### Betrieb

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Lebenszeichen (ohne Datenbank) (`health.live`) | `GET /healthz` | öffentlich (ohne Anmeldung) |
| Bereitschaft (Datenbank erreichbar, Schema aktuell) (`health.ready`) | `GET /readyz` | öffentlich (ohne Anmeldung) |
| Systemstatus: Version, Datenbank, Audit-Kette, Sicherungen, Ausgangspostfach, BI (`system.status`) | `GET /api/v1/system/status` | `admin` |
| Protokollierte Fehler (`system.errors`) | `GET /api/v1/system/errors` | `admin` |
| Sicherungen (`system.backups`) | `GET /api/v1/system/backups` | `admin` |
| Verschlüsselte Sicherung jetzt erstellen (`system.backupNow`) | `POST /api/v1/system/backups` | `admin` |

### Audit

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| Audit-Log durchsuchen (`audit.list`) | `GET /api/v1/audit` | `auditor`, `admin` |
| Integrität der Hash-Kette prüfen (`audit.verify`) | `GET /api/v1/audit/verify` | `auditor`, `admin` |
| Audit-Log exportieren (CSV oder JSON) (`audit.export`) | `GET /api/v1/audit/export` | `auditor` |
| Externe Verankerung: letzter eigener Prüfpunkt, Zustellung, für Partner verwahrte Prüfpunkte (`anchors.status`) | `GET /api/v1/audit/anchors` | `auditor`, `admin` |
| Prüfpunkt der Audit-Kette jetzt signieren und an alle vertrauenswürdigen Partner senden (`anchors.create`) | `POST /api/v1/audit/anchors` | `auditor`, `admin` |
| Letzten signierten Prüfpunkt exportieren (`anchors.latest`) | `GET /api/v1/audit/anchors/latest` | `auditor`, `admin` |
| Audit-Kette mit den bei Partnern verwahrten Prüfpunkten abgleichen (`anchors.verify`) | `POST /api/v1/audit/anchors/verify` | `auditor`, `admin` |

### BI

| Vorgang | Methode und Pfad | Berechtigt |
|---|---|---|
| BI-Views (Schema "bi") und Verbindungsdaten für BI-Werkzeuge (`bi.views`) | `GET /api/v1/bi/views` | `admin`, `data_steward` |
| BI-Views neu aufbauen (`bi.refresh`) | `POST /api/v1/bi/refresh` | `admin`, `data_steward` |
