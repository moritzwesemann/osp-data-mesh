#!/usr/bin/env python3
"""Freigegebene Daten eines OSP-Data-Mesh-Knotens mit Python auswerten (siehe docs/bi.md).

(a) direkt aus der Datenbank: eine View im Schema ``bi`` als nur lesende Rolle ``mesh_bi``
(b) über die REST-API: ein freigegebenes Datenprodukt als CSV mit einem persönlichen API-Token

Voraussetzungen: Python >= 3.10 und ``pip install pandas "psycopg[binary]" requests``

Konfiguration nur über Umgebungsvariablen (keine Passwörter oder Tokens im Code):

  Datenbank (a)  MESH_BI_HOST, MESH_BI_PORT (5432), MESH_BI_DB (mesh), MESH_BI_USER (mesh_bi),
                 MESH_BI_PASSWORD, MESH_BI_SSLMODE (require; über SSH-Tunnel ohne TLS: prefer),
                 MESH_BI_VIEW (optional; sonst die erste View im Schema bi)
  REST-API (b)   OSP_BASE_URL (z. B. https://mesh.osp-beispiel.example.de), OSP_TOKEN (osp_…),
                 OSP_PRODUCT (Kürzel, optional; sonst die erste Freigabe), OSP_PURPOSE (optional;
                 sonst der erste freigegebene Zweck), OSP_CA_BUNDLE (optional: Zertifikat der internen CA),
                 OSP_OUT (optional: CSV zusätzlich in diese Datei schreiben)

Aufruf:
  python python_bi_example.py db     nur (a)
  python python_bi_example.py api    nur (b)
  python python_bi_example.py        beides
"""

from __future__ import annotations

import io
import os
import sys

import pandas as pd


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None or value == "":
        sys.exit(f"Umgebungsvariable {name} fehlt (siehe Kopf dieser Datei)")
    return value


def summarize(df: pd.DataFrame, title: str) -> None:
    print(f"\n== {title}: {len(df)} Zeilen, {len(df.columns)} Spalten")
    print(df.dtypes.to_string())
    print(df.head(5).to_string(index=False))
    numeric = df.select_dtypes("number")
    if not numeric.empty:
        print("\nKennwerte der Zahlenspalten:")
        print(numeric.describe().round(2).to_string())
    categorical = [
        c for c in df.columns if pd.api.types.is_string_dtype(df[c]) and df[c].nunique() <= 30
    ]
    if categorical:
        column = min(categorical, key=lambda c: df[c].nunique())
        print(f"\nAnzahl je {column}:")
        print(df.groupby(column).size().to_string())


def from_database() -> pd.DataFrame:
    """(a) View im Schema bi lesen – mesh_bi sieht nur diese Views, jede Sitzung ist nur lesend."""
    import psycopg
    from psycopg import sql

    with psycopg.connect(
        host=env("MESH_BI_HOST"),
        port=int(env("MESH_BI_PORT", "5432")),
        dbname=env("MESH_BI_DB", "mesh"),
        user=env("MESH_BI_USER", "mesh_bi"),
        password=env("MESH_BI_PASSWORD"),
        sslmode=env("MESH_BI_SSLMODE", "require"),
        connect_timeout=10,
        application_name="osp-bi-beispiel-python",
    ) as conn, conn.cursor() as cur:
        cur.execute("select current_setting('default_transaction_read_only')")
        print(f"Datenbank: verbunden als {conn.info.user}, nur lesend: {cur.fetchone()[0]}")
        cur.execute(
            "select table_name from information_schema.views where table_schema = 'bi' order by 1"
        )
        views = [r[0] for r in cur.fetchall()]
        print(f"Views im Schema bi: {', '.join(views) or '(keine – es gibt noch keine BI-Freigabe)'}")
        if not views:
            return pd.DataFrame()
        view = os.environ.get("MESH_BI_VIEW") or views[0]
        if view not in views:
            sys.exit(f"View bi.{view} gibt es nicht (vorhanden: {', '.join(views)})")
        # Bezeichner sicher einsetzen (keine Zeichenkettenverkettung)
        cur.execute(sql.SQL("select * from bi.{}").format(sql.Identifier(view)))
        columns = [d.name for d in cur.description]
        df = pd.DataFrame(cur.fetchall(), columns=columns)
    summarize(df, f"bi.{view} (PostgreSQL, Rolle mesh_bi)")
    return df


def from_rest_api() -> pd.DataFrame:
    """(b) Freigegebenes Datenprodukt als CSV über die REST-API abrufen."""
    import requests

    base = env("OSP_BASE_URL").rstrip("/")
    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {env('OSP_TOKEN')}"
    if os.environ.get("OSP_CA_BUNDLE"):
        session.verify = os.environ["OSP_CA_BUNDLE"]

    def get(path: str, **params: str) -> requests.Response:
        resp = session.get(f"{base}{path}", params=params, timeout=120)
        if not resp.ok:
            try:
                err = resp.json()["error"]
                detail = f"{err['code']} {err.get('reason') or ''} (requestId {err.get('requestId')})"
            except (ValueError, KeyError):
                detail = resp.text[:200]
            sys.exit(f"REST-API {path}: HTTP {resp.status_code} {detail}")
        return resp

    grants = get("/api/v1/access").json()["items"]
    print(f"REST-API: {len(grants)} Freigabe(n) für dieses Token: {', '.join(g['product']['slug'] for g in grants)}")
    if not grants:
        return pd.DataFrame()
    wanted = os.environ.get("OSP_PRODUCT")
    grant = next((g for g in grants if g["product"]["slug"] == wanted), None) if wanted else grants[0]
    if grant is None:
        sys.exit(f"keine Freigabe für das Produkt {wanted}")
    purpose = os.environ.get("OSP_PURPOSE") or grant["purposes"][0]
    resp = get(f"/api/v1/access/{grant['releaseId']}/data", purpose=purpose, format="csv")
    print(f"CSV: {resp.headers.get('content-type')}, {len(resp.content)} Bytes, Zweck {purpose}")
    text = resp.content.decode("utf-8-sig")  # UTF-8 mit BOM (für Excel), Zeilenende CRLF
    if os.environ.get("OSP_OUT"):
        with open(os.environ["OSP_OUT"], "wb") as fh:
            fh.write(resp.content)
    df = pd.read_csv(io.StringIO(text))
    summarize(df, f"{grant['product']['slug']} (REST-API, CSV)")
    return df


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "both"
    if mode not in ("db", "api", "both"):
        sys.exit(__doc__)
    if mode in ("db", "both"):
        from_database()
    if mode in ("api", "both"):
        from_rest_api()
