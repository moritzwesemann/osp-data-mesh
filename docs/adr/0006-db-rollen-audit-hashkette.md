# ADR 0006: Getrennte Datenbankrollen und append-only Audit-Log mit Hash-Kette

## Status

angenommen

Datum: 2026-11-04

## Kontext

Zugriffe, Freigaben, Änderungen, Widerrufe und Austausch müssen nachweisbar protokolliert werden (R5).
Ein Protokoll, das der Server-Prozess selbst ändern oder löschen kann, ist bei einer Kompromittierung des
Servers wertlos. Zugleich sollen Schemaänderungen und Wiederherstellungen nicht mit den Rechten des
laufenden Servers möglich sein (S3, S5).

## Entscheidung

- Drei Datenbankrollen: **`mesh_owner`** (Schema-Eigentümer; Migrationen, Wiederherstellung; nur
  Kommandozeile), **`mesh_app`** (Server; Fachtabellen lesen/schreiben, **Audit-Log nur `INSERT` und
  `SELECT`**), **`mesh_bi`** (nur lesend, nur Views im Schema `bi`). Rechte in `migrations/grants.sql`,
  angewandt nach jeder Migration und Wiederherstellung.
- Das Audit-Log ist **nur anhängbar**: Trigger verhindern `UPDATE`, `DELETE` und `TRUNCATE` (auch für den
  Eigentümer, solange die Trigger nicht entfernt werden).
- Ein Trigger vergibt eine lückenlose Folgenummer und verkettet jeden Eintrag per **SHA-256** mit dem
  vorherigen (Hash-Kette); `audit_verify()` prüft die Kette (Oberfläche, CLI, SQL).
- Fachliche Änderung und Audit-Eintrag in **einer Transaktion**.

## Konsequenzen

- Ein kompromittierter Server-Prozess kann Einträge nicht ändern oder löschen; Manipulationen mit
  Owner-/Superuser-Rechten werden durch die Hash-Kette erkennbar (zusätzlich: Prüfwert regelmäßig extern
  notieren). *Ergänzung 2026-11-05:* Abschneiden und vollständiges Neuberechnen erkennt erst die externe
  Verankerung bei den Partnern ([ADR 0014](0014-externe-verankerung-audit-kette.md)).
- Einträge werden serialisiert (Advisory-Lock); für das Mengengerüst ohne spürbare Kosten.
- Das Audit-Log wächst unbegrenzt; Archivierung/Aufbewahrungsfrist muss organisatorisch festgelegt und
  ggf. später technisch umgesetzt werden.
- Rollen gelten in PostgreSQL für den ganzen Cluster. Die Rollen haben feste Namen; die Trennung
  funktioniert daher nur mit **einem PostgreSQL-Cluster je Knoten** (auch für Test- und
  Wiederherstellungssysteme). `db-bootstrap` bricht ab, wenn der Cluster schon eine andere Datenbank von
  `mesh_owner` enthält (`--force` nur für Fachleute).

## Nachtrag (2026-11-05): eindeutige Hash-Eingabe (Version 2)

**Befund.** `audit_digest_input()` verband die Felder mit `|` (`concat_ws`). Enthält ein Feld selbst `|`,
lässt sich Text auf ein benachbartes Feld verschieben, ohne dass sich der Hash ändert (z. B. `actor_id`
`u-123`, `actor_label` `Eve|Admin` → `actor_id` `u-123|Eve`, `actor_label` `Admin`); `null` und `''` waren
nicht unterscheidbar, und `concat_ws` überspringt `NULL` ganz.

**Entscheidung (Migration 0620).** Neue Spalte `audit_log.digest_version` (1 für alle bestehenden
Einträge, der Trigger setzt für jeden neuen Eintrag 2). Version 2 der Eingabe:
`'osp-audit-digest@2'` und je Feld in unveränderter Reihenfolge `'|'` + (`'~'` für `NULL`, sonst
*UTF-8-Byte-Länge* `:` *Wert*) – präfixfrei und damit eindeutig zerlegbar; die Kennung am Anfang bindet die
Version in die Eingabe (eine Eingabe der Version 1 beginnt mit einer Ziffer). `audit_digest_input()` wählt
die Version je Zeile, `audit_verify()` prüft zusätzlich, dass die Version nie zurückfällt. Die Prüfung im
Programm (`modules/audit/chain.ts`, ADR 0014) rechnet beide Versionen Byte für Byte gleich (Tests mit
Unicode, `NULL`/leer, Trennzeichen, Ziffern und Doppelpunkten, JSON) und prüft als zusätzliche Absicherung
den Aufbau der Tabelle über `pg_attribute` (eingebaute Typen ohne Modifikator, `NOT NULL` wie angelegt,
keine berechneten Spalten) sowie die erlaubten Werte von `actor_type` und `outcome`. Bestehende Hashes
bleiben gültig; die Kette läuft über den Versionswechsel hinweg weiter.

**Restrisiko.** Für Einträge der Version 1 bleibt die Mehrdeutigkeit: Wer die Datenbank besitzt, kann dort
Text über `|` zwischen benachbarten Feldern verschieben, ohne dass die Neuberechnung oder ein Prüfpunkt es
bemerkt. Die Prüfung zählt solche Einträge (Version 1 mit `|` in einem frei belegten Feld) und meldet die
Zahl als Hinweis `legacy_digest_ambiguous`.
