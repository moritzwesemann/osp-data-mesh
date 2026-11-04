# ADR 0009: Freigabebezogene Pseudonyme statt lokaler IDs im Austausch

## Status

angenommen

Datum: 2026-11-04

## Kontext

Partner benötigen eine stabile Kennung je Person, um Zeilen zuzuordnen und Löschmitteilungen umzusetzen.
Die Weitergabe interner Datenbank-IDs würde es Empfängern ermöglichen, Daten aus verschiedenen
Freigaben – auch über mehrere Partner hinweg – über dieselbe ID zu verknüpfen (Datenminimierung,
Zweckbindung).

## Entscheidung

Statt der internen ID enthält jede ausgetauschte Zeile ein **freigabebezogenes Pseudonym**:
`HMAC-SHA-256(Knotengeheimnis, "<freigabe-id>:<personen-id>")`, gekürzt auf 22 Zeichen base64url. Das
Knotengeheimnis ist zufällig, wird beim ersten Start erzeugt und verschlüsselt gespeichert. Der
Datenhalter protokolliert die übermittelten Pseudonyme je Lieferung im Austauschprotokoll.

## Konsequenzen

- Gleiche Person, verschiedene Freigaben → verschiedene Pseudonyme; Empfänger können Freigaben nicht
  über eine ID verknüpfen.
- Innerhalb einer Freigabe ist das Pseudonym stabil (Abrufe ersetzen die Kopie zeilengenau).
- Löschmitteilungen (`subjects_withdrawn`) adressieren genau die gelieferten Pseudonyme.
- Pseudonyme schützen nicht vor Identifizierung über Inhalte (Namen, seltene Merkmalskombinationen); das
  muss die Gestaltung der Datenprodukte berücksichtigen.
- Geht das Knotengeheimnis verloren, ändern sich alle Pseudonyme (Partner erhalten neue Kopien, alte
  Mitteilungen sind nicht mehr zuordenbar).
