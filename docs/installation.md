# Installation

Diese Anleitung führt Schritt für Schritt von einer leeren Umgebung zu einem laufenden Knoten, der über
HTTPS erreichbar ist und einem Partnerknoten vertraut. Es gibt zwei gleichwertige Wege für den
Produktivbetrieb:

- **Variante A – nativ** auf einem Linux-Server (**Debian 13 oder Ubuntu 24.04**) mit Bun 1.4.3,
  PostgreSQL 18, Caddy und systemd. Alle Befehle der Variante A sind für diese Systeme geschrieben.
- **Variante B – Docker Compose**: Datenbank, Migration, Knoten und Caddy als Container.

macOS eignet sich nur für **Testinstallationen** (Abweichungen im Kasten [macOS](#macos-nur-testinstallationen)).
Für einen Test ohne Domain und Zertifikat auf dem eigenen Rechner gibt es die
[Testinstallation ohne Caddy](#testinstallation-ohne-caddy-nur-http-nur-lokal).

Beide Varianten enden mit denselben [Prüfschritten](#prüfen) und dem
[Vertrauensaufbau mit einem Partnerknoten](#vertrauen-mit-einem-partnerknoten-herstellen).

> **Was angepasst werden muss**
>
> - Platzhalter in spitzen Klammern (`<…>`) immer durch eigene Werte ersetzen.
> - Die Beispielwerte `osp-beispiel`, `OSP Beispiel`, `mesh.osp-beispiel.example.de` und
>   `it@osp-beispiel.example.de` durch die eigenen Werte ersetzen.
> - Zeilen mit dem Kommentar `# anpassen` enthalten **Standardwerte**, die nur bei abweichender
>   Umgebung geändert werden: `127.0.0.1` und `5432` (Adresse und Port des PostgreSQL-Clusters dieses
>   Knotens) sowie `4401` (Port des Knotens, `MESH_PORT`).
> - Befehle mit `sed -i` sind für Linux (GNU sed) geschrieben; unter macOS `sed -i ''` verwenden.

## Vorbereitung (beide Varianten)

Festlegen und notieren:

| Angabe | Beispiel | Hinweis |
|---|---|---|
| Knotenkennung `MESH_NODE_ID` | `osp-beispiel` | Kleinbuchstaben, Ziffern, Bindestrich; **nach dem ersten Start unveränderlich** |
| Anzeigename `MESH_NODE_NAME` | `OSP Beispiel` | sehen Partner und Nutzende |
| DNS-Name | `mesh.osp-beispiel.example.de` | zeigt auf den Server; für Partner-Austausch aus deren Netz erreichbar |
| Öffentliche URL `MESH_PUBLIC_URL` | `https://mesh.osp-beispiel.example.de` | immer `https://` + DNS-Name |
| TLS-Modus | E-Mail-Adresse (ACME) oder `internal` | ACME braucht Ports 80/443 aus dem Internet; `internal` für LAN/Test |
| E-Mail der ersten Administration | `it@osp-beispiel.example.de` | Anmeldename |

Netzwerk: eingehend TCP 443 (und 80 für ACME/Weiterleitung) zum Server; ausgehend HTTPS zu den
Partnerknoten und ggf. zu API-Quellen (Messsysteme). Die Datenbank wird **nicht** nach außen geöffnet.
Docker Compose (Variante B) legt feste interne Subnetze an (`172.31.252.0/24`, mit BI-Datenbankzugang
zusätzlich `172.31.250.0/24` und `172.31.251.0/24`); sie dürfen sich nicht mit Netzen des OSP
überschneiden.

Mindestausstattung für einen OSP (Mengengerüst: einige tausend Athletinnen/Athleten und Messwerte):
2 vCPU, 4 GB RAM, 20 GB Plattenplatz zuzüglich Sicherungen.

> **Ein PostgreSQL-Cluster je Knoten.** Die Datenbankrollen `mesh_owner`, `mesh_app` und `mesh_bi`
> gelten in PostgreSQL für den **ganzen Cluster** (die Server-Instanz mit einem Port), nicht nur für eine
> Datenbank. Lägen zwei Knoten in einem Cluster (z. B. Datenbanken `mesh` und `mesh2`), teilten sie sich
> diese Rollen: Jeder `db-bootstrap` des einen Knotens setzte die Passwörter des anderen neu (dieser
> verlöre seine Datenbankverbindung), und `mesh_app` bzw. `mesh_bi` des einen Knotens könnten die
> Datenbank des anderen lesen – die Trennung der Knoten wäre aufgehoben. Deshalb erhält jeder Knoten –
> auch ein Test- oder Wiederherstellungssystem – einen **eigenen Cluster**: am besten auf einem eigenen
> Server, in einer eigenen VM oder einem eigenen Container, mindestens aber als eigener Cluster mit
> eigenem Port (Debian/Ubuntu: `sudo pg_createcluster --port=5433 --start 18 <name>`). `db-bootstrap`
> bricht ab, wenn der Cluster schon eine andere Datenbank von `mesh_owner` enthält
> (siehe [A4](#a4-rollen-und-datenbank-anlegen-db-bootstrap)). Der Cluster sollte keine Datenbanken
> anderer Anwendungen enthalten.

---

## Variante A: native Installation

Ausgeführt wird Variante A von einer Person mit `sudo`-Rechten auf dem Server (im Folgenden
„Administrationskonto“). Ab A2 laufen die Befehle als Systembenutzer `osp-mesh`, der **kein** `sudo`
verwenden kann; Schritte, die `sudo` brauchen, sind deshalb ausdrücklich dem Administrationskonto
zugeordnet.

### A1. Pakete installieren (Administrationskonto)

```sh
sudo apt update
sudo apt install -y git curl unzip openssl ca-certificates jq

# PostgreSQL 18 aus dem offiziellen PGDG-Repository
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-18

# Caddy (offizielles Repository, siehe https://caddyserver.com/docs/install)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# Bun in genau der getesteten Version 1.4.3 (systemweit nach /usr/local/bin)
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"
sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
bun --version   # erwartet: 1.4.3
```

Getestet ist **Bun 1.4.3**; andere Versionen nicht verwenden. Das Installationsskript installiert mit dem
Argument `bun-v1.4.3` genau diese Version (ohne Argument die neueste).

Prüfen: `psql --version` und `pg_dump --version` melden **18.x** (pg_dump muss mindestens die Version des
Servers haben).

**Superuser-Passwort für PostgreSQL setzen.** `db-bootstrap` (A4) meldet sich einmalig als Superuser
`postgres` über TCP an. Nach der Paketinstallation hat `postgres` kein Passwort:

```sh
openssl rand -hex 24                             # Ausgabe sofort in die Passwortverwaltung übernehmen
sudo -u postgres psql -c '\password postgres'    # dieses Passwort zweimal eingeben (Eingabe unsichtbar)
```

Ein Passwort aus Hex-Zeichen (`openssl rand -hex 24`) kann ohne Kodierung in einer Verbindungs-URL stehen.
Verwendet der Knoten nicht den Standard-Cluster (`main`, Port 5432), sondern einen eigenen Cluster mit
anderem Port, `psql` zusätzlich `-p <port>` übergeben und in A3 `DB_PORT` entsprechend setzen.

> #### macOS (nur Testinstallationen)
>
> Variante A ist für Linux geschrieben (`useradd`, `sudo -u postgres`, systemd, `/etc/caddy`). Für eine
> **Testinstallation** auf einem Mac mit Homebrew gelten diese Abweichungen; für den Produktivbetrieb
> Linux oder Docker verwenden.
>
> - **A1:** `brew install postgresql@18 caddy git openssl jq`, dann `brew services start postgresql@18`.
>   PostgreSQL 18 ist nicht im `PATH`: `export PATH="$(brew --prefix postgresql@18)/bin:$PATH"` (auch in
>   `~/.zshrc` eintragen). Bun 1.4.3: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"`, dann
>   `export PATH="$HOME/.bun/bin:$PATH"` und `bun --version` → `1.4.3` (nicht `brew install bun`: das
>   installiert die jeweils neueste Version). Ein Superuser-Passwort ist nicht nötig.
> - **A2:** kein Systembenutzer: Quellcode in ein Verzeichnis des eigenen Kontos legen (z. B.
>   `git clone <REPOSITORY-URL> ~/osp-data-mesh`), dort `bun install --frozen-lockfile` und
>   `mkdir -m 700 backups`; alle weiteren Befehle in diesem Verzeichnis ohne `sudo`.
> - **A4:** Superuser ist das **eigene macOS-Konto** (Homebrew richtet den Cluster mit vertrauender
>   Anmeldung für lokale Verbindungen ein): statt der ersten beiden Zeilen
>   `export MESH_DB_SUPERUSER_URL="postgres://$(whoami)@127.0.0.1:5432/postgres"`.
> - **A5:** zusätzlich `sed -i '' "s|^MESH_PG_DUMP=.*|MESH_PG_DUMP=$(brew --prefix postgresql@18)/bin/pg_dump|" .env`.
> - **A8:** kein systemd; den Knoten im Vordergrund mit `bun run start` betreiben.
> - **A9:** am einfachsten ganz ohne Caddy, siehe
>   [Testinstallation ohne Caddy](#testinstallation-ohne-caddy-nur-http-nur-lokal). Mit Caddy: die
>   Konfiguration steht in `$(brew --prefix)/etc/Caddyfile`, neu laden mit `brew services restart caddy`;
>   das Wurzelzertifikat von `tls internal` liegt unter
>   `~/Library/Application Support/Caddy/pki/authorities/local/root.crt` (nicht verifiziert).

### A2. Systembenutzer und Quellcode (Administrationskonto)

```sh
sudo useradd --system --create-home --home-dir /var/lib/osp-mesh --shell /bin/bash osp-mesh
sudo git clone <REPOSITORY-URL> /opt/osp-data-mesh      # oder Release-Archiv nach /opt/osp-data-mesh entpacken
sudo chown -R osp-mesh:osp-mesh /opt/osp-data-mesh
sudo -iu osp-mesh                                       # ab hier als osp-mesh
cd /opt/osp-data-mesh
bun install --frozen-lockfile
mkdir -m 700 backups     # Sicherungsverzeichnis (MESH_BACKUP_DIR=./backups); muss vor dem Start des Dienstes existieren
```

Alle weiteren Befehle bis einschließlich A7 laufen als Benutzer `osp-mesh` im Verzeichnis
`/opt/osp-data-mesh`, **in derselben Shell-Sitzung** (A3 setzt Variablen, die A4 und A5 verwenden).

### A3. Passwörter und Owner-Zugang erzeugen

Die Passwörter der drei Datenbankrollen und der Owner-Zugang kommen in eine eigene Datei `.env.owner`,
die **nur** für Kommandozeilenaufrufe geladen wird. Der Server-Prozess erhält das Owner-Passwort nie.

```sh
DB_HOST=127.0.0.1   # anpassen: Adresse des PostgreSQL-Clusters dieses Knotens
DB_PORT=5432        # anpassen: Port des PostgreSQL-Clusters dieses Knotens
OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24); BI_PW=$(openssl rand -hex 24)
cat > .env.owner <<EOF
MESH_DB_OWNER_PASSWORD=$OWNER_PW
MESH_DB_APP_PASSWORD=$APP_PW
MESH_DB_BI_PASSWORD=$BI_PW
MESH_DB_OWNER_URL=postgres://mesh_owner:$OWNER_PW@$DB_HOST:$DB_PORT/mesh
EOF
chmod 600 .env.owner
```

### A4. Rollen und Datenbank anlegen (db-bootstrap)

`db-bootstrap` führt `deploy/postgres/bootstrap.sql` als PostgreSQL-Superuser aus und legt die Rollen
`mesh_owner`, `mesh_app`, `mesh_bi` sowie die Datenbank `mesh` an (idempotent; ein erneuter Aufruf setzt
die Passwörter aus `.env.owner` neu). Die Verbindung als Superuser liest der Befehl aus der
Umgebungsvariable `MESH_DB_SUPERUSER_URL`:

```sh
printf 'Passwort des PostgreSQL-Superusers postgres: '; read -rs SU_PW; echo
export MESH_DB_SUPERUSER_URL="postgres://postgres:$SU_PW@$DB_HOST:$DB_PORT/postgres"
bun --silent --env-file=.env.owner run cli db-bootstrap
unset MESH_DB_SUPERUSER_URL SU_PW
```

Warum so: Das Passwort wird unsichtbar eingelesen und steht nur in der Umgebung des Prozesses – nicht in
der Shell-History, nicht in der Prozessliste (`ps`) und nicht in der Ausgabe. `--silent` verhindert, dass
`bun run` die ausgeführte Befehlszeile anzeigt. Die Option `--superuser-url <url>` gibt es weiterhin, sie
sollte aber nicht verwendet werden, weil die URL mit dem Passwort dann in History, Prozessliste und
(ohne `--silent`) in der Ausgabe erscheint. Alternative: die Zeile `MESH_DB_SUPERUSER_URL=…`
vorübergehend in `.env.owner` eintragen und nach dem Aufruf wieder entfernen.

Erwartete Ausgabe: `Datenbank "mesh" und Rollen mesh_owner, mesh_app, mesh_bi eingerichtet`; als
nächster Schritt wird `bun --env-file=.env --env-file=.env.owner run cli migrate` genannt (siehe A6).

- **Abbruch, weil der Cluster schon eine andere Datenbank von `mesh_owner` enthält:** In diesem Cluster
  läuft bereits ein Knoten. Für diesen Knoten einen eigenen Cluster verwenden (siehe
  [Ein PostgreSQL-Cluster je Knoten](#vorbereitung-beide-varianten)). Die Option `--force` übergeht
  diese Prüfung; sie ist **nur für Fachleute**, die wissen, dass dann beide Datenbanken dieselben Rollen
  und Passwörter verwenden und die Knoten nicht mehr voneinander getrennt sind.
- **Erneuter Aufruf:** Bestehen die Rollen bereits, ändert `db-bootstrap` ihre Passwörter **nicht** und
  meldet das („Passwörter wurden NICHT geändert“). So kann ein versehentlicher zweiter Aufruf – etwa für
  einen zweiten Knoten im selben Cluster – die Zugänge eines laufenden Knotens nicht übernehmen. Um die
  Passwörter bewusst zu ändern (Rotation), mit `--rotate-passwords` aufrufen und danach `.env` und
  `.env.owner` anpassen.
- Ein anderer Datenbankname als `mesh` ist mit `--db <name>` möglich (nur `a-z`, `0-9`, `_`; dann auch
  den Namen in den URLs in `.env` und `.env.owner` anpassen). Er ändert nichts an der Regel „ein Cluster
  je Knoten“.

### A5. Konfiguration `.env`

```sh
cp .env.example .env && chmod 600 .env
sed -i "s|^MESH_NODE_ID=.*|MESH_NODE_ID=osp-beispiel|" .env
sed -i "s|^MESH_NODE_NAME=.*|MESH_NODE_NAME=OSP Beispiel|" .env
sed -i "s|^MESH_PUBLIC_URL=.*|MESH_PUBLIC_URL=https://mesh.osp-beispiel.example.de|" .env
sed -i "s|^MESH_DB_URL=.*|MESH_DB_URL=postgres://mesh_app:$APP_PW@$DB_HOST:$DB_PORT/mesh|" .env
sed -i "s|^MESH_MASTER_KEY=.*|MESH_MASTER_KEY=$(bun src/server/cli/main.ts gen-key)|" .env
sed -i "s|^MESH_BACKUP_KEY=.*|MESH_BACKUP_KEY=$(bun src/server/cli/main.ts gen-key)|" .env
# Kontrolle (zeigt keine Geheimnisse): erwartet ist genau die Zeile "ok: Pflichtwerte gesetzt"
grep -nE '^(MESH_NODE_ID|MESH_NODE_NAME|MESH_PUBLIC_URL|MESH_DB_URL|MESH_MASTER_KEY|MESH_BACKUP_KEY)=$|APP_PASSWORT' .env \
  || echo "ok: Pflichtwerte gesetzt"
```

Gibt die Kontrolle eine Zeile von `.env` aus, ist dieser Wert noch leer bzw. ein Platzhalter.

Alle übrigen Werte haben sinnvolle Standards (Beschreibung jeder Variable in `.env.example`); für diese
Installation mit Caddy auf demselben Server bleiben insbesondere `MESH_HOST=127.0.0.1`, `MESH_PORT=4401`,
`MESH_TRUST_PROXY=true` und `MESH_TRUSTED_PROXIES` (Standard `127.0.0.1,::1`) unverändert (siehe A9). Für
API-Quellen (Messsysteme) die erlaubten Hosts in `MESH_SOURCE_ALLOWED_HOSTS` eintragen.

**Sofort sichern:** `MESH_MASTER_KEY`, `MESH_BACKUP_KEY` und die Passwörter aus `.env.owner` in die
Passwortverwaltung des OSP übertragen (getrennt von den Sicherungsdateien). Ohne `MESH_MASTER_KEY` sind
Knotenschlüssel und Zugangsdaten verloren, ohne `MESH_BACKUP_KEY` die Sicherungen.

### A6. Schema anlegen, bauen, Administration anlegen

```sh
bun --env-file=.env --env-file=.env.owner run cli migrate
bun run build                    # Web-Oberfläche nach dist/ui, Hilfe nach dist/docs
bun --env-file=.env run cli create-admin --email it@osp-beispiel.example.de --name "IT-Administration"
```

`create-admin` gibt ein **Initialpasswort einmalig** aus; es muss bei der ersten Anmeldung geändert
werden. Soll stattdessen ein eigenes Passwort gesetzt werden (mind. 12 Zeichen, nicht gleich der
E-Mail-Adresse; dann entfällt der erzwungene Wechsel), es vorher unsichtbar einlesen:
`printf 'Passwort: '; read -rs MESH_ADMIN_PASSWORD; echo; export MESH_ADMIN_PASSWORD` – und nach
`create-admin` mit `unset MESH_ADMIN_PASSWORD` wieder entfernen.

### A7. Probestart

```sh
bun run start
```

Die Logzeile `"msg":"node started"` enthält Version, Knotenkennung und den **Fingerprint**. In einem
zweiten Terminal (beliebiges Konto auf dem Server):

```sh
curl -s http://127.0.0.1:4401/healthz    # anpassen: 4401 = MESH_PORT aus .env; erwartet {"status":"ok"}
```

Danach den Probestart mit `Strg+C` beenden.

### A8. Dienst einrichten (systemd, Administrationskonto)

```sh
exit                                            # Shell von osp-mesh verlassen, zurück zum Administrationskonto
sudo cp /opt/osp-data-mesh/deploy/systemd/osp-data-mesh.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now osp-data-mesh
sudo systemctl status osp-data-mesh
```

### A9. Caddy vor den Knoten setzen (Administrationskonto)

`/etc/caddy/Caddyfile` ersetzen durch:

```text
mesh.osp-beispiel.example.de {
	# öffentliche Domain: automatisches HTTPS per ACME; im LAN/Test stattdessen: tls internal
	tls it@osp-beispiel.example.de
	encode zstd gzip
	request_body {
		max_size 25MB
	}
	# anpassen: Port = MESH_PORT aus .env (Standard 4401)
	reverse_proxy 127.0.0.1:4401
}
```

```sh
sudo systemctl reload caddy
```

Der Server lauscht nur auf `127.0.0.1` (`MESH_HOST`); von außen ist ausschließlich Caddy erreichbar.

**Client-Adresse hinter Caddy:** Caddy übergibt die echte Client-Adresse im Header `X-Forwarded-For`.
Der Server wertet ihn nur aus, wenn `MESH_TRUST_PROXY=true` gesetzt ist **und** die Verbindung von einer
Adresse aus `MESH_TRUSTED_PROXIES` kommt (kommagetrennte IP-Adressen, Standard `127.0.0.1,::1`). Da Caddy
hier auf demselben Server läuft und sich von `127.0.0.1` verbindet, passen die Standardwerte – nichts
ändern. Ohne diese Auswertung sähe der Server für alle Anfragen die Adresse von Caddy: Die
Ratenbegrenzungen je IP-Adresse (Anmeldung, abgelehnte Föderationsanfragen) träfen dann alle Nutzenden
und Partner gemeinsam (siehe
[Betrieb](betrieb.md#föderationsendpunkt-größen-ratenbegrenzung-protokollierung)). Läuft der
Reverse Proxy auf einem anderen Rechner, dessen Adresse (und nur diese) in `MESH_TRUSTED_PROXIES`
eintragen; der Server muss dann auf einer Netzadresse lauschen (`MESH_HOST`), und die Firewall darf
Verbindungen zu `MESH_PORT` nur von diesem Proxy zulassen.

Weiter mit [Prüfen](#prüfen).

### Testinstallation ohne Caddy (nur HTTP, nur lokal)

> **Warnung: nie für den Produktivbetrieb und nie mit echten Personendaten.** Ohne Caddy gibt es keine
> Transportverschlüsselung: Passwörter, Sitzungs-Cookies und Daten gehen unverschlüsselt über HTTP, das
> Sitzungs-Cookie trägt kein `Secure`-Attribut, und Partnerknoten dürfen per `http://` angesprochen
> werden. Nur für Tests auf dem eigenen Rechner (Server weiterhin nur auf `127.0.0.1`).

Ablauf: A1 bis A5 wie oben (auf einem Mac mit den Abweichungen aus dem Kasten [macOS](#macos-nur-testinstallationen)),
danach zusätzlich in `.env`:

```sh
PORT=4401   # anpassen: freier lokaler Port für diesen Testknoten
sed -i "s|^MESH_PORT=.*|MESH_PORT=$PORT|" .env
sed -i "s|^MESH_PUBLIC_URL=.*|MESH_PUBLIC_URL=http://127.0.0.1:$PORT|" .env
sed -i "s|^MESH_FEDERATION_ALLOW_HTTP=.*|MESH_FEDERATION_ALLOW_HTTP=true|" .env
sed -i "s|^MESH_COOKIE_SECURE=.*|MESH_COOKIE_SECURE=false|" .env
sed -i "s|^MESH_TRUST_PROXY=.*|MESH_TRUST_PROXY=false|" .env
```

| Variable | Wert | Warum |
|---|---|---|
| `MESH_PUBLIC_URL` | `http://127.0.0.1:<port>` | Adresse für Browser und Test-Partner |
| `MESH_PORT` | `<port>` | muss zur URL passen |
| `MESH_FEDERATION_ALLOW_HTTP` | `true` | ohne diese Einstellung startet der Server mit einer `http://`-URL nicht |
| `MESH_COOKIE_SECURE` | `false` | sonst sendet der Browser das Sitzungs-Cookie über HTTP nicht zurück und die Anmeldung scheitert; das Cookie heißt dann `osp_session` (statt `__Host-osp_session`), HSTS entfällt |
| `MESH_TRUST_PROXY` | `false` | es gibt keinen Reverse Proxy; `X-Forwarded-For` darf nicht ausgewertet werden |

Dann A6 und A7 (`bun run start`); A8 und A9 entfallen. Die Oberfläche ist unter
`http://127.0.0.1:<port>/` erreichbar, die Prüfschritte gelten mit dieser Adresse statt der
HTTPS-Adresse. Mehrere Testknoten auf einem Rechner brauchen je einen eigenen Port, ein eigenes
Verzeichnis und einen **eigenen PostgreSQL-Cluster** (Debian/Ubuntu: `sudo pg_createcluster --port=5433 --start 18 test2`,
Superuser-Passwort mit `sudo -u postgres psql -p 5433 -c '\password postgres'`; macOS: `initdb -D ~/osp-test/pg2 -U postgres -A scram-sha-256 -W` und
`pg_ctl -D ~/osp-test/pg2 -o "-p 5433" -l ~/osp-test/pg2.log start`, Superuser-URL dann
`postgres://postgres:<passwort>@127.0.0.1:5433/postgres`).

---

## Variante B: Docker Compose

Voraussetzung: Linux-Server mit Docker Engine 24 oder neuer und dem Compose-Plugin (v2.20 oder neuer),
`git` und `openssl`.

### B1. Quellcode und Umgebungsdatei

```sh
sudo git clone <REPOSITORY-URL> /opt/osp-data-mesh   # oder Release-Archiv entpacken
cd /opt/osp-data-mesh/deploy
sudo cp .env.example .env && sudo chmod 600 .env
for v in POSTGRES_PASSWORD MESH_DB_OWNER_PASSWORD MESH_DB_APP_PASSWORD MESH_DB_BI_PASSWORD; do
  sudo sed -i "s|^$v=.*|$v=$(openssl rand -hex 24)|" .env
done
for v in MESH_MASTER_KEY MESH_BACKUP_KEY; do
  sudo sed -i "s|^$v=.*|$v=$(openssl rand -base64 32)|" .env
done
sudo sed -i "s|^MESH_NODE_ID=.*|MESH_NODE_ID=osp-beispiel|" .env
sudo sed -i "s|^MESH_NODE_NAME=.*|MESH_NODE_NAME=OSP Beispiel|" .env
sudo sed -i "s|^MESH_PUBLIC_URL=.*|MESH_PUBLIC_URL=https://mesh.osp-beispiel.example.de|" .env
sudo sed -i "s|^CADDY_DOMAIN=.*|CADDY_DOMAIN=mesh.osp-beispiel.example.de|" .env
sudo sed -i "s|^CADDY_TLS=.*|CADDY_TLS=it@osp-beispiel.example.de|" .env    # LAN/Test: internal
```

Die Datei `deploy/.env` sofort in der Passwortverwaltung sichern (siehe Hinweis bei A5).

### B2. Starten

```sh
sudo docker compose up -d --build
sudo docker compose ps -a
```

Erwartet: `db` *healthy*, `migrate` *Exited (0)*, `node` *healthy* (nach bis zu 60 s), `caddy` *Up*.
Bei Problemen: `sudo docker compose logs migrate node`.

Ablauf beim Start: `db` initialisiert beim ersten Start mit `deploy/postgres/init/10-osp-bootstrap.sh`
Rollen und Datenbank (ein eigener Cluster je Compose-Projekt) → `migrate` wendet die Migrationen als
`mesh_owner` an → `node` startet mit der Rolle `mesh_app` → `caddy` stellt HTTPS bereit. Nur Caddy
veröffentlicht Ports (80, 443); Datenbank und Knoten liegen im internen Netz. Caddy hat im Netz
`frontend` (`172.31.252.0/24`) die feste Adresse `172.31.252.10`; der Knoten wertet `X-Forwarded-For`
nur für Verbindungen von dieser Adresse aus (`MESH_TRUST_PROXY=true`,
`MESH_TRUSTED_PROXIES=172.31.252.10`, in `docker-compose.yml` fest gesetzt).

### B3. Administration anlegen

```sh
sudo docker compose run --rm cli create-admin --email it@osp-beispiel.example.de --name "IT-Administration"
```

Das ausgegebene Initialpasswort notieren (wird nur einmal angezeigt).

### B4. Sicherungen

Sicherungen landen im Docker-Volume `osp-data-mesh_backups` (im Container `/var/lib/osp-mesh/backups`).
Für Kopien außerhalb des Servers siehe [Betrieb › Sicherungen](betrieb.md#sicherungen).

---

## Prüfen

1. **Lebenszeichen und Bereitschaft** (vom Server oder einem Arbeitsplatz):

   ```sh
   curl -s https://mesh.osp-beispiel.example.de/healthz   # {"status":"ok"}
   curl -s https://mesh.osp-beispiel.example.de/readyz    # {"status":"ok","db":true,"schema":true}
   ```

   Bei `CADDY_TLS=internal` bzw. `tls internal` ist das Zertifikat von Caddys eigener CA ausgestellt.
   Das Wurzelzertifikat exportieren:
   Docker: `sudo docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./osp-root.crt`;
   nativ (Debian/Ubuntu):
   `sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt > osp-root.crt`.
   Dann `curl --cacert osp-root.crt https://…/healthz`. Für Browser das Zertifikat als vertrauenswürdige
   Stelle importieren.

2. **Anmeldung:** `https://mesh.osp-beispiel.example.de/` im Browser öffnen, mit der E-Mail-Adresse und
   dem Initialpasswort anmelden. Bei einem erzeugten Initialpasswort verlangt die Oberfläche sofort ein
   neues Passwort (mind. 12 Zeichen).

3. **Systemstatus:** Menü *System* zeigt Version, Datenbank/Migrationen, Audit-Kette (*ok*), Sicherungen
   und den Fingerprint des Knotens. Eine erste Sicherung mit *Sicherung erstellen* anlegen.

4. **Hilfe:** `https://mesh.osp-beispiel.example.de/hilfe/` zeigt diese Dokumentation.

5. **Audit-Kette auf der Kommandozeile:** nativ (als `osp-mesh` in `/opt/osp-data-mesh`, also nach
   `sudo -iu osp-mesh` und `cd /opt/osp-data-mesh`) `bun --env-file=.env run cli verify-audit`, Docker
   `sudo docker compose run --rm cli verify-audit` → `Audit-Kette ok`.

6. **Weitere Benutzer** unter *Benutzer* anlegen (Rollen siehe [Rollen und Rechte](rollen.md)). Die
   Administration hat bewusst keinen Zugriff auf Fachdaten; Datenverantwortliche erhalten die Rolle
   `data_steward`.

## Vertrauen mit einem Partnerknoten herstellen

Knoten tauschen erst Daten aus, wenn **beide Seiten** einander ausdrücklich vertrauen. Der Abgleich des
Fingerprints über einen zweiten Kanal schützt davor, eine gefälschte Knotenkarte aufzunehmen.

1. **Eigene Knotenkarte exportieren** (Rolle `admin`): Oberfläche *Partner › Eigene Knotenkarte*
   herunterladen, oder nativ (als `osp-mesh` in `/opt/osp-data-mesh`) `bun --env-file=.env run cli
   node-card` bzw. `sudo docker compose run --rm cli node-card`. Die Karte enthält Kennung, Name, Adresse,
   öffentlichen Schlüssel und Fingerprint – keine Geheimnisse.
2. **Karte an den Partner senden** (z. B. per E-Mail) und die Karte des Partners empfangen.
3. **Partnerkarte aufnehmen:** *Partner › Partner aufnehmen*, JSON der Karte einfügen. Der Partner erhält
   den Status *ausstehend* (`pending`).
4. **Fingerprint abgleichen – telefonisch oder persönlich**, nicht über denselben Kanal wie die Karte:
   Die Partner-Administration liest ihren Fingerprint (*System* bzw. Logzeile `node started`) vor; er muss
   Zeichen für Zeichen mit dem angezeigten übereinstimmen.
5. **Vertrauen bestätigen:** *Partner › Vertrauen bestätigen*, abgeglichenen Fingerprint eingeben →
   Status *vertrauenswürdig* (`trusted`).
6. Dasselbe führt der Partner mit Ihrer Karte durch (Schritte 3–5 auf seiner Seite).
7. **Verbindung prüfen:** *Partner › Verbindung prüfen* (signierter `ping`; Rolle `admin` oder
   `data_steward`). Erwartet: „Verbindung zu <Partner> in Ordnung (<n> ms)“. Andernfalls nennt die Meldung
   den Grund. Über die REST-API (`POST /api/v1/peers/{id}/ping`) kommt auch ein fehlgeschlagener Test mit
   HTTP 200 zurück; das Ergebnis steht im Body, z. B. `{"ok":false,"latencyMs":null,"errorCode":"untrusted"}`
   (Erfolg: `{"ok":true,"latencyMs":42,"errorCode":null}`).

   | `errorCode` | Bedeutung | Abhilfe |
   |---|---|---|
   | `untrusted` | Der Partner kennt diesen Knoten, vertraut ihm aber (noch) nicht (dort *ausstehend* oder *gesperrt*) | Partner führt Schritte 3–5 aus |
   | `unknown_node` | Der Partner hat die Karte dieses Knotens noch nicht aufgenommen | Karte senden; Partner führt Schritte 3–5 aus |
   | `peer_unreachable` | Partner nicht erreichbar: DNS, Firewall, TLS-Zertifikat, Partner ausgefallen | Erreichbarkeit von `MESH_PUBLIC_URL` des Partners prüfen (`curl https://<partner>/healthz`) |
   | `clock_skew` | Uhren weichen mehr als 5 Minuten ab | NTP auf beiden Servern prüfen |
   | `bad_signature`, `signature_invalid` | Signatur abgelehnt bzw. Antwort falsch signiert – meist eine falsche oder veraltete Knotenkarte | Karten und Fingerprints erneut abgleichen |
   | `peer_untrusted` | Der Partner ist auf **dieser** Seite gesperrt; es wird kein `ping` gesendet (nur über die API, die Oberfläche bietet den Test dann nicht an) | Partner nach Klärung wieder als vertrauenswürdig bestätigen |

   Weitere Codes des Partners sind im [Föderationsprotokoll](protokoll.md#transport-und-signatur)
   beschrieben.

Voraussetzungen für den Austausch: Beide Knoten erreichen einander per HTTPS unter ihrer `MESH_PUBLIC_URL`
und haben ein Zertifikat, dem die Gegenseite vertraut (öffentliche Domain mit ACME empfohlen). Die Uhren
beider Server müssen per NTP synchron sein (zulässige Abweichung 5 Minuten).

*Interne CA (`tls internal`) zwischen OSPs (nicht verifiziert):* Der Partnerknoten muss Caddys
Wurzelzertifikat vertrauen, z. B. über die Umgebungsvariable `NODE_EXTRA_CA_CERTS=/pfad/osp-root.crt`
für den Server-Prozess, die von Bun ausgewertet wird. Für den produktiven Austausch werden öffentlich
vertrauenswürdige Zertifikate empfohlen.

## Optional: Apache Superset

Mit Docker Compose: in `deploy/.env` `SUPERSET_SECRET_KEY` (`openssl rand -base64 42`) und
`SUPERSET_ADMIN_PASSWORD` setzen, dann

```sh
sudo docker compose --profile bi up -d --build
sudo docker compose --profile bi logs superset-bootstrap
```

Superset läuft unter einem **eigenen Hostnamen**, Standard `bi.<CADDY_DOMAIN>`, also
`https://bi.mesh.osp-beispiel.example.de/`; abweichend in `deploy/.env` mit
`MESH_BI_DOMAIN=bi.osp-beispiel.example.de` festlegen. Für diesen Namen einen DNS-Eintrag auf denselben
Server anlegen (bei ACME öffentlich auflösbar; mit `CADDY_TLS=internal` stellt Caddy das Zertifikat selbst
aus). Ohne Superset antwortet der Name mit 502; bei ACME ohne DNS-Eintrag meldet Caddy im Log, dass es
für ihn kein Zertifikat erhält – der Knoten selbst ist davon nicht betroffen.

**Warum ein eigener Hostname?** Cookies sind nicht an Ports gebunden (RFC 6265, Abschnitt 8.5): Liefe
Superset unter dem Namen des Knotens mit anderem Port, schickte der Browser das Sitzungs-Cookie des Knotens
(`__Host-osp_session`) bei jeder Anfrage auch an Superset – Superset (oder wer es kompromittiert) erhielte
die Sitzungen aller angemeldeten Personen. Das Cookie gilt ohne `Domain`-Attribut nur für genau den Namen
des Knotens und wird an `bi.<knoten>` nicht gesendet. Superset deshalb nie unter dem Namen des Knotens
(auch nicht mit anderem Port) betreiben.

Einzelheiten, Vertrag der BI-Views und manuelle Schritte: [BI-Anbindung](bi.md) und
`deploy/superset/README.md`.
**Nicht lokal verifiziert.**

## Lokale Demo und Tests (Entwicklungsrechner)

Für eine Vorführung ohne Server: `bun install` und `bun run demo` starten drei Knoten
(`osp-nord`, `osp-mitte`, `osp-sued`, Ports 4401–4403) mit eigenen PostgreSQL-Clustern unter `.local/demo/`
und ein simuliertes Messsystem (Port 4410), spielen das Szenario durch und stoppen danach alles. Mit
`bun run demo -- --keep-running` bleiben die Knoten für die Oberfläche erreichbar; beenden mit
`bun run demo:stop`. `bun test` führt die automatisierten Tests aus (eigener Testcluster
auf Port 55434). Voraussetzung: PostgreSQL-18-Programme (`initdb`, `pg_ctl`, `psql`, `pg_dump`) lokal
installiert (Suchorte siehe README; abweichend `MESH_PG_BIN=<verzeichnis>`).
