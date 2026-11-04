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
  notieren).
- Einträge werden serialisiert (Advisory-Lock); für das Mengengerüst ohne spürbare Kosten.
- Das Audit-Log wächst unbegrenzt; Archivierung/Aufbewahrungsfrist muss organisatorisch festgelegt und
  ggf. später technisch umgesetzt werden.
- Rollen gelten in PostgreSQL für den ganzen Cluster. Die Rollen haben feste Namen; die Trennung
  funktioniert daher nur mit **einem PostgreSQL-Cluster je Knoten** (auch für Test- und
  Wiederherstellungssysteme). `db-bootstrap` bricht ab, wenn der Cluster schon eine andere Datenbank von
  `mesh_owner` enthält (`--force` nur für Fachleute).
