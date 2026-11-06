# Betriebskonzept

Dieses Konzept beschreibt, wie ein Knoten bereitgestellt, überwacht, gesichert, wiederhergestellt und
aktualisiert wird und wie auf Sicherheitsvorfälle reagiert wird. Die Befehle und Einstellungen stehen im
[Betriebshandbuch](../betrieb.md), in der [Installation](../installation.md) und in der
[Incident Response](../incident-response.md).

## Betriebsmodelle

Jeder OSP entscheidet selbst, wo sein Knoten läuft. Alle drei Modelle der Ausschreibung nutzen dieselbe
Software und dieselbe Konfiguration:

| Modell | Beschreibung | Hinweise |
|---|---|---|
| **Lokal beim OSP** | Server oder VM im eigenen Netz, nativ oder mit Docker | volle Datenhoheit; IT des OSP betreibt |
| **Beim Dienstleister** | Rechenzentrum eines IT-Dienstleisters | Auftragsverarbeitungsvertrag (Art. 28 DSGVO); Zugriff auf Master- und Sicherungsschlüssel regeln |
| **In einer Cloud** | VM oder Container-Plattform eines Cloud-Anbieters | Standort EU/EWR, verschlüsselte Volumes, Auftragsverarbeitung |

**Mindestumgebung je Knoten:** Linux-Server (Debian 13 oder Ubuntu 24.04) bzw. Docker-Host mit 2 vCPU,
4 GB RAM und 20 GB verschlüsseltem Plattenplatz zuzüglich Sicherungen; Superset braucht zusätzlich Speicher
und Arbeitsspeicher. Ein DNS-Name mit TLS-Zertifikat; eingehend nur Port 443 (und 80 für die
Weiterleitung), ausgehend HTTPS zu Partnerknoten und Datenquellen.

## Rollen im Betrieb

| Rolle | Aufgaben |
|---|---|
| IT-Betrieb des OSP (Rolle `admin` im System) | Installation, Updates, Sicherungen, Überwachung, Benutzer, Vertrauen zu Partnern, Schlüsselverwaltung |
| Datenverantwortung (`data_steward`) | Quellen, Importe, Datensätze, Datenprodukte, Freigaben, Einwilligungen |
| Datenschutz/Revision (`auditor`) | regelmäßige Prüfung von Audit-Log und Austauschprotokoll |
| Partner-OSP | Abgleich der Fingerabdrücke, Verwahrung der Prüfpunkte des Audit-Logs, Erreichbarkeit für Mitteilungen |

Die Rolle Administration hat **keinen Zugriff auf Fachdaten**. Sie vergibt aber Rollen – auch sich selbst;
jede Rollenänderung ist protokolliert und für die Revision sichtbar. Wer Zugriff auf Host oder Datenbank
hat, kann Fachdaten unabhängig von Rollen lesen. Bei einem externen Dienstleister regeln deshalb der
Auftragsverarbeitungsvertrag und die Prüfung durch die Revision, dass er keine Fachdaten einsieht.

## Bereitstellung (Deployment)

**Variante A – nativ:** Bun 1.4.3, PostgreSQL 18, Caddy und systemd auf einem Linux-Server.
**Variante B – Docker Compose:** Datenbank, Migration, Knoten und Caddy als Container; Superset als
optionales Profil `bi`.

Ablauf in beiden Varianten:

1. Umgebungsdatei mit Knotenkennung, Domain, Master-Key und Sicherungsschlüssel anlegen (Schlüssel per
   Befehl erzeugt, Kopie in die Passwortverwaltung).
2. Datenbankrollen und -datenbank anlegen, Schema migrieren, Oberfläche und Hilfe bauen.
3. Erste Administration anlegen (Initialpasswort, Wechsel bei der ersten Anmeldung erzwungen).
4. Prüfen: `/healthz`, `/readyz`, Anmeldung über HTTPS, Hilfe unter `/hilfe/`; bei Docker zusätzlich
   `deploy/verify-deployment.sh` (TLS, Netztrennung, Proxy-Vertrauen, BI-Zugang, Superset).
5. Vertrauen mit Partnerknoten herstellen (Knotenkarten tauschen, Fingerabdruck telefonisch abgleichen).

**Nachweis:** Neuinstallation in einer leeren Umgebung ausschließlich nach Dokumentation, nativ und mit
Docker (Abnahmekriterium AK3); gefundene Mängel der Dokumentation sind behoben.

## Überwachung

| Prüfung | Erwartung | Empfohlener Alarm |
|---|---|---|
| `GET /readyz` | `{"status":"ok","db":true,"schema":true}` | ≠ 200 länger als 2 Minuten |
| letzte Sicherung | erfolgreich, jünger als 2 × Intervall | keine erfolgreiche Sicherung seit 48 Stunden |
| Ausgangspostfach | keine fehlgeschlagenen Mitteilungen | `outbox.failed > 0` (Partner hat Widerruf oder Löschung nicht erhalten) |
| Fehler der letzten 24 Stunden (*System*) | gering, stabil | stark steigend |
| `verify-audit` (täglich), mit Partnern und Anker-Profil (wöchentlich) | Exit-Code 0 | jede Abweichung → Incident Response |
| Plattenplatz | > 20 % frei | darunter |
| Zertifikatslaufzeit | > 14 Tage | darunter (Caddy erneuert automatisch) |

Logs: JSON-Zeilen ohne Fachdaten (IP-Adressen nur in Zugriffs- und Ablehnungsprotokollen), jede Antwort
mit Request-ID, die auch in Fehlermeldungen der
Oberfläche erscheint. Empfehlung: 30 Tage aufbewahren, an ein zentrales Log-System des OSP weiterleiten.

## Sicherung

| Merkmal | Umsetzung |
|---|---|
| Umfang | vollständige Datenbank einschließlich Audit-Log, Austauschprotokoll und (verschlüsselter) Schlüssel; abgeleitete BI-Sichten werden nach einer Wiederherstellung neu aufgebaut |
| Verschlüsselung | AES-256-GCM mit eigenem Sicherungsschlüssel; Knotenkennung, Zeitpunkt und Schemaversion fälschungssicher gebunden; Manifest mit SHA-256 |
| Häufigkeit | automatisch alle 24 Stunden (einstellbar), zusätzlich manuell in der Oberfläche oder per Kommandozeile – immer vor einem Update |
| Aufbewahrung | die neuesten 14 Sicherungen (einstellbar) |
| Auslagerung | täglich auf ein zweites System (3-2-1-Regel); Sicherungsschlüssel getrennt von den Dateien |
| Protokoll | jede Sicherung im Audit-Log und unter *System › Sicherungen* |

## Wiederherstellung

- **Ein Befehl** (`cli restore`) ersetzt die gesamte Datenbank durch den Stand einer Sicherung – **in einer
  Transaktion**: Schlägt sie fehl, bleibt die Datenbank unverändert.
- Eine **Knotensperre** verhindert, dass ein laufender Server während der Wiederherstellung schreibt.
- Danach werden Rechte neu gesetzt, alle Sitzungen beendet und die **Audit-Kette geprüft**; die
  Wiederherstellung beginnt eine neue, dokumentierte Epoche der Kette.
- Löschungen und Widerrufe nach dem Sicherungszeitpunkt sind erneut auszuführen (siehe
  [Datenschutzkonzept](datenschutzkonzept.md#rechte-der-betroffenen-personen)).
- **Wiederherstellungstest vierteljährlich** auf einem getrennten System mit eigenem PostgreSQL-Cluster;
  Ergebnis dokumentieren, Testsystem danach löschen.

**Nachweis:** `backup.test.ts`, `fix-cli-operations.test.ts`, `fix-node-lock.test.ts`; Sicherung und
Wiederherstellung nativ, mit Docker und in einen neuen Stack durchgeführt.

**Wiederanlaufziele (Vorschlag, mit dem OSP festzulegen):** Wiederherstellungszeit (RTO) 1 Arbeitstag;
maximaler Datenverlust (RPO) 24 Stunden – kürzer durch häufigere Sicherungen oder PostgreSQL-Replikation.
Weil der Trainingsbetrieb nicht vom System abhängt, genügt normale Verfügbarkeit.

## Updatefähigkeit

- **Versionierte Migrationen** mit Prüfsummen, nur vorwärts gerichtet; eine Rückkehr erfolgt über die vor
  dem Update erstellte Sicherung mit der alten Programmversion.
- **Ablauf:** Sicherung → neue Version holen → Abhängigkeiten nach `bun.lock` → bauen → Migration →
  Neustart → Prüfung. Mit Docker startet die Migration automatisch vor dem Knoten.
- **Rhythmus:** Betriebssystem und Container-Basisabbilder monatlich; Bun und Abhängigkeiten quartalsweise
  oder bei Sicherheitsmeldungen; PostgreSQL-Nebenversionen zeitnah; Hauptversionswechsel geplant mit
  `pg_upgrade` oder Sicherung und Wiederherstellung.
- **Kompatibilität im Netz:** Jede Nachricht des Föderationsprotokolls trägt eine Protokollversion
  (`osp-mesh/1`, Feld `v`). Grundsatz für die Weiterentwicklung: Protokolländerungen werden so eingeführt,
  dass Knoten mit alter und neuer Version eine Übergangszeit lang zusammenarbeiten – jeder OSP aktualisiert
  zu seinem eigenen Zeitpunkt.
- Jede Version erhält eine neue, signierte SBOM.

## Incident Response

| Phase | Vorgehen |
|---|---|
| Erkennen | Audit-Prüfung (`verify-audit`, Abgleich mit Partnern), gehäufte Anmeldefehler, abgewiesene Zugriffe, ungewöhnliche Abrufe, Föderations-Ablehnungen, Fehlerzahlen, Meldungen von Nutzenden, Partnern und Betroffenen |
| Einstufen | Stufe 1 (niedrig) im Regelbetrieb; Stufe 2 (mittel) binnen 1 Arbeitstag; Stufe 3 (hoch, z. B. unbefugter Zugriff auf Personendaten) **sofort**; Gesundheitsdaten im Zweifel höher |
| Beweise sichern | Audit-Log exportieren, Betriebs- und Proxy-Logs sichern, Sicherung erstellen, ggf. Abbild des Datenträgers |
| Eindämmen | Konto deaktivieren (widerruft alle Sitzungen und API-Tokens), Partner sperren, Freigaben widerrufen, Produkt stilllegen, Knoten vom Netz nehmen |
| Schlüssel erneuern | je nach Vorfall Passwörter, Tokens, Datenbankpasswörter, Master-Key, Knotenschlüssel (bei Kompromittierung ohne Mitteilung, Abgleich per Telefon), Sicherungsschlüssel, TLS |
| Melden | Aufsichtsbehörde binnen **72 Stunden** (Art. 33 DSGVO), Betroffene bei hohem Risiko (Art. 34), Partner-OSP, deren Daten betroffen sind |
| Wiederherstellen | Ursache beseitigen, ggf. Sicherung vor dem Vorfall einspielen oder auf frischem System neu installieren, Funktionsprüfung, Partner informieren |
| Nachbereiten | Besprechung ohne Schuldzuweisung binnen zwei Wochen, Maßnahmen, Aktualisierung der Konzepte, Ablage des Vorfallprotokolls |

Vor einem Echtbetrieb trägt jeder OSP seine Kontakte in die Vorlage der
[Incident Response](../incident-response.md) ein und hinterlegt sie ausgedruckt beim IT-Betrieb.

## Aufbewahrung und Löschung

Technisch geregelt: Ablauf empfangener Kopien bei Fristende (minütliche Prüfung), Importvorschauen nach
höchstens 7 Tagen, Sitzungen nach 12 Stunden, Sicherungen nach der eingestellten Anzahl. Organisatorisch
festzulegen: Fristen für Fach- und Gesundheitsdaten, Einwilligungsnachweise und das Audit-Log
([Betrieb › Aufbewahrung](../betrieb.md#aufbewahrung-und-löschfristen)).

## Kapazität

Ausgelegt auf das Mengengerüst eines OSP: einige tausend Personen, zehn- bis hunderttausende Messwerte je
Datensatz. Importe bis 100 000 Zeilen je Lauf; Abrufe lassen sich mit `limit` auf bis zu 100 000 Zeilen
je Anfrage begrenzen. Datenbank überschlägig
1–2 KB je Messwert einschließlich Indizes.
