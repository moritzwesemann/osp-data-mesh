# Abnahme

Checkliste für die Abnahme nach den vier Abnahmekriterien der Ausschreibung (siehe
[Anforderungen](requirements.md#abnahmekriterien)). Jede Prüfung nennt den Nachweis (Befehl bzw.
Vorgehen) und das erwartete Ergebnis. **Ergebnisfelder werden bei der Abnahme ausgefüllt.**

| Angabe | Eintrag |
|---|---|
| Version / Commit | |
| Datum | |
| Prüfende Personen | |
| Prüfumgebung (Betriebssystem, Bun-, PostgreSQL-, Docker-Version) | |

## Vorbereitung

```sh
bun --version            # 1.4.x
psql --version           # 18.x (für Demo und Tests: initdb, pg_ctl, psql lokal installiert)
bun install --frozen-lockfile
bun run build            # Oberfläche + Hilfe
```

| Prüfung | Erwartet | Ergebnis | Bemerkung |
|---|---|---|---|
| `bun run typecheck` | keine Fehler | | |
| `bun run lint` | keine Fehler | | |
| `bun run build:docs` | „Linkprüfung: alle relativen Links und Anker gültig“ | | |
| `bun run sbom` | SBOM geschrieben, „Schema-Prüfung (cdx-validate): ok“ | | |

## AK1 – mindestens zwei CSV-Quellen und eine API-Quelle durchgängig verarbeitet

Nachweis: `bun run demo` (drei Knoten mit Beispieldaten aus drei CSV-Dateien und einem simulierten
Messsystem mit HTTP-API auf Port 4410). Für die Prüfschritte in der Oberfläche die Demo mit
`bun run demo -- --keep-running` starten und danach mit `bun run demo:stop` beenden.

| # | Prüfschritt | Erwartet | Ergebnis | Bemerkung |
|---|---|---|---|---|
| 1.1 | `bun run demo` starten, Ausgabe lesen | Importe aus ≥ 2 CSV-Quellen und ≥ 1 API-Quelle *übernommen*, keine Abbrüche | | |
| 1.2 | Oberfläche eines Knotens öffnen (Zugangsdaten laut Demo-Ausgabe), *Datenquellen* | je Connector ein Importlauf mit Status *übernommen*, Fehlerprotokoll einsehbar | | |
| 1.3 | Importvorschau einer fehlerhaften Datei (z. B. Demo-Datei mit Formatfehlern) | Fehler je Zeile/Feld mit Code, gültige Zeilen übernehmbar | | |
| 1.4 | *Datenprodukte*, Vorschau eines Produkts | Daten aus CSV und API sichtbar | | |
| 1.5 | Abruf als CSV, JSON, XML über *Datenzugriff* bzw. `GET /api/v1/access/{id}/data?purpose=…&format=…` | Dateien mit nur freigegebenen Spalten/Zeilen | | |
| 1.6 | *Audit*: Einträge `import.start`, `import.commit`, `access.data` | vorhanden, Kette *ok* | | |

## AK2 – mindestens drei Knoten-Instanzen

Nachweis: `bun run demo` – Knoten `osp-nord`, `osp-mitte`, `osp-sued` auf `http://127.0.0.1:4401` bis
`:4403`, je ein eigener PostgreSQL-Cluster (Ports 55431–55433) unter `.local/demo/`.

| # | Prüfschritt | Erwartet | Ergebnis | Bemerkung |
|---|---|---|---|---|
| 2.1 | `curl -s http://127.0.0.1:440{1,2,3}/readyz` | dreimal `{"status":"ok","db":true,"schema":true}` | | |
| 2.2 | *Partner* auf jedem Knoten | die beiden anderen Knoten *vertrauenswürdig*, Verbindungsprüfung erfolgreich | | |
| 2.3 | *Discovery* auf einem Knoten | Kataloge der Partner mit Status *ok*, nur Metadaten | | |
| 2.4 | Abruf eines freigegebenen Produkts bei einem Partner | Daten mit Pseudonymen, nur freigegebene Spalten; Herkunftsnachweis | | |
| 2.5 | Abruf ohne passende Freigabe bzw. mit falschem Zweck | abgelehnt (`access_denied`), auf beiden Seiten protokolliert | | |
| 2.6 | Freigabe widerrufen | Mitteilung zugestellt, Kopie beim Empfänger gelöscht (*Empfangene Daten*: *widerrufen*) | | |
| 2.7 | Einwilligung einer Person widerrufen bzw. Person löschen | `subjects_withdrawn` zugestellt, Zeilen beim Empfänger entfernt | | |

## AK3 – Neuinstallation in leerer Umgebung nur nach Dokumentation

Nachweis: Eine Person, die nicht an der Entwicklung beteiligt war, installiert einen Knoten auf einem
frischen System ausschließlich nach [Installation](installation.md) (Variante A oder B) und stellt
Vertrauen zu einem zweiten Knoten her.

| # | Prüfschritt | Erwartet | Ergebnis | Bemerkung |
|---|---|---|---|---|
| 3.1 | Variante gewählt (A nativ / B Docker), Ausgangssystem dokumentiert | leeres System (nur Betriebssystem) | | |
| 3.2 | Installation bis „Prüfen“ | `/healthz` und `/readyz` ok über HTTPS | | |
| 3.3 | Erste Anmeldung mit Initialpasswort | Passwortwechsel erzwungen, danach Zugang | | |
| 3.4 | Hilfe unter `/hilfe/` | erreichbar, Navigation funktioniert | | |
| 3.5 | Sicherung erstellen und auf einem zweiten System wiederherstellen ([Betrieb](betrieb.md#wiederherstellung)) | `restore` mit Exit 0, Audit-Kette ok | | |
| 3.6 | Vertrauen mit Partnerknoten inkl. Fingerprint-Abgleich | beidseitig *vertrauenswürdig*, `ping` erfolgreich | | |
| 3.7 | Dauer, Rückfragen, Abweichungen von der Dokumentation | protokolliert, Dokumentation ggf. korrigiert | | |

Protokoll der Neuinstallation (Befehle, Ausgaben, Abweichungen):

```text
(hier eintragen)
```

## AK4 – Tests für Sicherheit, Backup, Wiederherstellung, Fehlerbehandlung

Nachweis: `bun test` (lokaler Testcluster auf Port 55434, wird automatisch angelegt).

| # | Prüfschritt | Erwartet | Ergebnis | Bemerkung |
|---|---|---|---|---|
| 4.1 | `bun test` | alle Tests bestanden; Anzahl Tests notieren | | |
| 4.2 | `bun test tests/integration/security.test.ts` | Anmeldung, Sperre, CSRF, Rollen, Tokens | | |
| 4.3 | `bun test tests/integration/backup.test.ts` | Sicherung verschlüsselt, Wiederherstellung inkl. Audit-Kette | | |
| 4.4 | `bun test tests/integration/errors.test.ts` | Fehlercodes, Request-ID, Fehlerprotokoll | | |
| 4.5 | `bun test tests/unit/crypto.test.ts tests/unit/release-engine.test.ts` | Kryptografie, Freigaberegeln | | |
| 4.6 | `bun test tests/integration/federation.test.ts tests/integration/audit.test.ts` | Signaturen, Replay-Schutz, Widerruf; Unveränderlichkeit des Audit-Logs | | |

## Ergebnis

| Kriterium | bestanden / nicht bestanden | Nachbesserungen bis |
|---|---|---|
| AK1 | | |
| AK2 | | |
| AK3 | | |
| AK4 | | |

Unterschriften:

| Auftraggeber | Auftragnehmer |
|---|---|
| | |
