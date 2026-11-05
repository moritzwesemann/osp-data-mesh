# Mitmachen / Contributing

Danke für Ihr Interesse an OSP-Data-Mesh! Fragen, Ideen und Fehlerberichte sind als
[Issue](https://github.com/moritzwesemann/osp-data-mesh/issues) willkommen; Sicherheitslücken bitte
vertraulich melden (siehe [SECURITY.md](SECURITY.md)).

## Entwicklung

Voraussetzungen und Schnellstart: [README](README.md#ausprobieren). Vor einem Pull Request bitte:

```sh
bun run typecheck
bun run lint            # Biome; formatieren mit bun run format
bun test                # Unit- und Integrationstests
bun run test:e2e        # Browser-Abläufe, wenn die Oberfläche betroffen ist
```

Hinweise:

- Architektur und Konventionen: [docs/architektur.md](docs/architektur.md). Neue Entscheidungen von
  Gewicht als ADR in [docs/adr/](docs/adr/) festhalten.
- Schnittstellen entstehen aus einem gemeinsamen Vertrag (`src/shared/contract/`); Datenbankänderungen
  nur als neue, nummerierte Migration in `migrations/`.
- Texte der Oberfläche immer auf Deutsch und Englisch (`src/ui/i18n/`).
- Keine echten Personendaten in Code, Tests oder Beispielen – nur erfundene.
- Sicherheitsrelevante Änderungen (Freigaben, Austausch, Audit, Anmeldung) mit Tests für Positiv- und
  Negativfälle.
- Neue Abhängigkeiten nur mit OSI-Lizenz, die mit der EUPL-1.2 vereinbar ist; danach `bun run sbom` und
  `bun scripts/licenses.ts` ausführen.

## Lizenz

Beiträge werden unter der [EUPL-1.2](LICENSE) veröffentlicht, wie das gesamte Projekt.

---

**English:** Issues and pull requests are welcome. Please run typecheck, lint and tests before opening a
pull request, keep UI texts in German and English, never use real personal data, and report security
issues privately (see [SECURITY.md](SECURITY.md)). Contributions are licensed under the EUPL-1.2.
