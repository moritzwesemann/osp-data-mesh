# ADR 0003: Datensätze als JSONB mit typisierten Felddefinitionen

## Status

angenommen

Datum: 2026-11-04

## Kontext

Jeder OSP hat andere Messsysteme und Testformen (Sprungkraft, Leistungsdiagnostik, Verletzungen …).
Datenverantwortliche sollen neue Datenarten ohne Entwicklung und ohne Datenbankänderung anlegen können
(D1–D5, K5). Dynamisch erzeugte Tabellen je Datenart würden Migrationen, Rechte, Sicherung und Prüfung
erheblich verkomplizieren.

## Entscheidung

Ein **Datensatz** (`dataset`) beschreibt seine Felder als Liste typisierter Felddefinitionen
(`FieldDef`: Name, Typ, Einheit, Pflicht, Grenzen, zulässige Werte). Jeder Eintrag
(`dataset_record`) speichert die Werte als **JSONB** zusammen mit Person, fachlichem Schlüssel und
Messdatum. Prüfung von Format und Plausibilität erfolgt beim Import gegen die Felddefinitionen.
Feldänderungen erhöhen die Version des Datensatzes.

## Konsequenzen

- Neue Datenarten ohne Schemaänderung; ein festes, gut dokumentierbares Datenmodell.
- Typprüfung liegt in der Anwendung (Import, Datenprodukte), nicht in Datenbank-Constraints je Feld.
- Für BI werden typisierte Views erzeugt ([ADR 0007](0007-bi-materialisierung-zeitwaechter.md)), damit
  Werkzeuge echte Spaltentypen sehen.
- Abfragen über viele Felder sind weniger effizient als in spezialisierten Tabellen; für das
  Mengengerüst unkritisch.
