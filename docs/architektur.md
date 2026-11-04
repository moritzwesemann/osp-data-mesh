# Architektur

Dieses Dokument beschreibt den Aufbau eines OSP-Data-Nodes, die Modulgrenzen, die Schnittstellen zwischen
den Modulen und die verbindlichen Konventionen für die Weiterentwicklung.

## Überblick

Jeder Olympiastützpunkt (OSP) betreibt einen eigenen **Knoten** (Node). Ein Knoten ist ein **modularer
Monolith**: ein einziger Server-Prozess (Bun + Hono) mit eigener PostgreSQL-Datenbank, der Web-Oberfläche
(React-SPA), REST-API, Föderationsprotokoll und deutscher HTML-Dokumentation ausliefert. Knoten tauschen
ausschließlich **explizit freigegebene** Daten aus; es gibt keine zentrale Datenhaltung und keine
Gesamtsynchronisation.

```
                ┌───────────────────────────── OSP-Data-Node ─────────────────────────────┐
 Browser ──TLS──┤ Caddy ── Hono-Server ── Module ── Kysely ── PostgreSQL (mesh_app)       │
 Excel/PowerBI ─┤   │         │                                  │                       │
 Python (REST) ─┤   │         ├─ /api/v1/*        (Sitzung oder API-Token)               │
                │   │         ├─ /federation/v1/* (Ed25519-signiert, nur Partner)        │
 Partnerknoten ─┤───┘         ├─ /hilfe/*          (HTML-Doku)                           │
                │             └─ /*                (Web-Oberfläche)                       │
 BI (Superset) ─┼──────────── PostgreSQL, Rolle mesh_bi, nur Schema "bi" (read-only)       │
                └──────────────────────────────────────────────────────────────────────────┘
```

## Verzeichnisstruktur

| Pfad | Inhalt |
|---|---|
| `src/shared/contract/` | HTTP-Vertrag (zod): Schemas und Routen, genutzt von Server, Oberfläche und OpenAPI |
| `src/server/core/` | Querschnitt: DB, Migrationen, Krypto, Audit, Ereignisse, Routing, Fehler, Formate |
| `src/server/modules/<modul>/` | Fachmodule (siehe unten) |
| `src/server/cli/` | Betriebs-Kommandozeile (`bun run cli …`) |
| `src/ui/` | Web-Oberfläche (React + Vite) |
| `migrations/` | versionierte SQL-Migrationen `NNNN_name.sql` + `grants.sql` |
| `tests/unit`, `tests/integration` | automatisierte Tests (`bun test`) |
| `scripts/` | lokale Cluster, Demo, Mock-Messsystem, Doku-Build, SBOM |
| `deploy/` | Dockerfile, docker-compose, Caddy, Postgres-Bootstrap, Superset |
| `docs/` | Dokumentation (Markdown → HTML), ADRs |

## Module und Verantwortlichkeiten

| Modul | Routen (Vertrag) | Tabellen (schreibend) | Bietet an / löst aus | Reagiert auf, Hintergrundaufgaben |
|---|---|---|---|---|
| `auth` | `auth.*`, `tokens.*`, `users.*` | app_user, user_session, api_token | `deps.authenticator` | – |
| `audit` | `audit.*` | – (audit_log schreibt jedes Modul über `deps.audit`) | | – |
| `system` | `health.*`, `system.*`, `/api/v1/openapi.json` | backup_run, app_error | `services.backup` | geplante Sicherungen |
| `athletes` | `athletes.*`, `consents.*`, `purposes.list` | athlete, athlete_identifier, consent_record | Ereignisse `consent.withdrawn`, `athlete.deleted` (in der Transaktion), `data.changed` | – |
| `datasets` | `datasets.*` | dataset | Ereignis `dataset.changed` (in der Transaktion der Änderung, wenn Einstufung, Beobachtungsdatum oder Felder sich produktrelevant ändern) | – |
| `connectors` | `connectors.*`, `imports.*` | connector, import_run, import_error, dataset_record, athlete (Import), dataset (Import einer Definition) | Ereignis `data.changed` | `athlete.deleted` (Person aus offenen Importläufen entfernen); Ablauf nicht übernommener Vorschauen (beim Start und stündlich, `connectors/retention.ts`) |
| `products` | `products.*`, `access.*` | data_product | Laden von Produktzeilen; Ereignis `product.changed` | `dataset.changed` (neue Produktversion, ggf. `revokePeerReleases`) |
| `releases` | `releases.*` | data_release | `services.pep`, `services.offers`, Ereignisse `release.*` | `product.changed` (Stilllegung bzw. Neueinstufung: Freigaben widerrufen) |
| `bi` | `bi.*` | bi_view, Schemata `bi`/`bi_data` | `services.bi` | `release.*`, `product.changed`, `consent.withdrawn`, `athlete.deleted`, `data.changed`; periodische Aktualisierung (10 min) |
| `catalog` | `catalog.local` | – (liest Metadaten) | | – |
| `federation` | `node.card`, `peers.*`, `discovery.search`, `received.*`, `exchange.log`, `outbox.*`, `/federation/v1/*` | peer, federation_nonce, outbox_message, exchange_log, received_product, received_row | `services.federation` | `release.revoked`, `product.changed`, `consent.withdrawn`, `athlete.deleted` (Mitteilungen ins Ausgangspostfach); Ausgangspostfach (5 s), Aufbewahrung (minütlich) |

Hintergrundaufgaben laufen nur mit `MESH_WORKERS=true` (Standard).

Module lesen fremde Tabellen nur, wo es für Anzeige oder Prüfung nötig ist (z. B. `releases` liest
`consent_record` für die Einwilligungsprüfung). **Schreibend** greift jedes Modul nur auf eigene Tabellen zu.
Querbeziehungen laufen über `deps.services` (synchron) oder `deps.events` (Ereignisse).

## Datenfluss

1. **Import**: Connector (CSV-Upload oder HTTP-API) → Parsen → Mapping → Format-/Plausibilitätsprüfung →
   Vorschau mit Fehlerprotokoll → Übernahme (Athletenkern oder `dataset_record`) → Audit.
2. **Datenprodukt**: Sicht auf einen Datensatz (oder den Athletenkern) mit gewählten Spalten und Basisfilter.
3. **Freigabe**: Produkt × Empfänger (lokale Rolle, BI oder Partnerknoten), beschränkt nach Spalten,
   Zeilen, Datenzeitraum, Gültigkeit und Zweck, optional mit Einwilligungspflicht (bei Art.-9-Daten Pflicht).
4. **Ausgabe**: ausschließlich über den Policy Enforcement Point `services.pep.serve()`:
   lokaler Abruf/Export (`access.data`), BI-Materialisierung (`bi`), Partnerabruf (`federation`).
5. **Austausch**: Partner ruft per signierter Anfrage ab (Pull), Antwort ist signiert, beide Seiten
   protokollieren. Widerruf → signierte Mitteilung → Empfänger löscht seine Kopie.

## Verbindliche Konventionen

**Vertrag zuerst.** Jede HTTP-Route steht in `src/shared/contract/*.ts`. Handler werden mit
`registerRoutes(app, deps, { 'route.id': async (ctx) => … })` registriert. Der Rahmen prüft Anmeldung,
Rollen, CSRF, Eingaben und filtert die Ausgabe gegen das Antwortschema (unbekannte Felder werden entfernt).
Nur das Föderationsmodul registriert zusätzlich rohe Routen unter `/federation/v1/*` (eigene Signaturprüfung).

**Datenbank.** Spaltennamen `snake_case`; API-Felder `camelCase`; Abbildung explizit im Modul.
Zeitstempel als `Date` aus der DB, in der API ISO-Strings (`iso()`/`isoReq()` aus `core/db.ts`);
`date`-Spalten sind Strings `YYYY-MM-DD`. Änderungen und ihr Audit-Eintrag in **einer** Transaktion:
`await deps.db.transaction().execute(async (trx) => { …; await deps.audit.record({...}, trx); })`.

**Audit.** `deps.audit.record({ actor, action, outcome, objectType, objectId, details, ip, requestId }, trx?)`.
`action` = `<bereich>.<vorgang>` (z. B. `release.create`, `release.revoke`, `access.data`,
`exchange.pull.served`, `exchange.pull.denied`, `import.commit`, `consent.withdraw`, `auth.login`).
In `details` keine personenbezogenen Rohdaten, nur IDs, Zähler, Codes. Abgelehnte Zugriffe werden mit
`outcome: 'denied'` protokolliert; Lesezugriffe auf Personendaten ebenfalls (Zugriffsprotokoll).

**Fehler.** Fachliche Fehler als `throw new AppError(code, { reason?, fields? })` mit Codes aus
`ERROR_CODES`. Die Oberfläche übersetzt nur Codes; Server-Freitext erreicht nie die Nutzenden.
Unerwartete Fehler → 500 `internal_error`, Eintrag in `app_error` und Log (mit Request-ID).

**Ereignisse** (`core/events.ts`): `inTx` in der Transaktion des Auslösers (muss gelingen),
`after` nach dem Commit (Fehler werden geloggt). Auslöser rufen beides auf. Ereignisse:
`release.created`, `release.revoked`, `product.changed` (mit `retired` bzw. `revokePeerReleases:
'dataset_reclassified'`), `dataset.changed`, `consent.withdrawn`, `athlete.deleted`, `data.changed`.

**Sperren** (`core/locks.ts`, PostgreSQL-Advisory-Locks, transaktionsgebunden): Die **Liefersperre**
serialisiert Datenlieferungen gegen Widerrufe und Löschungen. Jede Auslieferung – Partnerabruf
(`federation`) und BI-Materialisierung (`bi`) – hält sie *geteilt* vom PEP-Aufruf bis zum Speichern bzw.
Protokollieren; Einwilligungswiderruf, Löschung einer Person, Stilllegung und Neueinstufung (Widerruf der
Freigaben) nehmen sie *exklusiv*. So sieht jede spätere Lieferung den Widerruf, und jede frühere ist
abgeschlossen, bevor bereinigt wird. Reihenfolge: zuerst diese Sperre, danach Zeilensperren auf
`data_release`; wer sie geteilt hält, schreibt in derselben Transaktion kein Audit. Weitere Schlüssel:
Audit-Kette, Migrationen, empfangene Kopien.

**Geheimnisse.** Nie im Klartext speichern: `deps.box.seal(value, aad)` / `deps.box.open(sealed, aad)`
mit festem AAD je Verwendungszweck (z. B. `connector.secret:<id>`).

**Deny by default.** Ohne passende, gültige Freigabe gibt es keine Daten. Rollen `admin` und `auditor`
haben keinen impliziten Zugriff auf Fachdaten. Datenverantwortliche (`data_steward`) sehen Rohdaten
ihres Knotens zur Pflege (jeder Lesezugriff wird protokolliert).

**Tests.** Unit-Tests in `tests/unit/<thema>.test.ts`, Integrationstests in
`tests/integration/<modul>.test.ts` mit `createTestNode()` bzw. `TestMesh` (`tests/helpers/node.ts`):
eigene Datenbank je Testdatei im lokalen Testcluster (Port 55434), Anfragen in-process,
Partnerknoten und API-Quellen über injiziertes `deps.fetch`.

## Rollen

| Rolle | Zweck |
|---|---|
| `admin` | Benutzer, Partner (Vertrauensaufnahme), System, Sicherungen. Kein Datenzugriff. |
| `data_steward` | Datenverantwortliche: Athleten, Einwilligungen, Quellen, Importe, Datensätze, Produkte, Freigaben, Abrufe bei Partnern |
| `analyst` | Nutzt freigegebene Produkte (Rolle `analyst`), Discovery, empfangene Daten |
| `coach` | Nutzt freigegebene Produkte (Rolle `coach`) |
| `auditor` | Audit-Log, Austauschprotokoll, Freigaben lesen (Datenschutz/Revision) |
| `bi` (technisch) | Empfängerrolle für die BI-Schnittstelle; keine Person kann sie haben |

## Sicherheitsarchitektur (Kurzfassung)

- TLS terminiert am Reverse Proxy (Caddy); Knoten-zu-Knoten zusätzlich Ed25519-Signaturen auf Anfrage und Antwort.
- Datenbankrollen: `mesh_owner` (Schema, Migrationen, Wiederherstellung; nur CLI), `mesh_app` (Server; Audit-Log nur
  `INSERT`/`SELECT`), `mesh_bi` (nur Views im Schema `bi`, read-only).
- Audit-Log: Trigger sperren `UPDATE`/`DELETE`/`TRUNCATE`; Hash-Kette, prüfbar mit `audit_verify()`.
- Passwörter: Argon2id; Sitzungstoken nur als SHA-256 gespeichert; Cookie HttpOnly/SameSite=Strict/Secure; CSRF-Header.
- Geheimnisse (privater Knotenschlüssel, Pseudonym-Schlüssel, API-Zugangsdaten): AES-256-GCM mit Master-Key aus der Umgebung.
- API-Quellen nur zu freigegebenen Hosts (`MESH_SOURCE_ALLOWED_HOSTS`, SSRF-Schutz); Zugangsgeheimnisse an
  das gespeicherte Ziel gebunden und nur über HTTPS (bzw. Loopback).
- Föderationsendpunkt: Absender vor dem Lesen des Bodys geprüft, Anfragen ≤ 2 MB, Ratenbegrenzung und
  zusammengefasstes Audit abgelehnter Anfragen (`federation/guard.ts`).

Details: [Sicherheitskonzept](sicherheit.md), [Freigaberegeln](freigaberegeln.md), [Protokoll](protokoll.md).
