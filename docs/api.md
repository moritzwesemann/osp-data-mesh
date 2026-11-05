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
| **Sitzungs-Cookie** `__Host-osp_session` (lokale HTTP-Testinstallation: `osp_session`) | Browser (Oberfläche), Skripte mit Cookie-Datei | zustandsändernde Anfragen (`POST`, `PUT`, `PATCH`, `DELETE`) brauchen zusätzlich `X-OSP-CSRF: 1`; das gilt auch für die Anmeldung selbst |

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

Alternativ per API mit einer Sitzung (Cookie-Datei `cookies.txt`; funktioniert mit beiden Cookie-Namen,
siehe [Beispiel](#beispiel-vom-csv-import-bis-zum-datenabruf-curl)):

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

Leere Werte: CSV leeres Feld, JSON `null`, XML `<spalte nil="true"/>`.

**Schutz vor Formel-Injection (CSV):** Textwerte, die mit `=`, `+`, `-`, `@`, Tabulator oder
Wagenrücklauf beginnen, erhalten in CSV ein vorangestelltes `'` (aus `-Muster` wird `'-Muster`), damit
Excel und andere Tabellenkalkulationen sie nicht als Formel ausführen. Zahlen (auch negative) und
Wahrheitswerte sind nicht betroffen, ebenso JSON und XML. Wer CSV maschinell weiterverarbeitet und den
Originalwert braucht, verwendet JSON oder entfernt das führende `'` bei genau diesen Anfangszeichen.
Pseudonyme (Spalte `subject` bzw. `_subject` beim Export empfangener Daten) bestehen aus 32
Hex-Zeichen in Kleinbuchstaben (`0-9a-f`) und sind deshalb nie betroffen (Kopien von Partnern mit
älterer Programmversion können noch 22-stellige Pseudonyme enthalten, bis der Partner aktualisiert hat
und erneut abgerufen wurde).

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

## Beispiel: vom CSV-Import bis zum Datenabruf (curl)

Dieses Beispiel führt einmal durch die ganze Kette – Connector aus einer Vorlage anlegen, CSV-Datei
hochladen und übernehmen, Datenprodukt definieren, Freigabe prüfen und erteilen, API-Token erzeugen und
die freigegebenen Daten als CSV abrufen. Jeder Schritt entspricht einer Route aus der
[OpenAPI-Beschreibung](#openapi) (in Klammern die Vorgangskennung); die Oberfläche ruft dieselben Routen auf.

**Voraussetzungen**

- `curl` und `jq` (Debian/Ubuntu: `sudo apt install -y curl jq`; macOS: `brew install jq`), eine
  `bash`- oder `zsh`-Shell.
- Zwei Konten, von der Administration unter *Benutzer* angelegt: eines mit der Rolle `data_steward`
  (Schritte 1–8) und eines mit der Rolle `analyst` (Schritte 9–10). Im Beispiel
  `daten@osp-beispiel.example.de` und `analyse@osp-beispiel.example.de`.
- Ein leerer Knoten bzw. noch nicht vorhandene Kürzel: Connector `athleten-stammdaten-csv` und Produkt
  `kader_uebersicht` dürfen noch nicht existieren (sonst 409 `conflict`, Grund `slug_exists` bzw.
  `slug_taken`).

**Regeln für alle Aufrufe**

- **Sitzung** (Schritte 1–9): Das Sitzungs-Cookie liegt in einer Cookie-Datei; jeder Aufruf liest und
  aktualisiert sie mit `-b <datei> -c <datei>`. Das funktioniert unabhängig vom Cookie-Namen
  (`__Host-osp_session` über HTTPS, `osp_session` bei einer lokalen HTTP-Testinstallation). Jede
  zustandsändernde Anfrage (`POST`, `PUT`, `PATCH`, `DELETE`, auch die Anmeldung) braucht zusätzlich den
  Header `X-OSP-CSRF: 1`, sonst 403 `csrf_failed`. JSON-Bodys mit `Content-Type: application/json`.
- **API-Token** (Schritt 10): Header `Authorization: Bearer osp_…`, **kein** CSRF-Header und keine
  Cookie-Datei nötig.
- Passwörter und Tokens nicht in die Befehlszeile schreiben (sie landen sonst in der Shell-History und
  der Prozessliste): Passwörter mit `read -rs` einlesen und per `jq` aus der Umgebung (`env.…`) in den
  Body einsetzen.
- Die Cookie-Dateien enthalten gültige Sitzungen: am Ende abmelden und löschen (Schritt 11).

```sh
BASE=https://mesh.osp-beispiel.example.de   # anpassen; lokale Testinstallation: http://127.0.0.1:4401
# nur bei interner CA (tls internal): export CURL_CA_BUNDLE="$PWD/osp-root.crt"
```

### 1. Als Datenverantwortliche anmelden (`auth.login`)

```sh
printf 'Passwort: '; read -rs OSP_PW; echo; export OSP_PW
jq -n '{email: "daten@osp-beispiel.example.de", password: env.OSP_PW}' \
  | curl -s -b steward.txt -c steward.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
      --data-binary @- "$BASE/api/v1/auth/login" | jq .user
```

Antwort: `{"id":"…","email":"daten@osp-beispiel.example.de","roles":["data_steward"],…,"mustChangePassword":true}`.
Ist `mustChangePassword` `true` (neues Konto mit Initialpasswort), lässt der Knoten bis zum
Passwortwechsel nur diesen zu (sonst 403 `forbidden`, Grund `password_change_required`):

```sh
printf 'Neues Passwort (mind. 12 Zeichen): '; read -rs OSP_NEW_PW; echo; export OSP_NEW_PW
jq -n '{currentPassword: env.OSP_PW, newPassword: env.OSP_NEW_PW}' \
  | curl -s -b steward.txt -c steward.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
      --data-binary @- "$BASE/api/v1/auth/password"
# → {"ok":true}   (die aktuelle Sitzung bleibt gültig)
unset OSP_PW OSP_NEW_PW
```

### 2. Connector-Vorlagen ansehen (`connectors.templates`)

```sh
curl -s -b steward.txt -c steward.txt "$BASE/api/v1/connector-templates" \
  | jq -r '.items[] | "\(.id)\t\(.name)"'
```

```text
athleten-stammdaten-csv	Athleten-Stammdaten (CSV)
leistungsdiagnostik-csv	Leistungsdiagnostik (CSV)
leistungsdiagnostik-xlsx	Leistungsdiagnostik (Excel)
sprungkraft-api	Sprungkraft-Messsystem (API)
sprungkraft-oauth2-api	Sprungkraft-Messsystem (API mit OAuth2)
verletzungen-csv	Verletzungen (CSV)
```

Jede Vorlage enthält unter `definition` eine portable Connector-Definition
(`"format": "osp-data-mesh/connector@1"`); ihre Beschreibung (`description`) nennt die erwarteten Spalten.

### 3. Connector aus der Vorlage anlegen (`connectors.import`)

Body: `{ "definition": <Connector-Definition>, "createDataset": true }`. `createDataset: true` legt eine
mitgelieferte Datensatz-Struktur gleich mit an (bei Stammdaten gibt es keine).

```sh
curl -s -b steward.txt -c steward.txt "$BASE/api/v1/connector-templates" \
  | jq '{definition: (.items[] | select(.id == "athleten-stammdaten-csv") | .definition), createDataset: true}' \
  | curl -s -b steward.txt -c steward.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
      --data-binary @- "$BASE/api/v1/connectors/import" > connector.json
jq '{id, slug, version, targetType}' connector.json
CONNECTOR_ID=$(jq -r .id connector.json)
```

Antwort (gekürzt): `{"id":"3ae866e5-…","slug":"athleten-stammdaten-csv","version":1,"targetType":"athletes"}`.

### 4. CSV-Datei hochladen und prüfen lassen (`imports.start`)

Die Vorlage erwartet eine Kaderliste mit Semikolon oder Komma (automatisch erkannt), Datum als
`TT.MM.JJJJ`:

```sh
cat > kader.csv <<'CSV'
Athleten-ID;Nachname;Vorname;Geburtsdatum;Geschlecht;Sportart;Disziplin;Kaderstatus;Verein
A-1001;Muster;Anna;14.03.2004;w;Leichtathletik;Sprint;Perspektivkader;LG Beispielstadt
A-1002;Beispiel;Ben;02.11.2006;m;Rudern;Einer;Nachwuchskader 1;RC Beispielsee
A-1003;Probe;Paula;27.07.2001;w;Leichtathletik;Weitsprung;Olympiakader;LG Beispielstadt
CSV
```

Hochladen als `multipart/form-data` im Feld **`file`** (den `Content-Type` setzt `curl -F` selbst; nicht
von Hand angeben):

```sh
curl -s -b steward.txt -c steward.txt -H 'X-OSP-CSRF: 1' -F 'file=@kader.csv;type=text/csv' \
  "$BASE/api/v1/connectors/$CONNECTOR_ID/runs" > run.json
jq '.run | {id, status, totalRows, validRows, errorRows, warningRows}' run.json
jq '.errorSummary' run.json
RUN_ID=$(jq -r .run.id run.json)
```

Antwort: `{"id":"bcd2dfce-…","status":"previewed","totalRows":3,"validRows":3,"errorRows":0,"warningRows":0}`
und `[]`. Noch ist nichts übernommen: Der Lauf ist eine **Vorschau**; `preview.rows` zeigt bis zu 50
Zeilen roh und zugeordnet. Fehler je Zeile und Feld: `GET /api/v1/import-runs/$RUN_ID/errors`
(`imports.errors`). Nicht übernommene Vorschauen verfallen nach 7 Tagen.

### 5. Geprüfte Zeilen übernehmen (`imports.commit`)

```sh
curl -s -b steward.txt -c steward.txt -H 'X-OSP-CSRF: 1' -X POST \
  "$BASE/api/v1/import-runs/$RUN_ID/commit" | jq '{status, insertedRows, updatedRows}'
# → {"status":"committed","insertedRows":3,"updatedRows":0}
```

Verwerfen statt übernehmen: `POST /api/v1/import-runs/$RUN_ID/discard` (`imports.discard`).

### 6. Datenprodukt definieren (`products.create`)

Das Produkt „Kaderübersicht“ zeigt aus dem Athletenkern nur Sportart, Kaderstatus, Geburtsjahr und
Geschlecht – keine Namen. Das Kürzel (`slug`, nur `a-z`, `0-9`, `_`) ist zugleich der Name einer
späteren BI-View.

```sh
cat > product.json <<'JSON'
{
  "slug": "kader_uebersicht",
  "name": "Kaderübersicht",
  "description": "Sportart, Kaderstatus, Geburtsjahr und Geschlecht – ohne Namen",
  "sourceType": "athletes",
  "columns": [
    { "key": "sport",        "label": "Sportart",    "source": "athlete.sport" },
    { "key": "squad_status", "label": "Kaderstatus", "source": "athlete.squad_status" },
    { "key": "birth_year",   "label": "Geburtsjahr", "source": "athlete.birth_year" },
    { "key": "sex",          "label": "Geschlecht",  "source": "athlete.sex" }
  ]
}
JSON
curl -s -b steward.txt -c steward.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
  --data-binary @product.json "$BASE/api/v1/products" > product-created.json
jq '{id, slug, category, specialCategory, version}' product-created.json
PRODUCT_ID=$(jq -r .id product-created.json)
```

Antwort: `{"id":"65c50692-…","slug":"kader_uebersicht","category":"master","specialCategory":false,"version":1}`.
Ohne Angabe gelten `filters: []` (kein Basisfilter) und `shareability: "on_request"`.

### 7. Freigabe vorab prüfen (`releases.preview`)

Die geplante Freigabe: Rolle `analyst`, Zweck `talent_development`, nur drei Spalten, nur Olympia- und
Perspektivkader, gültig bis Ende 2027. Die Freigabe wird einmal als Datei geschrieben und für Vorschau
und Erteilung verwendet:

```sh
jq -n --arg p "$PRODUCT_ID" '{
  productId: $p,
  recipient: { type: "role", role: "analyst" },
  purposes: ["talent_development"],
  columns: ["sport", "squad_status", "birth_year"],
  rowFilter: [ { column: "squad_status", op: "in", value: ["OK", "PK"] } ],
  validUntil: "2027-12-31T23:59:59Z",
  requiresConsent: false,
  legalBasis: "Art. 6 Abs. 1 lit. e DSGVO i. V. m. Kooperationsvereinbarung",
  note: "Beispiel aus der API-Dokumentation"
}' > release.json
```

Die Vorschau erwartet die Freigabe **eingepackt** zusammen mit dem Zweck, für den geprüft werden soll:
`{ "release": { … }, "purpose": "…" }`.

```sh
jq '{release: ., purpose: "talent_development"}' release.json \
  | curl -s -b steward.txt -c steward.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
      --data-binary @- "$BASE/api/v1/releases/preview" | jq '{decision, stats, rows}'
```

```json
{
  "decision": { "allowed": true, "reason": null },
  "stats": { "total": 3, "returned": 2, "excludedByFilter": 1, "excludedByTime": 0, "excludedByConsent": 0 },
  "rows": [ { "sport": "Leichtathletik", "squad_status": "PK", "birth_year": 2004 },
            { "sport": "Leichtathletik", "squad_status": "OK", "birth_year": 2001 } ]
}
```

`decision` zeigt, ob ein Abruf mit diesem Zweck erlaubt wäre (bei einem nicht freigegebenen Zweck
`"allowed": false` mit Grund `purpose_not_allowed`); `stats` nennt – nur für Datenverantwortliche – auch
die ausgeschlossenen Zeilen. Fachlich ungültige Freigaben beantwortet die Vorschau mit 422
`release_invalid` und den betroffenen Feldern (z. B. `"body.release.columns.3": "unknown_column"` für eine
unbekannte vierte Spalte). Pflichtfelder der Freigabe sind `productId`,
`recipient`, `purposes`, `columns` und `requiresConsent`; bei Daten besonderer Kategorie (Art. 9 DSGVO)
muss `requiresConsent` `true` sein ([Freigaberegeln](freigaberegeln.md)).

### 8. Freigabe erteilen (`releases.create`)

Body ist die Freigabe selbst (ohne `release`/`purpose`-Hülle):

```sh
curl -s -b steward.txt -c steward.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
  --data-binary @release.json "$BASE/api/v1/releases" | jq '{id, status, recipient, purposes, validUntil}'
# → {"id":"95411501-…","status":"active","recipient":{"type":"role","role":"analyst"},…}
```

Freigaben sind unveränderlich; eine Änderung ist eine neue Freigabe (und ggf. Widerruf der alten mit
`POST /api/v1/releases/{id}/revoke`, Body `{"reason":"…"}`).

### 9. Als Empfänger anmelden und API-Token erzeugen (`tokens.create`)

Die Person mit der Rolle `analyst` meldet sich mit einer eigenen Cookie-Datei `analyst.txt` an:

```sh
printf 'Passwort: '; read -rs OSP_PW; echo; export OSP_PW
jq -n '{email: "analyse@osp-beispiel.example.de", password: env.OSP_PW}' \
  | curl -s -b analyst.txt -c analyst.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
      --data-binary @- "$BASE/api/v1/auth/login" | jq .user.mustChangePassword
```

Bei `true` zuerst den Passwortwechsel aus Schritt 1 ausführen (dort `steward.txt` durch `analyst.txt`
ersetzen). Dann das Token erzeugen. Tokens lassen sich **nur mit einer Sitzung** erzeugen, nicht mit
einem anderen Token (403 `forbidden`, Grund `session_required`):

```sh
curl -s -b analyst.txt -c analyst.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
  -d '{"name":"Auswertung Talententwicklung","expiresInDays":90}' "$BASE/api/v1/auth/tokens" > token.json
jq .item token.json
export OSP_TOKEN=$(jq -r .token token.json); rm token.json
```

Das Token (`osp_…`) wird **nur einmal** ausgegeben; für die dauerhafte Nutzung in der Passwortverwaltung
ablegen. `item` enthält Name, Präfix (`osp_xRJenM…` zur Wiedererkennung) und Ablaufdatum.

### 10. Daten mit dem Token abrufen (`access.list`, `access.data`)

```sh
curl -s -H "Authorization: Bearer $OSP_TOKEN" "$BASE/api/v1/access" \
  | jq '.items[] | {releaseId, product: .product.slug, purposes, columns: [.columns[].key]}'
RELEASE_ID=$(curl -s -H "Authorization: Bearer $OSP_TOKEN" "$BASE/api/v1/access" \
  | jq -r '.items[] | select(.product.slug == "kader_uebersicht") | .releaseId')
curl -s -H "Authorization: Bearer $OSP_TOKEN" -o kader_uebersicht.csv \
  "$BASE/api/v1/access/$RELEASE_ID/data?purpose=talent_development&format=csv"
cat kader_uebersicht.csv
```

```text
sport,squad_status,birth_year
Leichtathletik,PK,2004
Leichtathletik,OK,2001
```

Die Datei ist UTF-8 mit BOM und CRLF-Zeilenenden (für Excel). Der Zweck (`purpose`) ist Pflicht und muss
einer der freigegebenen sein: ohne Zweck 400 `validation_failed` (`"query.purpose": "invalid_type"`),
mit einem anderen Zweck 403 `access_denied`, Grund `purpose_not_allowed`. Jeder Abruf steht im Audit-Log
(`access.data`).

### 11. Aufräumen

```sh
curl -s -b steward.txt -H 'X-OSP-CSRF: 1' -X POST "$BASE/api/v1/auth/logout"
curl -s -b analyst.txt -H 'X-OSP-CSRF: 1' -X POST "$BASE/api/v1/auth/logout"
rm -f steward.txt analyst.txt connector.json run.json product-created.json
unset OSP_PW OSP_NEW_PW
```

Das Token bleibt bis zum Ablauf gültig; nicht mehr benötigte Tokens unter *Konto › API-Tokens* oder mit
`DELETE /api/v1/auth/tokens/{id}` (Sitzung + CSRF-Header) widerrufen.

### Variante: Produkt aus einem Datensatz (Messwerte)

Für Messwerte (z. B. Leistungsdiagnostik) zuerst die Personen importieren (Schritte 3–5 wie oben), dann
Schritte 3–5 mit der Vorlage `leistungsdiagnostik-csv` wiederholen. Diese bringt eine Datensatz-Struktur
mit; `createDataset: true` legt sie an, und der Connector verweist darauf (`targetDatasetId`). Die
CSV-Datei hat Komma, Dezimalpunkt und ISO-Datum; die Personen werden über Nachname, Vorname und
Geburtsdatum zugeordnet:

```text
Nachname,Vorname,Geburtsdatum,Testdatum,Protokoll,VO2max,Laktatschwelle_W,HFmax
Muster,Anna,2004-03-14,2026-09-14,Stufentest Laufband,61.5,,198
Beispiel,Ben,2006-11-02,2026-09-15,Stufentest Ruderergometer,58.2,310,192
```

Im Produkt dann `sourceType: "dataset"`, `datasetId` = `targetDatasetId` des Connectors und als Quellen
`data.<feld>` (Feld des Datensatzes), `record.observed_at` (Messdatum) oder `athlete.<feld>`:

```sh
DATASET_ID=$(jq -r .targetDatasetId connector.json)   # connector.json aus Schritt 3 mit dieser Vorlage
jq -n --arg d "$DATASET_ID" '{
  slug: "leistungsdiagnostik", name: "Leistungsdiagnostik", sourceType: "dataset", datasetId: $d,
  columns: [
    { key: "sport",     label: "Sportart",  source: "athlete.sport" },
    { key: "test_date", label: "Testdatum", source: "record.observed_at" },
    { key: "protocol",  label: "Protokoll", source: "data.protocol" },
    { key: "vo2max",    label: "VO2max",    source: "data.vo2max" }
  ]
}' | curl -s -b steward.txt -c steward.txt -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' \
      --data-binary @- "$BASE/api/v1/products" | jq '{id, category, columns}'
```

Typ und Einheit der Spalten ergeben sich aus dem Datensatz (z. B. `vo2max`: `number`, `ml/kg/min`); die
Kategorie des Produkts ist die des Datensatzes (`performance`). Freigabe und Abruf wie in Schritten 7–10,
mit einem passenden Zweck (z. B. `performance_diagnostics`).

### Variante: Excel-Datei statt CSV

Die Vorlage `leistungsdiagnostik-xlsx` legt eine Quelle der Art `xlsx_upload` an (gleicher Datensatz,
gleiche Spalten wie `leistungsdiagnostik-csv`). Ihre Konfiguration:

```json
{ "type": "xlsx", "sheet": "", "headerRow": 1, "decimalSeparator": ",", "dateFormat": "DD.MM.YYYY" }
```

`sheet` = Name des Tabellenblatts (leer: erstes Blatt), `headerRow` = Kopfzeile ist die erste nicht leere
Zeile ab dieser Zeilennummer (Titelzeilen davor werden übersprungen). Zahlen- und Datumszellen werden
unabhängig von `decimalSeparator` und `dateFormat` richtig gelesen (Datum als ISO 8601); diese gelten
für Werte, die als Text gespeichert sind. Formeln werden nicht berechnet – übernommen wird das in der
Datei gespeicherte Ergebnis. Hochladen wie in Schritt 4:

```sh
# Spalten, Beispielzeilen und Tabellenblätter ansehen (connectors.inspect)
curl -s -b steward.txt -c steward.txt -H 'X-OSP-CSRF: 1'   -F 'file=@leistungsdiagnostik.xlsx' -F "config=$(jq -c .config connector.json)"   "$BASE/api/v1/connectors/inspect" | jq '{sheets, sheet, columns}'
# Import starten (imports.start) – Vorschau, Prüfung und Fehlerprotokoll wie bei CSV
curl -s -b steward.txt -c steward.txt -H 'X-OSP-CSRF: 1' -F 'file=@leistungsdiagnostik.xlsx'   "$BASE/api/v1/connectors/$CONNECTOR_ID/runs" | jq '.run | {status, totalRows, validRows, failureCode}'
```

Ist die Datei keine lesbare `.xlsx`-Datei, endet der Lauf mit `status: "failed"` und `failureCode:
"invalid_file"`; der Grund steht im Fehlerprotokoll (`params.reason`: `not_xlsx`, `xls_or_encrypted` – alte
`.xls`-Datei oder kennwortgeschützt, `xlsx_corrupt`, `xlsx_too_large` – mehr als 100 MB entpackt oder ein
Zellwert über 1 MB, `xlsx_unsupported` – z. B. ZIP64, `.xlsb`, DTD). Ein nicht vorhandenes Blatt ergibt
`failureCode: "sheet_not_found"` (`params.sheet`). *Beispiel abrufen* meldet dieselben Gründe als 422
`import_failed` mit `reason`. Grenzen wie bei CSV: 20 MB Datei, 500 Spalten, 100 000 Zeilen.

### Variante: API-Quelle mit OAuth2 (Client Credentials)

Die Vorlage `sprungkraft-oauth2-api` zeigt die Konfiguration (`config.auth`):

```json
{ "type": "oauth2_client_credentials", "tokenUrl": "https://login.messsystem.example.org/oauth2/token",
  "clientId": "osp-data-mesh", "scope": "measurements.read", "clientAuth": "basic" }
```

`audience` ist optional; `clientAuth` `basic` sendet Client-Kennung und -Geheimnis per HTTP-Basic
(RFC 6749, 2.3.1), `body` im Formular (`client_id`, `client_secret`). Adressen anpassen
(`PATCH /api/v1/connectors/{id}`), dann das **Client-Geheimnis** wie jedes Zugangsgeheimnis setzen
(`connectors.setSecret`; verschlüsselt gespeichert, nie ausgegeben):

```sh
printf 'Client-Geheimnis: '; read -rs SECRET; echo; export SECRET
jq -n '{secret: env.SECRET}' | curl -s -b steward.txt -c steward.txt -X PUT   -H 'Content-Type: application/json' -H 'X-OSP-CSRF: 1' --data-binary @-   "$BASE/api/v1/connectors/$CONNECTOR_ID/secret"
unset SECRET
curl -s -b steward.txt -c steward.txt -H 'X-OSP-CSRF: 1' -X POST   "$BASE/api/v1/connectors/$CONNECTOR_ID/runs" | jq '.run | {status, totalRows, failureCode}'
```

Der Knoten holt beim Token-Endpunkt ein Zugriffstoken (`grant_type=client_credentials`) und sendet es als
`Authorization: Bearer …` an die Quelle; er hält es im Arbeitsspeicher bis 60 Sekunden vor Ablauf
(`expires_in`, ohne Angabe 5 Minuten, höchstens 1 Stunde) und holt nach einer 401-Antwort der Quelle
einmal ein neues. Fehler des Token-Abrufs: Lauf `failed` mit `failureCode: "source_unreachable"`
(`params.reason`: `oauth_invalid_client` – Client-Kennung oder -Geheimnis falsch, `oauth_invalid_scope`,
`oauth_unauthorized_client`, `token_rejected` mit `params.status`, `token_network`, `token_timeout`,
`secret_missing`) bzw. `invalid_response` (`token_invalid`). Der Host des Token-Endpunkts muss in
`MESH_SOURCE_ALLOWED_HOSTS` stehen (sonst 400 `source_not_allowed`, `reason: token_url_not_allowed`); das
Client-Geheimnis geht nur über HTTPS (bzw. an Loopback-Adressen). Wer Token-Endpunkt oder Client-Kennung
ändert, muss das Geheimnis neu setzen (es wird verworfen, Audit `connector.secret_cleared`).

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
| 400 | `validation_failed`, `password_too_weak`, `source_not_allowed` | Eingabe ungültig (`fields` nennt Feld und Prüfcode, z. B. `"body.slug": "invalid_format"`); **auch ein zu kurzes Passwort** (unter 12 Zeichen) ist `validation_failed` mit `"body.newPassword": "too_small"` (Passwortwechsel) bzw. `"body.password": "too_small"` (Benutzer anlegen, Passwort zurücksetzen). `password_too_weak` = Passwort verletzt eine weitere Regel (`reason`: `equals_email` – gleich der E-Mail-Adresse, `equals_current` – gleich dem bisherigen Passwort). `source_not_allowed` = API-Quelle nicht in `MESH_SOURCE_ALLOWED_HOSTS` (bei OAuth2 auch der Token-Endpunkt: `reason: token_url_not_allowed`) bzw. Zugangsgeheimnis über unverschlüsseltes `http://` (`reason: insecure_http`, siehe [Sicherheit](sicherheit.md#schutz-vor-server-side-request-forgery-ssrf)) |
| 401 | `unauthenticated`, `invalid_credentials` | nicht angemeldet, Sitzung abgelaufen, Token ungültig/abgelaufen/widerrufen; Anmeldung fehlgeschlagen – **einheitlich** für unbekannte E-Mail, falsches Passwort, inaktives und vorübergehend gesperrtes Konto (5 Fehlversuche in Folge → 15 Minuten); der tatsächliche Grund steht nur im Audit-Log |
| 403 | `forbidden`, `csrf_failed`, `access_denied` | Rolle fehlt; `reason: password_change_required` (Initialpasswort noch nicht geändert); `reason: session_required` (Token erzeugen mit einem Token); CSRF-Header fehlt; Freigabe verweigert (`reason` = Ablehnungsgrund, z. B. `purpose_not_allowed`, `expired`, `revoked`) |
| 404 | `not_found` | Objekt oder Route unbekannt |
| 409 | `conflict`, `peer_untrusted` | Zustandskonflikt (`reason` z. B. `email_exists`, `slug_exists` – Connector-Kürzel vergeben, `slug_taken` – Produktkürzel vergeben, `last_admin`, `backup_running`), Partner nicht vertrauenswürdig |
| 413 / 415 | `payload_too_large`, `unsupported_format` | Anfrage zu groß (API 1 MB, Uploads 20 MB; bei *Beispiel abrufen* auch `reason: too_many_columns`, mehr als 500 Spalten) bzw. falscher Inhaltstyp |
| 422 | `import_failed`, `release_invalid` | Antwort einer API-Quelle bzw. Excel-Datei unbrauchbar (*Beispiel abrufen*, `reason` z. B. `invalid_response`, `too_many_rows`, `token_invalid`, `not_xlsx`, `sheet_not_found`) bzw. Freigabe fachlich ungültig (`fields`) |
| 429 | `rate_limited` | zu viele Anmeldeversuche (30 je IP-Adresse in 5 Minuten) bzw. Passwortwechsel (30 je Person in 5 Minuten) |
| 500 | `internal_error`, `backup_failed` | unerwarteter Fehler (Details nur im Server-Log, Request-ID angeben) bzw. Sicherung fehlgeschlagen |
| 502 | `source_unreachable`, `peer_unreachable`, `peer_rejected`, `signature_invalid` | Quelle oder Partner nicht erreichbar bzw. Antwort ungültig (bei *Beispiel abrufen* einer API-Quelle `reason` z. B. `http_401`, `timeout`, `oauth_invalid_client`) |

Der Code `account_locked` (423) steht aus Kompatibilitätsgründen noch in der festen Liste `ERROR_CODES`,
wird aber **nicht mehr geliefert**: Ein gesperrtes Konto erhält bei der Anmeldung dieselbe Antwort 401
`invalid_credentials` wie ein falsches Passwort, damit Außenstehende weder Existenz noch Sperre eines
Kontos erkennen. Gesperrte Konten sieht die Administration unter *Benutzer* (`lockedUntil`).

Die Ablehnungsgründe einer Freigabeprüfung (`reason`) sind in den
[Freigaberegeln](freigaberegeln.md#prüfreihenfolge-ablehnungsgründe) erklärt.
