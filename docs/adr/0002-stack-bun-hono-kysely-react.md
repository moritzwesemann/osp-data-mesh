# ADR 0002: Stack Bun, Hono, Kysely, React mit zod-Vertrag

## Status

angenommen

Datum: 2026-11-04

## Kontext

Gesucht war ein Stack, der mit wenigen, verbreiteten Open-Source-Komponenten auskommt, sich ohne den
ursprünglichen Entwickler betreiben und weiterentwickeln lässt und eine typsichere Verbindung von
Datenbank, Server, Oberfläche und API-Dokumentation ermöglicht (U3, K6, S7).

## Entscheidung

- **Bun** (TypeScript-Laufzeit, Paketverwaltung, Testläufer, Passwort-Hashing) statt Node.js + mehrerer
  Werkzeuge.
- **Hono** als HTTP-Framework (klein, standardbasiert auf `Request`/`Response`).
- **Kysely** als typsicherer SQL-Query-Builder über `pg`; kein ORM, SQL-Migrationen als Dateien.
- **PostgreSQL 18** als einzige Datenhaltung.
- **React + Vite** für die Oberfläche (mobil-responsiv), TanStack Query, React Router.
- **zod** definiert den **HTTP-Vertrag** (`src/shared/contract/`) als **einzige Quelle** für:
  Validierung der Eingaben und Filterung der Ausgaben im Server, den typisierten Client der Oberfläche und
  das OpenAPI-Dokument (`/api/v1/openapi.json`).

## Konsequenzen

- Dokumentation, Server und Oberfläche können nicht auseinanderlaufen; Vertragsänderungen fallen beim
  Typecheck auf.
- Kleine Abhängigkeitsliste zur Laufzeit (Hono, Kysely, pg, zod, papaparse), gut für SBOM und
  Schwachstellenmanagement.
- Bun ist jünger als Node.js; Betreiber müssen Bun-Versionen pflegen (gepinnt im `Dockerfile`).
- Kenntnisse in TypeScript genügen für Server und Oberfläche.
