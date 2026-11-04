# Installation

Diese Anleitung führt Schritt für Schritt von einer leeren Umgebung zu einem laufenden Knoten, der über
HTTPS erreichbar ist und einem Partnerknoten vertraut. Es gibt zwei gleichwertige Wege:

- **Variante A – nativ** auf einem Linux-Server (Beispiel: Debian 13 / Ubuntu 24.04) oder macOS mit Bun,
  PostgreSQL 18 und Caddy.
- **Variante B – Docker Compose**: Datenbank, Migration, Knoten und Caddy als Container.

Beide Varianten enden mit denselben [Prüfschritten](#prüfen) und dem
[Vertrauensaufbau mit einem Partnerknoten](#vertrauen-mit-einem-partnerknoten-herstellen).

> Platzhalter in spitzen Klammern (`<…>`) und die Beispielwerte `osp-beispiel`,
> `mesh.osp-beispiel.example.de`, `it@osp-beispiel.example.de` durch die eigenen Werte ersetzen.
> Befehle mit `sed -i` sind für Linux (GNU sed) geschrieben; unter macOS `sed -i ''` verwenden.

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

Mindestausstattung für einen OSP (Mengengerüst: einige tausend Athletinnen/Athleten und Messwerte):
2 vCPU, 4 GB RAM, 20 GB Plattenplatz zuzüglich Sicherungen.

---

## Variante A: native Installation

### A1. Pakete installieren

**Debian/Ubuntu** (als Benutzer mit `sudo`):

```sh
sudo apt update
sudo apt install -y git curl unzip openssl ca-certificates

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

# Bun 1.4.3 (systemweit nach /usr/local/bin)
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.3"
sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
bun --version   # erwartet: 1.4.3
```

**macOS** (Homebrew): `brew install postgresql@18 caddy oven-sh/bun/bun git openssl`, danach
`brew services start postgresql@18`. Die PostgreSQL-Werkzeuge liegen unter
`/opt/homebrew/opt/postgresql@18/bin` (in den `PATH` aufnehmen).

Prüfen: `psql --version` und `pg_dump --version` melden **18.x** (pg_dump muss mindestens die Version des
Servers haben).

### A2. Systembenutzer und Quellcode

```sh
sudo useradd --system --create-home --home-dir /var/lib/osp-mesh --shell /bin/bash osp-mesh
sudo git clone <REPOSITORY-URL> /opt/osp-data-mesh      # oder Release-Archiv nach /opt/osp-data-mesh entpacken
sudo chown -R osp-mesh:osp-mesh /opt/osp-data-mesh
sudo -iu osp-mesh
cd /opt/osp-data-mesh
bun install --frozen-lockfile
```

Alle weiteren Befehle der Variante A laufen als Benutzer `osp-mesh` im Verzeichnis `/opt/osp-data-mesh`
(außer ausdrücklich mit `sudo`).

### A3. Passwörter und Owner-Zugang erzeugen

Die Passwörter der drei Datenbankrollen und der Owner-Zugang kommen in eine eigene Datei `.env.owner`,
die **nur** für Kommandozeilenaufrufe geladen wird. Der Server-Prozess erhält das Owner-Passwort nie.

```sh
OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24); BI_PW=$(openssl rand -hex 24)
cat > .env.owner <<EOF
MESH_DB_OWNER_PASSWORD=$OWNER_PW
MESH_DB_APP_PASSWORD=$APP_PW
MESH_DB_BI_PASSWORD=$BI_PW
MESH_DB_OWNER_URL=postgres://mesh_owner:$OWNER_PW@127.0.0.1:5432/mesh
EOF
chmod 600 .env.owner
```

### A4. Rollen und Datenbank anlegen (db-bootstrap)

`db-bootstrap` führt `deploy/postgres/bootstrap.sql` als PostgreSQL-Superuser aus und legt die Rollen
`mesh_owner`, `mesh_app`, `mesh_bi` sowie die Datenbank `mesh` an (idempotent). Dafür wird einmalig ein
Superuser-Zugang über TCP benötigt:

```sh
SU_PW=$(openssl rand -hex 24)
sudo -u postgres psql -c "ALTER USER postgres PASSWORD '$SU_PW'"
bun --env-file=.env.owner run cli db-bootstrap \
  --superuser-url "postgres://postgres:$SU_PW@127.0.0.1:5432/postgres"
```

Erwartete Ausgabe endet mit `Weiter / next: bun run migrate`. Das Superuser-Passwort in der
Passwortverwaltung ablegen (nur für Wartung).

*Alternative ohne Superuser-Passwort:* `sudo -u postgres psql -v ON_ERROR_STOP=1 -v db_name=mesh
-v owner_password=$OWNER_PW -v app_password=$APP_PW -v bi_password=$BI_PW -f deploy/postgres/bootstrap.sql`
(der Benutzer `postgres` muss die Datei lesen können).

### A5. Konfiguration `.env`

```sh
cp .env.example .env && chmod 600 .env
sed -i "s|^MESH_NODE_ID=.*|MESH_NODE_ID=osp-beispiel|" .env
sed -i "s|^MESH_NODE_NAME=.*|MESH_NODE_NAME=OSP Beispiel|" .env
sed -i "s|^MESH_PUBLIC_URL=.*|MESH_PUBLIC_URL=https://mesh.osp-beispiel.example.de|" .env
sed -i "s|^MESH_DB_URL=.*|MESH_DB_URL=postgres://mesh_app:$APP_PW@127.0.0.1:5432/mesh|" .env
sed -i "s|^MESH_MASTER_KEY=.*|MESH_MASTER_KEY=$(bun src/server/cli/main.ts gen-key)|" .env
sed -i "s|^MESH_BACKUP_KEY=.*|MESH_BACKUP_KEY=$(bun src/server/cli/main.ts gen-key)|" .env
grep -v '^#' .env | grep .     # Kontrolle: keine leeren Pflichtwerte
```

Alle übrigen Werte haben sinnvolle Standards (Beschreibung jeder Variable in `.env.example`). Für
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
werden. (Soll ein eigenes Passwort gesetzt werden: vorher `export MESH_ADMIN_PASSWORD=…`, mind. 12 Zeichen.)

### A7. Probestart

```sh
bun run start
```

Die Logzeile `"msg":"node started"` enthält Version, Knotenkennung und den **Fingerprint**. In einem
zweiten Terminal: `curl -s http://127.0.0.1:4401/healthz` → `{"status":"ok"}`. Danach mit `Strg+C`
beenden.

### A8. Dienst einrichten (systemd)

```sh
exit                                            # zurück zum sudo-Benutzer
sudo cp /opt/osp-data-mesh/deploy/systemd/osp-data-mesh.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now osp-data-mesh
sudo systemctl status osp-data-mesh
```

### A9. Caddy vor den Knoten setzen

`/etc/caddy/Caddyfile` ersetzen durch:

```text
mesh.osp-beispiel.example.de {
	# öffentliche Domain: automatisches HTTPS per ACME; im LAN/Test stattdessen: tls internal
	tls it@osp-beispiel.example.de
	encode zstd gzip
	request_body {
		max_size 60MB
	}
	reverse_proxy 127.0.0.1:4401
}
```

```sh
sudo systemctl reload caddy
```

Der Server lauscht nur auf `127.0.0.1` (`MESH_HOST`); von außen ist ausschließlich Caddy erreichbar.
`MESH_TRUST_PROXY=true` (Standard in `.env.example`) übernimmt die Client-Adresse aus `X-Forwarded-For`.
Weiter mit [Prüfen](#prüfen).

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
Rollen und Datenbank → `migrate` wendet die Migrationen als `mesh_owner` an → `node` startet mit der
Rolle `mesh_app` → `caddy` stellt HTTPS bereit. Nur Caddy veröffentlicht Ports (80, 443); Datenbank
und Knoten liegen im internen Netz.

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
   Das Wurzelzertifikat exportieren und verwenden:
   Docker: `sudo docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./osp-root.crt`;
   nativ: `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`.
   Dann `curl --cacert osp-root.crt https://…/healthz`. Für Browser das Zertifikat als vertrauenswürdige
   Stelle importieren.

2. **Anmeldung:** `https://mesh.osp-beispiel.example.de/` im Browser öffnen, mit der E-Mail-Adresse und
   dem Initialpasswort anmelden. Die Oberfläche verlangt sofort ein neues Passwort (mind. 12 Zeichen).

3. **Systemstatus:** Menü *System* zeigt Version, Datenbank/Migrationen, Audit-Kette (*ok*), Sicherungen
   und den Fingerprint des Knotens. Eine erste Sicherung mit *Sicherung jetzt erstellen* anlegen.

4. **Hilfe:** `https://mesh.osp-beispiel.example.de/hilfe/` zeigt diese Dokumentation.

5. **Audit-Kette auf der Kommandozeile:** nativ
   `bun --env-file=.env run cli verify-audit`, Docker `sudo docker compose run --rm cli verify-audit`
   → `Audit-Kette ok`.

6. **Weitere Benutzer** unter *Benutzer* anlegen (Rollen siehe [Rollen und Rechte](rollen.md)). Die
   Administration hat bewusst keinen Zugriff auf Fachdaten; Datenverantwortliche erhalten die Rolle
   `data_steward`.

## Vertrauen mit einem Partnerknoten herstellen

Knoten tauschen erst Daten aus, wenn **beide Seiten** einander ausdrücklich vertrauen. Der Abgleich des
Fingerprints über einen zweiten Kanal schützt davor, eine gefälschte Knotenkarte aufzunehmen.

1. **Eigene Knotenkarte exportieren** (Rolle `admin`): Oberfläche *Partner › Eigene Knotenkarte*
   herunterladen, oder `bun --env-file=.env run cli node-card` bzw.
   `sudo docker compose run --rm cli node-card`. Die Karte enthält Kennung, Name, Adresse, öffentlichen
   Schlüssel und Fingerprint – keine Geheimnisse.
2. **Karte an den Partner senden** (z. B. per E-Mail) und die Karte des Partners empfangen.
3. **Partnerkarte aufnehmen:** *Partner › Partner hinzufügen*, JSON der Karte einfügen. Der Partner erhält
   den Status *ausstehend* (`pending`).
4. **Fingerprint abgleichen – telefonisch oder persönlich**, nicht über denselben Kanal wie die Karte:
   Die Partner-Administration liest ihren Fingerprint (*System* bzw. Logzeile `node started`) vor; er muss
   Zeichen für Zeichen mit dem angezeigten übereinstimmen.
5. **Vertrauen bestätigen:** *Partner › Vertrauen bestätigen*, abgeglichenen Fingerprint eingeben →
   Status *vertrauenswürdig* (`trusted`).
6. Dasselbe führt der Partner mit Ihrer Karte durch (Schritte 3–5 auf seiner Seite).
7. **Verbindung prüfen:** *Partner › Verbindung prüfen* (signierter `ping`). Erwartet: Erfolg mit Name und
   Uhrzeit des Partners. Fehler `peer_untrusted`/`peer_rejected` bedeuten, dass die Gegenseite noch nicht
   vertraut; `peer_unreachable` deutet auf DNS, Firewall oder TLS hin.

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
(`osp_session`) bei jeder Anfrage auch an Superset – Superset (oder wer es kompromittiert) erhielte die
Sitzungen aller angemeldeten Personen. Das Cookie gilt ohne `Domain`-Attribut nur für genau den Namen des
Knotens und wird an `bi.<knoten>` nicht gesendet. Superset deshalb nie unter dem Namen des Knotens (auch
nicht mit anderem Port) betreiben.

Einzelheiten, Vertrag der BI-Views und manuelle Schritte: [BI-Anbindung](bi.md) und
`deploy/superset/README.md`.
**Nicht lokal verifiziert.**

## Lokale Demo und Tests (Entwicklungsrechner)

Für eine Vorführung ohne Server: `bun install` und `bun run demo` starten drei Knoten
(`osp-nord`, `osp-mitte`, `osp-sued`, Ports 4401–4403) mit eigenen PostgreSQL-Clustern unter `.local/demo/`
und ein simuliertes Messsystem (Port 4410), spielen das Szenario durch und stoppen danach alles. Mit
`bun run demo -- --keep-running` bleiben die Knoten für die Oberfläche erreichbar; beenden mit
`bun run demo:stop`. `bun test` führt die automatisierten Tests aus (eigener Testcluster
auf Port 55434). Voraussetzung: PostgreSQL-18-Programme (`initdb`, `pg_ctl`, `psql`) lokal installiert.
