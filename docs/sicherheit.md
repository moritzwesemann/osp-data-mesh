# Sicherheitskonzept

Dieses Konzept beschreibt die technischen und organisatorischen Sicherheitsmaßnahmen eines Knotens. Es
richtet sich an IT-Betrieb, Informationssicherheits- und Datenschutzbeauftragte. Umgesetzte Maßnahmen
verweisen auf den Code; offene Punkte sind am Ende gesammelt.

## Schutzbedarf und Grundsätze

Ein Knoten verarbeitet personenbezogene Daten von Athletinnen und Athleten, darunter **Gesundheitsdaten
(Art. 9 DSGVO)**. Der Schutzbedarf für Vertraulichkeit und Integrität ist daher **hoch**, für
Verfügbarkeit **normal** (der Trainingsbetrieb hängt nicht vom System ab).

Grundsätze:

- **Deny by default:** ohne gültige Freigabe keine Daten; ohne passende Rolle kein Aufruf.
- **Ein einziger Ausgabeweg** für Fachdaten: der Policy Enforcement Point (`services.pep.serve`).
- **Geringste Rechte** für Prozesse und Datenbankrollen; Trennung von Betrieb (admin) und Fachdaten.
- **Nachvollziehbarkeit:** jeder relevante Vorgang im manipulationsgeschützten Audit-Log.
- **Keine selbstgebaute Kryptografie:** ausschließlich `node:crypto` (AES-256-GCM, Ed25519, SHA-256, HMAC)
  und Argon2id aus der Bun-Laufzeit.

## Transportverschlüsselung

| Strecke | Schutz |
|---|---|
| Browser, BI-Werkzeuge (REST), Skripte → Knoten | HTTPS über Caddy (TLS 1.2/1.3, automatische Zertifikate per ACME oder interne CA); `Strict-Transport-Security` vom Server bei `MESH_COOKIE_SECURE=true` |
| Knoten ↔ Partnerknoten | HTTPS (Caddy) **und** Ed25519-Signaturen auf Anfrage und Antwort (siehe unten); `http://` nur mit `MESH_FEDERATION_ALLOW_HTTP=true` (ausschließlich Demo/Tests) |
| Caddy → Server | unverschlüsselt, aber nur über `127.0.0.1` (nativ) bzw. das Docker-Netz `frontend` |
| Server → PostgreSQL | über `127.0.0.1` bzw. das interne Docker-Netz `backend` (`internal: true`) |
| BI-Werkzeuge → PostgreSQL (`mesh_bi`) | nur wenn bewusst freigeschaltet; dann **PostgreSQL-TLS** (`ssl = on`) oder VPN erforderlich (siehe [BI-Anbindung](bi.md)) |
| Knoten → API-Quellen (Messsysteme) | HTTPS empfohlen; nur Hosts aus `MESH_SOURCE_ALLOWED_HOSTS`; **Zugangsgeheimnisse nur über HTTPS** (Ausnahmen: Loopback-Adressen oder ausdrücklich `MESH_SOURCE_ALLOW_INSECURE_HTTP=true`, siehe [SSRF](#schutz-vor-server-side-request-forgery-ssrf)) |

## Föderation: Signaturen und Vertrauen

- Jeder Knoten besitzt ein **Ed25519-Schlüsselpaar**, erzeugt beim ersten Start; der private Schlüssel
  liegt nur mit dem Master-Key verschlüsselt in der Datenbank.
- **Vertrauensaufnahme** ausschließlich manuell: Knotenkarte austauschen, **Fingerprint über einen zweiten
  Kanal abgleichen**, Vertrauen bestätigen (Rolle `admin`); beidseitig erforderlich. Sperren
  (`suspended`) beendet jeden Austausch sofort – nur Mitteilungen (`notice`) des gesperrten Partners werden
  weiter angenommen, weil sie ausschließlich von ihm stammende Kopien löschen (Widerruf, Löschung,
  Einwilligungswiderruf).
- Jede Anfrage und jede Antwort ist über die **exakten Body-Bytes** signiert (keine Kanonisierung). Der
  Empfänger prüft bekannten/vertrauten Absender, Signatur, Schema, Empfänger, Zeitstempel (± 5 min) und
  Einmaligkeit der Nachrichten-ID (Replay-Schutz, 15 min). Antworten sind über `inReplyTo` an die Anfrage
  gebunden; Signatur und SHA-256 der Antwort werden als Herkunftsnachweis gespeichert.
- Partner erhalten statt lokaler IDs **freigabebezogene Pseudonyme** (HMAC mit einem Knotengeheimnis);
  Daten verschiedener Freigaben lassen sich beim Empfänger nicht verknüpfen.
- Fehlerantworten verraten Nicht-Empfängern nichts über Existenz oder Status von Freigaben
  (einheitlich `not_found`).
- **Schutz vor Überflutung:** Absender werden geprüft, bevor der Body gelesen wird; Anfragen höchstens
  2 MB. Abgelehnte Anfragen stehen alle im Betriebslog, im Audit-Log nur die erste je Quelle und Code in
  5 Minuten (höchstens 20 je 5 Minuten). Nach 60 Ablehnungen je IP-Adresse (bzw. je behauptetem, nicht
  zugelassenem Absender) in 5 Minuten antwortet der Knoten mit 429, ohne weitere Prüfung. Eine gefälschte
  Absenderkennung sperrt keinen echten Partner aus. Details: [Protokoll](protokoll.md#schutz-vor-überflutung).

Details: [Föderationsprotokoll](protokoll.md), [ADR 0005](adr/0005-pull-austausch-ed25519.md).

## Authentifizierung

| Maßnahme | Umsetzung |
|---|---|
| Passwortspeicherung | **Argon2id** (`Bun.password`), nie im Klartext |
| Passwortregeln | mind. 12 Zeichen, nicht gleich E-Mail-Adresse, nicht gleich bisherigem Passwort |
| Initialpasswörter | von Administration bzw. `create-admin` erzeugt; Änderung bei der ersten Anmeldung erzwungen (bis dahin nur Passwortwechsel möglich) |
| Kontosperre | nach **5** Fehlversuchen in Folge für **15 Minuten** (gilt auch mit richtigem Passwort; Fehlversuche während der Sperre verlängern sie nicht); Entsperren durch Administration (*Benutzer › Sperre aufheben*, `users.update` mit `unlock: true`) |
| Ratenbegrenzung | 30 Anmeldeversuche je IP-Adresse in 5 Minuten (im Speicher des Prozesses) |
| Konto-Aufzählung | bei unbekannter E-Mail wird trotzdem ein Hash geprüft (gleiche Antwortzeit); **einheitliche Antwort** 401 `invalid_credentials` für unbekannte E-Mail, falsches Passwort, inaktives und gesperrtes Konto (Meldung: „E-Mail-Adresse oder Passwort ist falsch, oder das Konto ist vorübergehend gesperrt.“); der tatsächliche Grund (`invalid_credentials`, `inactive`, `locked`) steht nur im Audit-Log |
| Sitzungen | zufälliges 256-Bit-Token im Cookie `osp_session` (`HttpOnly`, `SameSite=Strict`, `Secure`, ohne `Domain`-Attribut, also nur für genau den Hostnamen des Knotens); in der Datenbank nur SHA-256; Ablauf nach `MESH_SESSION_TTL_HOURS` (Standard 12 h); neue Sitzung bei jeder Anmeldung (keine Sitzungsfixierung); Passwort-Reset und Deaktivierung beenden alle Sitzungen der Person, der eigene Passwortwechsel alle anderen |
| CSRF | zustandsändernde Anfragen mit Sitzungs-Cookie benötigen zusätzlich den Header `X-OSP-CSRF: 1` (fremde Seiten können ihn ohne CORS-Freigabe nicht setzen) + `SameSite=Strict` |
| API-Tokens | für Werkzeuge (Excel, Power BI, Python): `Authorization: Bearer osp_…`, 256 Bit Zufall, nur SHA-256 gespeichert, **einmalige Anzeige**, Ablauf 1–365 Tage (Standard 90), jederzeit widerrufbar; Rechte = Rollen der Person. Erzeugen nur mit Sitzung (Passwort-Anmeldung), nicht mit einem Token (403 `forbidden`, Grund `session_required`). **Alle Tokens einer Person werden widerrufen** bei eigenem Passwortwechsel, Zurücksetzen durch die Administration und Deaktivierung (Audit `token.revoke` je Token) |
| Inaktive Konten | sofort abgewiesen (Sitzungen beendet, Tokens widerrufen; auch nach einer Reaktivierung bleiben sie ungültig) |

**Restrisiko Protokollmenge bei Passwort-Angriffen:** Jeder fehlgeschlagene Anmeldeversuch wird einzeln
im Audit-Log protokolliert (`auth.login`, `outcome = denied`, mit Grund). Je IP-Adresse ist das durch die
Ratenbegrenzung beschränkt (30 Versuche in 5 Minuten, danach nur die erste Abweisung `rate_limited` je
Zeitfenster); ein Angriff über **viele wechselnde IP-Adressen** kann das Audit-Log dagegen unbegrenzt
wachsen lassen (Plattenplatz, Übersichtlichkeit; keine Vertraulichkeit). Erkennung über die Überwachung
des Plattenplatzes und gehäufte `auth.login`-Ablehnungen; Gegenmaßnahme: Quellen am Proxy bzw. an der
Firewall sperren. Die Föderation fasst Ablehnungen dagegen zusammen (siehe oben).

**Restrisiko Kontosperre als Angriff:** Wer eine E-Mail-Adresse kennt, kann das Konto mit fünf
Fehlversuchen je 15 Minuten gesperrt halten (Verfügbarkeit, keine Vertraulichkeit). Die Ratenbegrenzung je
IP-Adresse bremst das, verhindert es aber nicht (z. B. bei verteilten Angriffen). Erkennung über das
Audit-Log (`auth.login`, `outcome = denied`, Grund `locked`); Gegenmaßnahmen: Entsperren durch die
Administration, Quelle am Proxy bzw. an der Firewall sperren. Die einheitliche Antwort verrät dabei nicht,
ob ein Konto existiert oder gesperrt ist.

Nicht umgesetzt (offen): Zwei-Faktor-Authentisierung, Single Sign-on (SAML/OIDC) mit dem
Verzeichnisdienst des OSP. Als zusätzliche Härtung möglich, aber **nicht umgesetzt**: das Cookie-Präfix
`__Host-` (z. B. `__Host-osp_session`), mit dem der Browser erzwingt, dass das Cookie nur mit `Secure`,
`Path=/` und ohne `Domain` gesetzt werden kann; das schützt zusätzlich vor dem Überschreiben des Cookies
durch Subdomains (z. B. `bi.<knoten>`). Voraussetzung wäre `MESH_COOKIE_SECURE=true` (Standard).

## Rollen und Rechte

Fünf Rollen (`admin`, `data_steward`, `analyst`, `coach`, `auditor`) plus die technische Empfängerrolle
`bi`. Jede Route des HTTP-Vertrags deklariert die erlaubten Rollen; der Rahmen (`core/http.ts`) prüft sie
vor dem Handler und protokolliert Abweisungen (`access.forbidden`). **Administration und Revision haben
keinen impliziten Zugriff auf Fachdaten.** Daten erhalten Rollen nur über Freigaben. Matrix:
[Rollen und Rechte](rollen.md).

## Eingaben, Ausgaben, Web-Sicherheit

- **Validierung** jeder Anfrage (Pfad, Query, Body) gegen das zod-Schema des Vertrags; Fehler →
  `validation_failed` mit Feldcodes. **Ausgaben** werden gegen das Antwortschema gefiltert (unbekannte
  Felder entfernt) – verhindert versehentliche Datenabflüsse.
- **Größenbegrenzung:** API 1 MB, CSV-Uploads 20 MB, Föderationsanfragen 2 MB (Body erst nach der
  Absenderprüfung gelesen), Antworten von Partnern beim Abruf bis 50 MB.
- **SQL** ausschließlich parametrisiert (Kysely); dynamische Bezeichner (BI-Views) werden gegen ein
  striktes Muster geprüft.
- **Sicherheits-Header:** Content-Security-Policy (`default-src 'self'`, keine fremden Skripte,
  `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`,
  HSTS.
- **Datei-Auslieferung** (Oberfläche, Hilfe) nur innerhalb der Build-Verzeichnisse (Pfadprüfung).

## Datenbankrollen

| Rolle | Rechte | Verwendet von |
|---|---|---|
| `mesh_owner` | Eigentümer des Schemas; Migrationen, Wiederherstellung | nur Kommandozeile (`migrate`, `restore`), nie der Server |
| `mesh_app` | Lesen/Schreiben der Fachtabellen; **Audit-Log nur `INSERT`/`SELECT`**; Migrationshistorie nur lesen; Anlegen von Objekten in `bi`/`bi_data` | Server |
| `mesh_bi` | nur `USAGE` auf Schema `bi` und Lesen der dortigen Views; `default_transaction_read_only = on`, `statement_timeout = 60s` | BI-Werkzeuge, Superset |

Zusätzlich: `REVOKE ALL ON DATABASE … FROM PUBLIC`, kein `CREATE` im Schema `public` für andere Rollen.
Das Audit-Log ist zusätzlich durch Trigger gegen `UPDATE`, `DELETE` und `TRUNCATE` gesperrt (auch für den
Eigentümer) und durch eine Hash-Kette gesichert ([ADR 0006](adr/0006-db-rollen-audit-hashkette.md)).
Rechte werden nach jeder Migration und Wiederherstellung aus `migrations/grants.sql` neu gesetzt.

## Verschlüsselung gespeicherter Geheimnisse

- Privater Knotenschlüssel, Pseudonym-Schlüssel und Zugangsdaten von API-Quellen werden mit
  **AES-256-GCM** verschlüsselt gespeichert (`core/crypto.ts`, `SecretBox`). Format
  `v1.<Schlüssel-ID>.<IV|Chiffrat|Tag>`; die Schlüssel-ID (8 Hex-Zeichen von SHA-256 des Schlüssels)
  erlaubt die Rotation; ein fester Verwendungszweck (AAD) je Geheimnis verhindert Vertauschen.
- Der **Master-Key** kommt ausschließlich aus der Umgebung (`MESH_MASTER_KEY`), nie aus der Datenbank
  ([ADR 0008](adr/0008-geheimnisse-aes-gcm-master-key.md)).
- Zugangsdaten von API-Quellen werden nach dem Setzen nie wieder ausgegeben; Connector-Exporte enthalten
  keine Geheimnisse.
- **Sicherungen** sind vollständig mit einem eigenen Schlüssel (`MESH_BACKUP_KEY`, AES-256-GCM)
  verschlüsselt.
- **Fachdaten** in der Datenbank sind nicht auf Anwendungsebene verschlüsselt. Für Datenbank- und
  Sicherungsdatenträger wird eine **Datenträgerverschlüsselung** (z. B. LUKS, verschlüsselte Volumes des
  Dienstleisters) gefordert.

## Schlüsselverwaltung

| Schlüssel | Erzeugung | Speicherort | Rotation |
|---|---|---|---|
| Master-Key | `bun run cli gen-key` / `openssl rand -base64 32` | Umgebung (`.env`, `deploy/.env`, Rechte 0600) + Passwortverwaltung + Offline-Kopie | `rotate-master-key` mit `MESH_MASTER_KEY_PREVIOUS` ([Betrieb](betrieb.md#master-key-rotieren)) |
| Sicherungsschlüssel | wie oben | wie oben, getrennt von Sicherungen | neuer Schlüssel für neue Sicherungen; alter bis Ablauf der alten Sicherungen |
| Ed25519-Knotenschlüssel | automatisch beim ersten Start | Datenbank, verschlüsselt | im Prototyp kein Kommando (offen) |
| Pseudonym-Schlüssel | automatisch beim ersten Start | Datenbank, verschlüsselt | nicht vorgesehen (Pseudonyme bleiben je Freigabe stabil) |
| Datenbankpasswörter | `openssl rand -hex 24` | `.env.owner` / `deploy/.env` + Passwortverwaltung | `bootstrap.sql` erneut ausführen |
| TLS-Zertifikate | Caddy (ACME oder interne CA) | Caddy-Datenverzeichnis | automatisch |

Organisatorisch: Zugriff auf Master- und Sicherungsschlüssel nur für benannte Personen (mindestens zwei),
Vier-Augen-Prinzip bei Nutzung, Rotation beim Ausscheiden einer berechtigten Person.

## Trennung interner und externer Dienste

- **Nur Caddy** ist von außen erreichbar (Ports 80/443). Apache Superset (optional, Profil `bi`) läuft
  über denselben Port 443, aber unter einem **eigenen Hostnamen** `MESH_BI_DOMAIN` (Standard
  `bi.<CADDY_DOMAIN>`), nie unter dem Namen des Knotens mit anderem Port: Cookies sind nicht an Ports
  gebunden (RFC 6265, Abschnitt 8.5), der Browser schickte das Sitzungs-Cookie des Knotens sonst auch an
  Superset. An einen anderen Hostnamen sendet er es nicht (Cookie ohne `Domain`-Attribut). Siehe
  [Installation](installation.md#optional-apache-superset).
- Der Server lauscht nativ auf `127.0.0.1` (`MESH_HOST`), im Container nur im Docker-Netz.
- PostgreSQL ist nativ auf `localhost` beschränkt (Standard der Pakete), im Container nur im internen
  Netz `backend` (`internal: true`: weder von außen erreichbar noch mit Internetzugang).
- Der Server ist zusätzlich im Netz `frontend`, weil er Partnerknoten und API-Quellen erreichen muss.
- Owner-Zugangsdaten erhält nur die Kommandozeile (Dienste `migrate`/`cli`), nie der Server-Prozess.
- Empfehlung: Server in einer DMZ bzw. eigenem VLAN; ausgehend nur HTTPS zu Partnern und Quellen
  (Firewall-Freigaben je Ziel).

## Schutz vor Server-Side Request Forgery (SSRF)

Der Knoten ruft Daten von API-Quellen ab. Damit niemand über eine Connector-Definition interne Dienste
abfragen kann:

- Ziele nur aus der **Positivliste** `MESH_SOURCE_ALLOWED_HOSTS` (exakter Vergleich `host[:port]`, nicht
  über die Oberfläche änderbar); leere Liste = keine API-Quellen.
- nur `http`/`https`; **Weiterleitungen werden nicht verfolgt**; Zeitlimit je Abruf (1–60 s, Standard
  15 s); Antworten insgesamt höchstens **50 MB** und **100 000 Einträge** je Lauf (über alle Seiten), sonst
  bricht der Abruf ab, ohne weiterzulesen.
- **Zugangsgeheimnisse sind an das gespeicherte Ziel gebunden:** Ändert sich beim Bearbeiten eines
  Connectors der Origin der URL (Schema, Host, Port) oder die Art der Authentifizierung (einschließlich
  Header-Name), wird das gespeicherte Geheimnis gelöscht (Audit `connector.secret_cleared`) und muss neu
  gesetzt werden. So lässt sich ein Geheimnis nicht durch Ändern der URL an einen anderen Host umleiten.
- *Beispiel abrufen* (`connectors.inspect`) mit einem gespeicherten Connector (`connectorId`) verwendet
  ausschließlich dessen **gespeicherte** URL und Authentifizierung; URL und Authentifizierung aus der
  Anfrage werden dann ignoriert.
- Geheimnisse werden nur über **https://** gesendet, über `http://` nur an Loopback-Adressen
  (`127.0.0.1`, `::1`, `localhost`) oder wenn `MESH_SOURCE_ALLOW_INSECURE_HTTP=true` gesetzt ist (Standard
  `false`; nur in abgeschotteten Netzen, das Geheimnis geht dann im Klartext über das Netz).
- Abweisung mit `source_not_allowed` (Host nicht freigegeben) bzw. `source_not_allowed` mit Grund
  `insecure_http` (Geheimnis über unverschlüsselte Verbindung) und Audit-Eintrag.

**Grenzen beim Import** (Schutz vor Überlastung durch Quelldateien, `src/server/modules/connectors/pipeline.ts`):
CSV-Uploads höchstens **20 MB**; je Lauf höchstens **500 Spalten** und **100 000 Zeilen** (bzw.
API-Einträge). Wird eine Grenze überschritten, endet das Lesen sofort und der Lauf schlägt mit
`too_many_columns` bzw. `too_many_rows` fehl, ohne Zeilen zu übernehmen; *Beispiel abrufen* liest nur die
ersten Zeilen und weist mehr als 500 Spalten mit `payload_too_large` ab. Verschachtelte JSON-Objekte
werden bis zur Tiefe 32 in Spalten aufgelöst; Arrays und tiefere Teile werden als JSON-Text übernommen.

Restrisiko: Die Liste prüft Namen, nicht die aufgelöste IP-Adresse; nur vertrauenswürdige Hosts eintragen.
Partneradressen werden nur bei der manuellen Vertrauensaufnahme festgelegt.

## Protokollierung

- **Audit-Log** (Datenbank, nur anhängbar, Hash-Kette): Anmeldungen und Fehlversuche, Benutzer- und
  Rollenänderungen, Zugriffe auf Personendaten (auch lesend), Importe, Freigaben, Widerrufe, Einwilligungen,
  Löschungen, jeder Austausch (gesendet/empfangen/abgelehnt), Sicherungen, Wiederherstellungen,
  Schlüsselrotation, abgewiesene Zugriffe (`outcome = denied`). Keine personenbezogenen Rohdaten in den
  Details, nur IDs und Zähler. Abgelehnte Föderationsanfragen ohne gültige, frische Signatur werden
  **zusammengefasst** (erste je Quelle und Code in 5 Minuten, höchstens 20 je 5 Minuten; Rest im
  Betriebslog), damit unauthentifizierte Anfragen das Log nicht fluten können.
- **Austauschprotokoll** (`exchange_log`): jede gelieferte oder abgelehnte Partneranfrage mit Spalten,
  Zeilenzahl, übermittelten Pseudonymen und Prüfsumme.
- **Betriebslog** (JSON-Zeilen, stdout/stderr) ohne personenbezogene Daten; **Fehlerprotokoll** in der
  Tabelle `app_error`.
- Auswertung durch die Rolle `auditor` (Suche, Export CSV/JSON, Integritätsprüfung).

## Fehlerbehandlung

- Fachliche Fehler liefern einen **Fehlercode** aus einer festen Liste (`ERROR_CODES` im Vertrag) und eine
  Request-ID; die Oberfläche zeigt eine verständliche deutsche Meldung zum Code und die Request-ID.
  Server-Freitext (z. B. Datenbankmeldungen) erreicht die Nutzenden nie.
- Unerwartete Fehler → HTTP 500 `internal_error`; Details nur im Log und in `app_error` (Administration:
  *System › Letzte Fehler*).
- Föderationsfehler werden mit Code beim Partner gespeichert (`last_error`) und im Austauschprotokoll
  vermerkt; Zustellfehler des Ausgangspostfachs sind sichtbar und werden wiederholt. Nach 20 Fehlversuchen
  ist eine Mitteilung *fehlgeschlagen*; *Jetzt zustellen* (`outbox.flush`) versucht sie erneut (Audit
  `outbox.requeue`), z. B. nachdem die Verbindung wiederhergestellt ist.

## Schwachstellenmanagement

**Bestandsaufnahme**

- SBOM im Format CycloneDX für jede Version: `bun run sbom` → `sbom/osp-data-mesh.cdx.json`
  (siehe [unten](#sbom-und-bsi-tr-03183-2)); Lizenzübersicht: [Lizenzen](lizenzen.md).
- Wenige, verbreitete Laufzeitabhängigkeiten (Hono, Kysely, pg, zod, papaparse; Oberfläche: React,
  React Router, TanStack Query), festgeschrieben in `bun.lock` mit SHA-512-Integrität;
  Container-Builds nur mit `--frozen-lockfile`.

**Prüfen (mindestens wöchentlich und vor jedem Release, z. B. als CI-Job)**

```sh
bun audit          # bekannte Schwachstellen der npm-Abhängigkeiten (Stand der Erstellung: keine)
bun run sbom       # SBOM aktualisieren und gegen das CycloneDX-Schema prüfen
```

Zusätzlich: Sicherheitsmeldungen von Bun, PostgreSQL, Caddy, Debian und (falls genutzt) Apache Superset
abonnieren; Container-Abbilder nach dem Bau mit einem Scanner (z. B. Trivy, Grype oder `docker scout`)
prüfen. Die OSV-Datenbank (osv.dev) kann mit der SBOM abgefragt werden (z. B. `osv-scanner --sbom`).

**Bewerten und beheben**

| Schweregrad (CVSS) | Reaktionszeit (Ziel) |
|---|---|
| kritisch (≥ 9,0), ausnutzbar im Knoten | Notfall-Update binnen 72 Stunden, ggf. Abschalten der betroffenen Funktion |
| hoch (7,0–8,9) | binnen 14 Tagen |
| mittel/niedrig | mit dem nächsten regulären Update (monatlich) |

Ablauf: Meldung prüfen (betrifft sie einen ausgelieferten Bestandteil? – SBOM-Feld `scope = required`),
Abhängigkeit anheben (`bun update <paket>`), Tests (`bun test`), SBOM und Lizenzseite neu erzeugen,
Version ausliefern, Betreiber informieren. Meldungen von außen an eine vom Betreiber festzulegende
Sicherheitskontaktadresse (offen; empfohlen: `/.well-known/security.txt` über Caddy).

**Update-Rhythmus:** Betriebssystem und Container-Basisabbilder monatlich; Bun und Abhängigkeiten
quartalsweise bzw. bei Sicherheitsmeldungen; PostgreSQL-Nebenversionen zeitnah.

## SBOM und BSI TR-03183-2

`bun run sbom` erzeugt `sbom/osp-data-mesh.cdx.json` (CycloneDX 1.6, JSON):

1. **cdxgen** (`@cyclonedx/cdxgen@12.9.0`, über `bun x`) liest `bun.lock` und erzeugt Komponenten mit
   Paket-URL (purl), SHA-512-Hash (aus der Lockfile-Integrität) und Abhängigkeitsgraph. Ohne Netz bzw.
   cdxgen: `bun run sbom -- --builtin` erzeugt dieselbe Struktur direkt aus `bun.lock`.
2. **Anreicherung** (`scripts/sbom.ts`) für die Pflichtfelder nach TR-03183-2 (Abschnitt 5.2):

| TR-03183-2 Feld | Umsetzung |
|---|---|
| Ersteller der SBOM, Zeitstempel | `metadata.authors` (Platzhalter), `metadata.timestamp`, `metadata.tools` |
| Komponentenname, Version | `name`, `group`, `version`, eindeutig über `purl` und `bom-ref` |
| Urheber der Komponente (E-Mail/URL) | `authors` aus `package.json` (Name/E-Mail), `externalReferences` `website`/`vcs` |
| Dateiname | Eigenschaft `bsi:component:filename` (npm-Archiv, z. B. `hono-4.13.16.tgz`) |
| Abhängigkeiten | `dependencies` (vollständiger Graph, inkl. Hauptkomponente) |
| Lizenzen | SPDX-Kennung/-Ausdruck aus `package.json` (deklarierte Lizenz); Projekt: EUPL-1.2 |
| Hashwert (SHA-512) | `hashes` aus `bun.lock` (Integrität des npm-Archivs) |
| Eigenschaften ausführbar/Archiv/strukturiert | `bsi:component:executable`, `bsi:component:archive`, `bsi:component:structured` |
| Geltungsbereich | `scope`: `required` = ausgeliefert (Server oder in die Oberfläche gebündelt), `excluded` = nur Build/Entwicklung; Eigenschaft `osp:usage` |
| URI der ausführbaren Form | `externalReferences` `distribution` (npm-Registry) |

Das Ergebnis wird mit `cdx-validate` gegen das CycloneDX-Schema geprüft (Ergebnis bei Erstellung:
schema- und strukturgültig).

**Bekannte Lücken (offen):**

- Hersteller, Lieferant und SBOM-Ersteller sind Platzhalter **„Auftragnehmer (tbd)“** ohne E-Mail/URL;
  ebenso fehlt ein Kontakt für Schwachstellenmeldungen (auch für den Cyber Resilience Act relevant).
- Die SBOM ist **nicht signiert** (möglich mit `cdx-sign` bzw. einer Signatur im Release-Prozess).
- Sie erfasst die npm-Abhängigkeiten und die Bun-Laufzeit (ohne Hash). **Betriebssystempakete der
  Container-Abbilder** (Debian, PostgreSQL-Client, Caddy, Superset) sind nicht enthalten; dafür nach dem
  Bauen eine Abbild-SBOM erzeugen (z. B. `bun x @cyclonedx/cdxgen -t docker osp-data-mesh:local`; nicht
  lokal verifiziert).
- Die Eigenschaften `executable`/`archive`/`structured` und der Dateiname sind aus der Paketart abgeleitet
  (npm-Archiv = Archiv, strukturiert; Pakete mit Programmen/Binärdateien = ausführbar), nicht je Datei
  geprüft.
- Lizenzen sind **deklarierte** Lizenzen der Pakete; nicht installierte plattformspezifische Pakete erben
  die Lizenz des einbindenden Pakets (gekennzeichnet). Copyright-Vermerke fehlen.
- Lebenszyklus „pre-build“: die SBOM beschreibt den Quellstand, nicht das gebaute Artefakt.

## Offene Punkte vor einem Produktivbetrieb

1. Externer Penetrationstest und Code-Review der Sicherheitsfunktionen.
2. Zwei-Faktor-Authentisierung bzw. Anbindung an das Identitätsmanagement des OSP.
3. Werkzeug für den Wechsel des Ed25519-Knotenschlüssels mit Benachrichtigung der Partner.
4. Sicherheitskontakt, signierte Releases und signierte SBOM; Container-SBOM.
5. Ratenbegrenzung prozessübergreifend (Anmeldung und Föderation derzeit im Speicher eines Prozesses; nach
   einem Neustart beginnen die Zähler neu).
6. Festlegung der Aufbewahrungsfristen (insbesondere Audit-Log) und eines Archivierungsverfahrens.
7. Datenträgerverschlüsselung und Härtung des Hosts nach BSI IT-Grundschutz (Bausteine SYS.1.3, APP.4.3).
