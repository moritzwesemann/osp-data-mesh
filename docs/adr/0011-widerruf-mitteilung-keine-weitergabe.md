# ADR 0011: Widerruf per signierter Mitteilung und Ausgangspostfach; keine Weitergabe empfangener Daten

## Status

angenommen

Datum: 2026-11-04

## Kontext

Nach einem Widerruf, einem Einwilligungswiderruf oder einer Löschung müssen bereits übermittelte Kopien
bei Partnern gelöscht werden (S11, Art. 17/19 DSGVO). Partner können zeitweise nicht erreichbar sein.
Zudem soll verhindert werden, dass Daten über Zwischenknoten an Dritte gelangen, die der Datenhalter
nicht kennt.

## Entscheidung

- Widerruf, Stilllegung, Einwilligungswiderruf und Löschung erzeugen in derselben Transaktion eine
  **Mitteilung im Ausgangspostfach** (`release_revoked` bzw. `subjects_withdrawn` mit den gelieferten
  Pseudonymen).
- Das Ausgangspostfach stellt **signiert** zu und wiederholt mit exponentiellem Abstand (bis 1 h, bis zu
  20 Versuche); Zustellung und Bestätigung (Zeilenzahl) werden protokolliert.
- Empfänger akzeptieren Mitteilungen nur vom Datenhalter der Freigabe und löschen automatisch.
- Empfänger löschen Kopien zusätzlich selbstständig bei Ablauf der Freigabe und wenn ein erneuter Abruf
  wegen Widerruf/Ablauf/Stilllegung abgelehnt wird.
- **Empfangene Daten können nicht weitergegeben werden:** Sie sind keine Quelle für Datenprodukte und
  damit weder lokal, noch an Partner, noch an BI freigebbar. Dritte benötigen eine eigene Freigabe des
  Datenhalters.

## Konsequenzen

- Widerrufe erreichen Partner auch nach vorübergehenden Ausfällen; der Zustand ist im Ausgangspostfach
  sichtbar.
- Technisch kann ein Knoten nicht erzwingen, dass ein fremder Knoten löscht; dafür sind vertragliche
  Regeln und die Protokolle beider Seiten als Nachweis nötig.
- Exporte empfangener Daten (für Auswertungen) bleiben möglich und werden protokolliert; ihre Weitergabe
  ist organisatorisch zu untersagen.
- Endgültig fehlgeschlagene Mitteilungen erfordern manuelles Nachfassen (erneute Zustellung ist ein
  offener Punkt).
