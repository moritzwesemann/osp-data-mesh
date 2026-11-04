# ADR 0007: BI über materialisierte Tabellen und Views im Schema bi mit SQL-Zeitwächter

## Status

angenommen

Datum: 2026-11-04

## Kontext

BI-Werkzeuge (Superset, Excel, Power BI, Tableau, SAP Analytics Cloud, Python) sollen ohne proprietäre
Zugriffsschicht auf freigegebene Daten zugreifen (B1–B3). Die Freigaberegeln liegen in TypeScript
([ADR 0004](0004-freigabelogik-reine-funktionen.md)); ein direkter Datenbankzugriff auf Fachtabellen
würde sie umgehen.

## Entscheidung

- Für jede gültige Freigabe an die Empfängerrolle **`bi`** holt der Server die zulässigen Zeilen über den
  PEP und schreibt sie in eine Tabelle `bi_data.r_<id>` (nur `mesh_app`).
- Darüber liegt eine **typisierte View** `bi.<produktkürzel>`, die nur `mesh_bi` liest.
- Jede View enthält einen **SQL-Zeitwächter**: Sie liefert nur Zeilen, solange die Freigabe gültig, nicht
  widerrufen und das Produkt aktiv und unverändert ist – auch wenn die nächste Aktualisierung noch
  aussteht.
- Widerruf entfernt die View in derselben Transaktion; Einwilligungswiderruf und Löschung entfernen Zeilen
  der Person sofort (verborgene Spalte `_subject`, nie in der View).
- Materialisierung und Bereinigung sind über die **Liefersperre** (`core/locks.ts`, dieselbe wie beim
  Partnerabruf) serialisiert: Die Materialisierung hält sie geteilt vom PEP-Aufruf bis zum Commit, die
  Bereinigung nimmt sie exklusiv. So kann keine laufende Materialisierung eine eben entfernte Person aus
  einem älteren Datenstand zurückbringen.
- Aktualisierung nach Datenänderungen (entprellt), periodisch und auf Anforderung.

## Konsequenzen

- BI-Werkzeuge sehen gewöhnliche PostgreSQL-Views mit echten Spaltentypen; Standardtreiber genügen.
- Daten in BI können kurzzeitig (bis zur nächsten Aktualisierung) einen älteren Stand zeigen, aber nie
  mehr als erlaubt.
- Die Schemata `bi`/`bi_data` sind abgeleitet und nicht Teil der Sicherung; sie werden nach einer
  Wiederherstellung neu aufgebaut.
- Die Datenbank muss für direkten BI-Zugriff bewusst im internen Netz freigegeben werden (mit TLS).
