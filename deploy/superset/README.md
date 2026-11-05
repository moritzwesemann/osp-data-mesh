# Apache Superset für OSP-Data-Mesh (optional)

> **Ohne Docker verifiziert** (November 2026): Superset 6.1.0 aus PyPI in einer virtuellen Umgebung
> (Python 3.11, Abhängigkeiten auf die Stände von `requirements/base.txt` des Tags 6.1.0 festgelegt, aus
> denen auch das Abbild gebaut ist) mit genau dieser `superset_config.py` und diesem
> `bootstrap_superset.py` gegen die BI-Views der Demo (`osp-nord`, als `mesh_bi`): Verbindung, drei
> Datasets, 13 Diagramme (jede Abfrage liefert Zeilen) und drei Dashboards im Browser ohne Fehler,
> wiederholter Lauf ohne Duplikate. Bildschirmfotos: `docs/screenshots/17-…19-superset-*.png`. Ablauf siehe
> [Lokal ohne Docker prüfen](#lokal-ohne-docker-prüfen).
> **Mit Docker verifiziert** (November 2026, Docker 29 in Colima, arm64): Bau des Abbilds, Compose-Profil
> `bi` mit `superset-init` → `superset` (*healthy*) → `superset-bootstrap` (Exit 0, zweiter Lauf ohne
> Duplikate) gegen einen Knoten, dessen Daten aus den Demo-Vorlagen importiert wurden; alle 13 Diagramme
> liefern Daten (`--verify`, siehe unten), auch über Caddy/HTTPS (`https://bi.<CADDY_DOMAIN>/`, Zertifikat
> geprüft); Sitzungs-Cookie `Secure; HttpOnly; SameSite=Lax`; Content-Security-Policy ohne Dritte.
> Superset spricht die Datenbank im internen Netz `backend` ohne TLS an.

Superset dient als Referenz für die BI-Anforderung (B1/B2): Es liest **ausschließlich als Datenbankrolle
`mesh_bi`** die Views im Schema `bi` (nur lesend, nur freigegebene Daten) und bringt drei
Referenz-Dashboards mit. Keine Beispieldaten von Superset.

## Dateien

| Datei | Zweck |
|---|---|
| `Dockerfile` | `apache/superset:6.1.0` (schlankes Abbild) + PostgreSQL-Treiber `psycopg2-binary` |
| `superset_config.py` | `SECRET_KEY` aus `SUPERSET_SECRET_KEY` (Pflicht, ≥ 32 Zeichen), Metadaten in SQLite im Volume `superset_home`, Betrieb hinter Caddy, sichere Cookies, keine öffentliche Rolle |
| `bootstrap_superset.py` | legt über die Superset-REST-API idempotent Datenbankverbindung, Datasets, Diagramme und Dashboards an (nur Python-Standardbibliothek) |

## Start (Docker Compose, Profil `bi`)

In `deploy/.env` setzen:

```sh
SUPERSET_SECRET_KEY=<openssl rand -base64 42>
SUPERSET_ADMIN_USER=admin
SUPERSET_ADMIN_EMAIL=bi@osp-beispiel.example.de
SUPERSET_ADMIN_PASSWORD=<openssl rand -hex 16>
```

```sh
cd deploy
docker compose --profile bi up -d --build
docker compose --profile bi logs -f superset-bootstrap
```

Ablauf: `superset-init` (Metadaten-Datenbank anlegen/aktualisieren, Administrationskonto, Rollen) →
`superset` (Webserver, Port 8088 nur intern) → `superset-bootstrap` (Einrichtung über die REST-API,
wartet auf `/health`). Erreichbar über Caddy unter einem **eigenen Hostnamen**: `https://<MESH_BI_DOMAIN>/`,
Standard `bi.<CADDY_DOMAIN>` (in `deploy/.env` änderbar; DNS-Eintrag auf denselben Server nötig).

**Warum ein eigener Hostname?** Cookies sind nicht an Ports gebunden (RFC 6265, Abschnitt 8.5): Liefe
Superset unter dem Namen des Knotens mit anderem Port, schickte der Browser das Sitzungs-Cookie des Knotens
(`osp_session`) bei jeder Anfrage auch an Superset – Superset (oder wer es kompromittiert) erhielte die
Sitzungen aller angemeldeten Personen. Das Cookie gilt ohne `Domain`-Attribut nur für genau den Namen des
Knotens und wird an `<MESH_BI_DOMAIN>` nicht gesendet.

Die Einrichtung kann jederzeit wiederholt werden (z. B. nachdem die BI-Freigaben angelegt wurden oder das
Passwort von `mesh_bi` geändert wurde):

```sh
docker compose --profile bi run --rm superset-bootstrap
```

Plan ohne Superset anzeigen: `python3 bootstrap_superset.py --print-plan`.

Prüfen, ob jedes Diagramm der drei Dashboards Daten liefert (Abfrage wie im Browser über
`POST /api/v1/chart/data`; Exit-Code 1, wenn ein Diagramm fehlt oder keine Zeilen liefert):

```sh
docker compose --profile bi run --rm --no-deps superset-bootstrap python /app/osp/bootstrap_superset.py --verify
```

Über Caddy/HTTPS von einem anderen Rechner: `SUPERSET_URL=https://bi.<CADDY_DOMAIN>`,
`SUPERSET_ADMIN_PASSWORD=…` und bei `CADDY_TLS=internal` `SSL_CERT_FILE=osp-root.crt` setzen, dann
`python3 bootstrap_superset.py --verify`.

**Datenschutz:** `superset_config.py` setzt eine Content-Security-Policy ohne Dritte. Die Standardrichtlinie
von Superset 6.1 erlaubt den Telemetrie-Dienst Scarf; das veröffentlichte Abbild bindet auf jeder Seite ein
Zählpixel (`apachesuperset.gateway.scarf.sh`) ein, das der Browser sonst mit der IP-Adresse der
angemeldeten Person abriefe. Ebenso gesperrt sind Karten-Kacheln (Mapbox, OpenStreetMap, Carto) und
Schriften-CDNs; Kartendiagramme funktionieren daher nicht (die Referenz-Dashboards nutzen keine).

## Lokal ohne Docker prüfen

Gegen die Demo, ohne globale Installation: alles liegt im (gitignorierten) Verzeichnis `.local/superset/`
(virtuelle Umgebung etwa 0,7 GB). Benötigt Python 3.10 oder neuer (geprüft mit 3.11); vom
Projektverzeichnis aus:

```sh
bun run demo -- --keep-running            # osp-nord mit den Views bi.* auf 127.0.0.1:55431

python3.11 -m venv .local/superset/venv
# Abhängigkeitsstände wie im Abbild (ohne die Zeile "-e ./superset-core" der Quellen)
curl -sfL https://raw.githubusercontent.com/apache/superset/6.1.0/requirements/base.txt \
  | grep -v '^-e' > .local/superset/constraints-6.1.0.txt
.local/superset/venv/bin/pip install -c .local/superset/constraints-6.1.0.txt \
  apache-superset==6.1.0 apache-superset-core==0.1.0rc3 psycopg2-binary==2.9.13

export SUPERSET_CONFIG_PATH="$PWD/deploy/superset/superset_config.py"
export PYTHONDONTWRITEBYTECODE=1                         # kein __pycache__ in deploy/superset/
export SUPERSET_HOME="$PWD/.local/superset/home"
export SUPERSET_METADATA_DB_URI="sqlite:///$PWD/.local/superset/superset.db?check_same_thread=false"
export SUPERSET_SECRET_KEY="$(openssl rand -base64 42)"   # für spätere Starts aufbewahren
export SUPERSET_ADMIN_USER=admin SUPERSET_ADMIN_PASSWORD="$(openssl rand -hex 16)"
export SUPERSET_URL=http://127.0.0.1:4411
# Passwort: MESH_DB_BI_PASSWORD aus .local/demo/osp-nord/owner.env; der Demo-Cluster hat kein TLS
export SUPERSET_MESH_DB_URI="postgresql+psycopg2://mesh_bi:<passwort>@127.0.0.1:55431/mesh?sslmode=disable"

S=.local/superset/venv/bin
$S/superset db upgrade
$S/superset fab create-admin --username admin --firstname Superset --lastname Admin \
  --email admin@localhost --password "$SUPERSET_ADMIN_PASSWORD"
$S/superset init
$S/gunicorn --bind 127.0.0.1:4411 --workers 1 --worker-class gthread --threads 4 --timeout 120 \
  "superset.app:create_app()" &
$S/python deploy/superset/bootstrap_superset.py
```

`apache-superset-core==0.1.0rc3` ist der Stand, den der Tag 6.1.0 mitbringt. Anmelden im Browser unter
`http://127.0.0.1:4411/`: Das Sitzungs-Cookie trägt `Secure` (`SESSION_COOKIE_SECURE`); Chromium
akzeptiert es für `127.0.0.1` auch ohne HTTPS (geprüft), andere Browser womöglich nicht. Beenden: den
gunicorn-Prozess stoppen, dann `bun run demo:stop`.

## Vertrag: Views im Schema `bi`

Die Dashboards erwarten die folgenden Views. Eine View heißt wie das **Kürzel (slug) des Datenprodukts**
und entsteht, sobald eine gültige Freigabe an die Empfängerrolle `bi` besteht; ihre Spalten sind die
freigegebenen Produktspalten (`key`). Die Demo legt diese Produkte und Freigaben an.

| View | Spalte | Typ (Feldtyp → PostgreSQL) | Bedeutung |
|---|---|---|---|
| `bi.kader_uebersicht` | `sport` | `string` → `text` | Sportart |
| | `squad_status` | `string` → `text` | Kaderstatus (`OK`, `PK`, `EK`, `NK1`, `NK2`, `LK`, `none`) |
| | `birth_year` | `integer` → `bigint` | Geburtsjahr (Quelle `athlete.birth_year`) |
| | `sex` | `string` → `text` | Geschlecht (`f`, `m`, `d`) |
| `bi.sprungkraft` | `sport` | `text` | Sportart |
| | `squad_status` | `text` | Kaderstatus |
| | `test_type` | `string`/`enum` → `text` | Sprungform; die Dashboards filtern auf **`CMJ`** (Countermovement Jump) |
| | `jump_height_cm` | `number` → `double precision` | Sprunghöhe in cm |
| | `peak_power_w` | `number` → `double precision` | Maximalleistung in W |
| | `measured_at` | `date` oder `datetime` → `date`/`timestamptz` | Messdatum (Zeitachse, Monatsraster) |
| `bi.leistungsdiagnostik` | `sport` | `text` | Sportart |
| | `squad_status` | `text` | Kaderstatus |
| | `test_date` | `date` → `date` | Testdatum (Zeitachse, Quartalsraster) |
| | `protocol` | `string`/`enum` → `text` | Testprotokoll (z. B. Stufentest Rad/Laufband) |
| | `vo2max` | `number` → `double precision` | VO2max in ml/min/kg |
| | `lactate_threshold_power` | `number` → `double precision` | Leistung an der Laktatschwelle in W |
| | `max_heart_rate` | `integer` → `bigint` | maximale Herzfrequenz in 1/min |

Fehlt eine View, überspringt das Skript die zugehörigen Diagramme mit einer Warnung; das Dashboard wird
trotzdem angelegt und beim nächsten Lauf vervollständigt.

## Referenz-Dashboards

| Dashboard (Slug) | Diagramme |
|---|---|
| **Kaderübersicht** (`osp-kaderuebersicht`) | Personen gesamt (Kennzahl); Personen nach Sportart und Kaderstatus (gestapelte Balken); Anteile Kaderstatus (Kreis); Jahrgänge nach Geschlecht (Balken); Sportart × Kaderstatus (Pivot-Tabelle) |
| **Sprungkraft-Entwicklung** (`osp-sprungkraft`) | Ø CMJ-Sprunghöhe je Sportart (Linie, Monat); Ø Maximalleistung CMJ je Sportart (Linie, Monat); Ø CMJ-Sprunghöhe nach Kaderstatus (Balken); Anzahl Messungen (Kennzahl) |
| **Leistungsdiagnostik** (`osp-leistungsdiagnostik`) | VO2max-Verteilung je Sportart (Histogramm); Ø Leistung an der Laktatschwelle je Sportart (Balken); Ø VO2max im Zeitverlauf (Linie, Quartal); Kennwerte je Sportart (Tabelle) |

Verwendete Superset-Diagrammtypen: `big_number_total`, `echarts_timeseries_bar`, `pie`,
`pivot_table_v2`, `echarts_timeseries_line`, `histogram_v2`, `table`.

**Abfragekontext:** Das Skript legt die Diagramme (wie Superset seine Beispieldiagramme) nur mit
Formulardaten an. Dashboards berechnen die Abfrage daraus im Browser und sind nicht betroffen.
`GET /api/v1/chart/<id>/data/` sowie Berichte und Alerts mit CSV- oder Textinhalt brauchen dagegen einen
gespeicherten Abfragekontext (sonst „Chart has no query context saved“). Superset erzeugt und speichert
ihn, sobald das Diagramm einmal in *Explore* geöffnet wird. Ändert ein späterer Lauf des Skripts die
Definition eines Diagramms, verwirft das Skript den gespeicherten Kontext, damit keine veraltete Abfrage
übrig bleibt; danach das Diagramm erneut einmal in Explore öffnen.

## Manuelle Einrichtung (falls das Skript scheitert)

1. Als Administration in Superset anmelden.
2. *Settings › Database Connections › + Database › PostgreSQL*, SQLAlchemy-URI
   `postgresql+psycopg2://mesh_bi:<passwort>@db:5432/mesh`, Anzeigename `OSP-Data-Mesh (BI)`;
   unter *Advanced › SQL Lab*: DML nicht erlauben; *Advanced › Other › Engine Parameters*:
   `{"connect_args": {"options": "-csearch_path=bi"}}`.
3. *Datasets › + Dataset*: Datenbank `OSP-Data-Mesh (BI)`, Schema `bi`, Tabellen `kader_uebersicht`,
   `sprungkraft`, `leistungsdiagnostik`.
4. Je Dashboard die Diagramme aus der Tabelle oben anlegen (*Charts › + Chart*; Metrik `COUNT(*)` bzw.
   `AVG(<spalte>)`; Zeitachse `measured_at`/`test_date`; Filter `test_type = CMJ` bei Sprungkraft) und
   einem neuen Dashboard mit dem angegebenen Namen hinzufügen.
5. Rollen: Für Lesende eine Rolle auf Basis von *Gamma* mit Zugriff nur auf diese Datenbank/Datasets
   anlegen (Dashboard-Zugriff über Rollen ist mit `DASHBOARD_RBAC` aktiviert).

## Sicherheitshinweise

- Eigener Hostname (`MESH_BI_DOMAIN`), nie der Name des Knotens mit anderem Port: sonst erhielte Superset
  das Sitzungs-Cookie des Knotens (siehe oben und `deploy/Caddyfile`).
- Superset sieht nur, was `mesh_bi` sieht: Views im Schema `bi`, nur lesend, Abfragezeit ≤ 60 s.
- Die Verbindungsdaten speichert Superset mit `SUPERSET_SECRET_KEY` verschlüsselt in seiner
  Metadaten-Datenbank (Volume `superset_home`); Schlüssel in der Passwortverwaltung ablegen.
- Superset-Konten sind unabhängig von den Konten des Knotens; Zugriffe in Superset protokolliert Superset
  selbst (Action Log), nicht das Audit-Log des Knotens. Auf der Datenbankseite sind sie als Abfragen der
  Rolle `mesh_bi` sichtbar.
- Für größere Installationen eine eigene PostgreSQL-Datenbank für die Superset-Metadaten verwenden
  (`SUPERSET_METADATA_DB_URI`, gelesen von `superset_config.py`), nicht die Knotendatenbank. Die Variable
  wird von `docker-compose.yml` nicht durchgereicht: dafür im `environment` des Dienstes `superset-init`
  (Anker `&superset-env`, gilt damit auch für `superset` und `superset-bootstrap`) die Zeile
  `SUPERSET_METADATA_DB_URI: postgresql+psycopg2://<benutzer>:<passwort>@<host>:5432/<datenbank>`
  ergänzen. Nicht leer durchreichen (etwa als `${SUPERSET_METADATA_DB_URI:-}`): ein leerer Wert ersetzte
  die SQLite-Vorgabe in `superset_config.py`.
