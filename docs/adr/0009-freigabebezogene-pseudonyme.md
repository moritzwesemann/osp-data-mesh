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
`HMAC-SHA-256(Knotengeheimnis, "<freigabe-id>:<personen-id>")`, gekürzt auf die ersten 16 Byte und als
**32 Hex-Zeichen in Kleinbuchstaben** (`0-9a-f`) dargestellt. Das Knotengeheimnis ist zufällig, wird beim
ersten Start erzeugt und verschlüsselt gespeichert. Der Datenhalter protokolliert die übermittelten
Pseudonyme je Lieferung im Austauschprotokoll.

*Änderung (2026-11):* Bis dahin wurden Pseudonyme als 22 Zeichen base64url dargestellt. Diese konnten mit
`-` beginnen und wurden dann im CSV-Export durch den Schutz vor Formel-Injection mit `'` versehen – das
Pseudonym im Export stimmte nicht mehr mit dem gelieferten überein. Hex-Zeichen beginnen nie mit `=`, `+`,
`-` oder `@`. Für Lieferungen, die noch in der alten Form protokolliert sind, sucht der Datenhalter bei
Löschmitteilungen beide Formen und teilt die tatsächlich gelieferte mit; beim nächsten Abruf ersetzt der
Empfänger seine Kopie durch Zeilen mit Pseudonymen in der neuen Form.

## Konsequenzen

- Gleiche Person, verschiedene Freigaben → verschiedene Pseudonyme; Empfänger können Freigaben nicht
  über eine ID verknüpfen.
- Innerhalb einer Freigabe ist das Pseudonym stabil (Abrufe ersetzen die Kopie zeilengenau).
- Löschmitteilungen (`subjects_withdrawn`) adressieren genau die gelieferten Pseudonyme.
- Pseudonyme schützen nicht vor Identifizierung über Inhalte (Namen, seltene Merkmalskombinationen); das
  muss die Gestaltung der Datenprodukte berücksichtigen.
- Geht das Knotengeheimnis verloren, ändern sich alle Pseudonyme (Partner erhalten neue Kopien, alte
  Mitteilungen sind nicht mehr zuordenbar).
