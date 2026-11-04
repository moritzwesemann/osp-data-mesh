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
   Spalten und passenden Datentypen an.
3. Aktualisierung: kurz nach jeder Datenänderung, alle 10 Minuten und auf Knopfdruck (*BI › Neu
   aufbauen*). Übersicht der Views mit Zeilenzahl und Status unter *BI* (Rollen `admin`, `data_steward`).
4. **Widerruf** entfernt die View sofort; **Ablauf** der Freigabe wirkt sofort, weil jede View bei jeder
   Abfrage in SQL prüft, ob die Freigabe noch gilt; **Einwilligungswiderruf und Löschung** entfernen die
   Zeilen der Person in derselben Transaktion.

`mesh_bi` kann weder die internen Tabellen (`bi_data`) noch Fachtabellen (`public`) lesen; jede Sitzung
ist nur lesend, Abfragen werden nach 60 Sekunden abgebrochen.

## Verbindungsdaten

| Angabe | Wert |
|---|---|
| Server | Hostname/IP der Datenbank (siehe *BI* in der Oberfläche, falls `MESH_BI_DB_HOST` gesetzt) |
| Port | `5432` |
| Datenbank | `mesh` |
| Benutzer | `mesh_bi` |
| Passwort | `MESH_DB_BI_PASSWORD` (bei der IT-Administration) |
| Schema | `bi` |
| Verschlüsselung | TLS erforderlich (`sslmode=require` bzw. „SSL erforderlich“) |

Vorhandene Views anzeigen:

```sql
select table_name from information_schema.views where table_schema = 'bi' order by 1;
```

## Datenbank für BI-Werkzeuge erreichbar machen

Standardmäßig ist PostgreSQL **nicht** von außen erreichbar (Trennung interner und externer Dienste).
Für den direkten BI-Zugang bewusst und nur im internen Netz des OSP freischalten, immer mit TLS und nur
für `mesh_bi`:

**Nativ (Debian/Ubuntu):**

1. `/etc/postgresql/18/main/postgresql.conf`: `listen_addresses = 'localhost,10.0.5.10'` (interne
   Adresse des Servers); `ssl = on` mit einem Zertifikat für den Hostnamen (`ssl_cert_file`,
   `ssl_key_file`; Debian nutzt sonst ein selbstsigniertes Zertifikat).
2. `/etc/postgresql/18/main/pg_hba.conf` ergänzen (Netz der BI-Arbeitsplätze anpassen):
   `hostssl  mesh  mesh_bi  10.20.0.0/16  scram-sha-256`
3. `sudo systemctl restart postgresql`; Firewall: Port 5432 nur aus dem BI-Netz.
4. In `.env` `MESH_BI_DB_HOST`, `MESH_BI_DB_PORT`, `MESH_BI_DB_NAME` setzen, damit die Oberfläche die
   Verbindungsdaten anzeigt.

**Docker Compose** (nicht lokal verifiziert): Zertifikat und Schlüssel nach `deploy/postgres/tls/`
(`server.crt`, `server.key`; Schlüssel `chown 999:999`, `chmod 600`), in `deploy/.env` `BI_DB_BIND` auf
die interne IP-Adresse setzen, dann

```sh
docker compose -f docker-compose.yml -f docker-compose.bi-db.yml up -d
```

Die Zusatzdatei veröffentlicht den Port nur auf dieser Adresse und setzt eine `pg_hba.conf`, die von
außen ausschließlich `mesh_bi` mit TLS zulässt (`deploy/postgres/pg_hba.bi.conf`).

Alternativ ohne Freischaltung: SSH-Tunnel oder VPN zum Server, oder die REST-API.

## Werkzeuge

### Excel (Power Query)

- *Daten › Daten abrufen › Aus Datenbank › Aus PostgreSQL-Datenbank*: Server `host:5432`, Datenbank
  `mesh`, Anmeldung *Datenbank* mit `mesh_bi`. Excel benötigt dafür den Npgsql-Datenanbieter
  (je nach Excel-Version separat zu installieren).
- Alternative **ODBC**: psqlODBC-Treiber installieren, DSN mit `sslmode=require` anlegen, dann
  *Daten abrufen › Aus anderen Quellen › Aus ODBC*.
- Alternative ohne Treiber: REST-Abruf als CSV ([REST-API › Excel und Power BI](api.md#excel-und-power-bi-über-rest)).

### Power BI

*Daten abrufen › PostgreSQL-Datenbank*: Server `host:5432`, Datenbank `mesh`, Modus *Import* (oder
*DirectQuery*), Anmeldung *Datenbank* mit `mesh_bi`. Power BI verlangt standardmäßig eine verschlüsselte
Verbindung mit vertrauenswürdigem Zertifikat. Für geplante Aktualisierungen im Power-BI-Dienst ist ein
lokales Datengateway im OSP-Netz nötig.

### Tableau

*Verbinden › PostgreSQL*: Server, Port `5432`, Datenbank `mesh`, Benutzername `mesh_bi`, Passwort,
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
    host="db.osp-beispiel.intern", port=5432, dbname="mesh",
    user="mesh_bi", password="…", sslmode="require",
) as conn:
    df = pd.read_sql("select * from bi.sprungkraft", conn)
print(df.groupby("sport")["jump_height_cm"].describe())
```

(pandas empfiehlt für `read_sql` SQLAlchemy; mit `create_engine("postgresql+psycopg://mesh_bi:…@host/mesh?sslmode=require")`
entfällt der Hinweis.)

### R

```r
con <- DBI::dbConnect(RPostgres::Postgres(), host = "db.osp-beispiel.intern", dbname = "mesh",
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
des Knotens (`osp_session`) bei jeder Anfrage auch an Superset – Superset (oder wer es kompromittiert)
erhielte die Sitzungen aller angemeldeten Personen. Das Cookie gilt ohne `Domain`-Attribut nur für genau den
Namen des Knotens und wird an `bi.<knoten>` nicht gesendet.
