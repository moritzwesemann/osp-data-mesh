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
blieben nach einer Sperre Kopien bestehen, die der Datenhalter löschen lassen will. Mitteilungen, die nicht
löschen – Schlüsselwechsel (`key_rotated`) und Prüfpunkte der Audit-Kette (`audit_checkpoint`) –, weist der
Empfänger bei gesperrten Partnern ab (`untrusted`, protokolliert). Ausstehende (`pending`) und unbekannte
Knoten werden auch mit Mitteilungen abgewiesen.

## Transport und Signatur

```
POST {baseUrl}/federation/v1/{type}        type ∈ ping | catalog | pull | notice | checkpoints
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
2. Signatur gültig mit dessen gespeichertem Public Key – nach einem
   [Schlüsselwechsel](#schlüsselwechsel) des Partners bis zum Ende der Übergangszeit auch mit dem bisherigen
   (`bad_signature`). Ein Body über 2 MB wird nicht
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

Der Client prüft Signatur (gespeicherter bzw. in der Übergangszeit bisheriger Schlüssel des Partners),
`from`, `to` und `inReplyTo`; unsignierte oder falsch signierte Antworten werden verworfen
(`signature_invalid`). Ausnahmen: HTTP 429 sowie 502/503/504 ohne Signatur gelten als
`peer_unreachable` (später erneut versuchen). Die Signatur der Antwort und der SHA-256 des Antwort-Bodys werden
beim Empfänger als **Herkunftsnachweis** gespeichert.

## Nachrichten

| type | Body (Anfrage) | Antwort-Body | Wirkung |
|---|---|---|---|
| `ping` | `{}` | `{nodeId, displayName, time}` | Verbindungsprüfung |
| `catalog` | `{q?}` | `{node, offers[]}` | Katalog: Metadaten teilbarer Produkte + für den Anfragenden gültige Freigaben |
| `pull` | `{releaseId, purpose}` | `{release, columns, rows[{subject, values}], generatedAt}` | Daten gemäß Freigabe |
| `notice` | `release_revoked`, `subjects_withdrawn`, `key_rotated` oder `audit_checkpoint` | `{ack, affectedRows}` | Empfänger löscht Kopie bzw. Zeilen, übernimmt einen neuen Schlüssel oder verwahrt einen Prüfpunkt |
| `checkpoints` | `{afterSeq, afterEpoch?, limit ≤ 1000}` | `{checkpoints[{statement, signature}], more}` | eigene, beim Partner verwahrte Prüfpunkte der Audit-Kette abrufen |

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

- `key_rotated {statement, signatureOld, signatureNew}` – Schlüsselwechsel des Absenders, siehe
  [Schlüsselwechsel](#schlüsselwechsel).
- `audit_checkpoint {statement, signature}` – Prüfpunkt der Audit-Kette des Absenders, siehe
  [Prüfpunkte der Audit-Kette](#prüfpunkte-der-audit-kette).

Eine Lösch- oder Widerrufsmitteilung wirkt nur auf Kopien, die vom Absender stammen (Absender =
Datenhalter, der die Freigabe erteilt hat) – auch wenn der Empfänger den Datenhalter gesperrt hat (siehe
oben).

Das Ausgangspostfach wiederholt fehlgeschlagene Zustellungen mit wachsendem Abstand (10 s, 20 s, 40 s …
höchstens 1 h). Nach 20 Fehlversuchen erhält die Mitteilung den Status `failed`. *Jetzt zustellen*
(`POST /api/v1/outbox/flush`) setzt solche Mitteilungen wieder auf ausstehend und stellt sie sofort zu
(Audit `outbox.requeue`); die Zahl der Versuche bleibt erhalten, scheitert auch dieser Versuch, ist die
Mitteilung sofort wieder `failed`. Der Hintergrundlauf versucht fehlgeschlagene Mitteilungen nicht erneut.

## Schlüsselwechsel

[ADR 0013](adr/0013-knotenschluessel-rotation.md). Ein planmäßiger Wechsel (*Partner › Eigene Knotenkarte ›
Schlüssel wechseln*, `bun run cli rotate-node-key --routine`) erzeugt ein neues Schlüsselpaar und die
**Rotationsaussage** (exakt signierte JSON-Zeichenkette, keine Kanonisierung):

```
statement = {"format":"osp-data-mesh/key-rotation@1","nodeId":"osp-a","oldPublicKey":"<base64>",
             "newPublicKey":"<base64>","rotatedAt":"<ISO>","graceUntil":"<ISO>"}
notice    = {"kind":"key_rotated","statement":"<statement>","signatureOld":"<Ed25519(alt)>","signatureNew":"<Ed25519(neu)>"}
```

`signatureOld` beweist die Kontinuität (nur der Inhaber des vertrauten Schlüssels kann wechseln),
`signatureNew` den Besitz des neuen Schlüssels. Die Mitteilung geht über das Ausgangspostfach an alle
Partner mit Status `trusted` oder `suspended`; ihr Umschlag ist mit dem **bisherigen** Schlüssel signiert.

**Übergangszeit** (1–30 Tage, Standard 7): Für jeden Partner, der die Mitteilung noch nicht mit einer
gültig signierten Antwort bestätigt hat, signiert der Knoten Anfragen und Antworten weiter mit dem
bisherigen Schlüssel; für alle anderen (auch neu aufgenommene) mit dem neuen. Danach wird der bisherige
private Schlüssel gelöscht; noch offene Mitteilungen werden `failed` (`key_rotation_expired`). Während einer
laufenden Übergangszeit ist kein weiterer planmäßiger Wechsel möglich (`conflict`,
`key_rotation_in_progress`).

**Empfänger** übernehmen den neuen Schlüssel nur, wenn der Absender vertrauenswürdig ist, beide Signaturen
stimmen, `nodeId` passt, die Aussage beim **gespeicherten** Schlüssel beginnt und der Umschlag mit genau
diesem signiert ist (nicht mit einem bisherigen Schlüssel aus einer Übergangszeit), und wenn der neue
Schlüssel weder der eigene noch der eines anderen Partners ist. Danach gilt der neue Schlüssel; der
bisherige wird bis `graceUntil` (höchstens 30 Tage) zusätzlich angenommen, aber nie für eine weitere
Rotationsmitteilung. Ablehnungen: `untrusted` (gesperrt), `bad_signature` (`rotation_proof_invalid`,
`previous_key`), `bad_request` (`stale_key`, `wrong_node`, `invalid_statement`, `own_key`,
`public_key_in_use`); alle protokolliert (`peer.key_rotation.rejected`). Eine bereits übernommene Aussage
– oder eine, deren neuer Schlüssel beim Empfänger schon gespeichert ist (manuell eingetragen, s. u.) – wird
ohne Änderung bestätigt (`affectedRows: 0`); ein wiederholter Umschlag scheitert am Replay-Schutz.

**Neuer Schlüssel beim Partner schon manuell eingetragen** (Partner hat die Mitteilung verpasst und während
der Übergangszeit `peers.replaceKey` benutzt): Er lehnt alles ab, was noch mit dem bisherigen Schlüssel
signiert ist (`bad_signature`). Lehnt ein Partner eine Anfrage, die während der Übergangszeit mit dem
bisherigen Schlüssel signiert war, mit `bad_signature` ab, wiederholt der Client sie **einmal** mit dem
neuen Schlüssel (neuer Umschlag, neue id). Gelingt das, kennt der Partner den neuen Schlüssel nachweislich:
Er gilt als bestätigt (Audit `node.key_rotation.confirmed`, `via: new_key_accepted`), Anfragen und
Antworten für ihn werden ab dann mit dem neuen Schlüssel signiert. Das gilt auch für die
Rotationsmitteilung selbst, die der Partner dann ohne Änderung bestätigt. Scheitert auch die Wiederholung,
bleibt es beim ursprünglichen Fehler.

**Verpasste Mitteilung** (Partner über die ganze Übergangszeit nicht erreichbar, Absender beim Empfänger
gesperrt oder ausstehend, Partner beim wechselnden Knoten nur ausstehend und daher nicht benachrichtigt):
Der Empfänger lehnt danach Nachrichten des Knotens ab. Er trägt die neue
Knotenkarte unter *Partner › Neuen Schlüssel eintragen* ein (`peers.replaceKey`: gleiche Knoten-ID,
bisheriger Schlüssel gilt sofort nicht mehr, Status `pending`) und bestätigt das Vertrauen nach
telefonischem Fingerprint-Abgleich.

**Verdacht auf Kompromittierung** (`rotate-node-key --compromised --yes` bzw. Anlass „Verdacht auf
Kompromittierung“): neuer Schlüssel **ohne** Mitteilung und ohne Übergangszeit – eine mit dem alten
Schlüssel signierte Mitteilung wäre nicht vertrauenswürdig. Partner sperren den Knoten, tragen die neue
Karte ein und gleichen den Fingerprint telefonisch ab ([Betrieb](betrieb.md#knotenschlüssel-ed25519)).

## Prüfpunkte der Audit-Kette

[ADR 0014](adr/0014-externe-verankerung-audit-kette.md). Der Knoten signiert stündlich
(`MESH_AUDIT_CHECKPOINT_HOURS`) und auf Anforderung Epoche, Laufnummer und Hash des Kopfes seiner
Audit-Kette:

```
statement = {"format":"osp-data-mesh/audit-checkpoint@1","nodeId":"osp-a","epoch":"<uuid>","seq":1234,
             "hash":"<sha256 hex>","at":"<ISO>"}
notice    = {"kind":"audit_checkpoint","statement":"<statement>","signature":"<Ed25519(aktueller Schlüssel)>"}
```

**Epoche:** Jede Wiederherstellung einer Sicherung beginnt eine neue Epoche der Kette (`restore`); danach
vergibt der Knoten Laufnummern erneut. Aussagen ohne `epoch` stammen von Knoten vor Migration 0610 und
gelten als Aussagen der ersten Epoche.

Empfänger verwahren den Prüfpunkt je **(Partner, Epoche, Laufnummer)**, nur von vertrauenswürdigen
Partnern und nur mit gültiger Signatur (`checkpoint_signature_invalid`):

| Fall | Antwort | Audit |
|---|---|---|
| gleiche Epoche und Laufnummer, gleicher Hash (Wiederholung) | bestätigt, `affectedRows: 0` | – |
| gleiche Epoche und Laufnummer, anderer Hash | `bad_request` `checkpoint_conflict`, Original bleibt | `audit.checkpoint.conflict` (`denied`) |
| Laufnummer kleiner als die höchste verwahrte derselben Epoche **mit demselben signierenden Schlüssel** (Prüfpunkte eines gestohlenen, inzwischen ersetzten Schlüssels blockieren die des neuen nicht) | `bad_request` `checkpoint_not_increasing` | `audit.checkpoint.rejected`, zusammengefasst* (mit `fingerprint`) |
| mehr als `MESH_AUDIT_CHECKPOINT_MAX_PER_DAY` (Standard 48) neue Prüfpunkte dieses Partners in 24 h | `bad_request` `checkpoint_rate_limited` | `audit.checkpoint.rejected`, zusammengefasst* |
| ohne `epoch`, obwohl der Partner schon Prüfpunkte mit Epoche gesendet hat | `bad_request` `checkpoint_epoch_required` | `audit.checkpoint.rejected` |
| neue Epoche des Partners (nach dessen Wiederherstellung) | angenommen, auch mit kleinerer Laufnummer | zusätzlich `audit.checkpoint.epoch_changed` (bisherige Epochen) |
| sonst | angenommen, `affectedRows: 1` | `audit.checkpoint.received` |

\* wie bei der Protokollprüfung (Abschnitt [Schutz vor Überflutung](#schutz-vor-überflutung)): je Partner
und Grund nur die erste Ablehnung je 5 Minuten im Audit-Log, die nächste nennt `suppressed`; jede im
Betriebslog.

Alle Prüfungen der Tabelle laufen in derselben Transaktion wie das Verwahren, unter einer Sperre je Partner
(ADR 0014, Nachtrag 2): gleichzeitige Zustellungen können Reihenfolge und Ratenbegrenzung nicht
unterlaufen.

Mit `checkpoints {afterSeq, afterEpoch, limit}` ruft ein Knoten die bei einem Partner hinterlegten eigenen
Prüfpunkte ab (nur die eigenen, aufsteigend nach Laufnummer und Epoche; `afterEpoch` ist die Epoche des
letzten Eintrags der vorigen Seite, `""` für Aussagen ohne Epoche; `more` = weitere Seiten). Ohne
`afterEpoch` gilt nur `seq > afterSeq` (ältere Clients). Der Abgleich berechnet die eigene Kette im Programm
neu und verlangt, dass sie diese Paare (seq, hash) enthält – für Prüfpunkte früherer Epochen nur bis zur bei
der Wiederherstellung übernommenen Laufnummer (dahinter: „durch Wiederherstellung verloren“). Gültig sind
nur Signaturen eigener Schlüssel innerhalb ihres Gültigkeitszeitraums; Abweichungen, die mit einem wegen
Kompromittierung abgelösten Schlüssel signiert sind, gelten nicht als Beweis
([Betrieb](betrieb.md#externe-verankerung-bei-den-partnern)).

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
