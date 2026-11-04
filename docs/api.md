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

- Tokens lassen sich **nur mit einer Sitzung** (Anmeldung mit Passwort) erzeugen. Ein Aufruf von
  `POST /api/v1/auth/tokens` mit einem Token wird mit 403 `forbidden`, Grund `session_required`,
  abgewiesen (und protokolliert): Ein Token kann keine weiteren Tokens erzeugen.
- **Alle Tokens einer Person werden widerrufen**, wenn sie ihr Passwort ändert, die Administration es
  zurücksetzt oder das Konto deaktiviert (je Token Audit-Eintrag `token.revoke` mit Grund
  `password_change`, `password_reset` bzw. `user_deactivated`). Danach liefert das Token 401
  `unauthenticated`; Werkzeuge brauchen ein neues Token. Auch nach einer Reaktivierung des Kontos
  bleiben widerrufene Tokens ungültig.

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
  "stats": { "returned": 1 }
}
```

`stats.returned` ist die Zahl der gelieferten Zeilen. Empfänger erfahren bewusst **nichts** über Zeilen
außerhalb der Freigabe (Gesamtzahl, Ausschlüsse durch Zeilenbeschränkung, Zeitraum oder fehlende
Einwilligung) – daraus ließe sich etwa ablesen, für wie viele Personen keine Einwilligung vorliegt. Diese
Zahlen sehen nur Datenverantwortliche in den Vorschauen (`products.preview`, `releases.preview`; siehe
[Freigaberegeln](freigaberegeln.md#zeilenregeln)). XML-Aufbau:

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
`@`, Tabulator oder Wagenrücklauf beginnen, werden in CSV mit `'` geschützt (keine Formelausführung in
Tabellenkalkulationen).

Jeder Abruf wird im Audit-Log protokolliert (`access.data`, mit Zweck, Format, Spalten und Zeilenzahl;
abgelehnte Abrufe mit `outcome = denied` und Ablehnungsgrund).

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
| 400 | `validation_failed`, `password_too_weak`, `source_not_allowed` | Eingabe ungültig (`fields` nennt die Felder); Passwort zu schwach (`reason`: `too_short`, `equals_email`, `equals_current`); API-Quelle nicht in `MESH_SOURCE_ALLOWED_HOSTS` bzw. Zugangsgeheimnis über unverschlüsseltes `http://` (`reason: insecure_http`, siehe [Sicherheit](sicherheit.md#schutz-vor-server-side-request-forgery-ssrf)) |
| 401 | `unauthenticated`, `invalid_credentials` | nicht angemeldet, Sitzung abgelaufen, Token ungültig/abgelaufen/widerrufen; Anmeldung fehlgeschlagen – **einheitlich** für unbekannte E-Mail, falsches Passwort, inaktives und vorübergehend gesperrtes Konto (5 Fehlversuche in Folge → 15 Minuten); der tatsächliche Grund steht nur im Audit-Log |
| 403 | `forbidden`, `csrf_failed`, `access_denied` | Rolle fehlt; `reason: password_change_required` (Initialpasswort noch nicht geändert); `reason: session_required` (Token erzeugen mit einem Token); CSRF-Header fehlt; Freigabe verweigert (`reason` = Ablehnungsgrund, z. B. `purpose_not_allowed`, `expired`, `revoked`) |
| 404 | `not_found` | Objekt oder Route unbekannt |
| 409 | `conflict`, `peer_untrusted` | Zustandskonflikt (`reason` z. B. `email_exists`, `slug_exists`, `last_admin`, `backup_running`), Partner nicht vertrauenswürdig |
| 413 / 415 | `payload_too_large`, `unsupported_format` | Anfrage zu groß (API 1 MB, Uploads 20 MB; bei *Beispiel abrufen* auch `reason: too_many_columns`, mehr als 500 Spalten) bzw. falscher Inhaltstyp |
| 422 | `import_failed`, `release_invalid` | Antwort einer API-Quelle unbrauchbar (*Beispiel abrufen*, `reason` z. B. `invalid_response`, `too_many_rows`) bzw. Freigabe fachlich ungültig (`fields`) |
| 429 | `rate_limited` | zu viele Anmeldeversuche (30 je IP-Adresse in 5 Minuten) bzw. Passwortwechsel (30 je Person in 5 Minuten) |
| 500 | `internal_error`, `backup_failed` | unerwarteter Fehler (Details nur im Server-Log, Request-ID angeben) bzw. Sicherung fehlgeschlagen |
| 502 | `source_unreachable`, `peer_unreachable`, `peer_rejected`, `signature_invalid` | Quelle oder Partner nicht erreichbar bzw. Antwort ungültig |

Der Code `account_locked` (423) steht aus Kompatibilitätsgründen noch in der festen Liste `ERROR_CODES`,
wird aber **nicht mehr geliefert**: Ein gesperrtes Konto erhält bei der Anmeldung dieselbe Antwort 401
`invalid_credentials` wie ein falsches Passwort, damit Außenstehende weder Existenz noch Sperre eines
Kontos erkennen. Gesperrte Konten sieht die Administration unter *Benutzer* (`lockedUntil`).

Die Ablehnungsgründe einer Freigabeprüfung (`reason`) sind in den
[Freigaberegeln](freigaberegeln.md#prüfreihenfolge-ablehnungsgründe) erklärt.
