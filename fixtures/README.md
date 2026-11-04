# Synthetische Demo-Daten

Alle Dateien in diesem Verzeichnis sind **frei erfunden** und werden von
`scripts/generate-fixtures.ts` deterministisch erzeugt (`bun scripts/generate-fixtures.ts`).
Namen sind Zufallskombinationen häufiger deutscher Vor- und Nachnamen; Übereinstimmungen mit realen
Personen wären zufällig. Vereine und die Knoten "osp-nord", "osp-mitte" und "osp-sued" sind fiktiv.

## Dateien

| Datei | Inhalt | Format | Vorlage (Connector) |
|---|---|---|---|
| `osp-nord/athleten.csv` | 43 Zeilen Stammdaten (Kennungen `NORD-0001` …), davon **3 absichtlich fehlerhaft** | Semikolon, UTF-8, Datum TT.MM.JJJJ | `athleten-stammdaten-csv` |
| `osp-nord/leistungsdiagnostik.csv` | 80 Stufentests (VO2max, Laktatschwelle, HFmax), davon **2 unplausibel** | Komma, UTF-8, ISO-Datum, Dezimalpunkt | `leistungsdiagnostik-csv` |
| `osp-nord/verletzungen.csv` | 25 Verletzungen (Gesundheitsdaten, besondere Kategorie Art. 9 DSGVO) | Semikolon, UTF-8, Datum TT.MM.JJJJ | `verletzungen-csv` |
| `osp-mitte/athleten.csv` | 25 Stammdatensätze (`MITTE-0001` …) mit Umlauten | Semikolon, **Windows-1252**, CRLF | `athleten-stammdaten-csv` |
| `osp-sued/athleten.csv` | 20 Stammdatensätze (`SUED-0001` …) | Semikolon, UTF-8 mit BOM | `athleten-stammdaten-csv` |

Die Sprungkraft-Messungen (API-Quelle) liefert das Mock-Messsystem `scripts/mock-measurement-api.ts`
(`bun run mock-api`, Vorlage `sprungkraft-api`): 123 Messungen für Athletinnen und Athleten von osp-nord,
davon 3 absichtlich fehlerhaft (unbekannte Kennung, Sprunghöhe 250 cm, unbekannte Testart).

## Absichtliche Fehler (Fehlerprotokoll)

- `osp-nord/athleten.csv`: Zeile 13 Geburtsdatum `31.02.2004` (ungültiges Datum),
  Zeile 27 ohne Sportart (Pflichtfeld), Zeile 38 Kaderstatus `Bundeskader` (unbekannter Wert).
- `osp-nord/leistungsdiagnostik.csv`: eine Zeile mit VO2max 140 ml/kg/min (außerhalb 20–95),
  eine Zeile mit Testdatum in der Zukunft (2099-03-15).

Die Zuordnung erfolgt bei Stammdaten und Verletzungen über die Kennung `Athleten-ID` (System `osp-id`),
bei der Leistungsdiagnostik über Nachname, Vorname und Geburtsdatum. Der Kaderstatus steht in den
Dateien als Bezeichnung (z. B. "Perspektivkader") und wird über die Wertübersetzung der Vorlage auf den
Code (z. B. `PK`) abgebildet.
