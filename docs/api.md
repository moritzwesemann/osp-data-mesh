# REST-API

Alle Funktionen der Oberfläche stehen auch über die REST-API unter `/api/v1/` zur Verfügung. Für
Werkzeuge (Excel/Power Query, Power BI, Tableau, Python, R) ist vor allem der **Abruf freigegebener
Datenprodukte** in CSV, JSON oder XML gedacht. Es gibt keine proprietäre Zugriffsschicht: HTTPS, JSON,
offene Dateiformate und eine OpenAPI-Beschreibung.

## OpenAPI

Die vollständige, maschinenlesbare Beschreibung aller Routen (Parameter, Antwortschemas, erforderliche
Rollen) liefert jeder Knoten ohne Anmeldung unter

```
https://<knoten>/api/v1/openapi.json
```

Sie wird aus demselben Vertrag (zod-Schemas in `src/shared/contract/`) erzeugt, mit dem der Server
Anfragen prüft – Dokumentation und Verhalten können nicht auseinanderlaufen. Die Datei lässt sich in
Swagger UI, Postman, Insomnia oder Codegeneratoren laden. Eine Übersicht der Routen mit Rollen steht unter
[Rollen und Rechte](rollen.md#detail-alle-vorgänge-der-rest-api).

## Anmeldung

Zwei Verfahren:

| Verfahren | Verwendung | Besonderheit |
|---|---|---|
| **API-Token** (`Authorization: Bearer osp_…`) | Skripte, BI-Werkzeuge, Automatisierung | kein CSRF-Header nötig; Rechte = Rollen der Person; Ablauf 1–365 Tage |
| **Sitzungs-Cookie** `osp_session` | Browser (Oberfläche) | zustandsändernde Anfragen (`POST`, `PUT`, `PATCH`, `DELETE`) brauchen zusätzlich `X-OSP-CSRF: 1`; das gilt auch für die Anmeldung selbst |

### API-Token erzeugen

In der Oberfläche unter *Konto › API-Tokens* (Name und Gültigkeit angeben). Das Token wird **nur einmal
angezeigt** und ist wie ein Passwort zu behandeln; gespeichert wird nur ein Hash. Widerruf jederzeit an
derselben Stelle.

Alternativ per API mit einer Sitzung:

```sh
BASE=https://mesh.osp-beispiel.example.de
# anmelden (Cookie in cookies.txt)
curl -s -c cookies.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
  -d '{"email":"analyse@osp-beispiel.example.de","password":"…"}' "$BASE/api/v1/auth/login"
# Token erzeugen (90 Tage)
curl -s -b cookies.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
  -d '{"name":"Power BI Leistungsdiagnostik","expiresInDays":90}' "$BASE/api/v1/auth/tokens"
# → {"token":"osp_…","item":{"id":"…","name":"Power BI Leistungsdiagnostik","prefix":"osp_AbCdEf",…}}
```

## Freigegebene Daten abrufen

**1. Verfügbare Freigaben auflisten** – welche Datenprodukte für die eigenen Rollen freigegeben sind, mit
Zwecken, Spalten und Gültigkeit:

```sh
TOKEN=osp_…
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/access"
```

```json
{ "items": [ {
  "releaseId": "5f0c2a8e-…",
  "recipientRole": "analyst",
  "product": { "id": "…", "slug": "sprungkraft", "name": "Sprungkraft (CMJ)", "description": "…",
               "category": "performance", "specialCategory": false },
  "purposes": ["performance_diagnostics", "training_steering"],
  "columns": [ { "key": "sport", "label": "Sportart", "type": "string" },
               { "key": "jump_height_cm", "label": "Sprunghöhe", "type": "number", "unit": "cm" } ],
  "validFrom": "2026-10-01T00:00:00.000Z", "validUntil": null,
  "dataFrom": null, "dataUntil": null, "requiresConsent": false
} ] }
```

**2. Daten abrufen** – `GET /api/v1/access/{releaseId}/data` mit Pflichtparameter `purpose` (einer der
freigegebenen Zwecke) und `format` (`json` Standard, `csv`, `xml`); optional `limit` (bis 100 000 Zeilen):

```sh
# CSV (UTF-8 mit BOM, Komma, CRLF – direkt in Excel/Power Query lesbar)
curl -s -H "Authorization: Bearer $TOKEN" -o sprungkraft.csv \
  "$BASE/api/v1/access/5f0c2a8e-…/data?purpose=performance_diagnostics&format=csv"

# JSON
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/v1/access/5f0c2a8e-…/data?purpose=performance_diagnostics&format=json"

# XML
curl -s -H "Authorization: Bearer $TOKEN" -o sprungkraft.xml \
  "$BASE/api/v1/access/5f0c2a8e-…/data?purpose=performance_diagnostics&format=xml"
```

Es werden nur die freigegebenen Spalten und Zeilen geliefert (Datenzeitraum, Zeilenbeschränkung,
Einwilligungen). JSON-Antwort:

```json
{
  "columns": [ { "key": "sport", "label": "Sportart", "type": "string" },
               { "key": "jump_height_cm", "label": "Sprunghöhe", "type": "number", "unit": "cm" },
               { "key": "measured_at", "label": "Messdatum", "type": "date" } ],
  "rows": [ { "sport": "Leichtathletik", "jump_height_cm": 41.5, "measured_at": "2026-09-14" } ],
  "stats": { "total": 120, "returned": 96, "excludedByFilter": 20, "excludedByTime": 4, "excludedByConsent": 0 }
}
```

`stats` zeigt, wie viele Zeilen das Produkt hat und wie viele durch Zeilenbeschränkung, Zeitraum oder
fehlende Einwilligung ausgeschlossen wurden. XML-Aufbau:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<dataProduct name="Sprungkraft (CMJ)" generatedAt="2026-11-04T09:12:00.000Z" …>
  <columns>
    <column key="jump_height_cm" type="number" label="Sprunghöhe" unit="cm"/>
  </columns>
  <rows>
    <row><jump_height_cm>41.5</jump_height_cm></row>
  </rows>
</dataProduct>
```

Leere Werte: CSV leeres Feld, JSON `null`, XML `<spalte nil="true"/>`. Textwerte, die mit `=`, `+`, `-`,
`@` beginnen, werden in CSV mit `'` geschützt (keine Formelausführung in Tabellenkalkulationen).

Jeder Abruf wird im Audit-Log protokolliert (`access.data`, mit Zweck und Zeilenzahl).

## Beispiel Python (requests, pandas)

```python
import io
import pandas as pd
import requests

BASE = "https://mesh.osp-beispiel.example.de"
TOKEN = "osp_…"                       # besser aus einer Umgebungsvariable lesen
s = requests.Session()
s.headers["Authorization"] = f"Bearer {TOKEN}"
# bei interner CA:  s.verify = "/pfad/osp-root.crt"

grants = s.get(f"{BASE}/api/v1/access", timeout=30).json()["items"]
release = next(g for g in grants if g["product"]["slug"] == "sprungkraft")

# JSON → DataFrame
r = s.get(f"{BASE}/api/v1/access/{release['releaseId']}/data",
          params={"purpose": "performance_diagnostics", "format": "json"}, timeout=120)
r.raise_for_status()
df = pd.DataFrame(r.json()["rows"])

# alternativ CSV (BOM beachten)
r = s.get(f"{BASE}/api/v1/access/{release['releaseId']}/data",
          params={"purpose": "performance_diagnostics", "format": "csv"}, timeout=120)
df_csv = pd.read_csv(io.StringIO(r.content.decode("utf-8-sig")))
print(df.groupby("sport")["jump_height_cm"].mean())
```

Fehler auswerten:

```python
if not r.ok:
    err = r.json()["error"]
    print(r.status_code, err["code"], err.get("reason"), err["requestId"])
```

## Excel und Power BI über REST

- **Excel (Power Query):** *Daten › Aus dem Web › Erweitert*; URL
  `https://<knoten>/api/v1/access/<releaseId>/data?purpose=<zweck>&format=csv`; HTTP-Anforderungsheader
  `Authorization` = `Bearer osp_…`; Anmeldeart *Anonym* (der Token steht im Header).
- **Power BI Desktop:** *Daten abrufen › Web* mit denselben Angaben, oder in Power Query M:
  `Csv.Document(Web.Contents("https://<knoten>/api/v1/access/<id>/data", [Query=[purpose="reporting", format="csv"], Headers=[Authorization="Bearer osp_…"]]), [Delimiter=",", Encoding=65001])`.
  Für den Power-BI-Dienst (geplante Aktualisierung) Token-Ablauf beachten.

Direkter Datenbankzugang für BI-Werkzeuge: siehe [BI-Anbindung](bi.md).

## Weitere häufige Aufrufe

| Zweck | Aufruf | Rolle |
|---|---|---|
| Wer bin ich, welcher Knoten | `GET /api/v1/auth/me` | alle |
| Zweck-Vokabular | `GET /api/v1/purposes` | alle |
| Metadatenkatalog | `GET /api/v1/catalog` | alle |
| Discovery bei Partnern | `GET /api/v1/discovery?q=sprung` | `data_steward`, `analyst` |
| Empfangene Daten | `GET /api/v1/received`, `GET /api/v1/received/{id}/rows?format=csv` | `data_steward`, `analyst` |
| Audit-Export | `GET /api/v1/audit/export?format=csv&from=…&to=…` | `auditor` |
| Systemstatus | `GET /api/v1/system/status` | `admin` |

Listen sind seitenweise (`page`, `pageSize` bis 500) und liefern `{ items, total, page, pageSize }`.

## Fehlerformat

Fehler haben immer dieselbe Form; `code` stammt aus einer festen Liste, `requestId` steht auch im
Server-Log und im Antwort-Header `X-Request-Id`:

```json
{ "error": { "code": "access_denied", "requestId": "3f0c9a…", "reason": "purpose_not_allowed" } }
{ "error": { "code": "validation_failed", "requestId": "…", "fields": { "query.purpose": "invalid_format" } } }
```

| HTTP | Codes | Bedeutung |
|---|---|---|
| 400 | `validation_failed`, `password_too_weak`, `source_not_allowed` | Eingabe ungültig (`fields` nennt die Felder) |
| 401 | `unauthenticated`, `invalid_credentials` | nicht angemeldet, Token ungültig/abgelaufen, Anmeldedaten falsch |
| 403 | `forbidden`, `csrf_failed`, `access_denied` | Rolle fehlt (`reason: password_change_required` bei Initialpasswort), CSRF-Header fehlt, Freigabe verweigert (`reason` = Ablehnungsgrund, z. B. `purpose_not_allowed`, `expired`, `revoked`) |
| 404 | `not_found` | Objekt oder Route unbekannt |
| 409 | `conflict`, `peer_untrusted` | Zustandskonflikt (z. B. doppelter Name), Partner nicht vertrauenswürdig |
| 413 / 415 | `payload_too_large`, `unsupported_format` | Anfrage zu groß bzw. falscher Inhaltstyp |
| 422 | `import_failed`, `release_invalid` | Import bzw. Freigabe fachlich ungültig |
| 423 | `account_locked` | Konto vorübergehend gesperrt (5 Fehlversuche → 15 min) |
| 429 | `rate_limited` | zu viele Anmeldeversuche |
| 500 | `internal_error`, `backup_failed` | unerwarteter Fehler (Details nur im Server-Log, Request-ID angeben) |
| 502 | `source_unreachable`, `peer_unreachable`, `peer_rejected`, `signature_invalid` | Quelle oder Partner nicht erreichbar bzw. Antwort ungültig |

Die Ablehnungsgründe einer Freigabeprüfung (`reason`) sind in den
[Freigaberegeln](freigaberegeln.md#prüfreihenfolge-ablehnungsgründe) erklärt.
