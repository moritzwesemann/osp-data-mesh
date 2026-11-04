# Widerruf und Weitergabe

Handlungskonzept für widerrufene oder weitergegebene Daten (Anforderung S11): Was geschieht technisch und
organisatorisch, wenn eine Freigabe endet, eine Einwilligung widerrufen oder eine Person gelöscht wird –
und wie mit der Weitergabe empfangener Daten umzugehen ist.

## Grundprinzipien

1. **Der Datenhalter entscheidet.** Nur der Knoten, der eine Freigabe erteilt hat, kann sie widerrufen und
   Löschmitteilungen dazu senden; Mitteilungen anderer Absender werden abgewiesen.
2. **Widerruf wirkt sofort für künftige Zugriffe**: Der Policy Enforcement Point prüft bei jeder Ausgabe
   (lokal, BI, Partner) den aktuellen Stand.
3. **Bereits übermittelte Kopien** werden über **signierte Mitteilungen** zur Löschung angewiesen; der
   Empfänger löscht automatisch und bestätigt (Zeilenzahl).
4. **Keine Weitergabe empfangener Daten:** Empfangene Daten können technisch nicht erneut freigegeben
   werden. Wer sie benötigt, braucht eine eigene Freigabe des Datenhalters.
5. **Alles ist nachweisbar:** Audit-Log und Austauschprotokoll beider Seiten dokumentieren Lieferung,
   Mitteilung und Bestätigung.

## Übersicht der Fälle

| Auslöser | Wirkung beim Datenhalter | Wirkung in der BI-Schnittstelle | Wirkung beim Partner |
|---|---|---|---|
| **Freigabe widerrufen** (*Freigaben › Widerrufen*, mit Begründung) | keine weitere Ausgabe (`revoked`) | View wird in derselben Transaktion entfernt | Mitteilung `release_revoked` → Partner löscht **alle** Zeilen der Kopie, Status *widerrufen* |
| **Datenprodukt stillgelegt** | alle Freigaben des Produkts enden (`product_inactive`) | Views entfallen | `release_revoked` (Grund `product_retired`) für jede bereits belieferte Partnerfreigabe |
| **Datenprodukt geändert** (Spalten/Filter) | bestehende Freigaben *veraltet* (`product_changed`), liefern nichts mehr | Views liefern keine Zeilen mehr | keine Mitteilung; die zuletzt gelieferte Kopie bleibt bis zu Ablauf/Widerruf bestehen (siehe Hinweis unten) |
| **Freigabe abgelaufen** (`validUntil` erreicht) | keine weitere Ausgabe (`expired`) | View prüft die Gültigkeit bei jeder Abfrage in SQL → sofort leer | Partner kennt das Ablaufdatum und **löscht die Kopie selbstständig** (minütliche Prüfung), auch ohne Verbindung |
| **Einwilligung widerrufen** (*Person › Einwilligung › Widerruf erfassen*) | Person entfällt sofort bei Freigaben mit Einwilligungsprüfung, deren Zweck und Kategorie der Widerruf erfasst | Zeilen der Person werden in derselben Transaktion entfernt | Mitteilung `subjects_withdrawn` (Grund `consent_withdrawn`) mit den Pseudonymen der Person je betroffener Freigabe → Partner löscht diese Zeilen |
| **Person gelöscht** (Recht auf Löschung) | Person und alle zugehörigen Daten gelöscht | Zeilen entfernt | `subjects_withdrawn` (Grund `erasure`) an **alle** Partner, die Daten der Person erhalten haben |
| **Partner gesperrt** | jede Anfrage des Partners abgewiesen | – | Partner erhält keine neuen Daten; bestehende Kopie: Freigaben zusätzlich widerrufen |

Welche Partner Daten einer Person erhalten haben, ergibt sich aus dem **Austauschprotokoll**: Der
Datenhalter speichert bei jeder Lieferung die übermittelten Pseudonyme. Daraus werden die Mitteilungen
zielgenau erzeugt.

**Hinweis zu Produktänderungen:** Eine Änderung macht Freigaben ungültig, damit nie unbemerkt *mehr* Daten
fließen. Die vorher rechtmäßig gelieferte Kopie beim Partner wird dadurch nicht gelöscht. Soll sie
gelöscht werden, die alte Freigabe ausdrücklich **widerrufen** (erzeugt `release_revoked`) und bei Bedarf
eine neue Freigabe erteilen.

**Empfehlung:** Partnerfreigaben immer mit **Gültigkeitsende** (`validUntil`) erteilen. Dann löscht der
Empfänger seine Kopie auch dann rechtzeitig, wenn eine Mitteilung ihn nicht erreicht.

## Ablauf einer Mitteilung

```
Datenhalter                                            Empfänger
-----------                                            ---------
Widerruf/Löschung (Transaktion):
  Änderung + Audit-Eintrag + Eintrag im Ausgangspostfach
          │
Ausgangspostfach (alle 5 s)
  POST /federation/v1/notice  ── signiert (Ed25519) ──▶  prüft Absender, Signatur, Zeit, Replay,
                                                         Absender = Datenhalter der Freigabe
                                                         löscht Zeilen der Kopie bzw. der Pseudonyme
          ◀── signierte Antwort {ack, affectedRows} ──   Audit: exchange.notice.received
Status "zugestellt", Audit: exchange.notice.sent
```

**Partner nicht erreichbar:** Die Mitteilung bleibt im Ausgangspostfach und wird mit wachsendem Abstand
wiederholt (10 s, 20 s, 40 s … höchstens 1 h). Nach **20 Fehlversuchen** (rund 11–12 Stunden) erhält sie
den Status *fehlgeschlagen* (Audit `exchange.notice.failed`) und erscheint unter *Partner ›
Ausgangspostfach*; `system.status` zählt sie unter `outbox.failed`. *Jetzt zustellen* stößt ausstehende
Mitteilungen sofort an. Endgültig fehlgeschlagene Mitteilungen werden im Prototyp **nicht automatisch
erneut** versucht (offener Punkt); dann gilt das Vorgehen „Partner reagiert nicht“.

Unabhängig davon kann der Partner nach einem Widerruf keine neuen Daten mehr abrufen. Versucht er es, wird
die Anfrage abgelehnt (`revoked`, `expired` oder `product_inactive`), und der Partnerknoten löscht seine
Kopie daraufhin ebenfalls.

## Weitergabe empfangener Daten

**Technisch nicht unterstützt** ([ADR 0011](adr/0011-widerruf-mitteilung-keine-weitergabe.md)):

- Empfangene Daten liegen getrennt (`received_product`, `received_row`) und können **nicht** Quelle eines
  Datenprodukts sein. Damit können sie weder lokal noch an Partner noch an die BI-Schnittstelle
  freigegeben werden.
- Empfangene Daten sind nur für Personen mit den Rollen `data_steward` oder `analyst` des Empfängerknotens
  einsehbar; jeder Zugriff wird protokolliert (`received.read`).
- Ein Export empfangener Zeilen (CSV/JSON/XML) ist für die Auswertung möglich. Die Weitergabe solcher
  Exporte an Dritte ist **organisatorisch und vertraglich untersagt**; der Export ist im Audit-Log
  nachvollziehbar.

**Ein Dritter benötigt eine eigene Freigabe des Datenhalters:** Der dritte Knoten nimmt mit dem
Datenhalter gegenseitiges Vertrauen auf (Knotenkarte, Fingerprint), der Datenhalter erteilt eine eigene
Freigabe mit eigenem Zweck und eigenen Beschränkungen. So bleiben Widerruf, Löschung und Nachweis beim
Datenhalter steuerbar, und der Dritte erhält eigene, nicht verknüpfbare Pseudonyme.

## Partner reagiert nicht oder löscht nicht

Technisch kann ein Knoten Daten in einem fremden Knoten nicht löschen. Vorgehen:

1. **Feststellen:** Mitteilung im Ausgangspostfach *fehlgeschlagen* oder ohne Bestätigung; der letzte
   Kontakt (`lastSeenAt`, `lastError`) steht beim Partner.
2. **Kontakt** mit der Partner-Administration (Telefon/E-Mail aus der Austauschvereinbarung), Löschung
   anfordern und **schriftlich bestätigen lassen** (Löschprotokoll des Partners: Audit-Eintrag
   `exchange.notice.received` bzw. `received.delete`).
3. Bei Bedarf weitere Freigaben an den Partner **widerrufen** und den Partner **sperren**.
4. **Nachweise sichern:** Export des Audit-Logs und des Austauschprotokolls (was wurde wann geliefert –
   Spalten, Zeilenzahl, Pseudonyme, Prüfsumme –, wann wurde die Mitteilung erzeugt, welche Zustellversuche
   gab es). Die signierten Antworten des Partners belegen frühere Lieferungen und Bestätigungen.
5. **Eskalation** nach der Austauschvereinbarung (Vertragsstrafe, Prüfrechte), Information der
   Datenschutzbeauftragten; bei Risiko für Betroffene Prüfung einer Meldung nach Art. 33/34 DSGVO
   ([Incident Response](incident-response.md)).

## Organisatorische Voraussetzungen

- **Austauschvereinbarung** zwischen den OSP: Zwecke, Löschpflicht bei Mitteilung und bei Ablauf,
  Weitergabeverbot, Ansprechpersonen, Nachweis- und Prüfrechte, Reaktionszeiten.
- **Betrieb des Ausgangspostfachs** überwachen (`outbox.failed`, siehe [Betrieb](betrieb.md#überwachung)).
- **Nach einer Wiederherstellung** aus der Sicherung: Widerrufe und Löschungen nach dem
  Sicherungszeitpunkt wiederholen ([Betrieb](betrieb.md#wiederherstellung)).
- Datenverantwortliche dokumentieren Widerrufe von Einwilligungen zeitnah im System, damit die
  Mitteilungen an Partner ausgelöst werden.
