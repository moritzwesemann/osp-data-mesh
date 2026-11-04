"""
Einrichtung von Apache Superset für OSP-Data-Mesh über die REST-API von Superset.

NICHT LOKAL VERIFIZIERT (kein Docker auf der Entwicklungsmaschine). Geprüft wurden nur die Syntax
(Python 3.9) und der Plan (--print-plan); siehe deploy/superset/README.md für manuelle Schritte.

Legt idempotent an:
  1. Datenbankverbindung "OSP-Data-Mesh (BI)" als Rolle mesh_bi (nur lesend, nur Schema "bi")
  2. Datasets bi.kader_uebersicht, bi.sprungkraft, bi.leistungsdiagnostik
  3. Diagramme und die drei Referenz-Dashboards
     "Kaderübersicht", "Sprungkraft-Entwicklung", "Leistungsdiagnostik"
Vorhandene Objekte (gleicher Name) werden aktualisiert statt doppelt angelegt.

Umgebung:
  SUPERSET_URL             z. B. http://superset:8088
  SUPERSET_ADMIN_USER      Standard: admin
  SUPERSET_ADMIN_PASSWORD  Passwort des Superset-Administrators
  SUPERSET_MESH_DB_URI     postgresql+psycopg2://mesh_bi:<passwort>@db:5432/mesh

Aufruf:
  python bootstrap_superset.py              Einrichtung ausführen
  python bootstrap_superset.py --print-plan nur den Plan (Datasets, Diagramme, Dashboards) ausgeben

Nur Standardbibliothek (läuft mit jedem Python >= 3.8).
"""

import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DATABASE_NAME = "OSP-Data-Mesh (BI)"
SCHEMA = "bi"

# ------------------------------------------------------------------------------------------------
# Vertrag mit dem BI-Modul / der Demo: Views im Schema "bi" und ihre Spalten
# ------------------------------------------------------------------------------------------------
VIEWS = {
    "kader_uebersicht": ["sport", "squad_status", "birth_year", "sex"],
    "sprungkraft": ["sport", "squad_status", "test_type", "jump_height_cm", "peak_power_w", "measured_at"],
    "leistungsdiagnostik": [
        "sport",
        "squad_status",
        "test_date",
        "protocol",
        "vo2max",
        "lactate_threshold_power",
        "max_heart_rate",
    ],
}


def avg(column, label):
    return {
        "expressionType": "SIMPLE",
        "column": {"column_name": column},
        "aggregate": "AVG",
        "label": label,
        "optionName": "metric_avg_" + column,
    }


def eq_filter(column, value):
    return {
        "expressionType": "SIMPLE",
        "subject": column,
        "operator": "==",
        "comparator": value,
        "clause": "WHERE",
    }


# Dashboards mit Diagrammen: (Titel, Slug, [(Diagrammtitel, View, viz_type, Formulardaten)])
DASHBOARDS = [
    (
        "Kaderübersicht",
        "osp-kaderuebersicht",
        [
            ("Kader: Personen gesamt", "kader_uebersicht", "big_number_total",
             {"metric": "count", "subheader": "Athletinnen und Athleten im BI-Datenprodukt"}),
            ("Kader: Personen nach Sportart und Kaderstatus", "kader_uebersicht", "echarts_timeseries_bar",
             {"x_axis": "sport", "metrics": ["count"], "groupby": ["squad_status"], "stack": "Stack",
              "x_axis_sort_asc": True, "show_legend": True, "row_limit": 1000}),
            ("Kader: Anteile Kaderstatus", "kader_uebersicht", "pie",
             {"groupby": ["squad_status"], "metric": "count", "show_labels": True,
              "label_type": "key_percent", "row_limit": 100}),
            ("Kader: Jahrgänge nach Geschlecht", "kader_uebersicht", "echarts_timeseries_bar",
             {"x_axis": "birth_year", "xAxisForceCategorical": True, "metrics": ["count"],
              "groupby": ["sex"], "stack": "Stack", "x_axis_sort_asc": True, "row_limit": 1000}),
            ("Kader: Sportart × Kaderstatus (Tabelle)", "kader_uebersicht", "pivot_table_v2",
             {"groupbyRows": ["sport"], "groupbyColumns": ["squad_status"], "metrics": ["count"],
              "aggregateFunction": "Sum", "rowTotals": True, "colTotals": True, "row_limit": 10000}),
        ],
    ),
    (
        "Sprungkraft-Entwicklung",
        "osp-sprungkraft",
        [
            ("Sprungkraft: Ø CMJ-Sprunghöhe je Sportart (Monat)", "sprungkraft", "echarts_timeseries_line",
             {"x_axis": "measured_at", "time_grain_sqla": "P1M",
              "metrics": [avg("jump_height_cm", "Ø Sprunghöhe (cm)")], "groupby": ["sport"],
              "adhoc_filters": [eq_filter("test_type", "CMJ")], "markerEnabled": True, "row_limit": 10000}),
            ("Sprungkraft: Ø Maximalleistung CMJ je Sportart (Monat)", "sprungkraft", "echarts_timeseries_line",
             {"x_axis": "measured_at", "time_grain_sqla": "P1M",
              "metrics": [avg("peak_power_w", "Ø Maximalleistung (W)")], "groupby": ["sport"],
              "adhoc_filters": [eq_filter("test_type", "CMJ")], "markerEnabled": True, "row_limit": 10000}),
            ("Sprungkraft: Ø CMJ-Sprunghöhe nach Kaderstatus", "sprungkraft", "echarts_timeseries_bar",
             {"x_axis": "squad_status", "metrics": [avg("jump_height_cm", "Ø Sprunghöhe (cm)")],
              "groupby": ["sport"], "adhoc_filters": [eq_filter("test_type", "CMJ")], "row_limit": 1000}),
            ("Sprungkraft: Anzahl Messungen", "sprungkraft", "big_number_total",
             {"metric": "count", "subheader": "Sprungtests im BI-Datenprodukt"}),
        ],
    ),
    (
        "Leistungsdiagnostik",
        "osp-leistungsdiagnostik",
        [
            ("Leistungsdiagnostik: VO2max-Verteilung je Sportart", "leistungsdiagnostik", "histogram_v2",
             {"column": "vo2max", "groupby": ["sport"], "bins": 10, "normalize": False, "cumulative": False,
              "show_legend": True, "x_axis_title": "VO2max (ml/min/kg)", "y_axis_title": "Anzahl Tests",
              "row_limit": 10000}),
            ("Leistungsdiagnostik: Ø Leistung an der Laktatschwelle je Sportart", "leistungsdiagnostik",
             "echarts_timeseries_bar",
             {"x_axis": "sport", "metrics": [avg("lactate_threshold_power", "Ø Leistung Laktatschwelle (W)")],
              "groupby": [], "x_axis_sort_asc": True, "row_limit": 1000}),
            ("Leistungsdiagnostik: Ø VO2max im Zeitverlauf (Quartal)", "leistungsdiagnostik",
             "echarts_timeseries_line",
             {"x_axis": "test_date", "time_grain_sqla": "P3M",
              "metrics": [avg("vo2max", "Ø VO2max (ml/min/kg)")], "groupby": ["sport"], "markerEnabled": True,
              "row_limit": 10000}),
            ("Leistungsdiagnostik: Kennwerte je Sportart (Tabelle)", "leistungsdiagnostik", "table",
             {"query_mode": "aggregate", "groupby": ["sport"],
              "metrics": ["count", avg("vo2max", "Ø VO2max"), avg("lactate_threshold_power", "Ø Laktatschwelle (W)"),
                          avg("max_heart_rate", "Ø max. Herzfrequenz")],
              "row_limit": 1000}),
        ],
    ),
]


# ------------------------------------------------------------------------------------------------
# Rison (Abfrageparameter "q" der Superset-API)
# ------------------------------------------------------------------------------------------------
def rison(value):
    if value is None:
        return "!n"
    if value is True:
        return "!t"
    if value is False:
        return "!f"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return "'" + value.replace("!", "!!").replace("'", "!'") + "'"
    if isinstance(value, (list, tuple)):
        return "!(" + ",".join(rison(v) for v in value) + ")"
    if isinstance(value, dict):
        return "(" + ",".join(k + ":" + rison(v) for k, v in value.items()) + ")"
    raise TypeError("nicht unterstützter Typ: %r" % (value,))


# ------------------------------------------------------------------------------------------------
# REST-Client
# ------------------------------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, status, body):
        super().__init__("HTTP %s: %s" % (status, body[:500]))
        self.status = status
        self.body = body


class Superset:
    def __init__(self, base_url):
        self.base = base_url.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.token = None
        self.csrf = None

    def request(self, method, path, body=None, query=None):
        url = self.base + path
        if query is not None:
            url += "?q=" + urllib.parse.quote(rison(query), safe="")
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/json")
        req.add_header("Referer", self.base + "/")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", "Bearer " + self.token)
        if self.csrf:
            req.add_header("X-CSRFToken", self.csrf)
        try:
            with self.opener.open(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as err:
            raise ApiError(err.code, err.read().decode("utf-8", "replace"))
        return json.loads(raw) if raw else {}

    def wait_until_healthy(self, attempts=60, delay=5):
        for _ in range(attempts):
            try:
                with self.opener.open(self.base + "/health", timeout=10) as resp:
                    if resp.status == 200:
                        return
            except Exception:  # noqa: BLE001 - Superset startet noch
                pass
            time.sleep(delay)
        raise SystemExit("Superset unter %s nicht erreichbar" % self.base)

    def login(self, username, password):
        res = self.request(
            "POST",
            "/api/v1/security/login",
            {"username": username, "password": password, "provider": "db", "refresh": False},
        )
        self.token = res["access_token"]
        self.csrf = self.request("GET", "/api/v1/security/csrf_token/")["result"]

    def find(self, resource, column, value, extra_filters=()):
        filters = [{"col": column, "opr": "eq", "value": value}] + list(extra_filters)
        res = self.request("GET", "/api/v1/%s/" % resource, query={"filters": filters, "page_size": 100})
        return res.get("result", [])


# ------------------------------------------------------------------------------------------------
# Einrichtung
# ------------------------------------------------------------------------------------------------
def ensure_database(api, uri):
    extra = {
        # Suchpfad auf das BI-Schema beschränken (mesh_bi sieht ohnehin nur "bi")
        "engine_params": {"connect_args": {"options": "-csearch_path=" + SCHEMA}},
        "metadata_params": {},
        "schemas_allowed_for_file_upload": [],
    }
    payload = {
        "database_name": DATABASE_NAME,
        "sqlalchemy_uri": uri,
        "expose_in_sqllab": True,
        "allow_ctas": False,
        "allow_cvas": False,
        "allow_dml": False,
        "allow_file_upload": False,
        "allow_run_async": False,
        "extra": json.dumps(extra),
    }
    found = api.find("database", "database_name", DATABASE_NAME)
    if found:
        db_id = found[0]["id"]
        api.request("PUT", "/api/v1/database/%d" % db_id, payload)
        print("Datenbankverbindung aktualisiert: %s (id %d)" % (DATABASE_NAME, db_id))
    else:
        db_id = api.request("POST", "/api/v1/database/", payload)["id"]
        print("Datenbankverbindung angelegt: %s (id %d)" % (DATABASE_NAME, db_id))
    return db_id


def ensure_dataset(api, db_id, view):
    found = [
        d
        for d in api.find("dataset", "table_name", view)
        if d.get("schema") == SCHEMA and (d.get("database") or {}).get("id") == db_id
    ]
    if found:
        ds_id = found[0]["id"]
        print("Dataset vorhanden: %s.%s (id %d)" % (SCHEMA, view, ds_id))
    else:
        try:
            ds_id = api.request("POST", "/api/v1/dataset/", {"database": db_id, "schema": SCHEMA, "table_name": view})[
                "id"
            ]
        except ApiError as err:
            print(
                "WARNUNG: View %s.%s nicht angelegt (%s). Existiert die BI-Freigabe? Diagramme dazu werden "
                "übersprungen." % (SCHEMA, view, err)
            )
            return None
        print("Dataset angelegt: %s.%s (id %d)" % (SCHEMA, view, ds_id))
    try:
        api.request("PUT", "/api/v1/dataset/%d/refresh" % ds_id)
    except ApiError as err:
        print("WARNUNG: Spalten von %s.%s nicht aktualisiert: %s" % (SCHEMA, view, err))
    return ds_id


def ensure_dashboard(api, title, slug):
    found = api.find("dashboard", "slug", slug)
    if found:
        return found[0]["id"]
    dash_id = api.request("POST", "/api/v1/dashboard/", {"dashboard_title": title, "slug": slug, "published": True})[
        "id"
    ]
    print("Dashboard angelegt: %s (id %d)" % (title, dash_id))
    return dash_id


def ensure_chart(api, title, viz_type, ds_id, form, dash_id):
    params = {
        "datasource": "%d__table" % ds_id,
        "viz_type": viz_type,
        "adhoc_filters": [],
        "time_range": "No filter",
    }
    params.update(form)
    payload = {
        "slice_name": title,
        "viz_type": viz_type,
        "datasource_id": ds_id,
        "datasource_type": "table",
        "params": json.dumps(params),
        "dashboards": [dash_id],
    }
    found = api.find("chart", "slice_name", title)
    if found:
        chart_id = found[0]["id"]
        api.request("PUT", "/api/v1/chart/%d" % chart_id, payload)
    else:
        chart_id = api.request("POST", "/api/v1/chart/", payload)["id"]
        print("  Diagramm angelegt: %s (id %d)" % (title, chart_id))
    return chart_id


def layout(charts):
    """position_json: je Zeile zwei Diagramme (Breite 6 von 12)."""
    pos = {
        "DASHBOARD_VERSION_KEY": "v2",
        "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
        "GRID_ID": {"type": "GRID", "id": "GRID_ID", "children": [], "parents": ["ROOT_ID"]},
    }
    for i in range(0, len(charts), 2):
        row_id = "ROW-%d" % (i // 2 + 1)
        pos["GRID_ID"]["children"].append(row_id)
        row = {
            "type": "ROW",
            "id": row_id,
            "children": [],
            "parents": ["ROOT_ID", "GRID_ID"],
            "meta": {"background": "BACKGROUND_TRANSPARENT"},
        }
        for chart_id, title in charts[i : i + 2]:
            cid = "CHART-%d" % chart_id
            row["children"].append(cid)
            pos[cid] = {
                "type": "CHART",
                "id": cid,
                "children": [],
                "parents": ["ROOT_ID", "GRID_ID", row_id],
                "meta": {"width": 6, "height": 50, "chartId": chart_id, "sliceName": title},
            }
        pos[row_id] = row
    return pos


def print_plan():
    plan = {
        "database": {"name": DATABASE_NAME, "schema": SCHEMA},
        "views": VIEWS,
        "dashboards": [
            {"title": t, "slug": s, "charts": [{"title": c[0], "view": c[1], "viz_type": c[2], "params": c[3]} for c in cs]}
            for t, s, cs in DASHBOARDS
        ],
    }
    print(json.dumps(plan, indent=2, ensure_ascii=False))
    # Plausibilität: alle verwendeten Spalten existieren im Vertrag
    for _, _, charts in DASHBOARDS:
        for title, view, _, form in charts:
            text = json.dumps(form)
            for key in ("x_axis", "column"):
                col = form.get(key)
                if col and col not in VIEWS[view]:
                    raise SystemExit("Spalte %s fehlt in View %s (%s)" % (col, view, title))
            for col in form.get("groupby", []) + form.get("groupbyRows", []) + form.get("groupbyColumns", []):
                if col not in VIEWS[view]:
                    raise SystemExit("Spalte %s fehlt in View %s (%s)" % (col, view, title))
            assert view in VIEWS, text


def main():
    if "--print-plan" in sys.argv:
        print_plan()
        return
    base = os.environ.get("SUPERSET_URL", "http://superset:8088")
    user = os.environ.get("SUPERSET_ADMIN_USER", "admin")
    password = os.environ.get("SUPERSET_ADMIN_PASSWORD", "")
    uri = os.environ.get("SUPERSET_MESH_DB_URI", "")
    if not password or not uri or ":@" in uri:
        raise SystemExit("SUPERSET_ADMIN_PASSWORD und SUPERSET_MESH_DB_URI (mit Passwort von mesh_bi) setzen")

    api = Superset(base)
    api.wait_until_healthy()
    api.login(user, password)
    db_id = ensure_database(api, uri)
    datasets = {view: ensure_dataset(api, db_id, view) for view in VIEWS}

    for title, slug, charts in DASHBOARDS:
        dash_id = ensure_dashboard(api, title, slug)
        created = []
        for chart_title, view, viz_type, form in charts:
            ds_id = datasets.get(view)
            if ds_id is None:
                continue
            try:
                chart_id = ensure_chart(api, chart_title, viz_type, ds_id, form, dash_id)
                created.append((chart_id, chart_title))
            except ApiError as err:
                print("  WARNUNG: Diagramm %s nicht angelegt: %s" % (chart_title, err))
        if created:
            api.request("PUT", "/api/v1/dashboard/%d" % dash_id, {"position_json": json.dumps(layout(created))})
        print("Dashboard bereit: %s (%d Diagramme) → %s/superset/dashboard/%s/" % (title, len(created), base, slug))


if __name__ == "__main__":
    main()
