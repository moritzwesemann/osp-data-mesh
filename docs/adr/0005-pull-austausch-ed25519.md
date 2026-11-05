# ADR 0005: Pull-basierter Austausch mit Ed25519-Signaturen auf Anfrage und Antwort

## Status

angenommen

Datum: 2026-11-04

## Kontext

Knoten sollen ohne zentrale Stelle kontrolliert Daten austauschen (A1, A2, M3, S1). Jede Lieferung muss
dem anfragenden Partner zweifelsfrei zuzuordnen und für beide Seiten nachweisbar sein. Optionen waren
Push (Datenhalter sendet), Synchronisation, mTLS, signierte JSON-Dokumente mit Kanonisierung (JWS/JCS)
oder HTTP-Message-Signatures.

## Entscheidung

- **Pull:** Der Empfänger ruft ein freigegebenes Produkt ab; jede Antwort enthält den vollständigen aktuell
  zulässigen Stand und ersetzt die bisherige Kopie (keine Deltas, keine Synchronisation). Nur
  Mitteilungen (Widerruf, Löschung) werden vom Datenhalter aktiv gesendet.
- Jeder Knoten hat ein **Ed25519-Schlüsselpaar**; Vertrauen entsteht nur durch manuellen
  Fingerprint-Abgleich.
- **Anfrage und Antwort** werden über die **exakten Body-Bytes** signiert (Header `X-Mesh-Node`,
  `X-Mesh-Signature`); **keine Kanonisierung**. Umschlag mit Version, Typ, Nonce, Absender, Empfänger,
  Zeitstempel; Antworten mit `inReplyTo`.
- **TLS zusätzlich** über Caddy für Vertraulichkeit; Signaturen sichern Herkunft und Integrität
  unabhängig vom TLS-Endpunkt und dienen als speicherbarer Herkunftsnachweis.

## Konsequenzen

- Einfache, gut prüfbare Implementierung mit `node:crypto`; keine Abhängigkeit von JSON-Kanonisierung.
- Der Empfänger muss die Rohbytes vor dem Parsen prüfen (umgesetzt im Föderationsmodul).
- Der Föderationsendpunkt ist ohne Anmeldung erreichbar und muss sich selbst schützen: Absenderprüfung,
  bevor der Body gelesen wird, Größengrenzen (Anfragen 2 MB, Antworten 50 MB), Ratenbegrenzung und
  zusammengefasstes Audit abgelehnter Anfragen ([Protokoll](../protokoll.md#schutz-vor-überflutung)).
- Replay-Schutz über Nonces (15 min) und Zeitfenster (± 5 min) erfordert synchronisierte Uhren (NTP).
- Pull bedeutet: Berichtigungen erreichen Partner erst beim nächsten Abruf; Löschungen und Widerrufe
  werden aktiv mitgeteilt ([ADR 0011](0011-widerruf-mitteilung-keine-weitergabe.md)).
- Schlüsselwechsel eines Knotens erfordert erneute Vertrauensaufnahme (Werkzeug offen). *Ergänzung
  2026-11-05:* planmäßiger Wechsel mit signierter Mitteilung ohne erneute Vertrauensaufnahme siehe
  [ADR 0013](0013-knotenschluessel-rotation.md).
