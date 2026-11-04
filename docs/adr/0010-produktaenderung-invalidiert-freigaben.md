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
- Eine **Änderung des zugrunde liegenden Datensatzes** gilt als Produktänderung, wenn sie die Einstufung
  (Kategorie, besondere Kategorie, Teilbarkeit), das Beobachtungsdatum oder ein vom Produkt genutztes Feld
  (entfernt, anderer Typ, andere Einheit) betrifft: Jedes betroffene aktive Produkt erhält in derselben
  Transaktion eine neue Version (Ereignis `dataset.changed`, Audit `product.update` mit
  `cause: dataset_changed`); seine Freigaben sind damit veraltet. Wird der Datensatz intern, wird auch das
  Produkt intern. Name, Beschreibung, Feldbezeichnungen, Prüfregeln und neue Felder ändern keine Version.
- Wird ein Datensatz dabei **neu besondere Kategorie**, wechselt ein Datensatz besonderer Kategorie die
  Kategorie (Einwilligungen gelten je Kategorie) oder wird er **intern**, werden zusätzlich alle nicht
  widerrufenen Partnerfreigaben der betroffenen Produkte widerrufen (Grund `dataset_reclassified`); die
  Partner erhalten `release_revoked` und löschen ihre Kopien.

## Konsequenzen

- Eine Produktänderung kann den Umfang einer Freigabe nie stillschweigend erweitern.
- Datenverantwortliche müssen nach Produktänderungen Freigaben bewusst neu erteilen (Oberfläche zeigt
  veraltete Freigaben an).
- Die zuletzt gelieferte Kopie beim Partner bleibt bestehen, bis die alte Freigabe widerrufen wird oder
  abläuft (siehe [Widerruf und Weitergabe](../widerruf-und-weitergabe.md)) – außer nach einer
  Hochstufung des Datensatzes (siehe oben), nach der sie hätte nicht übermittelt werden dürfen.
- Eine Umstufung eines Datensatzes kann viele Freigaben auf einmal veralten lassen bzw. Partnerfreigaben
  widerrufen; die Oberfläche und das Audit-Log zeigen die betroffenen Produkte und Freigaben.
