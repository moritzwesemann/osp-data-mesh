# ADR 0015: Excel-Import mit fflate und eigenem SpreadsheetML-Leser

## Status

angenommen

Datum: 2026-11-05

## Kontext

Leistungsdiagnostik an den Olympiastützpunkten liegt überwiegend in Excel-Dateien vor (D1, D2). Bisher
mussten sie vor dem Import als CSV gespeichert werden; dabei gehen Datumswerte und Zahlen je nach
Gebietsschema verloren oder werden verfälscht. Eine hochgeladene Datei ist feindliche Eingabe: Eine
`.xlsx`-Datei ist ein ZIP-Archiv mit XML-Teilen – Angriffsflächen sind ZIP-Bomben (kleine Datei, riesiger
entpackter Inhalt), manipulierte ZIP-Verzeichnisse, XML-Entitäten (XXE, „Billion Laughs“), übergroße
Elemente, Prototype Pollution über Schlüsselnamen und Formeln, deren Auswertung Daten verändern oder
externe Inhalte nachladen könnte.

Geprüfte Bibliotheken (npm, Stand 2026-11-05, Sicherheitshinweise aus der GitHub Advisory Database):

| Paket | Lizenz | Befund |
|---|---|---|
| `xlsx` (SheetJS) 0.18.5 | Apache-2.0 | offene Hinweise: Prototype Pollution (GHSA-4r6h-8v6p-xvw6, < 0.19.3) und ReDoS (GHSA-5pgg-2g8v-p4x9, < 0.20.2); behobene Versionen nur über das CDN des Herstellers, nicht über npm |
| `exceljs` 4.4.0 | MIT | letzte stabile Version 2023-10; großer Abhängigkeitsbaum (archiver, unzipper, jszip, tmp, uuid, …), darunter `tmp` mit Hinweisen (GHSA-52f5-9888-hmc6, GHSA-ph9p-34f9-6g65); keine Begrenzung der entpackten Größe |
| `read-excel-file` 9.3 | MIT | gepflegt, aber eigene Abhängigkeiten (`unzipper-esm`, `saxen`, `worker-f`); keine Begrenzung der entpackten Größe einstellbar – eine ZIP-Bombe müsste vorher ohnehin selbst entpackt und gemessen werden |
| `fflate` 0.8.3 | MIT | ohne Abhängigkeiten, weit verbreitet, gepflegt; 0.8.0–0.8.2 hatten eine Endlosschleife in `unzipSync` bei ZIP64 (GHSA-px8p-9vwx-vf98), in 0.8.3 behoben; streamendes `Inflate` mit Rückruf je Ausgabestück |

## Entscheidung

- **fflate** (MIT, ≥ 0.8.3) wird als einzige neue Laufzeitabhängigkeit aufgenommen, und zwar nur für das
  Entpacken von DEFLATE-Daten als Datenstrom (`Inflate`). Der ZIP-Container-Leser von fflate (`unzipSync`)
  wird nicht verwendet.
- Das **ZIP-Verzeichnis** und der benötigte **Ausschnitt von SpreadsheetML** (Beziehungen, Arbeitsmappe,
  Zahlenformate, gemeinsame Texte, ein Tabellenblatt) werden in `src/server/modules/connectors/xlsx.ts`
  selbst gelesen – linear, ohne reguläre Ausdrücke mit Rückverfolgung, mit festen Obergrenzen:
  höchstens 20 MB Datei (wie CSV), 10 000 ZIP-Einträge, **100 MB entpackt insgesamt** (gemessen an den
  tatsächlich erzeugten Bytes während des Entpackens, nicht an den Angaben im Archiv), 8 MB je
  Verwaltungsteil, 1 MB je XML-Element bzw. Zellwert, 1 000 000 gemeinsame Texte, 500 Spalten,
  100 000 Datenzeilen. Größe und CRC-32 jedes vollständig gelesenen Teils müssen stimmen.
- Abgelehnt werden ZIP64, mehrteilige und verschlüsselte Archive, unbekannte Kompressionsverfahren,
  doppelte Teilnamen, `.xlsb` und jede DTD (`<!DOCTYPE`). Entitäten werden nur für die fünf
  vordefinierten Namen und Zeichenreferenzen aufgelöst; Attribute liegen in `Map`s, Zeilen in Objekten
  ohne Prototyp.
- **Formeln werden nie ausgewertet.** Übernommen wird ausschließlich der in der Datei gespeicherte
  Ergebniswert (`<v>`); fehlt er, ist die Zelle leer.
- Nach dem Lesen entsteht dieselbe Quelltabelle wie beim CSV-Import; Zuordnung, Format- und
  Plausibilitätsprüfung, Vorschau, Fehlerprotokoll und Übernahme sind unverändert. Zahlen- und
  Datumszellen werden in eindeutigen Text überführt (Zahl mit dem eingestellten Dezimaltrennzeichen,
  Datum als ISO 8601, 1900- und 1904-System); als Text gespeicherte Werte prüft die Pipeline wie bei CSV
  nach Dezimaltrennzeichen und Datumsformat der Quelle.
- Neue Quellart `xlsx_upload` mit Konfiguration `{ type: "xlsx", sheet, headerRow, decimalSeparator,
  dateFormat }` (Migration `0700_connector_xlsx.sql` erweitert nur die Prüfbedingung der Spalte `kind`).

## Konsequenzen

- Excel-Dateien lassen sich ohne Umweg über CSV importieren; das Verhalten (Vorschau, Fehlercodes,
  Zeilennummern ohne Kopfzeile) entspricht dem CSV-Import.
- Der eigene Leser ist zusätzlicher Code, den das Projekt pflegt (etwa 800 Zeilen). Er ist durch
  Unit-Tests mit selbst erzeugten und mit einer von openpyxl geschriebenen Datei abgedeckt
  (`tests/unit/import-xlsx.test.ts`), einschließlich ZIP-Bomben, ZIP64, Verschlüsselung, DTD/Entitäten und
  beschädigter Dateien.
- Nicht unterstützt: alte `.xls`-Dateien, kennwortgeschützte Dateien, `.xlsb`, `.ods`; die Oberfläche und
  das Fehlerprotokoll nennen dafür einen übersetzten Grund. Ein Reader für weitere Formate wäre eine
  eigene Entscheidung.
- fflate erscheint in SBOM und [Lizenzen](../lizenzen.md); Aktualisierungen folgen dem
  Schwachstellenprozess in [Sicherheit](../sicherheit.md).
