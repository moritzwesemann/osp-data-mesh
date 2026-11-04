# ADR 0004: Freigabelogik als reine Funktionen und ein einziger Policy Enforcement Point

## Status

angenommen

Datum: 2026-11-04

## Kontext

Freigaben beschränken Daten nach Empfänger, Spalten, Zeilen, Datenzeitraum, Gültigkeit, Zweck und
Einwilligung (A2, A3, R1–R4). Fehler in dieser Logik führen unmittelbar zu Datenschutzverletzungen. Daten
verlassen einen Knoten auf vier Wegen: Abruf/Export in der Oberfläche, REST, BI-Schnittstelle und
Partnerabruf. Eine Umsetzung in SQL (Row-Level-Security, generierte Abfragen) wäre schwerer zu testen und
für alle Wege einheitlich zu halten.

## Entscheidung

- Die Regeln sind **reine Funktionen** in `src/server/modules/releases/engine.ts` (keine Datenbank, keine
  Uhr, keine Ein-/Ausgabe) und vollständig mit Unit-Tests abgedeckt.
- Es gibt **einen einzigen Policy Enforcement Point** `services.pep.serve()`: Er lädt Freigabe, Produkt,
  Zeilen und Einwilligungen und wendet die Regeln an. Alle vier Ausgabewege nutzen ausschließlich ihn.
- Die Auswertung erfolgt **in TypeScript** nach dem Laden der Produktzeilen. Mengengerüst: tausende
  Zeilen je OSP und Produkt; das ist im Speicher in Millisekunden auswertbar.
- Deny by default; eine feste Prüfreihenfolge mit Ablehnungsgründen ([Freigaberegeln](../freigaberegeln.md)).

## Konsequenzen

- Regeln sind lesbar, vollständig testbar und für alle Ausgabewege identisch.
- Die Datenbank liefert ggf. mehr Zeilen als ausgegeben werden; bei deutlich größeren Datenmengen
  (Millionen Zeilen) wäre eine Vorfilterung in SQL nötig (Erweiterungspunkt im PEP).
- Neue Ausgabewege müssen den PEP verwenden (Konvention, im Code-Review zu prüfen).
