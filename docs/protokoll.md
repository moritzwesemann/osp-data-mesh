# Föderationsprotokoll osp-mesh/1

Schemas: `src/shared/contract/federation-wire.ts`.

## Vertrauen (Onboarding)

1. Administration von Knoten A lädt die **Knotenkarte** herunter (`GET /api/v1/node/card`):
   `{ format, nodeId, displayName, baseUrl, publicKey, fingerprint }`.
2. Die Karte wird außerhalb des Systems übermittelt (z. B. E-Mail). Knoten B nimmt sie auf
   (`POST /api/v1/peers`) → Status `pending`.
3. Beide Seiten gleichen den **Fingerprint** über einen zweiten Kanal ab (Telefon). Knoten B bestätigt
   (`POST /api/v1/peers/:id/trust` mit dem abgeglichenen Fingerprint) → Status `trusted`.
4. Dasselbe in Gegenrichtung. Ohne beidseitiges Vertrauen ist kein Austausch möglich.

Sperren (`suspended`) beendet sofort jeden Austausch mit dem Partner.

## Transport und Signatur

```
POST {baseUrl}/federation/v1/{type}        type ∈ ping | catalog | pull | notice
Content-Type: application/json
X-Mesh-Node: <nodeId des Absenders>
X-Mesh-Signature: base64(Ed25519(privateKey_Absender, rawBody))

rawBody = {"v":1,"type":"pull","id":"<uuid>","from":"osp-a","to":"osp-b","ts":"<ISO>","body":{…}}
```

Die Signatur deckt exakt die übertragenen Bytes ab (keine Kanonisierung). Prüfungen beim Empfänger,
in dieser Reihenfolge; jeder Fehlschlag wird protokolliert:

1. `X-Mesh-Node` ist ein bekannter Partner (`unknown_node`) und vertrauenswürdig (`untrusted`).
2. Signatur gültig mit dessen gespeichertem Public Key (`bad_signature`).
3. Body entspricht dem Schema, `v = 1`, `from = X-Mesh-Node`, `type` = Pfad (`bad_request`).
4. `to` = eigene nodeId (`wrong_recipient`).
5. `ts` höchstens 5 Minuten Abweichung (`clock_skew`).
6. `id` wurde von diesem Absender noch nicht verwendet (`replay`; Nonces werden 15 Minuten gespeichert).

Die Antwort ist ebenso signiert (`X-Mesh-Node`, `X-Mesh-Signature` über den Antwort-Body):

```
{"v":1,"id":"<uuid>","inReplyTo":"<Anfrage-id>","from":"osp-b","to":"osp-a","ts":"…","ok":true,"body":{…}}
{"v":1,…,"ok":false,"error":{"code":"access_denied","reason":"purpose_not_allowed"}}
```

Der Client prüft Signatur, `from`, `to` und `inReplyTo`; unsignierte oder falsch signierte Antworten
werden verworfen (`signature_invalid`). Die Signatur der Antwort und der SHA-256 des Antwort-Bodys werden
beim Empfänger als **Herkunftsnachweis** gespeichert.

## Nachrichten

| type | Body (Anfrage) | Antwort-Body | Wirkung |
|---|---|---|---|
| `ping` | `{}` | `{nodeId, displayName, time}` | Verbindungsprüfung |
| `catalog` | `{q?}` | `{node, offers[]}` | Katalog: Metadaten teilbarer Produkte + für den Anfragenden gültige Freigaben |
| `pull` | `{releaseId, purpose}` | `{release, columns, rows[{subject, values}], generatedAt}` | Daten gemäß Freigabe |
| `notice` | `release_revoked` oder `subjects_withdrawn` | `{ack, affectedRows}` | Empfänger löscht Kopie bzw. Zeilen |

**Pull**: Der Server prüft die Freigabe über den PEP (Empfänger = anfragender Partner). Zeilen enthalten
statt lokaler IDs ein **freigabebezogenes Pseudonym** (`subject` = HMAC(Knotengeheimnis,
releaseId:athleteId)). Jeder Abruf liefert den vollständigen aktuell zulässigen Stand; der Empfänger
ersetzt seine Kopie (keine Synchronisation, keine Deltas). Der Server protokolliert gelieferte Pseudonyme
im Austauschprotokoll, um spätere Löschmitteilungen zielgenau senden zu können.

**Notice** (vom Datenhalter an den Empfänger, über das Ausgangspostfach mit Wiederholungen):

- `release_revoked {releaseId, reason}` – Freigabe widerrufen oder Produkt stillgelegt: Empfänger löscht
  alle Zeilen der Kopie und markiert sie als widerrufen.
- `subjects_withdrawn {releaseId, subjects[], reason: consent_withdrawn|erasure}` – Einwilligung
  widerrufen oder Person gelöscht: Empfänger löscht die Zeilen dieser Pseudonyme.

Eine Mitteilung wird nur vom Knoten akzeptiert, der die Freigabe erteilt hat (Absender = Datenhalter).

## Discovery ohne zentrale Stelle

Die Suche (`GET /api/v1/discovery`) fragt parallel alle vertrauenswürdigen Partner per `catalog` ab
(Zeitlimit je Partner) und zeigt die Ergebnisse je Partner mit Status (`ok`, `unreachable`, `rejected`,
`error`). Ergebnisse werden nicht dauerhaft gespeichert.
