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

Sperren (`suspended`) beendet sofort jeden Austausch mit dem Partner. Einzige Ausnahme: **Mitteilungen**
(`notice`) des gesperrten Partners werden weiter angenommen. Sie können beim Empfänger nur Daten löschen, die
von genau diesem Partner stammen (Widerruf, Löschung einer Person, Einwilligungswiderruf); ohne die Ausnahme
blieben nach einer Sperre Kopien bestehen, die der Datenhalter löschen lassen will. Ausstehende (`pending`)
und unbekannte Knoten werden auch mit Mitteilungen abgewiesen.

## Transport und Signatur

```
POST {baseUrl}/federation/v1/{type}        type ∈ ping | catalog | pull | notice
Content-Type: application/json
X-Mesh-Node: <nodeId des Absenders>
X-Mesh-Signature: base64(Ed25519(privateKey_Absender, rawBody))

rawBody = {"v":1,"type":"pull","id":"<uuid>","from":"osp-a","to":"osp-b","ts":"<ISO>","body":{…}}
```

Die Signatur deckt exakt die übertragenen Bytes ab (keine Kanonisierung). Anfragen sind höchstens **2 MB**
groß (Antworten bis 50 MB). Prüfungen beim Empfänger, in dieser Reihenfolge; jeder Fehlschlag wird signiert
beantwortet und protokolliert (siehe [Schutz vor Überflutung](#schutz-vor-überflutung)):

1. `X-Mesh-Node` ist ein bekannter Partner (`unknown_node`) und vertrauenswürdig (`untrusted`); von
   gesperrten Partnern nur `notice`. Geprüft, **bevor der Body gelesen wird**: von nicht zugelassenen
   Absendern wird nur der Anfang (4 KB) nach der Anfrage-id für `inReplyTo` durchsucht.
2. Signatur gültig mit dessen gespeichertem Public Key (`bad_signature`). Ein Body über 2 MB wird nicht
   weiter gelesen (`bad_request`, Grund `payload_too_large`; bei angekündigter Länge über 2 MB vorher
   HTTP 413 `payload_too_large`, unsigniert).
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
werden verworfen (`signature_invalid`). Ausnahmen: HTTP 429 sowie 502/503/504 ohne Signatur gelten als
`peer_unreachable` (später erneut versuchen). Die Signatur der Antwort und der SHA-256 des Antwort-Bodys werden
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

- `release_revoked {releaseId, reason}` – Freigabe widerrufen (`reason` = Begründung), Produkt stillgelegt
  (`product_retired`) oder Datensatz neu eingestuft (`dataset_reclassified`, siehe
  [Freigaberegeln](freigaberegeln.md#erteilen-ändern-widerrufen)): Empfänger löscht alle Zeilen der Kopie
  und markiert sie als widerrufen.
- `subjects_withdrawn {releaseId, subjects[], reason: consent_withdrawn|erasure}` – Einwilligung
  widerrufen oder Person gelöscht: Empfänger löscht die Zeilen dieser Pseudonyme.

Eine Mitteilung wirkt nur auf Kopien, die vom Absender stammen (Absender = Datenhalter, der die Freigabe
erteilt hat) – auch wenn der Empfänger den Datenhalter gesperrt hat (siehe oben).

Das Ausgangspostfach wiederholt fehlgeschlagene Zustellungen mit wachsendem Abstand (10 s, 20 s, 40 s …
höchstens 1 h). Nach 20 Fehlversuchen erhält die Mitteilung den Status `failed`. *Jetzt zustellen*
(`POST /api/v1/outbox/flush`) setzt solche Mitteilungen wieder auf ausstehend und stellt sie sofort zu
(Audit `outbox.requeue`); die Zahl der Versuche bleibt erhalten, scheitert auch dieser Versuch, ist die
Mitteilung sofort wieder `failed`. Der Hintergrundlauf versucht fehlgeschlagene Mitteilungen nicht erneut.

## Schutz vor Überflutung

Abgelehnte Anfragen (Prüfungen 1–6) können von jedem kommen, auch ohne gültige Signatur. Damit sie weder
das Audit-Log fluten noch den Knoten belasten (`src/server/modules/federation/guard.ts`, je Prozess im
Speicher):

- **Betriebslog:** jede Ablehnung (Code, Typ, behaupteter Absender, IP-Adresse, Request-ID).
- **Audit-Log** (`federation.request.rejected`): je Quelle (IP-Adresse + bekannter Partner bzw. „unbekannt“)
  und Code nur die erste Ablehnung je 5 Minuten, insgesamt höchstens 20 je 5 Minuten. Der nächste Eintrag
  derselben Quelle nennt die Zahl der dazwischen nur geloggten Ablehnungen (`details.suppressed`).
  Ablehnungen durch die Nachrichtenverarbeitung selbst (frische, gültig signierte Nachricht eines
  zugelassenen Partners, z. B. `exchange.pull.denied`) werden weiterhin einzeln auditiert.
- **Ratenbegrenzung:** nach 60 Ablehnungen je IP-Adresse in 5 Minuten antwortet der Knoten mit HTTP 429
  (`rate_limited`, unsigniert, `Retry-After`), ohne die Datenbank zu fragen oder den Body zu lesen. Ebenso
  nach 60 Ablehnungen je behauptetem Absender (`X-Mesh-Node`) – aber nur, wenn dieser kein zugelassener
  Partner ist: die Kennung kann jeder fälschen, und ein echter Partner darf dadurch nicht ausgesperrt
  werden (für ihn entscheidet die Signatur). Die 429-Antworten selbst werden ebenso zusammengefasst
  auditiert (Code `rate_limited`).

Voraussetzung ist die richtige Client-Adresse: hinter Caddy `MESH_TRUST_PROXY=true` **und** die Adresse
von Caddy in `MESH_TRUSTED_PROXIES` (nativ Standard `127.0.0.1,::1`, Docker `172.31.252.10`), sonst teilen
sich alle Anfragen die Adresse des Proxys. `X-Forwarded-For` wird nur von diesen Adressen angenommen; es
zählt die rechteste Adresse der Kette, die kein vertrauenswürdiger Proxy ist (siehe
[Betrieb](betrieb.md#föderationsendpunkt-größen-ratenbegrenzung-protokollierung)).

## Discovery ohne zentrale Stelle

Die Suche (`GET /api/v1/discovery`) fragt parallel alle vertrauenswürdigen Partner per `catalog` ab
(Zeitlimit je Partner) und zeigt die Ergebnisse je Partner mit Status (`ok`, `unreachable`, `rejected`,
`error`). Ergebnisse werden nicht dauerhaft gespeichert.
