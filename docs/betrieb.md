# Betrieb

Dieses Handbuch beschreibt den laufenden Betrieb eines Knotens: Starten und Stoppen, Protokolle,
Überwachung, Sicherung und Wiederherstellung, Schlüsselverwaltung, Updates und Aufbewahrung. Es gilt für
beide Installationsvarianten; Befehle sind jeweils für **nativ** (systemd, Arbeitsverzeichnis
`/opt/osp-data-mesh`, Benutzer `osp-mesh`) und **Docker** (Verzeichnis `/opt/osp-data-mesh/deploy`)
angegeben.

Abkürzung für native CLI-Aufrufe in diesem Dokument (als `osp-mesh` im Verzeichnis `/opt/osp-data-mesh`):

```sh
alias mesh-cli='bun --env-file=.env --env-file=.env.owner run cli'
```

`mesh-cli <befehl>` entspricht damit dem Aufruf `bun --env-file=.env --env-file=.env.owner run cli <befehl>`,
der Laufzeit-Konfiguration (`.env`) **und** Owner-Zugang (`.env.owner`) lädt. Er ist für alle Befehle
nötig, die als `mesh_owner` arbeiten (`migrate`, `restore`); für die übrigen genügt `.env`. Der Alias gilt
nur in der aktuellen Shell (bei Bedarf in `~/.bashrc` von `osp-mesh` eintragen).

Docker-Entsprechung: `docker compose run --rm cli <befehl>` (der Dienst `cli` erhält Laufzeit- und
Owner-Zugang, Schlüssel und das Sicherungs-Volume).

## Komponenten und Prozesse

| Komponente | Aufgabe | Zustand |
|---|---|---|
| Server (`bun src/server/main.ts`) | Oberfläche, API, Föderation, Hilfe; Hintergrundaufgaben | zustandslos bis auf Datenbank und Sicherungsverzeichnis |
| PostgreSQL 18, Datenbank `mesh` in einem **eigenen Cluster je Knoten** (die Rollen gelten clusterweit, siehe [Installation](installation.md#vorbereitung-beide-varianten)) | alle Fachdaten, Audit-Log, Schlüssel (verschlüsselt) | Datenverzeichnis bzw. Volume `db_data` |
| Caddy | TLS, Weiterleitung an `127.0.0.1:4401` bzw. `node:4401` | Zertifikate im Caddy-Datenverzeichnis bzw. Volume `caddy_data` |
| Sicherungsverzeichnis `MESH_BACKUP_DIR` | verschlüsselte Sicherungen `*.mbk` + Manifeste | Verzeichnis bzw. Volume `backups` |

Hintergrundaufgaben des Servers (abschaltbar mit `MESH_WORKERS=false`, z. B. auf Testsystemen):

- **Ausgangspostfach**: stellt signierte Mitteilungen (Widerrufe, Löschungen) an Partner zu; alle 5 s,
  Wiederholung mit wachsender Wartezeit (10 s, 20 s, 40 s … höchstens 1 h), nach 20 Fehlversuchen Status
  *fehlgeschlagen* (sichtbar unter *Partner › Ausgangspostfach*). Der Hintergrundlauf versucht
  fehlgeschlagene Mitteilungen nicht erneut; *Jetzt zustellen* (Oberfläche: Rolle `admin`; per REST-API
  `outbox.flush` auch `data_steward`) setzt sie wieder auf *ausstehend* (Audit `outbox.requeue`) und
  stellt sofort zu. Die Zahl der Versuche bleibt dabei erhalten: Scheitert auch dieser Versuch, ist die
  Mitteilung sofort wieder *fehlgeschlagen*. Siehe [Widerruf und Weitergabe](widerruf-und-weitergabe.md#ablauf-einer-mitteilung).
- **Aufbewahrung** (minütlich): empfangene Daten abgelaufener Freigaben löschen, Replay-Schutz-Einträge
  (Nonces) nach 15 Minuten entfernen.
- **Ablauf von Importvorschauen** (beim Start und stündlich): nicht übernommene Vorschauen, die älter als
  7 Tage sind, werden verworfen (Status *verworfen*, vorgemerkte Zeilen, Vorschauzeilen und Rohwerte des
  Fehlerprotokolls gelöscht; Audit-Eintrag `import.expire`). Personenbezogene Rohwerte gibt es nur,
  solange ein Lauf im Status *Vorschau* ist; Übernahme und Verwerfen löschen sie sofort.
- **BI-Aktualisierung**: BI-Views nach Datenänderungen (entprellt) und periodisch (10 min) neu aufbauen.
- **Sicherungen** nach `MESH_BACKUP_INTERVAL_HOURS` (Standard 24 h), Aufbewahrung der neuesten
  `MESH_BACKUP_RETENTION` (Standard 14) Sicherungen.

## Starten, Stoppen, Neustarten

| Aktion | nativ | Docker |
|---|---|---|
| Starten | `sudo systemctl start osp-data-mesh` | `docker compose up -d` |
| Stoppen (nur Knoten) | `sudo systemctl stop osp-data-mesh` | `docker compose stop node` |
| Neustart | `sudo systemctl restart osp-data-mesh` | `docker compose restart node` |
| Status | `systemctl status osp-data-mesh` | `docker compose ps -a` |
| Alles stoppen | zusätzlich `systemctl stop caddy postgresql` | `docker compose down` (Volumes bleiben erhalten) |

Der Server beendet sich bei `SIGTERM`/`SIGINT` geordnet (keine neuen Anfragen, Hintergrundaufgaben
stoppen, Datenbankverbindungen schließen). **Migrationen führt der Server nie selbst aus**; nach einem
Update ist `migrate` erforderlich (Docker: automatisch durch den Dienst `migrate` bei `up`).

`docker compose down -v` löscht auch die Volumes (Datenbank, Sicherungen, Zertifikate) – nur bewusst
verwenden.

## Protokolle (Logs)

Der Server schreibt **JSON-Zeilen** nach stdout (`debug`, `info`) und stderr (`warn`, `error`), z. B.:

```json
{"time":"2026-11-04T08:15:02.123Z","level":"error","msg":"request failed","node":"osp-beispiel","requestId":"3f0c…","method":"POST","path":"/api/v1/releases","status":500,"code":"internal_error","error":"…"}
```

- Felder: `time` (UTC), `level`, `msg`, `node`, je nach Ereignis `requestId`, `path`, `status`, `code`.
- **Keine personenbezogenen Daten** in Logs (Konvention im Code); Fachvorgänge stehen im Audit-Log.
- Jede Antwort trägt den Header `X-Request-Id`; Fehlermeldungen der Oberfläche zeigen dieselbe ID. Damit
  lassen sich Meldungen von Nutzenden dem Log und der Tabelle `app_error` (*System › Letzte Fehler*) zuordnen.
- Protokollstufe: `MESH_LOG_LEVEL` (`info` empfohlen; `debug` nur zur Fehlersuche).

Anzeigen:

```sh
journalctl -u osp-data-mesh -f -o cat                 # nativ
journalctl -u osp-data-mesh -o cat | jq 'select(.level=="error")'
docker compose logs -f node                           # Docker
docker compose logs caddy                             # Zugriffe/TLS (JSON)
```

Aufbewahrung der Logs regelt das System (journald bzw. Docker-Logtreiber, z. B. `json-file` mit
`max-size`). Empfehlung: 30 Tage, Weiterleitung an ein zentrales Log-System des OSP.

## Überwachung

| Prüfung | Erwartung | Bedeutung bei Abweichung |
|---|---|---|
| `GET /healthz` | 200 `{"status":"ok"}` | Prozess hängt oder läuft nicht (keine Datenbankprüfung) |
| `GET /readyz` | 200 `{"status":"ok","db":true,"schema":true}` | 503 mit `degraded`: Datenbank nicht erreichbar (`db:false`) oder Migrationen fehlen (`schema:false`) |
| *System*-Seite bzw. `GET /api/v1/system/status` (Rolle `admin`) | `audit.ok = true`, letzte Sicherung `ok` und jünger als 2 × Intervall, `outbox.failed = 0`, `bi.errors = 0` | siehe unten |
| `bun run cli verify-audit` (z. B. täglich per Timer) | Exit-Code 0 | Exit 1: Hash-Kette gebrochen → [Incident Response](incident-response.md) |
| Plattenplatz Sicherungsverzeichnis und Datenbank | > 20 % frei | Sicherungen schlagen fehl |
| Zertifikatslaufzeit | > 14 Tage | Caddy erneuert automatisch; Fehler im Caddy-Log |

Empfohlene Alarme: `readyz` ≠ 200 länger als 2 min; keine erfolgreiche Sicherung seit 48 h;
`outbox.failed > 0` (ein Partner hat Widerrufe/Löschungen nicht erhalten); `errors24h` stark steigend;
`verify-audit` ≠ 0. Beispiel für einen externen Monitor: `curl -fsS https://<domain>/readyz`.

### Föderationsendpunkt: Größen, Ratenbegrenzung, Protokollierung

Der Endpunkt `/federation/v1/*` ist von außen erreichbar und daher gegen Überflutung geschützt
(`src/server/modules/federation/guard.ts`, Einzelheiten im [Protokoll](protokoll.md#schutz-vor-überflutung)):

- **Größen:** Anfragen von Partnern höchstens **2 MB** (angekündigte Länge sofort geprüft, der Body wird
  erst nach der Absenderprüfung gelesen); Antworten von Partnern beim eigenen Abruf höchstens **50 MB**.
- **Ratenbegrenzung:** Nach **60 abgelehnten Anfragen je IP-Adresse** in 5 Minuten (bzw. 60 je
  behauptetem, nicht zugelassenem Absender) antwortet der Knoten mit **429** (`Retry-After: 300`), ohne
  den Body zu lesen. Zugelassene Partner mit gültiger Signatur sperrt eine gefälschte Absenderkennung nicht
  aus. Die Zähler liegen im Speicher des Prozesses und beginnen nach einem Neustart neu.
- **Protokollierung:** Jede Ablehnung steht im Betriebslog (`federation request rejected`, mit `code`,
  `ip`, `node`). Ins Audit-Log (`federation.request.rejected`, `outcome = denied`) kommt nur die **erste je
  Quelle und Code in 5 Minuten**, insgesamt höchstens **20 je 5 Minuten**; der nächste auditierte Eintrag
  derselben Quelle nennt in `suppressed` die Zahl der dazwischen nur geloggten Ablehnungen. Ist das
  Budget erschöpft, steht einmal je Zeitfenster die Warnung `federation rejections: audit budget of this
  window exhausted` im Log.
- **Voraussetzung: echte Client-Adresse hinter Caddy** (`MESH_TRUST_PROXY=true` und
  `MESH_TRUSTED_PROXIES`): Die Begrenzung je IP-Adresse (ebenso die Anmeldebegrenzung, 30 Versuche je
  IP-Adresse in 5 Minuten) braucht die echte Client-Adresse. Hinter Caddy sieht der Server sonst nur die
  Adresse des Proxys: Dann teilen sich **alle** Partner und Nutzenden einen Zähler, und ein einzelner
  Störer sperrt alle aus. Caddy übergibt die Client-Adresse im Header `X-Forwarded-For`. Der Server
  wertet ihn nur aus, wenn **beides** gilt: `MESH_TRUST_PROXY=true` **und** die Verbindung kommt von einer
  Adresse aus `MESH_TRUSTED_PROXIES` (kommagetrennte IP-Adressen, Standard `127.0.0.1,::1`). Aus der
  Kette im Header verwendet er die **rechteste Adresse, die nicht in `MESH_TRUSTED_PROXIES` steht** – also
  die Adresse, von der sich der Client mit Caddy verbunden hat; Einträge weiter links kann ein Client
  selbst setzen und werden ignoriert. Verbindungen von anderen Adressen werden mit ihrer eigenen Adresse
  gezählt, ein mitgesendeter Header bleibt unbeachtet.
  - **nativ** (Caddy auf demselben Server, verbindet sich von `127.0.0.1`): `MESH_TRUST_PROXY=true` in
    `.env`, `MESH_TRUSTED_PROXIES` beim Standard lassen.
  - **Docker Compose:** Caddy hat im Netz `frontend` (`172.31.252.0/24`) die feste Adresse
    `172.31.252.10`; `docker-compose.yml` setzt `MESH_TRUST_PROXY=true` und
    `MESH_TRUSTED_PROXIES=172.31.252.10`.
  - **ohne Reverse Proxy** (nur [Testinstallation](installation.md#testinstallation-ohne-caddy-nur-http-nur-lokal)):
    `MESH_TRUST_PROXY=false`.

Hinweise im Betrieb: Viele `federation.request.rejected` mit `unknown_node` oder `bad_signature` von
einer Adresse deuten auf Fehlkonfiguration eines Partners oder einen Angriff hin; Häufungen von
`clock_skew` auf eine falsche Uhr (NTP prüfen). Ein echter Partner, der 429 erhält, wertet das als
`peer_unreachable` und versucht es später erneut.

## Sicherungen

**Inhalt:** vollständige Datenbank `mesh` (pg_dump im Custom-Format, ohne Eigentümer/Rechte), **ohne** die
Schemata `bi` und `bi_data` – diese sind abgeleitet und werden nach einer Wiederherstellung automatisch neu
aufgebaut. Enthalten sind auch Audit-Log, Austauschprotokoll und die (mit dem Master-Key verschlüsselten)
Geheimnisse.

**Format:** `<MESH_NODE_ID>-<UTC-Zeit>.mbk` (Dateirechte 0600) mit AES-256-GCM verschlüsselt mit
`MESH_BACKUP_KEY`; Knotenkennung, Zeitpunkt und Schemaversion sind im Kopf fälschungssicher an den Inhalt
gebunden. Daneben liegt das Manifest `<datei>.mbk.json` (SHA-256, Größe, Zeitpunkt). Ohne `MESH_BACKUP_KEY`
sind Sicherungen deaktiviert.

**Erstellen:**

- automatisch alle `MESH_BACKUP_INTERVAL_HOURS` Stunden (0 = aus),
- manuell in der Oberfläche *System › Sicherung erstellen* (Rolle `admin`),
- per Kommandozeile: nativ `bun --env-file=.env run cli backup`, Docker `docker compose run --rm cli backup`.

Jede Sicherung erscheint unter *System › Sicherungen* und im Audit-Log (`backup.create`). Ältere als die
neuesten `MESH_BACKUP_RETENTION` Sicherungen des Knotens werden automatisch gelöscht.

**Auslagern (3-2-1-Regel):** Sicherungen täglich auf ein zweites System kopieren (z. B. Sicherungsserver
des OSP); die Dateien sind verschlüsselt. Den `MESH_BACKUP_KEY` **getrennt** von den Dateien aufbewahren.

```sh
# nativ
rsync -a /opt/osp-data-mesh/backups/ sicherung@backup.osp.intern:/srv/osp-mesh/
# Docker: Volume-Inhalt kopieren
docker compose cp node:/var/lib/osp-mesh/backups ./backups-export
```

## Wiederherstellung

Die Wiederherstellung ersetzt die **gesamte** Datenbank durch den Stand der Sicherung. Sie läuft als
`mesh_owner` in **einer Transaktion** (schlägt sie fehl, bleibt die Datenbank unverändert), stellt danach die
Rechte (`migrations/grants.sql`) wieder her, beendet alle Sitzungen und prüft die Audit-Kette.

**Der Knoten muss vorher gestoppt sein.** Liefe er weiter, griffen seine Anfragen und
Hintergrundaufgaben (Ausgangspostfach, BI-Aktualisierung, Sicherungen) während der Wiederherstellung auf
die Datenbank zu; sie könnten die Wiederherstellung blockieren oder den zurückgespielten Stand sofort
wieder verändern. `restore` prüft das: Bestehen noch Datenbankverbindungen des laufenden Servers (in
PostgreSQL am Anwendungsnamen `osp-data-mesh` erkennbar), bricht der Befehl ab, ohne etwas zu verändern. Dann den Knoten stoppen (Tabelle [Starten, Stoppen](#starten-stoppen-neustarten)) und
`restore` wiederholen. Prüfen, welche Verbindungen bestehen (als Superuser bzw. `mesh_owner`):
`select pid, usename, client_addr, backend_start from pg_stat_activity where application_name = 'osp-data-mesh';`
Die Option `--force` übergeht die Prüfung; nur verwenden, wenn sicher ist, dass kein Server-Prozess
dieses Knotens mehr läuft (z. B. weil die gemeldeten Verbindungen von einem gerade endenden
Kommandozeilenbefehl wie `backup` stammen – besser dessen Ende abwarten).

**Ablauf nativ:**

```sh
sudo systemctl stop osp-data-mesh                     # Knoten MUSS gestoppt sein
sudo -iu osp-mesh
cd /opt/osp-data-mesh
alias mesh-cli='bun --env-file=.env --env-file=.env.owner run cli'
mesh-cli restore --file backups/osp-beispiel-20261104T020000.000Z.mbk --yes
mesh-cli migrate                                      # falls die Sicherung ein älteres Schema hat
exit
sudo systemctl start osp-data-mesh
curl -s https://<domain>/readyz
```

**Ablauf Docker:**

```sh
docker compose stop node
docker compose run --rm cli restore --file /var/lib/osp-mesh/backups/osp-beispiel-20261104T020000.000Z.mbk --yes
docker compose up -d                                   # migrate läuft automatisch, dann node
```

Prüfungen der Kommandozeile: keine Verbindungen des laufenden Servers (sonst Abbruch; `--force` siehe
oben), Manifest/SHA-256 (falls vorhanden), richtiger Schlüssel (Schlüssel-ID im Kopf),
GCM-Authentisierung, Knotenkennung = `MESH_NODE_ID` (sonst Abbruch; `--allow-other-node` nur für
Wiederherstellungstests oder einen bewussten Umzug), Schemaversion nicht neuer als der installierte Code.
Exit-Code 0 nur, wenn die Audit-Kette danach intakt ist.

**Nach der Wiederherstellung – fachlich wichtig:**

1. Alles, was **nach** dem Sicherungszeitpunkt geschah, ist verloren – auch **Löschungen von Personen,
   Einwilligungswiderrufe und Widerrufe von Freigaben**. Diese müssen erneut ausgeführt werden, sonst
   wären gelöschte Daten wieder vorhanden. Grundlage: regelmäßige Exporte des Audit-Logs (Rolle `auditor`,
   *Audit › Export*) und die Unterlagen der Datenverantwortlichen.
2. Mitteilungen an Partner, die nach dem Sicherungszeitpunkt erzeugt wurden, fehlen im Ausgangspostfach;
   durch Wiederholung der Vorgänge aus Punkt 1 werden sie neu erzeugt.
3. Alle Personen müssen sich neu anmelden; API-Tokens, die nach der Sicherung erzeugt wurden, sind ungültig.
4. Wurde der Master-Key seit der Sicherung rotiert, beim Start `MESH_MASTER_KEY_PREVIOUS` (alter Schlüssel)
   setzen und anschließend `rotate-master-key` ausführen (siehe unten).
5. BI-Views werden beim Start neu aufgebaut (oder *System › BI-Schnittstelle › Views aktualisieren*).

### Wiederherstellungstest (vierteljährlich empfohlen)

Auf einem **getrennten Testsystem** ohne Verbindung zu Partnern, mit einem **eigenen
PostgreSQL-Cluster** – auf einem anderen Rechner, in einer eigenen VM oder einem eigenen Container,
**nicht** als zweite Datenbank im Cluster des Produktivknotens: Die Rollen `mesh_owner`, `mesh_app` und
`mesh_bi` gelten clusterweit; `db-bootstrap` für das Testsystem setzte sonst die Passwörter des
Produktivknotens neu (er verlöre seine Datenbankverbindung), und die Rollen des Testsystems könnten die
Produktivdatenbank lesen (siehe [Installation](installation.md#vorbereitung-beide-varianten)).
`db-bootstrap` bricht in diesem Fall ab.

1. Testsystem wie in der [Installation](installation.md) aufsetzen (eigener Cluster, eigene Passwörter
   in `.env.owner`), aber mit `MESH_WORKERS=false` (keine Zustellung von Mitteilungen, keine Sicherungen)
   und ohne Partner-Netzzugang. Gleiche `MESH_NODE_ID` und denselben `MESH_MASTER_KEY` wie produktiv
   verwenden (sonst sind die Geheimnisse nicht lesbar), alternativ `--allow-other-node`. Für die
   Wiederherstellung den `MESH_BACKUP_KEY` des Produktivknotens setzen.
2. Aktuelle Sicherung und Manifest kopieren, Knoten des Testsystems stoppen (bzw. noch nicht starten) und
   `bun --env-file=.env --env-file=.env.owner run cli restore --file <datei>.mbk --yes` ausführen,
   danach `bun --env-file=.env --env-file=.env.owner run cli migrate` und den Knoten starten.
3. Prüfen: `readyz` ok, `verify-audit` ok, Anmeldung möglich, Stichprobe von Athletinnen/Athleten,
   Datenprodukten und Freigaben; Anzahl Einträge mit dem Produktivsystem vergleichen.
4. Ergebnis (Datum, Sicherungsdatei, Dauer, Abweichungen) dokumentieren; Testsystem danach löschen, da es
   Echtdaten enthält.

## Schlüssel und Geheimnisse

| Geheimnis | Schützt | Aufbewahrung | Verlust bedeutet |
|---|---|---|---|
| `MESH_MASTER_KEY` | privaten Knotenschlüssel, Pseudonym-Schlüssel, Zugangsdaten der API-Quellen (AES-256-GCM in der Datenbank) | Passwortverwaltung + versiegelte Offline-Kopie (Tresor), Vier-Augen-Prinzip | Knoten startet nicht mehr; neue Identität und neue Vertrauensaufnahme bei allen Partnern nötig |
| `MESH_BACKUP_KEY` | Sicherungsdateien | wie oben, **getrennt** von den Sicherungen | Sicherungen nicht wiederherstellbar |
| Passwörter `mesh_owner`, `mesh_app`, `mesh_bi`, `postgres` | Datenbankzugänge | Passwortverwaltung | Zurücksetzen per `bootstrap.sql` (idempotent) |
| Ed25519-Knotenschlüssel | Identität gegenüber Partnern | nur verschlüsselt in der Datenbank, nie exportiert | siehe Master-Key |
| Zugangsgeheimnisse von API-Quellen | Zugang zu Messsystemen | verschlüsselt in der Datenbank (AAD `connector.secret:<id>`), nie ausgegeben | in der Oberfläche neu setzen |

### Zugangsgeheimnisse von API-Quellen

Ein gespeichertes Geheimnis (Bearer-Token oder Header-Wert) ist an das Ziel des Connectors gebunden:

- Ändert sich der **Origin** der URL (Schema, Host, Port) oder die **Art der Authentifizierung**
  (einschließlich des Header-Namens), wird das Geheimnis gelöscht (Audit `connector.secret_cleared`) und
  muss für das neue Ziel neu gesetzt werden. Pfad, Abfrageparameter und Paginierung dürfen sich ändern.
- *Beispiel abrufen* mit einem gespeicherten Connector verwendet ausschließlich dessen gespeicherte URL und
  Authentifizierung.
- Geheimnisse werden nur über **https://** gesendet. Ausnahmen: Loopback-Adressen (`127.0.0.1`, `::1`,
  `localhost`, z. B. ein Messsystem-Adapter auf demselben Server) oder ausdrücklich
  `MESH_SOURCE_ALLOW_INSECURE_HTTP=true` (Standard `false`; nur in abgeschotteten Netzen, da das
  Geheimnis dann im Klartext übertragen wird). Sonst wird der Abruf mit `source_not_allowed`
  (Grund `insecure_http`) abgewiesen und protokolliert.

### Master-Key rotieren

Beispielsweise jährlich oder beim Ausscheiden von Personen mit Schlüsselzugang. Der laufende Knoten
kennt nur den bisherigen Schlüssel; die Rotation daher bei **gestopptem Knoten** durchführen:

1. Neuen Schlüssel erzeugen: `bun src/server/cli/main.ts gen-key` (oder `openssl rand -base64 32`).
2. Knoten stoppen (`sudo systemctl stop osp-data-mesh` bzw. `docker compose stop node`).
3. In `.env` (Docker: `deploy/.env`) `MESH_MASTER_KEY_PREVIOUS=<alter Schlüssel>` und
   `MESH_MASTER_KEY=<neuer Schlüssel>` setzen.
4. Neu verschlüsseln: nativ `mesh-cli rotate-master-key`, Docker `docker compose run --rm cli
   rotate-master-key`. Ausgabe: neue Schlüssel-ID und Anzahl neu verschlüsselter Geheimnisse;
   Audit-Eintrag `system.master_key_rotated`.
5. `MESH_MASTER_KEY_PREVIOUS` wieder entfernen (bzw. leeren) und den Knoten starten
   (`systemctl start` bzw. `docker compose up -d`); prüfen: `readyz`, Anmeldung, *Partner › Verbindung
   prüfen*.
6. **Den alten Schlüssel aufbewahren**, solange Sicherungen von vor der Rotation existieren (Aufbewahrung
   × Intervall, Standard 14 Tage, plus ausgelagerte Kopien): diese enthalten noch mit ihm verschlüsselte
   Geheimnisse (nach einer solchen Wiederherstellung Schritte 3–5 wiederholen).

### Sicherungsschlüssel wechseln

Neuen `MESH_BACKUP_KEY` setzen und Knoten neu starten; neue Sicherungen verwenden den neuen Schlüssel. Den
alten Schlüssel aufbewahren, bis keine damit verschlüsselte Sicherung mehr benötigt wird; zur
Wiederherstellung einer alten Sicherung den alten Wert für den `restore`-Aufruf setzen
(`MESH_BACKUP_KEY=<alt> mesh-cli restore …`). Ein falscher Schlüssel wird vor dem Entschlüsseln erkannt.

### Datenbankpasswörter ändern

`bootstrap.sql` setzt bei jedem Aufruf die Passwörter neu. Nativ (als `osp-mesh` in
`/opt/osp-data-mesh`):

1. Neue Werte erzeugen (`openssl rand -hex 24`) und in `.env.owner` eintragen
   (`MESH_DB_OWNER_PASSWORD`, `MESH_DB_APP_PASSWORD`, `MESH_DB_BI_PASSWORD` und das Passwort in
   `MESH_DB_OWNER_URL`).
2. `db-bootstrap` erneut ausführen, wie bei der [Installation (A4)](installation.md#a4-rollen-und-datenbank-anlegen-db-bootstrap):

   ```sh
   printf 'Passwort des PostgreSQL-Superusers postgres: '; read -rs SU_PW; echo
   export MESH_DB_SUPERUSER_URL="postgres://postgres:$SU_PW@127.0.0.1:5432/postgres"   # anpassen: Adresse/Port des Clusters
   bun --silent --env-file=.env.owner run cli db-bootstrap
   unset MESH_DB_SUPERUSER_URL SU_PW
   ```

3. In `.env` das Passwort in `MESH_DB_URL` anpassen, Knoten neu starten
   (`sudo systemctl restart osp-data-mesh`), BI-Werkzeuge auf das neue `mesh_bi`-Passwort umstellen.

Docker: neue Werte in `deploy/.env` eintragen, dann `docker compose exec db psql -U postgres -v
ON_ERROR_STOP=1 -v db_name=mesh -v owner_password=… -v app_password=… -v bi_password=… -f
/opt/osp-data-mesh/bootstrap.sql` und `docker compose up -d` (startet die Dienste mit den neuen Werten).

### Knotenschlüssel (Ed25519)

Der Schlüssel entsteht beim ersten Start, der private Teil liegt nur verschlüsselt in der Datenbank.
Partner vertrauen genau diesem öffentlichen Schlüssel (Fingerprint). Ein Schlüsselwechsel ist im Prototyp
**nicht als Kommando umgesetzt** (das Datenmodell sieht `previous_public_key` vor). Bei Verdacht auf
Kompromittierung des Knotenschlüssels: Vorgehen nach [Incident Response](incident-response.md)
(Partner sperren lassen, neue Identität, erneuter Fingerprint-Abgleich).

## Updates

Schemamigrationen sind **nur vorwärts** gerichtet; ein Zurück gibt es nur über die Wiederherstellung der
vor dem Update erstellten Sicherung zusammen mit der alten Programmversion.

**Nativ:**

```sh
sudo -iu osp-mesh
cd /opt/osp-data-mesh
bun --env-file=.env run cli backup                     # 1. Sicherung
git fetch --tags && git checkout <neue-version>        # 2. neuen Stand holen (Versionshinweise lesen)
bun install --frozen-lockfile                          # 3. Abhängigkeiten
bun run build                                          # 4. Oberfläche und Hilfe
exit
sudo systemctl stop osp-data-mesh                      # 5. Knoten stoppen
sudo -iu osp-mesh bash -c 'cd /opt/osp-data-mesh && bun --env-file=.env --env-file=.env.owner run cli migrate'
sudo systemctl start osp-data-mesh                     # 6. starten und prüfen
curl -s https://<domain>/readyz
```

**Docker:**

```sh
cd /opt/osp-data-mesh/deploy
docker compose run --rm cli backup                     # 1. Sicherung
git -C .. fetch --tags && git -C .. checkout <neue-version>
docker compose build                                   # 2. neues Abbild
docker compose up -d                                   # 3. migrate läuft vor dem Start des Knotens
docker compose ps -a                                   # migrate: Exited (0), node: healthy
```

Danach in *System* die Version prüfen. Weitere Updates:

- **Betriebssystem/Pakete:** monatlich bzw. bei Sicherheitsmeldungen (`apt upgrade`; Docker: Abbilder neu
  bauen mit `docker compose build --pull`).
- **PostgreSQL-Nebenversionen** (18.x) über die Paketverwaltung bzw. `docker compose pull db`.
  **Hauptversionswechsel** (z. B. 18 → 19) mit `pg_upgrade` oder Sicherung/Wiederherstellung planen.
- **Bun:** getestet ist die in der [Installation](installation.md#a1-pakete-installieren-administrationskonto)
  genannte Version. Eine neue Version erst nach Tests (`bun test`) und neuer SBOM (`bun run sbom`)
  übernehmen: in `deploy/Dockerfile` (`ARG BUN_VERSION`) bzw. auf dem Server mit
  `curl -fsSL https://bun.sh/install | bash -s "bun-v<version>"` und
  `sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun`.
- **Abhängigkeiten:** siehe [Schwachstellenmanagement](sicherheit.md#schwachstellenmanagement).

## Aufbewahrung und Löschfristen

| Daten | Technische Regel | Organisatorisch festzulegen |
|---|---|---|
| Empfangene Daten von Partnern | gelöscht bei Widerruf, Ablauf der Freigabe (minütliche Prüfung), Löschmitteilung oder manuell | – |
| Replay-Schutz (Nonces) | 15 Minuten | – |
| Zähler der Ratenbegrenzung (Anmeldung, Föderation) | nur im Speicher, 5-Minuten-Fenster; nach Neustart leer | – |
| Sitzungen | Ablauf nach `MESH_SESSION_TTL_HOURS` | – |
| Sicherungen | neueste `MESH_BACKUP_RETENTION` Dateien | Aufbewahrung ausgelagerter Kopien |
| Athleten- und Messdaten | bis zur Löschung durch Datenverantwortliche | Löschfristen je Datensatz (z. B. Ende der Kaderzugehörigkeit + x Jahre), regelmäßige Prüfung |
| Audit-Log, Austauschprotokoll | **nur anhängbar, keine automatische Löschung** | Aufbewahrungsfrist (Nachweispflicht vs. Datenminimierung); Archivierung/Kürzung ist im Prototyp nicht vorgesehen |
| Importläufe, Fehlerprotokolle (Metadaten) | Zeitpunkt, Dateiname, Prüfsumme, Zähler sowie Zeile, Feld und Prüfcode je Fehler bleiben dauerhaft erhalten (Connectoren können nicht gelöscht, nur deaktiviert werden). Der Dateiname wird unverändert übernommen – Dateien nicht nach Personen benennen | Frist festlegen; eine Löschfunktion ist im Prototyp nicht vorgesehen |
| Importvorschauen (vorgemerkte Zeilen, Vorschauzeilen, Rohwerte im Fehlerprotokoll) | gelöscht bei Übernahme oder Verwerfen, spätestens nach **7 Tagen** (stündliche Prüfung); Zeilen einer Person sofort bei deren Löschung. Zuordnungsfehler speichern keine Namen, Geburtsdaten oder Kennungen als Rohwert | – |

## Prüfung der Audit-Kette

Das Audit-Log ist durch Datenbank-Trigger gegen Ändern und Löschen gesperrt; jeder Eintrag enthält den
SHA-256 des vorherigen (Hash-Kette). Prüfung:

- Oberfläche *Audit › Integrität prüfen* (Rollen `auditor`, `admin`),
- Kommandozeile `bun --env-file=.env run cli verify-audit` (Exit 0 = intakt, 1 = Bruch mit Position),
- SQL (als `mesh_owner`): `select * from audit_verify();`.

Ein Bruch bedeutet Manipulation unter Umgehung der Trigger (nur mit Owner-/Superuser-Rechten möglich) oder
Datenbankbeschädigung → [Incident Response](incident-response.md). Den Prüfwert (`hash` des letzten
Eintrags) monatlich außerhalb des Systems notieren, damit auch ein vollständiges Neuschreiben der Kette
erkennbar wird.

## Kapazität

- Ausgelegt auf das Mengengerüst eines OSP: einige tausend Personen, zehn- bis hunderttausende Messwerte je
  Datensatz. Freigaberegeln werden in TypeScript ausgewertet (siehe [ADR 0004](adr/0004-freigabelogik-reine-funktionen.md)).
- Uploads bis 20 MB je CSV-Datei, sonstige API-Anfragen bis 1 MB; im Partneraustausch Anfragen bis 2 MB
  und Antworten bis 50 MB; der Datenabruf (`access.data`) ist auf 100 000 Zeilen je Anfrage begrenzt.
- Importe: höchstens 500 Spalten und 100 000 Zeilen (bzw. API-Einträge) je Lauf, API-Antworten insgesamt
  bis 50 MB; darüber schlägt der Lauf mit `too_many_columns` bzw. `too_many_rows` (bzw.
  `invalid_response`) fehl, ohne die Quelle weiter zu lesen.
- Datenbankgröße: überschlägig 1–2 KB je Messwert inkl. Indizes; Audit-Log wächst mit jedem Zugriff
  (einige hundert Byte je Eintrag).
- Sicherungsdauer und -größe nach der ersten Sicherung messen und Plattenplatz für
  `MESH_BACKUP_RETENTION` + 1 Sicherungen vorhalten.
- Verbindungspool `MESH_DB_POOL_MAX` (Standard 10) reicht für typische Last; PostgreSQL-Standardwerte
  (`max_connections = 100`) genügen.
