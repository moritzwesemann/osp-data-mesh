# BI-Anbindung

Freigegebene Datenprodukte lassen sich ohne proprietäre Zugriffsschicht mit gängigen Werkzeugen
auswerten:

1. **Direkt über PostgreSQL**: nur lesende Rolle `mesh_bi`, ausschließlich Views im Schema `bi`
   (Excel, Power BI, Tableau, SAP Analytics Cloud, Python, R, Apache Superset).
2. **Über die REST-API**: CSV, JSON oder XML per HTTPS mit API-Token, siehe [REST-API](api.md).

Beide Wege liefern nur Daten aus Freigaben – die BI-Schnittstelle ist ein gewöhnlicher Empfänger, für
den alle [Freigaberegeln](freigaberegeln.md) gelten.

## Wie BI-Views entstehen

1. Datenverantwortliche erteilen eine Freigabe an die **Empfängerrolle `bi`** (genau ein Zweck, z. B.
   `reporting`; Spalten-, Zeilen- und Zeitbeschränkungen wie bei jeder Freigabe).
2. Der Server holt die freigegebenen Zeilen über den Policy Enforcement Point, schreibt sie in eine
   interne Tabelle (`bi_data.r_…`) und legt die View **`bi.<produktkürzel>`** mit den freigegebenen
   Spalten und passenden Datentypen an. Je Produkt gibt es höchstens eine gültige oder geplante
   BI-Freigabe (sonst `conflict`, Grund `bi_release_exists`); nach Widerruf oder Ablauf kann eine neue
   BI-Freigabe denselben View-Namen wieder belegen.
3. Aktualisierung: kurz nach jeder Datenänderung, alle 10 Minuten und auf Knopfdruck (*System ›
   BI-Schnittstelle › Views aktualisieren*). Übersicht der Views mit Zeilenzahl und Status unter *System ›
   BI-Schnittstelle* (Oberfläche: Rolle `admin`; über die REST-API `bi.views`/`bi.refresh` auch
   `data_steward`).
4. **Widerruf** und **Stilllegung** des Produkts entfernen die View sofort; **Ablauf** der Freigabe sowie
   eine **Produkt- oder Datensatzänderung** (neue Produktversion, auch nach Neueinstufung des Datensatzes)
   wirken sofort, weil jede View bei jeder Abfrage in SQL prüft, ob die Freigabe noch gilt und das Produkt
   aktiv und unverändert ist; die nächste Aktualisierung entfernt die View dann. **Einwilligungswiderruf
   und Löschung** entfernen die Zeilen der Person in derselben Transaktion (über die verborgene
   Personenspalte `_subject` der internen Tabelle, die `mesh_bi` nicht sieht). Eine Liefersperre sorgt
   dafür, dass eine gleichzeitig laufende Aktualisierung die Person nicht aus einem älteren Stand
   zurückbringt.

`mesh_bi` kann weder die internen Tabellen (`bi_data`) noch Fachtabellen (`public`) lesen; jede Sitzung
ist nur lesend, Abfragen werden nach 60 Sekunden abgebrochen.

## Verbindungsdaten

| Angabe | Wert |
|---|---|
| Server | Hostname bzw. IP-Adresse, unter der **BI-Arbeitsplätze** die Datenbank erreichen (nicht unbedingt die Adresse, die der Knoten selbst verwendet) |
| Port | Port des PostgreSQL-Clusters dieses Knotens, wie er von den BI-Arbeitsplätzen aus erreichbar ist: Standard `5432`; abweichend, wenn der Cluster einen anderen Port hat (eigener Cluster je Knoten, z. B. `5433`) oder über einen SSH-Tunnel ein lokaler Port verwendet wird |
| Datenbank | `mesh` (bzw. der bei der Installation gewählte Name) |
| Benutzer | `mesh_bi` |
| Passwort | `MESH_DB_BI_PASSWORD` (bei der IT-Administration) |
| Schema | `bi` |
| Verschlüsselung | bei direktem Zugriff über das Netz **TLS** (`sslmode=require` bzw. „SSL erforderlich“; besser `verify-full` mit dem Zertifikat der ausstellenden Stelle). Über SSH-Tunnel oder VPN übernimmt der Tunnel die Verschlüsselung; `sslmode=require` funktioniert dann nur, wenn PostgreSQL TLS anbietet (`ssl = on`), sonst `sslmode=prefer` verwenden |

Die Oberfläche zeigt unter *System › BI-Schnittstelle › Verbindungsdaten* immer Server, Port, Datenbank
und Schema an. Sind `MESH_BI_DB_HOST`, `MESH_BI_DB_PORT` und `MESH_BI_DB_NAME` (in `.env` bzw.
`deploy/.env`) **nicht** gesetzt, stammen die Werte aus der Verbindung des Knotens selbst (`MESH_DB_URL`) –
nativ meist `127.0.0.1:5432`, mit Docker `db:5432`. Diese Adressen sind von BI-Arbeitsplätzen aus **nicht**
erreichbar. Deshalb nach der Freischaltung (unten) die drei Variablen auf die Werte setzen, die
BI-Werkzeuge verwenden sollen, und den Knoten neu starten; sie dienen nur der Anzeige.

Vorhandene Views anzeigen:

```sql
select table_name from information_schema.views where table_schema = 'bi' order by 1;
```

## Datenbank für BI-Werkzeuge erreichbar machen

Standardmäßig ist PostgreSQL **nicht** von außen erreichbar (Trennung interner und externer Dienste).
Für den direkten BI-Zugang bewusst und nur im internen Netz des OSP freischalten, immer mit TLS und nur
für `mesh_bi`. Alternativ ohne Freischaltung: SSH-Tunnel oder VPN zum Server, oder die REST-API.

**Nativ (allgemein, jede Linux-Distribution):**

1. Speicherorte der Konfiguration ermitteln (als Superuser):
   `sudo -u postgres psql -p 5432 -Atc 'show config_file' -c 'show hba_file' -c 'show data_directory'`
   (`-p` = Port des Clusters dieses Knotens; anpassen). Debian/Ubuntu: `/etc/postgresql/18/<cluster>/`
   (Standard-Cluster `main`); andere Distributionen meist im Datenverzeichnis.
2. **TLS einrichten:** Zertifikat (mit dem Hostnamen, den die BI-Werkzeuge verwenden, als Subject
   Alternative Name; möglichst von der internen CA des OSP) und privaten Schlüssel auf den Server
   kopieren, z. B. nach `/etc/postgresql/tls/server.crt` und `server.key`. Der Schlüssel muss dem
   Betriebssystembenutzer gehören, unter dem PostgreSQL läuft (meist `postgres`), mit Rechten `0600`:
   `sudo chown postgres:postgres /etc/postgresql/tls/server.key && sudo chmod 600 /etc/postgresql/tls/server.key`.
   In `postgresql.conf`: `ssl = on`, `ssl_cert_file = '/etc/postgresql/tls/server.crt'`,
   `ssl_key_file = '/etc/postgresql/tls/server.key'`, `ssl_min_protocol_version = 'TLSv1.2'`.
   (Debian/Ubuntu aktivieren `ssl = on` bereits mit einem selbstsignierten „snakeoil“-Zertifikat; dieses
   durch ein Zertifikat für den Hostnamen ersetzen, da Power BI und `verify-full` ihm nicht vertrauen.)
3. In `postgresql.conf` zusätzlich `listen_addresses = 'localhost,10.0.5.10'` (anpassen: interne Adresse
   des Servers). Der Port ist der des Clusters (`port`, Standard `5432`).
4. `pg_hba.conf` ergänzen (anpassen: Netz der BI-Arbeitsplätze, Datenbankname), **vor** allgemeineren
   `host`-Zeilen:
   `hostssl  mesh  mesh_bi  10.20.0.0/16  scram-sha-256`
5. PostgreSQL neu starten (Debian/Ubuntu: `sudo systemctl restart postgresql@18-main`, andere:
   `sudo systemctl restart postgresql`); Firewall: Port des Clusters nur aus dem BI-Netz.
6. Prüfen von einem BI-Arbeitsplatz:
   `psql "host=<server> port=5432 dbname=mesh user=mesh_bi sslmode=require" -c 'select 1'`
   (Port anpassen).
7. In `.env` `MESH_BI_DB_HOST`, `MESH_BI_DB_PORT` und `MESH_BI_DB_NAME` setzen und den Knoten neu starten,
   damit die Oberfläche die richtigen Verbindungsdaten anzeigt.

**Docker Compose** (mit Docker 29 geprüft): Zertifikat und Schlüssel nach `deploy/postgres/tls/`
(`server.crt`, `server.key`; Schlüssel `chown 999:999`, `chmod 600` – UID 999 ist der Benutzer `postgres`
im Abbild; das Verzeichnis ist in `.gitignore` eingetragen). In `deploy/.env` setzen:

```sh
BI_DB_BIND=10.0.5.10          # anpassen: interne IP-Adresse des Servers, nie 0.0.0.0 im Internet
BI_DB_PORT=5432               # Port auf dem Server (im Container bleibt es 5432)
COMPOSE_FILE=docker-compose.yml:docker-compose.bi-db.yml
MESH_BI_DB_HOST=bi-db.osp-beispiel.example.de   # Anzeige in der Oberfläche: Name aus dem Zertifikat
MESH_BI_DB_PORT=5432
MESH_BI_DB_NAME=mesh
```

dann `sudo docker compose up -d` und `sudo ./verify-deployment.sh` (Abschnitt 7). `COMPOSE_FILE` sorgt
dafür, dass die Zusatzdatei bei **jedem** späteren `docker compose`-Aufruf in diesem Verzeichnis gilt
(Updates, Wiederherstellung). Ein einmaliges `docker compose -f docker-compose.yml -f
docker-compose.bi-db.yml up -d` reicht nicht: Das nächste `docker compose up -d` ohne `-f` setzte die
Datenbank wieder ohne TLS und ohne BI-Port auf.

Die Zusatzdatei schaltet TLS ein, veröffentlicht den Port nur auf dieser Adresse und setzt eine
`pg_hba.conf`, die von außen ausschließlich `mesh_bi` mit TLS zulässt (`deploy/postgres/pg_hba.bi.conf`).
Prüfen von einem BI-Arbeitsplatz mit dem Zertifikat der ausstellenden Stelle:
`psql "host=bi-db.osp-beispiel.example.de port=5432 dbname=mesh user=mesh_bi sslmode=verify-full sslrootcert=ca.crt" -c 'select 1'`.

**Netztrennung:** Die Zusatzdatei legt feste Subnetze an (`backend` 172.31.251.0/24, `bi_access`
172.31.250.0/24). `pg_hba.bi.conf` erlaubt alle Rollen nur aus `backend`; aus `bi_access` – dort können
Verbindungen über den veröffentlichten Port mit der Gateway-Adresse ankommen – und von überall sonst nur
`mesh_bi` mit TLS, jede andere Rolle wird ausdrücklich abgelehnt (`reject`). Wer die Subnetze ändert, muss
beide Dateien gleich ändern. Das Netz `bi_access` ist ohne NAT eingerichtet: Die Datenbank kann darüber
keine Verbindungen ins Internet aufbauen (ein veröffentlichter Port braucht ein nicht internes Netz).
Zusätzlich die veröffentlichte Adresse per Firewall auf das Netz der BI-Arbeitsplätze beschränken.
Geprüft mit Docker 29 (`verify-deployment.sh`, Abschnitt 7, und von Hand): `mesh_bi` mit TLS
(`verify-full` gegen eine Test-CA) angemeldet; `mesh_bi` ohne TLS, `mesh_app`, `mesh_owner` und
`postgres` abgelehnt („pg_hba.conf rejects connection“) – sowohl vom Server selbst als auch über die
Portweiterleitung aus einem anderen Netz; die Datenbank erreicht auch mit der Zusatzdatei das Internet nicht.

## Werkzeuge

### Excel (Power Query)

- *Daten › Daten abrufen › Aus Datenbank › Aus PostgreSQL-Datenbank*: Server `<host>:<port>` (Port aus
  den Verbindungsdaten, Standard `5432`), Datenbank `mesh`, Anmeldung *Datenbank* mit `mesh_bi`. Excel benötigt dafür den Npgsql-Datenanbieter
  (je nach Excel-Version separat zu installieren).
- Alternative **ODBC**: psqlODBC-Treiber installieren, DSN mit `sslmode=require` anlegen, dann
  *Daten abrufen › Aus anderen Quellen › Aus ODBC*.
- Alternative ohne Treiber: REST-Abruf als CSV ([REST-API › Excel und Power BI](api.md#excel-und-power-bi-über-rest)); die fertige Abfrage (Power Query M) mit der richtigen Adresse zeigt die Oberfläche unter *Meine Daten › Zugriff aus Excel, Power BI oder Python* (Anmeldeart „Anonym“, das Token steht im Header).

### Power BI

*Daten abrufen › PostgreSQL-Datenbank*: Server `<host>:<port>` (Standard-Port `5432`), Datenbank `mesh`, Modus *Import* (oder
*DirectQuery*), Anmeldung *Datenbank* mit `mesh_bi`. Power BI verlangt standardmäßig eine verschlüsselte
Verbindung mit vertrauenswürdigem Zertifikat. Für geplante Aktualisierungen im Power-BI-Dienst ist ein
lokales Datengateway im OSP-Netz nötig.

### Tableau

*Verbinden › PostgreSQL*: Server, Port (Standard `5432`), Datenbank `mesh`, Benutzername `mesh_bi`, Passwort,
*SSL erforderlich* aktivieren; Schema `bi` wählen.

### SAP Analytics Cloud

**Nicht verifiziert.** SAP Analytics Cloud bindet PostgreSQL nicht direkt als Live-Verbindung an. Möglich
sind Import-Verbindungen über den *SAP Analytics Cloud Agent* (mit SAP Cloud Connector) und den
PostgreSQL-JDBC-Treiber als „SQL-Datenbank“, oder der Import von CSV-Dateien aus der REST-API. Die
genaue Konfiguration hängt von der SAP-Landschaft des Betreibers ab.

### Python

```python
import pandas as pd
import psycopg                       # pip install "psycopg[binary]" pandas

with psycopg.connect(
    host="db.osp-beispiel.intern", port=5432, dbname="mesh",   # anpassen: Verbindungsdaten
    user="mesh_bi", password="…", sslmode="require",
) as conn:
    df = pd.read_sql("select * from bi.sprungkraft", conn)
print(df.groupby("sport")["jump_height_cm"].describe())
```

(pandas empfiehlt für `read_sql` SQLAlchemy; mit `create_engine("postgresql+psycopg://mesh_bi:…@host:5432/mesh?sslmode=require")`
entfällt der Hinweis.)

**Vollständiges, gegen einen Knoten geprüftes Beispiel:** `deploy/bi/examples/python_bi_example.py` liest
(a) eine View im Schema `bi` als `mesh_bi` und (b) ein freigegebenes Produkt als CSV über die REST-API mit
API-Token. Verbindungsdaten, Passwort und Token kommen aus Umgebungsvariablen (Kopf der Datei):

```sh
python3 -m venv .venv && .venv/bin/pip install pandas "psycopg[binary]" requests
MESH_BI_HOST=db.osp-beispiel.intern MESH_BI_PASSWORD='…' \
OSP_BASE_URL=https://mesh.osp-beispiel.example.de OSP_TOKEN='osp_…' \
  .venv/bin/python deploy/bi/examples/python_bi_example.py          # db | api | beides
```

### R

```r
con <- DBI::dbConnect(RPostgres::Postgres(), host = "db.osp-beispiel.intern", port = 5432, dbname = "mesh",
                      user = "mesh_bi", password = Sys.getenv("MESH_BI_PASSWORD"), sslmode = "require")
df <- DBI::dbGetQuery(con, "select * from bi.leistungsdiagnostik")
```

(Nicht geprüft: R ist auf der Entwicklungsmaschine nicht installiert.)

### DuckDB (oder ein anderer SQL-Client)

DuckDB liest die BI-Views über das PostgreSQL-Protokoll und die REST-CSV über HTTPS – praktisch, um beide
Wege ohne Treiberinstallation zu prüfen oder Daten lokal weiterzuverarbeiten:

```sql
INSTALL postgres; LOAD postgres; INSTALL httpfs; LOAD httpfs;
ATTACH 'host=db.osp-beispiel.intern port=5432 dbname=mesh user=mesh_bi password=… sslmode=require'
  AS mesh (TYPE postgres, READ_ONLY, SCHEMA 'bi');
SELECT sport, count(*) AS n, round(avg(jump_height_cm), 1) AS cmj FROM mesh.bi.sprungkraft GROUP BY sport;

-- REST-API: Token als HTTP-Header (Secret gilt nur für diese Sitzung)
CREATE SECRET osp (TYPE http, EXTRA_HTTP_HEADERS MAP {'Authorization': 'Bearer osp_…'});
SELECT * FROM read_csv('https://mesh.osp-beispiel.example.de/api/v1/access/<releaseId>/data?purpose=<zweck>&format=csv');
```

Mit `psql` als CSV exportieren:
`psql "host=… port=5432 dbname=mesh user=mesh_bi sslmode=require" -c "\copy (select * from bi.sprungkraft) to 'sprungkraft.csv' csv header"`.

## Welche Werkzeuge geprüft sind

Stand 05.11.2026, gegen den Demo-Knoten `osp-nord` (PostgreSQL 18.6, Rolle `mesh_bi`, drei BI-Views;
REST-API mit dem API-Token einer Person mit Rolle `analyst`). Der lokale Demo-Cluster bietet kein TLS
(`ssl = off`), daher dort `sslmode=prefer`; eine TLS-Verbindung zur Datenbank ist **nicht** geprüft.

| Werkzeug | Weg | Ergebnis | Wie geprüft |
|---|---|---|---|
| Python 3.11 (pandas 3.1.1, psycopg 3.3.8, requests 2.34.2) | Datenbank und REST-API | **verifiziert** | `deploy/bi/examples/python_bi_example.py` in einer projektlokalen virtuellen Umgebung: Sitzung nur lesend (`default_transaction_read_only = on`), Views `kader_uebersicht`, `leistungsdiagnostik`, `sprungkraft` gelesen (40 bzw. 120 Zeilen, Datentypen korrekt, z. B. `measured_at` als Zeitstempel mit Zeitzone); REST: Freigaben des Tokens gelistet, CSV (UTF-8 mit BOM, 1 109 Bytes) als DataFrame mit 40 Zeilen, Umlaute korrekt. Fehlerfälle: anderer Zweck → 403 `access_denied`/`purpose_not_allowed`, ungültiges Token → 401 `unauthenticated` |
| Python mit SQLAlchemy 2.1 | Datenbank | **verifiziert** | `pd.read_sql` mit `create_engine("postgresql+psycopg://…")`: 120 Zeilen, ohne Warnung (das kurze Beispiel oben mit psycopg-Verbindung funktioniert ebenfalls, pandas warnt dann) |
| DuckDB 2.0.0 | Datenbank und REST-API | **verifiziert** | Befehle oben: `ATTACH … (TYPE postgres, READ_ONLY)`, Abfrage über `mesh.bi.sprungkraft`; `read_csv` der REST-Adresse mit HTTP-Secret (Bearer-Token) |
| psql 18 | Datenbank | **verifiziert** | Views gelistet, `\copy … csv header` (40 Zeilen). Schreibversuch abgewiesen: `cannot execute CREATE TABLE in a read-only transaction`, mit `begin read write` `permission denied for schema bi`; Fachtabellen: `permission denied for schema public` |
| curl, Python-Beispiel der Oberfläche (*Meine Daten › Zugriff aus Excel, Power BI oder Python*) | REST-API | **verifiziert** | genau die angezeigten Beispiele (`src/ui/components/products/toolSnippets.ts`) mit echter Adresse und Token ausgeführt: CSV mit 40 Zeilen; curl bricht bei ungültigem Token mit Exit-Code 22 ab (`--fail`) statt die Fehlermeldung in die CSV-Datei zu schreiben |
| Power Query M (Excel, Power BI) aus der Oberfläche | REST-API | **nur Syntax geprüft** | mit dem Power-Query-Parser von Microsoft (`@microsoft/powerquery-parser` 4.0.1) für de/en und echte Adresse gültig, eine absichtlich kaputte Variante abgewiesen; Funktionen und Optionen (`Web.Contents` mit `Headers`, `Csv.Document` mit `Delimiter`/`Encoding`/`QuoteStyle.Csv`, `Table.PromoteHeaders`) gegen die Microsoft-Referenz abgeglichen. Das Beispiel nennt als Kommentar die Anmeldeart „Anonym“ (Power Query erlaubt einen eigenen `Authorization`-Header nur bei anonymer Anmeldung). **Nicht in Excel oder Power BI ausgeführt** |
| Apache Superset 6.1.0 | Datenbank | **verifiziert** | siehe [unten](#apache-superset-referenz-dashboards) |
| Excel, Power BI Desktop/Dienst, Tableau, SAP Analytics Cloud | Datenbank bzw. REST-API | **nicht verifiziert** | Diese Werkzeuge laufen auf der Entwicklungsmaschine (macOS, keine Lizenzen/Windows) nicht. Die Anleitungen oben folgen der Herstellerdokumentation. Geprüft ist, was sie voraussetzen: PostgreSQL-Protokoll mit Passwort-Anmeldung und Schema `bi` (wie Npgsql, ODBC, JDBC) sowie HTTPS-GET mit `Authorization`-Header und CSV in UTF-8 mit BOM |
| R (RPostgres) | Datenbank | **nicht verifiziert** | R nicht installiert |

Wiederholen (Entwicklungsmaschine): virtuelle Umgebung unter `.local/bi-tools` (nicht im Repository) mit
`python3.11 -m venv .local/bi-tools && .local/bi-tools/bin/pip install pandas "psycopg[binary]" requests sqlalchemy duckdb`,
dann das Beispiel wie oben mit den Verbindungsdaten des Knotens aufrufen; die Code-Beispiele der
Oberfläche prüft zusätzlich `bun test tests/unit/tool-snippets.test.ts` (Shell- und Python-Syntax).

## Apache Superset: Referenz-Dashboards

Optional enthält `deploy/` eine Superset-Installation (Docker-Profil `bi`), die sich ausschließlich als
`mesh_bi` mit dem Schema `bi` verbindet und drei Referenz-Dashboards anlegt. **Ohne Docker verifiziert:**
Superset 6.1.0 (aus PyPI, virtuelle Umgebung) mit der mitgelieferten Konfiguration und dem
Einrichtungsskript gegen die BI-Views der Demo: alle 13 Diagramme liefern Daten, die Dashboards laden ohne
Fehler. **Mit Docker 29 verifiziert:** Bau des Abbilds, Compose-Profil `bi` (Einrichtung idempotent, beim
zweiten Lauf keine Duplikate), alle 13 Diagramme der drei Dashboards liefern Daten
(`bootstrap_superset.py --verify`, auch über Caddy/HTTPS mit geprüftem Zertifikat), Sitzungs-Cookie
`Secure`/`HttpOnly`, Content-Security-Policy ohne Dritte (kein Telemetrie-Pixel von Scarf, keine
Karten- oder Schriften-CDNs). Superset verbindet sich im internen Netz `backend` ohne TLS zur Datenbank.
Anleitung, lokale Prüfung und manuelle Schritte in `deploy/superset/README.md`; Bildschirmfotos
[Kaderübersicht](screenshots/17-superset-kader.png),
[Sprungkraft-Entwicklung](screenshots/18-superset-sprungkraft.png),
[Leistungsdiagnostik](screenshots/19-superset-leistungsdiagnostik.png).

| Dashboard | View (Schema `bi`) | Spalten | Inhalt |
|---|---|---|---|
| **Kaderübersicht** | `kader_uebersicht` | `sport`, `squad_status`, `birth_year`, `sex` | Personen gesamt, nach Sportart und Kaderstatus (gestapelt), Anteile Kaderstatus, Jahrgänge nach Geschlecht, Kreuztabelle |
| **Sprungkraft-Entwicklung** | `sprungkraft` | `sport`, `squad_status`, `test_type`, `jump_height_cm`, `peak_power_w`, `measured_at` | Ø CMJ-Sprunghöhe und Ø Maximalleistung je Sportart im Monatsverlauf, Sprunghöhe nach Kaderstatus, Anzahl Messungen |
| **Leistungsdiagnostik** | `leistungsdiagnostik` | `sport`, `squad_status`, `test_date`, `protocol`, `vo2max`, `lactate_threshold_power`, `max_heart_rate` | VO2max-Verteilung je Sportart (Histogramm), Ø Leistung an der Laktatschwelle je Sportart, VO2max im Zeitverlauf, Kennwerte-Tabelle |

Die Views entstehen, wenn es Datenprodukte mit den Kürzeln `kader_uebersicht`, `sprungkraft` und
`leistungsdiagnostik` und dazu je eine gültige Freigabe an die Rolle `bi` gibt (in der Demo automatisch).
Superset ist danach unter einem **eigenen Hostnamen** erreichbar: `https://bi.<knoten>/` (Variable
`MESH_BI_DOMAIN` in `deploy/.env`, Standard `bi.<CADDY_DOMAIN>`; der Name braucht einen DNS-Eintrag auf
denselben Server). **Warum ein eigener Hostname?** Cookies sind nicht an Ports gebunden (RFC 6265, Abschnitt
8.5): Liefe Superset unter dem Namen des Knotens mit anderem Port, schickte der Browser das Sitzungs-Cookie
des Knotens (`__Host-osp_session`) bei jeder Anfrage auch an Superset – Superset (oder wer es kompromittiert)
erhielte die Sitzungen aller angemeldeten Personen. Das Cookie gilt ohne `Domain`-Attribut nur für genau den
Namen des Knotens und wird an `bi.<knoten>` nicht gesendet.
