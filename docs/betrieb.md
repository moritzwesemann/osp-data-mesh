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
| `bun run cli verify-audit` (z. B. täglich per Timer) | Exit-Code 0 | Exit 1: Hash-Kette gebrochen (im Programm neu berechnet) → [Incident Response](incident-response.md) |
| `bun run cli verify-audit --with-partners --profile <profil.json>` (z. B. wöchentlich; ohne `--profile` nicht unabhängig von der Datenbank) | Exit-Code 0 | Exit 1: Kette abgeschnitten oder umgeschrieben → [Incident Response](incident-response.md); Exit 3: nicht verankert (Partner des Profils nicht erreichbar bzw. zu wenige bestätigen); Exit 4: Klärung nötig (z. B. durch eine Wiederherstellung verlorene Prüfpunkte, nicht dokumentierte Epoche) |
| *Audit › Externe Verankerung* | Prüfpunkte zugestellt | nicht zugestellte Prüfpunkte (Partner prüfen, *Jetzt zustellen*) |
| *Partner › Eigene Knotenkarte* während eines Schlüsselwechsels | alle Partner bestätigt | Partner ohne Bestätigung vor Ende der Übergangszeit ansprechen |
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
# Docker: Volume-Inhalt kopieren ("/." kopiert den Inhalt, nicht das Verzeichnis selbst)
mkdir -p ./backups-export && docker compose cp node:/var/lib/osp-mesh/backups/. ./backups-export/
```

## Wiederherstellung

Die Wiederherstellung ersetzt die **gesamte** Datenbank durch den Stand der Sicherung. Sie läuft als
`mesh_owner` in **einer Transaktion** (schlägt sie fehl, bleibt die Datenbank unverändert), stellt danach die
Rechte (`migrations/grants.sql`) wieder her, beendet alle Sitzungen und prüft die Audit-Kette.

**Der Knoten muss vorher gestoppt sein.** Liefe er weiter, griffen seine Anfragen und
Hintergrundaufgaben (Ausgangspostfach, BI-Aktualisierung, Sicherungen) während der Wiederherstellung auf
die Datenbank zu; sie könnten die Wiederherstellung blockieren oder den zurückgespielten Stand sofort
wieder verändern. `restore` prüft das zweifach: Jeder laufende Server hält für seine ganze Laufzeit eine
**Knotensperre** (PostgreSQL-Advisory-Sperre auf einer eigenen Verbindung). Kann `restore` sie nicht
übernehmen, oder bestehen noch Datenbankverbindungen des Servers (in PostgreSQL am Anwendungsnamen
`osp-data-mesh` erkennbar), bricht der Befehl ab, ohne etwas zu verändern. Während der Wiederherstellung
hält `restore` die Knotensperre selbst; ein in dieser Zeit gestarteter Server beendet sich sofort mit dem
Hinweis „node lock is held by another process“. Aus demselben Grund startet auch kein zweiter Server auf
derselben Datenbank. Dann den Knoten stoppen (Tabelle [Starten, Stoppen](#starten-stoppen-neustarten)) und
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

**Ablauf Docker** (im Verzeichnis `deploy/`; mit Docker 29 geprüft: Wiederherstellung bei laufendem
Knoten abgelehnt, nach `stop node` erfolgreich, später angelegte Daten verschwunden, Sitzungen beendet,
Audit-Kette ok):

```sh
docker compose run --rm --no-deps --entrypoint ls cli -l /var/lib/osp-mesh/backups   # Dateinamen
docker compose stop node
docker compose run --rm cli restore --file /var/lib/osp-mesh/backups/osp-beispiel-20261104T020000.000Z.mbk --yes
docker compose up -d                                   # migrate läuft automatisch, dann node
```

Die Hinweiszeile „Weiter / next: bun … run cli migrate“ am Ende von `restore` gilt für die native
Installation; unter Docker erledigt das `docker compose up -d`.

*Sicherung von außerhalb einspielen* (z. B. vom Sicherungsserver auf einen neuen Server): Datei und
Manifest **über den Dienst `cli`** in das Volume schreiben. So gehören sie dem Benutzer des Abbilds (UID
1000) und haben die Rechte `0600`. `docker compose cp` übernähme dagegen Eigentümer und Rechte der Quelle;
der Knoten könnte die Datei dann nicht lesen.

```sh
for f in osp-beispiel-20261104T020000.000Z.mbk osp-beispiel-20261104T020000.000Z.mbk.json; do
  docker compose run --rm -T --no-deps --entrypoint sh cli -c "umask 077 && cat > /var/lib/osp-mesh/backups/$f" < "$f"
done
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
6. **Audit-Kette: neue Epoche.** Die Laufnummern nach dem Sicherungszeitpunkt werden neu vergeben, ihre
   Hashes unterscheiden sich von denen, die Partner aus der Zeit vor der Wiederherstellung verwahren.
   `restore` beginnt deshalb in derselben Transaktion eine neue Epoche (`audit_chain_epoch`: vorige Epoche,
   höchste übernommene Laufnummer, SHA-256 und Zeitpunkt der Sicherung, **Kopf der Kette unmittelbar vor der
   Wiederherstellung** – Epoche, Laufnummer, Hash; Audit `backup.restore` mit `epoch`, `previousEpoch`,
   `restoredSeq`, `preRestore`) und gibt das alles aus („Sicherung / backup SHA-256 …“, „Kopf vor der
   Wiederherstellung …“, „Neue Epoche der Audit-Kette … übernommen bis seq …“). Die wiederhergestellte
   Datenbank brächte sonst den alten Stand mit. Partner nehmen Prüfpunkte der neuen Epoche an (dort Audit
   `audit.checkpoint.epoch_changed`); der erste geht kurz nach dem Start hinaus.
   - Die Kette prüft `restore` danach **im Programm** (wie `verify-audit`) und nennt zum Vergleich das
     Ergebnis von `audit_verify()` der wiederhergestellten Datenbank – diese Funktion stammt aus der
     Sicherung. Maßgeblich ist die Neuberechnung; Exit 1, wenn sie einen Bruch findet.
   - `verify-audit --with-partners` vergleicht Prüfpunkte früherer Epochen weiter **bis zur übernommenen
     Laufnummer** (Abweichung = Manipulation) und meldet die dahinter als **„durch Wiederherstellung
     verloren“**: ohne Profil „Klärung nötig“, Exit 4 – nie still „ok“. Liegt ein solcher Prüfpunkt hinter
     dem festgehaltenen Kopf vor der Wiederherstellung, ist das Manipulation (Exit 1).
   - Die Wiederherstellung dokumentieren (Datum, Sicherungsdatei, **SHA-256 und Zeitpunkt der Sicherung,
     Kopf davor**, neue Epoche, übernommene Laufnummer, Anlass) und danach das **Anker-Profil neu
     exportieren**: `bun --env-file=.env run cli audit-anchor-profile --out profil-neu.json --previous
     profil-alt.json --accept-epochs` – vorher ohne `--accept-epochs` aufrufen, die angezeigte neue Epoche
     (Sicherung, Kopf davor) mit der Dokumentation abgleichen. Mit dem neuen Profil sind die verlorenen
     Prüfpunkte erklärt (nur noch Hinweis, Exit 0). **Mit dem alten Profil** meldet die Prüfung bis dahin
     „Manipulation“ (Exit 1): ein Verlust durch eine nicht im Profil dokumentierte Wiederherstellung ist nicht
     erklärt.
   - Eine Epoche, die nicht im Profil steht und zu keiner dokumentierten Wiederherstellung gehört, ist
     Manipulation ([Incident Response](incident-response.md)).
   - Sicherungen von vor Migration 0610 kennen keine Epochen; nach `migrate` beginnt eine neue erste Epoche,
     Prüfpunkte von vorher gelten dann als „unbekannte Epoche“ (Klärung nötig, Profil mit `--previous`).

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
| Ed25519-Knotenschlüssel | Identität gegenüber Partnern | nur verschlüsselt in der Datenbank, nie exportiert; der bisherige nach einem Wechsel nur während der Übergangszeit | siehe Master-Key; Wechsel siehe [Knotenschlüssel](#knotenschlüssel-ed25519) |
| Zugangsgeheimnisse von API-Quellen | Zugang zu Messsystemen | verschlüsselt in der Datenbank (AAD `connector.secret:<id>`), nie ausgegeben | in der Oberfläche neu setzen |

### Zugangsgeheimnisse von API-Quellen

Ein gespeichertes Geheimnis (Bearer-Token, Header-Wert oder OAuth2-Client-Geheimnis) ist an das Ziel des
Connectors gebunden:

- Ändert sich der **Origin** der URL (Schema, Host, Port) oder die **Art der Authentifizierung**
  (einschließlich des Header-Namens, bei OAuth2 Token-Endpunkt und Client-Kennung), wird das Geheimnis
  gelöscht (Audit `connector.secret_cleared`) und muss für das neue Ziel neu gesetzt werden. Pfad,
  Abfrageparameter und Paginierung dürfen sich ändern.
- OAuth2 (Client Credentials): Der Host des Token-Endpunkts muss ebenfalls in `MESH_SOURCE_ALLOWED_HOSTS`
  stehen. Zugriffstokens hält der Knoten nur im Arbeitsspeicher (bis kurz vor Ablauf); nach einem
  Neustart holt er beim nächsten Abruf ein neues. Ein neues Client-Geheimnis gilt ab dem nächsten Abruf.
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
Partner vertrauen genau diesem öffentlichen Schlüssel (Fingerprint). Ein Wechsel ist auf zwei Arten möglich,
die sich bewusst unterscheiden ([ADR 0013](adr/0013-knotenschluessel-rotation.md)):

**Planmäßiger Wechsel** – z. B. jährlich oder nach dem Ausscheiden einer Person mit Zugang zu Master-Key
und Datenbank, **nur ohne Verdacht auf Kompromittierung**:

1. Oberfläche *Partner › Eigene Knotenkarte › Schlüssel wechseln*, Anlass „Planmäßiger Wechsel“,
   Übergangszeit wählen (1–30 Tage, Standard 7), bestätigen (Rolle `admin`). Alternativ nativ
   `bun --env-file=.env run cli rotate-node-key --routine [--grace-days 7]`, Docker
   `docker compose run --rm cli rotate-node-key --routine`; das geht auch bei laufendem Knoten (er
   übernimmt den neuen Schlüssel innerhalb weniger Sekunden) – ohne laufenden Knoten gehen die
   Mitteilungen beim nächsten Start hinaus.
2. Jeder vertrauenswürdige (und gesperrte) Partner erhält über das Ausgangspostfach eine Mitteilung, die mit
   dem bisherigen und dem neuen Schlüssel signiert ist, und übernimmt den neuen Schlüssel selbsttätig
   (Audit dort `peer.key_rotated`, hier `node.key_rotate` und je Partner `node.key_rotation.confirmed`).
   Bis zur Bestätigung erhält ein Partner weiter mit dem bisherigen Schlüssel Signiertes; der Austausch
   läuft ohne Unterbrechung.
3. Stand verfolgen: *Partner › Eigene Knotenkarte* zeigt, wie viele Partner bestätigt haben; nicht
   zugestellte Mitteilungen stehen im Ausgangspostfach (*Jetzt zustellen* nach einer Störung).
4. Nach der Übergangszeit wird der bisherige private Schlüssel gelöscht (Audit
   `node.key_rotation.finished`; bei Partnern ohne Bestätigung `outcome = error` mit deren Knoten-IDs).
   Diese Partner lehnen Nachrichten des Knotens danach ab. Ihnen die neue Knotenkarte senden: Sie tragen
   sie unter *Partner › (Partner) › Neuen Schlüssel eintragen* ein, gleichen den Fingerprint telefonisch ab
   und bestätigen das Vertrauen.

Ein weiterer planmäßiger Wechsel ist erst nach dem Ende der Übergangszeit möglich.

Trägt ein Partner, der die Mitteilung verpasst hat, die neue Knotenkarte schon während der Übergangszeit
manuell ein, lehnt er mit dem bisherigen Schlüssel Signiertes ab. Der Knoten wiederholt eine solche
abgelehnte Anfrage einmal mit dem neuen Schlüssel; gelingt sie, gilt der Partner als bestätigt
(`node.key_rotation.confirmed`, `via: new_key_accepted`) und erhält ab dann nur noch neu Signiertes – der
Austausch läuft ohne Warten auf das Ende der Übergangszeit weiter. Nach jedem Wechsel das
[Anker-Profil](#anker-profil-unabhängige-prüfung) neu exportieren.

**Verdacht auf Kompromittierung** (Schlüssel, Master-Key oder Datenbank könnten in fremden Händen sein):
Eine Mitteilung mit dem bisherigen Schlüssel wäre dann nicht vertrauenswürdig – ein Angreifer könnte
dieselbe senden. Deshalb ohne Mitteilung:

1. Alle Partner telefonisch informieren; sie sperren den Knoten (*Partner › Sperren*).
2. Ursache klären und ggf. zuerst den Master-Key rotieren ([Master-Key rotieren](#master-key-rotieren)).
3. Schlüssel ersetzen: Oberfläche mit Anlass „Verdacht auf Kompromittierung“ oder
   `bun --env-file=.env run cli rotate-node-key --compromised --yes`. Der bisherige Schlüssel wird sofort
   verworfen (auch ein laufender planmäßiger Wechsel endet); es gibt keine Übergangszeit.
4. Neue Knotenkarte (`bun --env-file=.env run cli node-card` bzw. *Karte herunterladen*) an jeden Partner;
   dieser trägt sie unter *Neuen Schlüssel eintragen* ein, gleicht den **neuen Fingerprint telefonisch** ab
   und bestätigt das Vertrauen. Erst dann ist wieder Austausch möglich.
5. Weiter nach [Incident Response](incident-response.md).

**Partner wechselt seinen Schlüssel:** Planmäßige Wechsel übernimmt dieser Knoten automatisch (Partnerliste:
*Schlüssel gewechselt*, bisheriger Fingerprint bis zum Ende der Übergangszeit). Hat der Partner die
Mitteilung nicht zustellen können oder nach einer Kompromittierung ohne Mitteilung gewechselt, die neue
Knotenkarte unter *Neuen Schlüssel eintragen* aufnehmen und den Fingerprint telefonisch abgleichen.

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
docker compose build                                   # 2. neues Abbild (mit Superset: --profile bi)
docker compose up -d                                   # 3. migrate läuft vor dem Start des Knotens
docker compose ps -a                                   # migrate: Exited (0), node: healthy
./verify-deployment.sh                                 # 4. TLS, Netztrennung, Proxy-Vertrauen
```

Danach in *System* die Version prüfen. Weitere Updates:

- **Betriebssystem/Pakete:** monatlich bzw. bei Sicherheitsmeldungen (`apt upgrade`; Docker: Abbilder neu
  bauen mit `docker compose build --pull` und die fertigen Abbilder von Datenbank und Caddy aktualisieren
  mit `docker compose pull db caddy`, danach `docker compose up -d`).
- **PostgreSQL-Nebenversionen** (18.x) über die Paketverwaltung bzw. `docker compose pull db`.
  **Hauptversionswechsel** (z. B. 18 → 19) mit `pg_upgrade` oder Sicherung/Wiederherstellung planen.
- **Bun:** getestet ist die in der [Installation](installation.md#a1-pakete-installieren-administrationskonto)
  genannte Version. Eine neue Version erst nach Tests (`bun test`) und neuer SBOM (`bun run sbom`)
  übernehmen: in `deploy/Dockerfile` (`ARG BUN_VERSION`) bzw. auf dem Server mit
  `curl -fsSL https://bun.sh/install | bash -s "bun-v<version>"` und
  `sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun`.
- **Abhängigkeiten:** siehe [Schwachstellenmanagement](sicherheit.md#schwachstellenmanagement).

**SBOM des Container-Abbilds (Release):** Neben der SBOM des Quellcodes (`bun run sbom`, siehe
[Sicherheit](sicherheit.md)) beschreibt `sbom/osp-data-mesh.image.cdx.json` das gebaute Abbild des Knotens:
Debian-Pakete (u. a. PostgreSQL-Client), npm-Pakete in `/app/node_modules`, ausführbare Dateien und
Bibliotheken, CA-Zertifikate. Nach jedem Bau eines Release-Abbilds neu erzeugen und prüfen (auf dem
Build-Rechner mit Bun und Docker, im Repository-Verzeichnis; mit Colima zusätzlich
`DOCKER_HOST=unix://$HOME/.colima/default/docker.sock` setzen):

```sh
docker build -f deploy/Dockerfile -t osp-data-mesh:<version> .
bun x -p @cyclonedx/cdxgen@12.9.0 cdxgen -t docker osp-data-mesh:<version> \
  -o sbom/osp-data-mesh.image.cdx.json
bun x -p @cyclonedx/cdxgen@12.9.0 cdx-validate -i sbom/osp-data-mesh.image.cdx.json \
  --no-deep --no-include-manual --strict --fail-severity critical
```

Die SBOM gilt nur für genau dieses Abbild (Abbild-ID in `metadata.component.purl`); ein Neubau ändert sie.
Offene Lücken (Stand der ersten Erzeugung): Bun selbst erscheint ohne Version (`pkg:generic/bun`; die
Version steht in `deploy/Dockerfile`, `ARG BUN_VERSION`), die Debian-Pakete ohne Lizenzangabe, Hersteller
und Kontakt für Schwachstellenmeldungen fehlen in den Metadaten, die Datei ist nicht signiert.

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
SHA-256 des vorherigen (Hash-Kette). Prüfung der inneren Folge:

- Oberfläche *Audit › Integrität prüfen* (Rollen `auditor`, `admin`),
- Kommandozeile `bun --env-file=.env run cli verify-audit` (Exit 0 = intakt, 1 = Bruch mit Position),
- SQL (als `mesh_owner`): `select * from audit_verify();`.

Ein Bruch bedeutet Manipulation unter Umgehung der Trigger (nur mit Owner-/Superuser-Rechten möglich) oder
Datenbankbeschädigung → [Incident Response](incident-response.md).

### Externe Verankerung bei den Partnern

Wer Eigentümerrechte an der Datenbank hat, kann das **Ende abschneiden** oder die Kette ab einem Eintrag
**neu berechnen** – `audit_verify()` meldet dann weiter „intakt“. Dagegen hinterlegt der Knoten signierte
**Prüfpunkte** (Laufnummer und Hash des letzten Eintrags) bei allen vertrauenswürdigen Partnern
([ADR 0014](adr/0014-externe-verankerung-audit-kette.md)):

- automatisch alle `MESH_AUDIT_CHECKPOINT_HOURS` Stunden (Standard 1; `0` = nur auf Anforderung), sofern
  die Kette seitdem gewachsen ist, und als Lebenszeichen spätestens nach dem doppelten Intervall auch ohne
  neue Einträge; auf Anforderung mit *Audit › Externe Verankerung › Prüfpunkt jetzt senden* oder
  `bun --env-file=.env run cli audit-checkpoint`. Zustellung über das Ausgangspostfach. Maßgeblich für den
  Planer ist der jüngste **gültig signierte** eigene Prüfpunkt (nicht aus der Zukunft); eigene Prüfpunkte
  legt der Server nur über die Datenbankfunktion `audit_checkpoint_append()` an (`mesh_app` hat kein
  `INSERT` auf `audit_checkpoint`). Belegt eine ungültige Zeile den Platz, steht `audit.checkpoint.invalid_row`
  im Audit-Log – Hinweis auf einen kompromittierten Datenbankzugang ([Incident Response](incident-response.md)).
- **Abgleich** (mindestens monatlich und bei jedem Verdacht): `bun --env-file=.env run cli verify-audit
  --with-partners --profile <profil.json>` (unabhängig, siehe [Anker-Profil](#anker-profil-unabhängige-prüfung)),
  ohne Profil bzw. in der Oberfläche *Audit › Mit Partnern abgleichen* nur als schnelle, **nicht
  unabhängige** Kontrolle. Die Kette wird dabei im Programm aus den Rohspalten neu berechnet – nicht mit
  `audit_verify()` und nicht über die gespeicherte Spalte `hash`, die der Eigentümer stehen lassen kann,
  während er Inhalte ändert. Ergebnis je Partner (Fingerprint, Anzahl Prüfpunkte, bestätigte, letzte
  Laufnummer, erste Abweichung) und insgesamt:

  | Ergebnis | Exit-Code | Bedeutung |
  |---|---|---|
  | verankert und intakt | 0 | Kette intakt und enthält genau die bei den Partnern hinterlegten Paare (Laufnummer, Hash) – ohne Profil bei mindestens einem, mit Profil bei jedem Partner des Profils (bzw. begründet entschuldigt) und mindestens `minPartners` |
  | Manipulation erkannt | 1 | Kette gebrochen, Laufnummer fehlt (abgeschnitten) oder Hash weicht ab (umgeschrieben) → [Incident Response](incident-response.md) |
  | nicht verankert | 3 | ohne Profil: kein Partner bestätigt; mit Profil: ein Partner des Profils nicht erreichbar/ohne Bestätigung (ohne Begründung) oder weniger als `minPartners` |
  | Klärung nötig | 4 | kein Beleg für Manipulation, aber Hinweise, die erklärt und dokumentiert werden müssen: Prüfpunkte durch eine Wiederherstellung verloren (ohne Profil), Epoche nicht im Profil, unbekannte Epoche, Abweichung mit einem als kompromittiert abgelösten Schlüssel („nicht beweiskräftig“), Partner in der Datenbank gesperrt oder mit anderer Adresse/anderem Schlüssel als im Profil, **veralteter Anker**: der jüngste bestätigte Prüfpunkt ist älter als das Dreifache von `MESH_AUDIT_CHECKPOINT_HOURS` (Planer oder Zustellung gestört, oder der Knoten lief lange nicht – dann `audit-checkpoint` und erneut prüfen) |

  Mit Profil ist außerdem **Manipulation** (Exit 1): ein Prüfpunkt, den eine im Profil nicht dokumentierte
  Wiederherstellung „verloren“ hätte, und ein Prüfpunkt hinter dem vor einer Wiederherstellung
  festgehaltenen Kopf (dieser Fall auch ohne Profil). Jede Prüfung nennt außerdem, bis zu welcher
  Laufnummer die Kette von genug Partnern bestätigt ist und **wie viele Einträge danach noch nicht verankert**
  sind („Verankert / anchored: bis seq …; … Einträge danach noch nicht verankert“) – nur diese könnte der
  Eigentümer der Datenbank unbemerkt ändern oder löschen. Alte Einträge (vor Migration 0620) mit `|` in
  einem Feld werden als Hinweis gezählt ([ADR 0006](adr/0006-db-rollen-audit-hashkette.md), Restrisiko).

  Der Abgleich wird protokolliert (`audit.anchor.verify` mit Quelle `database` bzw. `profile` und
  Prüfsumme des Profils, bei Abweichung `outcome = error`). Er muss mit unveränderter Software laufen
  (z. B. die Kommandozeile aus einem geprüften Stand auf einem eigenen Rechner).
- Eigene Schlüssel gelten für Prüfpunkte nur in ihrem **Gültigkeitszeitraum** (ab dem Wechsel, der sie
  einführte, bis zum Ende der Übergangszeit des Wechsels, der sie ablöste; bei Kompromittierung bis zu
  dessen Zeitpunkt). Abweichungen, die mit einem als kompromittiert abgelösten Schlüssel signiert sind,
  gelten nicht als Beweis (Klärung nötig): Wer den Schlüssel gestohlen hat, könnte sie selbst erzeugt haben.
- Partner verwahren die Prüfpunkte nur anhängbar und protokollieren den Empfang
  (`audit.checkpoint.received`); ein widersprüchlicher Prüfpunkt (gleiche Epoche und Laufnummer, anderer
  Hash) wird dort abgewiesen und als `audit.checkpoint.conflict` protokolliert – ein Hinweis, beim Partner
  nachzufragen. Je Partner, Epoche und signierendem Schlüssel nimmt ein Knoten nur steigende Laufnummern an
  (ein gestohlener, inzwischen ersetzter Schlüssel blockiert die Prüfpunkte des neuen nicht) und höchstens
  `MESH_AUDIT_CHECKPOINT_MAX_PER_DAY` (Standard 48) neue Prüfpunkte in 24 Stunden; Ablehnungen stehen
  zusammengefasst im Audit-Log (`audit.checkpoint.rejected`, `checkpoint_not_increasing` bzw.
  `checkpoint_rate_limited`, `suppressed`). Ungeschützt bleibt nur der Teil nach dem letzten zugestellten
  Prüfpunkt.

#### Anker-Profil (unabhängige Prüfung)

Partnerliste, Adressen und Schlüssel der Partner sowie die früheren eigenen Schlüssel liegen in derselben
Datenbank wie das Audit-Log – teils sogar für `mesh_app` änderbar. Wer sie verändert, könnte Partner
sperren (Ergebnis dann „nicht verankert“ statt „Manipulation“) oder eine Partneradresse auf einen eigenen
Dienst mit eigenem Schlüssel umstellen und „ok“ unter dem Namen eines echten Partners erhalten. Das
**Anker-Profil** hält diese Angaben außerhalb der Datenbank fest:

1. Exportieren (Rolle Administration, Server-Umgebung):
   `bun --env-file=.env run cli audit-anchor-profile --out anker-profil-<datum>.json [--min-partners 2]
   [--previous <altes-profil>.json]` (Docker: `docker compose run --rm cli audit-anchor-profile --out …`
   in ein gemountetes Verzeichnis). Inhalt: Knoten-ID, eigene Schlüssel mit Fingerprint und
   Gültigkeitszeitraum, Epochen der Kette, vertrauenswürdige Partner mit Knoten-ID, Adresse, Schlüssel und
   Fingerprint, Mindestzahl bestätigender Partner (Standard 1), je Wiederherstellung SHA-256 und Zeitpunkt
   der Sicherung sowie der Kopf der Kette davor.
   **Mit `--previous`** ist das alte Profil die Grundlage und die Datenbank nur ein Vorschlag (sie kann
   verändert sein, teils schon mit `mesh_app`-Rechten): Die Mindestzahl bleibt die des alten Profils (ändern
   nur ausdrücklich mit `--min-partners`), die Ausgabe listet jede Abweichung, und jede Kategorie muss
   **ausdrücklich angenommen** werden, sonst wird nichts geschrieben („NICHT EXPORTIERT“, Exit 4,
   protokolliert):

   | Abweichung | Annahme mit |
   |---|---|
   | Partner entfernt (in der Datenbank gesperrt/fehlt), hinzugekommen, Schlüssel oder Adresse geändert | `--accept-partner-changes` |
   | eigener Schlüssel neu, Gültigkeitszeitraum oder Art der Ablösung geändert | `--accept-key-changes` |
   | Epoche neu (Wiederherstellung) oder geändert | `--accept-epochs` |

   Vorgehen: erst ohne `--accept-…` aufrufen, jede angezeigte Abweichung mit den Unterlagen abgleichen
   (Vertrauensaufnahme, Protokoll des Schlüsselwechsels bzw. der Wiederherstellung mit Prüfsumme der
   Sicherung und Kopf davor), dann nur die geprüften Kategorien annehmen. Eine Abweichung, zu der es keine
   Unterlage gibt, nicht annehmen, sondern [Incident Response](incident-response.md). Eigene Schlüssel und
   Epochen, die nur das alte Profil kennt, bleiben erhalten; Änderungen nur des Anzeigenamens eines Partners
   werden ohne Annahme übernommen.
2. Die ausgegebenen **Fingerprints** der Partner mit den Unterlagen der Vertrauensaufnahme (telefonischer
   Abgleich) vergleichen, jede Wiederherstellung in der Epochenliste mit ihrem Protokoll.
3. Profil **offline neben dem Sicherungsschlüssel** verwahren (z. B. Tresor bzw. Passwortmanager der
   Leitung, zweite Kopie bei der Revision) und die ausgegebene **SHA-256-Prüfsumme** notieren. Es enthält
   keine Geheimnisse, aber wer es unbemerkt ändern kann, kann die Prüfung täuschen.
4. Prüfen: `bun --env-file=.env run cli verify-audit --with-partners --profile anker-profil.json`. Die
   Ausgabe nennt Prüfsumme und Fingerprint jedes Partners; Partner, Adressen und Schlüssel stammen
   ausschließlich aus dem Profil. Jeder Partner des Profils muss bestätigen. Ist einer bekanntermaßen
   nicht verfügbar (Wartung, Ausscheiden): `--excuse <knoten-id>[,…] --reason "<Begründung>"` – die
   Begründung wird protokolliert, die Mindestzahl gilt weiter. Weichen Partnerzeilen der Datenbank vom
   Profil ab (gesperrt, andere Adresse, anderer Schlüssel), erscheint das als Hinweis (Exit 4).
5. **Neu exportieren** nach jedem eigenen Schlüsselwechsel (sonst gelten neue Prüfpunkte als „unbekannter
   Schlüssel“ und der Abgleich schlägt fehl; `--accept-key-changes`), nach Schlüsselwechsel, Umzug, Aufnahme
   oder Ausscheiden eines Partners (`--accept-partner-changes`) und nach jeder Wiederherstellung
   (`--accept-epochs`) – jeweils mit `--previous` und erneutem Abgleich der Fingerprints.

Auch der exportierte Prüfpunkt lässt sich mit Profil prüfen:
`verify-audit --checkpoint pruefpunkt.json --profile anker-profil.json` (Exit 0 passt, 1 Abweichung,
4 Klärung nötig, z. B. Prüfpunkt einer früheren Epoche).

**Grenzen:** Wer Datenbank **und** das prüfende Programm bzw. dessen Rechner kontrolliert, kann auch das
Ergebnis fälschen; ein Superuser des PostgreSQL-Clusters kann eingebaute Funktionen ändern oder dem
Prüfprogramm gezielt andere Zeilen zeigen als anderen Lesern. Deshalb: Prüfung von einem sauberen Rechner
mit geprüfter Software, Profil und Prüfpunkt-Exporte außerhalb des Knotens, Superuser-Zugang nur für die
Datenbankadministration.

**Verankerung außerhalb des Netzes:** *Prüfpunkt herunterladen* bzw.
`bun --env-file=.env run cli audit-checkpoint --out pruefpunkt.json` erzeugt eine Datei mit Aussage,
Signatur, öffentlichem Schlüssel und Fingerprint, z. B. monatlich an den Datenschutzbeauftragten. Später
prüfen mit `bun --env-file=.env run cli verify-audit --checkpoint pruefpunkt.json` (Exit 0/1) oder ohne die
Software mit OpenSSL 3:

```sh
jq -j .statement pruefpunkt.json > statement.txt
jq -r .signature pruefpunkt.json | base64 -d > signature.bin
( printf '302a300506032b6570032100' | xxd -r -p; jq -r .publicKey pruefpunkt.json | base64 -d ) > pub.der
openssl pkey -pubin -inform DER -in pub.der -out pub.pem
openssl pkeyutl -verify -pubin -inkey pub.pem -rawin -in statement.txt -sigfile signature.bin
```

Den Fingerprint der Datei mit dem außerhalb notierten Wert vergleichen; Laufnummer und Hash der Aussage
müssen in der Kette stehen (`select hash from audit_log where seq = …`).

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
