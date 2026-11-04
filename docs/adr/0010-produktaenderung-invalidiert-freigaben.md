# ADR 0010: Produktänderung macht Freigaben ungültig (Versionierung)

## Status

angenommen

Datum: 2026-11-04

## Kontext

Freigaben verweisen auf ein Datenprodukt. Würde eine Änderung des Produkts (neue Spalten, gelockerte
Filter) automatisch für bestehende Freigaben gelten, könnten unbemerkt mehr Daten an Empfänger fließen,
als bei der Freigabe geprüft wurde.

## Entscheidung

- Datenprodukte haben eine **Version**; jede Änderung an Spalten oder Basisfiltern erhöht sie.
- Eine Freigabe speichert die Produktversion bei Erteilung. Weicht die aktuelle Version ab, ist die
  Freigabe **veraltet** (`product_changed`) und liefert nichts mehr, bis sie neu erteilt wird.
- Freigaben sind **unveränderlich**: Änderung = neue Freigabe erteilen, alte widerrufen.
- Neue Produktspalten sind nie automatisch freigegeben (Spaltenliste der Freigabe).

## Konsequenzen

- Eine Produktänderung kann den Umfang einer Freigabe nie stillschweigend erweitern.
- Datenverantwortliche müssen nach Produktänderungen Freigaben bewusst neu erteilen (Oberfläche zeigt
  veraltete Freigaben an).
- Die zuletzt gelieferte Kopie beim Partner bleibt bestehen, bis die alte Freigabe widerrufen wird oder
  abläuft (siehe [Widerruf und Weitergabe](../widerruf-und-weitergabe.md)).
