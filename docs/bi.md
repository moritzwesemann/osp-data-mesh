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

**Docker Compose** (nicht lokal verifiziert): Zertifikat und Schlüssel nach `deploy/postgres/tls/`
(`server.crt`, `server.key`; Schlüssel `chown 999:999`, `chmod 600` – UID 999 ist der Benutzer `postgres`
im Abbild), in `deploy/.env` `BI_DB_BIND` auf die interne IP-Adresse setzen, dann

```sh
docker compose -f docker-compose.yml -f docker-compose.bi-db.yml up -d
```

Die Zusatzdatei schaltet TLS ein, veröffentlicht den Port `5432` nur auf dieser Adresse (ein anderer Port
auf dem Server: in `docker-compose.bi-db.yml` in `"${BI_DB_BIND…}:5432:5432"` die **mittlere** Zahl
ändern; die letzte ist der Port im Container und bleibt `5432`) und setzt eine `pg_hba.conf`, die von
außen ausschließlich `mesh_bi` mit TLS zulässt (`deploy/postgres/pg_hba.bi.conf`). Danach in
`deploy/.env` `MESH_BI_DB_HOST` (Name oder Adresse für BI-Werkzeuge), `MESH_BI_DB_PORT` und
`MESH_BI_DB_NAME` setzen und `docker compose up -d` ausführen.

**Netztrennung:** Die Zusatzdatei legt feste Subnetze an (`backend` 172.31.251.0/24, `bi_access`
172.31.250.0/24). `pg_hba.bi.conf` erlaubt alle Rollen nur aus `backend`; aus `bi_access` – dort können
Verbindungen über den veröffentlichten Port mit der Gateway-Adresse ankommen – und von überall sonst nur
`mesh_bi` mit TLS, jede andere Rolle wird ausdrücklich abgelehnt (`reject`). Wer die Subnetze ändert, muss
beide Dateien gleich ändern. Nicht lokal verifiziert (kein Docker); zusätzlich die veröffentlichte Adresse
per Firewall auf das Netz der BI-Arbeitsplätze beschränken.

## Werkzeuge

### Excel (Power Query)

- *Daten › Daten abrufen › Aus Datenbank › Aus PostgreSQL-Datenbank*: Server `<host>:<port>` (Port aus
  den Verbindungsdaten, Standard `5432`), Datenbank `mesh`, Anmeldung *Datenbank* mit `mesh_bi`. Excel benötigt dafür den Npgsql-Datenanbieter
  (je nach Excel-Version separat zu installieren).
- Alternative **ODBC**: psqlODBC-Treiber installieren, DSN mit `sslmode=require` anlegen, dann
  *Daten abrufen › Aus anderen Quellen › Aus ODBC*.
- Alternative ohne Treiber: REST-Abruf als CSV ([REST-API › Excel und Power BI](api.md#excel-und-power-bi-über-rest)).

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

### R

```r
con <- DBI::dbConnect(RPostgres::Postgres(), host = "db.osp-beispiel.intern", port = 5432, dbname = "mesh",
                      user = "mesh_bi", password = Sys.getenv("MESH_BI_PASSWORD"), sslmode = "require")
df <- DBI::dbGetQuery(con, "select * from bi.leistungsdiagnostik")
```

## Apache Superset: Referenz-Dashboards

Optional enthält `deploy/` eine Superset-Installation (Docker-Profil `bi`), die sich ausschließlich als
`mesh_bi` mit dem Schema `bi` verbindet und drei Referenz-Dashboards anlegt. **Nicht lokal verifiziert**
(auf der Entwicklungsmaschine ist kein Docker verfügbar); Anleitung und manuelle Schritte in
`deploy/superset/README.md`.

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
