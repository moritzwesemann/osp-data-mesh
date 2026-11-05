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
- **Schlüsselwechsel** ([ADR 0013](adr/0013-knotenschluessel-rotation.md)): planmäßig mit einer
  Mitteilung an alle Partner, die mit dem bisherigen (Kontinuität) und dem neuen Schlüssel (Besitz)
  signiert ist; Partner übernehmen den neuen Schlüssel nur von vertrauenswürdigen Absendern und nur, wenn
  die Aussage beim gespeicherten Schlüssel beginnt. Der bisherige Schlüssel gilt höchstens bis zum Ende der
  Übergangszeit (1–30 Tage) und nie für einen weiteren Wechsel. Bei **Verdacht auf Kompromittierung** gibt
  es bewusst keine Mitteilung (sie wäre mit dem verdächtigen Schlüssel signiert): Partner sperren den
  Knoten und gleichen den neuen Fingerprint telefonisch ab. Partner, die eine Mitteilung verpasst haben,
  tragen die neue Knotenkarte manuell ein (wieder mit Fingerprint-Abgleich).
- **Vertrauensaufnahme** ausschließlich manuell: Knotenkarte austauschen, **Fingerprint über einen zweiten
  Kanal abgleichen**, Vertrauen bestätigen (Rolle `admin`); beidseitig erforderlich. Sperren
  (`suspended`) beendet jeden Austausch sofort – nur Mitteilungen (`notice`) des gesperrten Partners werden
  weiter angenommen, weil sie ausschließlich von ihm stammende Kopien löschen (Widerruf, Löschung,
  Einwilligungswiderruf); Schlüsselwechsel und Prüfpunkte eines gesperrten Partners werden abgewiesen.
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
| Ratenbegrenzung | 30 Anmeldeversuche je IP-Adresse in 5 Minuten (im Speicher des Prozesses); maßgeblich ist die Client-Adresse (siehe [Client-Adresse hinter dem Reverse Proxy](#client-adresse-hinter-dem-reverse-proxy)) |
| Konto-Aufzählung | bei unbekannter E-Mail wird trotzdem ein Hash geprüft (gleiche Antwortzeit); **einheitliche Antwort** 401 `invalid_credentials` für unbekannte E-Mail, falsches Passwort, inaktives und gesperrtes Konto (Meldung: „E-Mail-Adresse oder Passwort ist falsch, oder das Konto ist vorübergehend gesperrt.“); der tatsächliche Grund (`invalid_credentials`, `inactive`, `locked`) steht nur im Audit-Log |
| Sitzungen | zufälliges 256-Bit-Token im Cookie **`__Host-osp_session`** (`HttpOnly`, `SameSite=Strict`, `Secure`, `Path=/`, ohne `Domain`-Attribut, also nur für genau den Hostnamen des Knotens). Das Präfix `__Host-` lässt der Browser nur mit `Secure`, `Path=/` und ohne `Domain` zu; so kann auch eine Subdomain (z. B. `bi.<knoten>`) das Cookie nicht setzen oder überschreiben. Nur bei `MESH_COOKIE_SECURE=false` (ausschließlich lokale HTTP-Testinstallation) heißt das Cookie `osp_session` und trägt kein `Secure`. In der Datenbank nur SHA-256; Ablauf nach `MESH_SESSION_TTL_HOURS` (Standard 12 h); neue Sitzung bei jeder Anmeldung (keine Sitzungsfixierung); Passwort-Reset und Deaktivierung beenden alle Sitzungen der Person, der eigene Passwortwechsel alle anderen |
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
Verzeichnisdienst des OSP.

### Client-Adresse hinter dem Reverse Proxy

Ratenbegrenzungen je IP-Adresse (Anmeldung, abgelehnte Föderationsanfragen) und die IP-Adressen im
Audit-Log brauchen die echte Client-Adresse. Hinter Caddy steht sie im Header `X-Forwarded-For`, den jeder
Client auch selbst mitsenden kann. Der Server wertet ihn deshalb nur aus, wenn `MESH_TRUST_PROXY=true`
gesetzt ist **und** die Verbindung von einer Adresse aus `MESH_TRUSTED_PROXIES` kommt (kommagetrennte
IP-Adressen, Standard `127.0.0.1,::1`). Aus der Kette verwendet er die rechteste Adresse, die nicht in
`MESH_TRUSTED_PROXIES` steht; weiter links stehende, vom Client gefälschte Einträge bleiben wirkungslos.
Nativ (Caddy auf demselben Server) passt der Standard; mit Docker Compose hat Caddy im Netz `frontend` die
feste Adresse `172.31.252.10`, die als einzige eingetragen ist. Ohne Reverse Proxy (lokale
Testinstallation) `MESH_TRUST_PROXY=false`. Einzelheiten:
[Betrieb](betrieb.md#föderationsendpunkt-größen-ratenbegrenzung-protokollierung).

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
- **Größenbegrenzung:** API 1 MB, CSV- und Excel-Uploads 20 MB (Excel entpackt höchstens 100 MB), Föderationsanfragen 2 MB (Body erst nach der
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
| `mesh_app` | Lesen/Schreiben der Fachtabellen; **Audit-Log nur `INSERT`/`SELECT`**; eigene Prüfpunkte nur über `audit_checkpoint_append()`, Schlüsselverlauf nur `finished_at`/`old_private_key_enc`; Migrationshistorie und Epochen nur lesen; Anlegen von Objekten in `bi`/`bi_data` | Server |
| `mesh_bi` | nur `USAGE` auf Schema `bi` und Lesen der dortigen Views; `default_transaction_read_only = on`, `statement_timeout = 60s` | BI-Werkzeuge, Superset |

Zusätzlich: `REVOKE ALL ON DATABASE … FROM PUBLIC`, kein `CREATE` im Schema `public` für andere Rollen.
**Rollen gelten in PostgreSQL clusterweit.** Die Trennung der Knoten setzt deshalb **einen eigenen
PostgreSQL-Cluster je Knoten** voraus (auch für Test- und Wiederherstellungssysteme): Zwei Knoten in einem
Cluster teilten sich `mesh_owner`, `mesh_app` und `mesh_bi` samt Passwörtern und könnten gegenseitig ihre
Datenbanken lesen. `db-bootstrap` bricht ab, wenn der Cluster schon eine andere Datenbank von `mesh_owner`
enthält (übergehbar nur mit `--force`, siehe [Installation](installation.md#a4-rollen-und-datenbank-anlegen-db-bootstrap)).
Das Audit-Log ist zusätzlich durch Trigger gegen `UPDATE`, `DELETE` und `TRUNCATE` gesperrt (auch für den
Eigentümer) und durch eine Hash-Kette gesichert ([ADR 0006](adr/0006-db-rollen-audit-hashkette.md)). Weil
der Eigentümer die Trigger abschalten und die Kette neu berechnen könnte, ist sie zusätzlich **extern
verankert** ([ADR 0014](adr/0014-externe-verankerung-audit-kette.md)): Signierte Prüfpunkte (Laufnummer und
Hash des Kettenkopfs, stündlich) liegen bei allen vertrauenswürdigen Partnern; der Abgleich (*Audit › Mit
Partnern abgleichen*, `verify-audit --with-partners`) erkennt Abschneiden und Umschreiben. Verwahrte
Prüfpunkte der Partner darf `mesh_app` nur lesen und anhängen, eigene nur lesen und über die Funktion
`audit_checkpoint_append()` anlegen (aktuelle Epoche, vorhandene Laufnummer mit ihrem Hash, `created_at`
setzt die Datenbank), den Epochenverlauf der Kette (`audit_chain_epoch`) nur lesen, im Verlauf der
Schlüsselwechsel nur Ende der Übergangszeit und Neuverschlüsselung setzen (Spaltenrechte, Trigger:
`finished_at` endgültig); `mesh_bi` sieht nichts davon.

Was der Abgleich der Datenbank **nicht** glaubt (Härtung nach einer Sicherheitsprüfung, Nachtrag zu
ADR 0014):

- **Hashes:** Die Kette wird im Programm aus den Rohspalten neu berechnet (`modules/audit/chain.ts`, Byte
  für Byte wie `audit_digest_input()`), nicht mit `audit_verify()` und nicht über die gespeicherte Spalte
  `hash` – beide könnte der Eigentümer ersetzen bzw. stehen lassen, während er Inhalte ändert. Auch
  `verify-audit` ohne Partner und `restore` rechnen so. Neue Einträge nutzen eine eindeutige Hash-Eingabe
  (Version 2 mit Längenangaben, Migration 0620); die Prüfung kontrolliert außerdem Spaltentypen und
  `NOT NULL` über `pg_attribute` und die erlaubten Werte von `actor_type`/`outcome`.
- **Partner und Schlüssel:** Partnerliste, Adressen, Partnerschlüssel und frühere eigene Schlüssel liegen in
  derselben Datenbank (teils von `mesh_app` änderbar). Unabhängig ist der Abgleich nur mit dem **Anker-Profil**
  (`audit-anchor-profile`, offline verwahrt): `verify-audit --with-partners --profile <datei>` nimmt
  Partner, Adressen und Schlüssel ausschließlich daraus, jeder Partner des Profils muss bestätigen (oder
  begründet entschuldigt sein). Der Abgleich in der Oberfläche läuft im Server und ist ausdrücklich als
  nicht unabhängig gekennzeichnet.
- **Epochen:** Eine vom Eigentümer erfundene „Wiederherstellung“ macht spätere Prüfpunkte ohne Profil zu
  „verloren“ (Ergebnis „Klärung nötig“, Exit 4), nie zu „ok“; mit Profil ist sie **Manipulation** (Exit 1),
  ebenso ein Prüfpunkt hinter dem Kopf, den `restore` vor der Wiederherstellung festhielt. Ein Neuexport des
  Profils übernimmt eine neue Epoche nur mit `--accept-epochs` (Sicherung und Kopf davor werden angezeigt).
- **Neuexport des Profils:** `--previous` behält die Mindestzahl und übernimmt geänderte Partner, eigene
  Schlüssel und Epochen nur je Kategorie ausdrücklich (`--accept-partner-changes`, `--accept-key-changes`,
  `--accept-epochs`), sonst kein Export.
- **Planer:** zählt nur gültig signierte eigene Prüfpunkte, die nicht aus der Zukunft stammen; ein
  veralteter Anker (jüngster bestätigter Prüfpunkt älter als 3 Intervalle) ergibt „Klärung nötig“, und jede
  Prüfung nennt die Zahl der noch nicht verankerten Einträge.
- **Kompromittierte Schlüssel:** Abweichungen, die mit einem wegen Kompromittierung abgelösten Schlüssel
  signiert sind, gelten nicht als Beweis; Signaturen außerhalb des Gültigkeitszeitraums eines Schlüssels
  zählen nicht. Partner setzen „nur steigende Laufnummern“ je signierendem Schlüssel durch, sodass ein
  gestohlener, später ersetzter Schlüssel die Prüfpunkte des neuen nicht blockiert; Reihenfolge- und
  Ratenprüfung laufen in der Transaktion des Verwahrens (Sperre je Partner).

**Restrisiken der Verankerung** (Nachtrag 2 zu ADR 0014, ADR 0006):

- Einträge **nach dem letzten Anker** kann der Eigentümer der Datenbank weiterhin unbemerkt ändern oder
  löschen; sichtbar ist nur ihre Zahl bzw. ein veralteter Anker. Der veraltete Anker ist „Klärung nötig“,
  kein Beweis: ein Knoten, der lange nicht lief, sieht genauso aus.
- Wer mit `mesh_app`-Rechten fortlaufend den Platz des jeweiligen Kettenkopfs vorwegnimmt, kann
  Prüfpunkte verzögern (jeder Versuch protokolliert als `audit.checkpoint.invalid_row`, die Prüfung meldet
  dann den veralteten Anker).
- Mit einem gestohlenen, noch gültigen Knotenschlüssel lassen sich bis zum Wechsel einzelne künftige
  Laufnummern beim Partner vorwegnehmen (höchstens `MESH_AUDIT_CHECKPOINT_MAX_PER_DAY` je Tag); ein
  ehrlicher Prüfpunkt genau dieser Laufnummer wird als Widerspruch abgelehnt (sichtbar als
  `audit.checkpoint.conflict`), der nächste kommt durch.
- Einträge von vor Migration 0620 (Hash-Version 1) bleiben mehrdeutig: Text mit `|` lässt sich dort
  zwischen benachbarten Feldern verschieben, ohne dass Hash oder Prüfpunkt sich ändern; die Prüfung zählt
  diese Einträge (Hinweis `legacy_digest_ambiguous`).
- Nach einer echten Wiederherstellung meldet das alte Profil „Manipulation“, bis es mit `--accept-epochs`
  neu exportiert ist – die Annahme ist nur so gut wie der Abgleich mit dem Protokoll der Wiederherstellung.
- Ohne Profil (Oberfläche, `--with-partners` ohne `--profile`) bleibt die Prüfung von der Datenbank
  abhängig.

Grenze: Wer Datenbank **und** das prüfende Programm (bzw. dessen Rechner) kontrolliert, kann auch das
Prüfergebnis fälschen; ebenso ein Superuser des PostgreSQL-Clusters, der eingebaute Typumwandlungen oder
Funktionen in `pg_catalog` ändert oder dem Prüfprogramm gezielt andere Zeilen zeigt als anderen Lesern. Dagegen
helfen die Prüfung von einem sauberen Stand aus (eigener Rechner, geprüfte Software, Profil von außerhalb),
der Export von Prüfpunkten an Dritte und Superuser-Rechte nur für die Datenbankadministration.
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
| Ed25519-Knotenschlüssel | automatisch beim ersten Start; neu bei jedem Wechsel | Datenbank, verschlüsselt; der bisherige nur während der Übergangszeit (verschlüsselt), danach gelöscht | *Partner › Schlüssel wechseln* bzw. `rotate-node-key --routine` (Partner werden signiert benachrichtigt), bei Verdacht auf Kompromittierung `--compromised` ohne Mitteilung ([Betrieb](betrieb.md#knotenschlüssel-ed25519), [ADR 0013](adr/0013-knotenschluessel-rotation.md)) |
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
  Header-Name, bei OAuth2 Token-Endpunkt und Client-Kennung), wird das gespeicherte Geheimnis gelöscht
  (Audit `connector.secret_cleared`) und muss neu gesetzt werden. So lässt sich ein Geheimnis nicht durch
  Ändern der URL an einen anderen Host umleiten.
- **OAuth2 (Client Credentials):** Der **Token-Endpunkt** unterliegt denselben Regeln wie die Adresse der
  Quelle – sein Host muss in `MESH_SOURCE_ALLOWED_HOSTS` stehen (sonst `source_not_allowed` mit Grund
  `token_url_not_allowed`), das Client-Geheimnis geht nur über HTTPS (bzw. Loopback), keine
  Weiterleitungen, Antwort höchstens 64 KB. Das Client-Geheimnis ist das verschlüsselt gespeicherte
  Zugangsgeheimnis (`connector.secret:<id>`); es geht nur an den Token-Endpunkt, nie an die Datenquelle.
  Zugriffstokens liegen nur im **Arbeitsspeicher** des Knotens (nicht in Datenbank, Audit oder
  Fehlerprotokoll), bis 60 Sekunden vor Ablauf (höchstens 1 Stunde); jede Änderung von Token-Endpunkt,
  Client-Kennung, Scope, Audience, Übermittlungsart oder Geheimnis erzwingt ein neues Token. Nach einer
  401-Antwort der Quelle wird **einmal** ein neues Token geholt. Ein Token wird nur übernommen, wenn es aus
  sichtbaren ASCII-Zeichen besteht (keine Kopfzeilen-Injektion) und `token_type` fehlt oder `Bearer` ist;
  Freitext des Token-Endpunkts erreicht die Oberfläche nicht (nur die Fehlercodes aus RFC 6749, 5.2).
- *Beispiel abrufen* (`connectors.inspect`) mit einem gespeicherten Connector (`connectorId`) verwendet
  ausschließlich dessen **gespeicherte** URL und Authentifizierung; URL und Authentifizierung aus der
  Anfrage werden dann ignoriert.
- Geheimnisse werden nur über **https://** gesendet, über `http://` nur an Loopback-Adressen
  (`127.0.0.1`, `::1`, `localhost`) oder wenn `MESH_SOURCE_ALLOW_INSECURE_HTTP=true` gesetzt ist (Standard
  `false`; nur in abgeschotteten Netzen, das Geheimnis geht dann im Klartext über das Netz).
- Abweisung mit `source_not_allowed` (Host nicht freigegeben) bzw. `source_not_allowed` mit Grund
  `insecure_http` (Geheimnis über unverschlüsselte Verbindung) und Audit-Eintrag.

**Grenzen beim Import** (Schutz vor Überlastung durch Quelldateien, `src/server/modules/connectors/pipeline.ts`):
CSV- und Excel-Uploads höchstens **20 MB**; je Lauf höchstens **500 Spalten** und **100 000 Zeilen** (bzw.
API-Einträge). Wird eine Grenze überschritten, endet das Lesen sofort und der Lauf schlägt mit
`too_many_columns` bzw. `too_many_rows` fehl, ohne Zeilen zu übernehmen; *Beispiel abrufen* liest nur die
ersten Zeilen und weist mehr als 500 Spalten mit `payload_too_large` ab. Verschachtelte JSON-Objekte
werden bis zur Tiefe 32 in Spalten aufgelöst; Arrays und tiefere Teile werden als JSON-Text übernommen.

**Excel-Dateien als feindliche Eingabe** (`src/server/modules/connectors/xlsx.ts`,
[ADR 0015](adr/0015-excel-import-eigener-leser.md)): Das ZIP-Verzeichnis wird selbst gelesen (höchstens
10 000 Einträge; ZIP64, mehrteilige und verschlüsselte Archive, unbekannte Kompressionsverfahren und
doppelte Teilnamen werden abgelehnt). Entpackt wird als Datenstrom (fflate); die Obergrenze von
**100 MB entpackt** je Datei (8 MB je Verwaltungsteil, 1 MB je XML-Element bzw. Zellwert) gilt für die
tatsächlich erzeugten Bytes, nicht für die Angaben im Archiv – eine ZIP-Bombe wird nach wenigen Megabyte
abgebrochen. Größe und CRC-32 jedes gelesenen Teils werden geprüft. Der XML-Leser kennt keine DTD
(`<!DOCTYPE` wird abgelehnt) und löst nur die fünf vordefinierten Entitäten und Zeichenreferenzen auf
(kein XXE, keine Entitätsexpansion); Attribute und Zeilen liegen in Strukturen ohne Prototyp. **Formeln
werden nie ausgewertet**: übernommen wird nur das gespeicherte Ergebnis. Text, der mit `=`, `+`, `-`
oder `@` beginnt, bleibt Text; beim CSV-Export schützt die bestehende Formel-Neutralisierung
(`core/formats.ts`, vorangestelltes `'`). Abgewiesene Dateien ergeben einen fehlgeschlagenen Lauf mit
`invalid_file` und Grund (Audit `import.start`, Ergebnis `error`).

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
- Auswertung durch die Rolle `auditor` (Suche, Export CSV/JSON, Integritätsprüfung, Abgleich mit den bei
  Partnern hinterlegten Prüfpunkten, Export des letzten signierten Prüfpunkts).

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

Grundlage ist **BSI TR-03183-2 Version 2.1.0 vom 20.08.2025** – laut BSI-Webseite (abgerufen am
05.11.2026) die aktuelle Fassung; sie verlangt CycloneDX ab Version 1.6 (hier: 1.6, JSON) und bildet die
Datenfelder in Abschnitt 8.2 auf CycloneDX ab. Diese Abbildung ist umgesetzt.

| SBOM | Lebenszyklus (TR 8.4) | Datei | Erzeugung |
|---|---|---|---|
| **Quell-SBOM** (alle npm-Pakete inkl. Build-Werkzeuge, Laufzeit Bun, PostgreSQL) | `pre-build` (Source SBOM) | `sbom/osp-data-mesh.cdx.json` (im Repository) | `bun run sbom` |
| **Build-SBOM der Web-Oberfläche** (ausgelieferte Dateien unter `dist/ui` mit SHA-512 und den darin gebündelten Paketen) | `build` (Build SBOM) | `dist/sbom/osp-data-mesh-ui.build.cdx.json` (je Build, nicht im Repository) | `bun run sbom -- build-ui` (baut `dist/ui` neu) |
| **Abbild-SBOM** (Betriebssystempakete des Container-Abbilds, Bun-Binärdatei) | nach dem Bau (Analysed SBOM) | `sbom/osp-data-mesh.image.cdx.json` | Befehl siehe [Betrieb](betrieb.md) |

**Quell-SBOM:** cdxgen (`@cyclonedx/cdxgen@12.9.0`, über `bun x`) liest `bun.lock` und liefert Komponenten,
Paket-URL (purl), SHA-512 und Abhängigkeitsgraph (ohne Netz bzw. cdxgen: `bun run sbom -- --builtin`, dieselbe
Struktur direkt aus `bun.lock`). `scripts/sbom.ts` ergänzt alle Felder der TR (Tabelle unten). Für die
plattformspezifischen Pakete anderer Betriebssysteme, die lokal nicht installiert sind, liest es Lizenz,
Urheber und Repository aus dem Paketmanifest der npm-Registry, nur wenn dessen Integrität mit `bun.lock`
übereinstimmt (`--offline`: ohne Abruf, Lizenz dann vom einbindenden Paket geerbt und gekennzeichnet).

**Build-SBOM:** `bun run sbom -- build-ui` baut die Oberfläche mit der Projektkonfiguration (Vite/Rolldown)
und liest dabei je Ausgabedatei die enthaltenen Module. Jede Datei unter `dist/ui` wird eine Komponente
(Typ `file`, SHA-512, Dateiname; gebündeltes JavaScript: ausführbar, kein Archiv, unstrukturiert), jedes
hineingebündelte npm-Paket eine vollständig beschriebene Komponente mit Eigenschaft `osp:bundled-in`
(TR 3.2.1: zusammengeführte Komponenten werden aufgeführt). Auch die von Vite/Rolldown eingefügten
Laufzeithilfen (Preload-Helfer, Rolldown-Laufzeit) erscheinen als Pakete `vite` bzw. `rolldown`. Version:
`<package.json-Version>+g<Commit>` (Zusatz `.dirty` bei uncommitteten Änderungen). Zum Prüfen ohne
`dist/ui` anzufassen: `bun run sbom -- build-ui --out-dir /tmp/ui-pruefung` (SBOM dann in
`/tmp/sbom/`). Für ein Release die Build-SBOM direkt nach dem Bau des ausgelieferten Artefakts erzeugen;
das Container-Abbild baut `dist/ui` selbst (gleiche Eingaben ergeben dieselben Dateien, im Container nicht
geprüft).

### Hersteller, Lieferant, SBOM-Ersteller und Sicherheitskontakt

Diese Angaben entscheidet der Eigentümer bzw. Auftraggeber; sie stehen an **einer** Stelle,
`sbom/sbom.config.json`, und gelten für Quell- und Build-SBOM:

| Schlüssel | Bedeutung | SBOM-Feld |
|---|---|---|
| `manufacturer` (`name`, `email`, `url`) | Hersteller/Ersteller der Software (TR: Component creator der Hauptkomponente) | `metadata.component.manufacturer`; Build-SBOM: auch je Datei |
| `supplier` | Anbieter/Lieferant (TR 3.2.9); fehlt er, gilt `manufacturer` | `metadata.supplier`, `metadata.component.supplier` |
| `sbomAuthor` | Ersteller der SBOM (TR 5.2.1); fehlt er, gilt `manufacturer` | `metadata.manufacturer` (so verlangt TR 8.2), `metadata.authors` |
| `securityContact.email` bzw. `.url` | Kontakt für Schwachstellenmeldungen (auch Cyber Resilience Act) | `externalReferences` Typ `security-contact` der Hauptkomponente |
| `securityContact.securityTxtUrl` | URL der `security.txt` (RFC 9116; TR 5.2.5, optional) | `externalReferences` Typ `rfc-9116` |
| `sourceCodeUrl` | öffentliches Repository (z. B. openCode); `null` = noch keins | `externalReferences` `vcs`/`source-distribution` |
| `signing.publicKey` | Pfad des veröffentlichten öffentlichen Signaturschlüssels | Standard für `verify` und die Prüfung nach dem Signieren |

**Gesetzt:** Hersteller, Lieferant und SBOM-Ersteller ist das Open-Source-Projekt selbst
(„OSP-Data-Mesh (Open-Source-Projekt)“), Kontakt ist das öffentliche Repository
(https://github.com/moritzwesemann/osp-data-mesh; TR-03183-2 erlaubt eine URL, wenn keine E-Mail-Adresse
besteht), Schwachstellen werden vertraulich über GitHub gemeldet (`SECURITY.md` im Repository (vertrauliche Meldung über https://github.com/moritzwesemann/osp-data-mesh/security/advisories/new)). Werte mit
`tbd`, `TODO` oder `.invalid` gelten als Platzhalter: Dann warnt `bun run sbom` deutlich, die SBOM trägt
`osp:sbom-status = ENTWURF …`, und `bun run sbom -- --release` bricht ab. Offen ist nur der
Signaturschlüssel des Projekts (`signing.publicKey`).

### Abbildung der Datenfelder (TR-03183-2 v2.1.0, Abschnitte 5.2 und 8.2)

| TR-Feld | Art | CycloneDX 1.6 | Umsetzung |
|---|---|---|---|
| Ersteller der SBOM | Pflicht | `metadata.manufacturer` (`url`, `contact[].email`), zusätzlich `metadata.authors` | aus `sbomAuthor` (Platzhalter) |
| Zeitstempel | Pflicht | `metadata.timestamp` | UTC |
| SBOM-URI | zusätzlich | `serialNumber` | `urn:uuid:…` |
| Urheber der Komponente | Pflicht | `manufacturer` (`url`, `contact[].email`) | npm: E-Mail des Autors aus `package.json`, sonst URL des Autors, Website, Repository, zuletzt npm-Paketseite (Herkunft in `osp:creator-source`); Hauptkomponente und Build-Dateien: `manufacturer` aus der Konfiguration |
| Name, Version | Pflicht | `name`, `group`, `version` | Build-Dateien: Pfad unter `dist/ui`, Version mit Commit |
| Dateiname | Pflicht | Eigenschaft `bsi:component:filename` | npm-Archiv (z. B. `hono-4.13.16.tgz`); Build: Dateiname der Ausgabedatei |
| Abhängigkeiten und Vollständigkeit | Pflicht | `dependencies` (jede Komponente, auch ohne Abhängigkeiten), `compositions` | Graph aus `bun.lock` inkl. Peer-Abhängigkeiten; `complete` für Hauptkomponente und npm-Pakete, `unknown` für Bun und PostgreSQL |
| Distributionslizenz | Pflicht | `licenses` mit `acknowledgement: concluded` | = deklarierte Lizenz (ohne eigene juristische Prüfung übernommen); Build-Dateien: Verknüpfung aus EUPL-1.2 und den Lizenzen der enthaltenen Pakete, z. B. `EUPL-1.2 AND MIT` |
| Hash der auslieferbaren Komponente | Pflicht | `externalReferences` Typ `distribution` mit `hashes` SHA-512 (zusätzlich `hashes`) | npm: Integrität des Archivs aus `bun.lock`; Build: SHA-512 der Datei |
| Ausführbar / Archiv / strukturiert | Pflicht | `bsi:component:executable`, `…:archive`, `…:structured` (je genau einmal) | npm-Archiv: `archive`, `structured`; ausführbar, wenn das installierte Paket Code enthält (JavaScript/TypeScript, native Module, WebAssembly, Programme – TR 8.1.4 zählt Skriptcode dazu), reine Typdeklarationen (`@types/*`, `csstype` …) `non-executable`; nicht installierte Plattformpakete (native Binärdateien) `executable` (`osp:executable-source`) |
| Quellcode-URI | zusätzlich | `externalReferences` `source-distribution` (und `vcs`) | Repository aus dem Paketmanifest |
| URI der auslieferbaren Form | zusätzlich | `externalReferences` `distribution` | npm-Registry; Build: Pfad relativ zur Wurzel der Oberfläche |
| Weitere eindeutige Kennungen | zusätzlich | `purl` (PostgreSQL zusätzlich `cpe`) | |
| Originallizenz | zusätzlich | `licenses` mit `acknowledgement: declared` | aus `package.json` bzw. Registry-Manifest (Einschränkung siehe unten) |
| Effektive Lizenz, Hash des Quellcodes | optional | `bsi:component:effectiveLicence`, `source-distribution` `hashes` | nicht gesetzt |
| URL der security.txt | optional | `externalReferences` `rfc-9116` | Hauptkomponente (Konfiguration), PostgreSQL |

Weitere Angaben: `copyright` je Komponente (aus `LICENSE`/`COPYING`/`NOTICE` des installierten Pakets, ohne
Vorlagenzeilen; Liste der ausgelieferten Pakete in [Lizenzen](lizenzen.md)), `scope` (`required` = zur
Laufzeit benötigt, Server oder in die Oberfläche gebündelt; `excluded` = nur Build/Entwicklung), `osp:usage`.
Die Hauptkomponente ist eine **logische Komponente** (TR 3.2.2: Urheber, Name, Version, Abhängigkeiten,
Lizenzen, Kennungen, security.txt; kein Dateiname/Hash), Bun und PostgreSQL sind **identifizierte
Komponenten** (TR 3.2.4: Urheber, Name, Version, Kennung) außerhalb des Lieferumfangs der Quelle; die
Bun-Binärdatei beschreibt die Abbild-SBOM. Die SBOM enthält keine Schwachstelleninformationen (TR 3.1;
dafür CSAF/VEX, siehe [Schwachstellenmanagement](#schwachstellenmanagement)).

**Prüfungen** (Ergebnis bei Erstellung am 05.11.2026):

- **Schema:** jede erzeugte SBOM wird mit `cdx-validate --strict` (cdxgen 12.9.0) gegen das
  CycloneDX-1.6-Schema geprüft – Quell-SBOM, signierte Quell-SBOM und signierte Build-SBOM: gültig.
- **Selbstprüfung der Pflichtfelder:** `checkTr03183` in `scripts/sbom.ts` meldet jede fehlende
  Pflichtangabe (Ausgabe von `bun run sbom`; Tests in `tests/unit/sbom.test.ts`) – Quell- und Build-SBOM: ok.
- **Unabhängig:** `sbomqs compliance --bsi-v21` (Interlynk sbomqs 2.1.3, Prüfmodus TR-03183-2 v2.1.0):
  Pflichtfelder 9,9 von 10 (alte SBOM vor dieser Überarbeitung: 7,1), zusätzliche Felder 10 von 10. Die
  Abzüge betreffen nur die 11 doppelt lizenzierten Pakete (Originallizenz, siehe unten) sowie Dateiname,
  Hash und TR-Eigenschaften der logischen Hauptkomponente und der identifizierten Komponenten Bun und
  PostgreSQL, die die TR für diese Komponentenarten nicht verlangt (sbomqs unterscheidet sie nicht).
  sbomqs kann die JSF-Signatur nicht lesen (erwartet Base64 statt des von JSF vorgeschriebenen base64url);
  geprüft wird sie mit den Werkzeugen unten.

### Signatur

Die SBOM wird **eingebettet** im JSON Signature Format (JSF 0.82, von CycloneDX für JSON vorgesehen) über
die kanonische Form nach RFC 8785 signiert (`scripts/sbom-sign.ts`; Ed25519, alternativ ECDSA P-256/P-384
oder RSA). Die Signatur enthält Algorithmus, öffentlichen Schlüssel (JWK) und `keyId =
sha256:<Fingerabdruck des öffentlichen Schlüssels>`. Kompatibel mit `cdx-sign`/`cdx-verify` aus cdxgen 12.9.0
(in beide Richtungen geprüft: mit `scripts/sbom-sign.ts` signiert → `cdx-verify` gültig; mit `cdx-sign`
signiert → `bun run sbom -- verify` gültig; nach Änderung einer Komponentenversion melden beide Werkzeuge
„ungültig“).

```sh
# einmalig: Schlüsselpaar AUSSERHALB des Repositorys erzeugen (keygen verweigert Pfade im Repository)
bun run sbom -- keygen ~/osp-sbom-schluessel
cp ~/osp-sbom-schluessel/sbom-signing.pub.pem sbom/signing-key.pub.pem
#   → in sbom/sbom.config.json: "signing": { "publicKey": "sbom/signing-key.pub.pem" }
#   → Fingerabdruck (Ausgabe von keygen) z. B. in README und Release-Hinweisen veröffentlichen

# Release: signieren, gegen den veröffentlichten Schlüssel prüfen, Platzhalter/Lücken ausschließen
OSP_SBOM_SIGNING_KEY=~/osp-sbom-schluessel/sbom-signing.key bun run sbom -- --release
OSP_SBOM_SIGNING_KEY=~/osp-sbom-schluessel/sbom-signing.key bun run sbom -- build-ui --release

# Empfänger: prüfen (Herkunft und Unversehrtheit mit dem veröffentlichten Schlüssel)
bun run sbom -- verify sbom/osp-data-mesh.cdx.json --public-key sbom/signing-key.pub.pem
bun x -p @cyclonedx/cdxgen@12.9.0 cdx-verify -i sbom/osp-data-mesh.cdx.json --public-key sbom/signing-key.pub.pem
```

Ohne `--public-key` (und ohne `signing.publicKey`) prüft `verify` nur gegen den eingebetteten Schlüssel:
Das belegt die Unversehrtheit, nicht die Herkunft – die Ausgabe sagt das und nennt den Fingerabdruck zum
Vergleich. **Schlüsselverwaltung:** Der private Schlüssel gehört nie ins Repository, sondern in die
Passwortverwaltung bzw. den Geheimnisspeicher der Release-Umgebung (Datei mit Rechten `0600`). Bei Verlust
oder Kompromittierung neues Paar erzeugen, neuen öffentlichen Schlüssel und Fingerabdruck veröffentlichen,
den alten als widerrufen kennzeichnen (bereits signierte SBOMs bleiben mit dem alten Schlüssel prüfbar). Die
Tests erzeugen ihre Schlüssel zur Laufzeit.

### Offen (Entscheidung des Eigentümers bzw. bewusst nicht umgesetzt)

1. **Platzhalter** für Hersteller, Lieferant, SBOM-Ersteller, Sicherheitskontakt und `security.txt`-URL
   sowie das öffentliche Repository (`sourceCodeUrl`) – Eintrag in `sbom/sbom.config.json`, siehe oben.
2. **Signaturschlüssel**: noch keiner festgelegt; die SBOM im Repository ist deshalb **unsigniert**. Signiert
   wird im Release-Schritt mit dem Schlüssel des Herstellers (`--release` erzwingt es).
3. **Originallizenz bei Lizenzausdrücken:** CycloneDX 1.6 erlaubt je Komponente nur *einen* Lizenzausdruck.
   Bei den 11 Paketen mit `MIT OR Apache-2.0` (Biome) steht daher nur die Distributionslizenz in `licenses`,
   die deklarierte zusätzlich in der Eigenschaft `osp:declared-license`. CycloneDX 1.7 hebt die Beschränkung
   auf (TR erlaubt ≥ 1.6); umstellen, sobald die Empfängerwerkzeuge 1.7 lesen.
4. **Distributionslizenz = deklarierte Lizenz:** keine eigene juristische Prüfung (CycloneDX versteht
   `concluded` als geprüft). Vor einer Veröffentlichung Lizenzprüfung empfohlen.
5. **Copyright-Vermerke** fehlen bei 60 Komponenten: bei den 52 lokal nicht installierten Plattformpaketen
   (keine Lizenzdatei verfügbar) und bei Paketen ohne Vermerk in ihren Lizenzdateien (z. B. `pg-types`).
6. **Quellcode-URI** je Paket ist das Repository ohne Versions-Tag (aus den Paketdaten nicht sicher
   ableitbar); effektive Lizenz und Hash des Quellcodes (beide optional; für Letzteren legt die TR noch kein
   Verfahren fest) sind nicht gesetzt.
7. Die Eigenschaft „ausführbar“ nicht installierter Plattformpakete ist angenommen (native Binärdateien),
   nicht geprüft.

## Offene Punkte vor einem Produktivbetrieb

1. Externer Penetrationstest und Code-Review der Sicherheitsfunktionen.
2. Zwei-Faktor-Authentisierung bzw. Anbindung an das Identitätsmanagement des OSP.
3. Knotenschlüssel: Der Wechsel mit Benachrichtigung der Partner ist umgesetzt
   ([ADR 0013](adr/0013-knotenschluessel-rotation.md)). Offen: eine signierte Sperrmitteilung bei
   Kompromittierung (heute telefonische Benachrichtigung) und die Verwahrung in einem HSM bzw.
   Schlüsseldienst statt verschlüsselt in der Datenbank.
4. Signaturschlüssel des Projekts und signierte Releases (SBOM-Signatur und Container-SBOM sind technisch
   umgesetzt; Hersteller und Sicherheitskontakt sind gesetzt, siehe `SECURITY.md` im Repository (vertrauliche Meldung über https://github.com/moritzwesemann/osp-data-mesh/security/advisories/new)).
5. Ratenbegrenzung prozessübergreifend (Anmeldung und Föderation derzeit im Speicher eines Prozesses; nach
   einem Neustart beginnen die Zähler neu).
6. Festlegung der Aufbewahrungsfristen (insbesondere Audit-Log) und eines Archivierungsverfahrens.
7. Datenträgerverschlüsselung und Härtung des Hosts nach BSI IT-Grundschutz (Bausteine SYS.1.3, APP.4.3).
