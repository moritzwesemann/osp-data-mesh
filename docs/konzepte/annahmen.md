# Annahmen, Abweichungen und Gleichwertigkeit

Die Ausschreibung verlangt, alle Annahmen offenzulegen und bei Abweichung von geforderter Technik die
Gleichwertigkeit nachzuweisen. Diese Seite fasst beides zusammen und nennt ehrlich, was geprüft ist und was
nicht.

## Geforderte Technik und Abweichungen

| Vorgabe der Ausschreibung | Umsetzung | Abweichung |
|---|---|---|
| Modularer Monolith je OSP-Data-Node, containerisiert | ein Server-Prozess mit Fachmodulen; Docker-Abbild und Docker Compose; zusätzlich native Installation | keine |
| Bereitstellung lokal, beim Auftragnehmer oder in einer Cloud | dieselbe Konfiguration für alle drei Modelle | keine |
| PostgreSQL oder gleichwertig | **PostgreSQL 18** | keine |
| Apache Superset oder gleichwertig, 2–3 Referenz-Dashboards | **Apache Superset 6.1**, drei Dashboards mit 13 Diagrammen | keine |
| Keine proprietäre Zugriffsschicht; offene Schnittstellen für Excel, Power BI, SAP Analytics Cloud, Tableau, Python | Standard-PostgreSQL-Zugang (nur lesend) und REST mit CSV, JSON, XML | keine |
| SBOM nach BSI TR-03183-2 im Format CycloneDX | CycloneDX 1.6 (JSON) nach TR-03183-2 v2.1.0 | keine |
| Open-Source-Lizenz gemäß openCode | EUPL-1.2 | keine |
| Deutschsprachige HTML-Webdokumentation | diese Hilfe | keine |

Es gibt **keine Abweichung** von geforderter Technik; ein Gleichwertigkeitsnachweis ist deshalb nicht
nötig.

**Nicht vorgegebene Technik**, frei gewählt und begründet in den Architekturentscheidungen:

| Wahl | Begründung | Alternative ohne Neuentwicklung |
|---|---|---|
| Bun 1.4 als TypeScript-Laufzeit | ein Werkzeug für Laufzeit, Pakete, Tests und Passwort-Hashing; wenige Abhängigkeiten ([ADR 0002](../adr/0002-stack-bun-hono-kysely-react.md)) | Standard-TypeScript mit Web-Standards (`Request`/`Response`) und nur wenigen Bun-spezifischen Aufrufen (Server-Start, Passwort-Hashing, Prozessaufrufe); ein Wechsel auf Node.js ist mit begrenztem Aufwand möglich |
| Caddy als Reverse Proxy | automatische Zertifikate, einfache Konfiguration | jeder Reverse Proxy mit TLS (nginx, Apache, Traefik) |
| Ed25519 für die Signaturen zwischen Knoten | modern, schnell, in allen gängigen Kryptobibliotheken verfügbar ([ADR 0005](../adr/0005-pull-austausch-ed25519.md)) | – |

## Annahmen

### Umfang

1. Die Software ist als **Prototyp fertig umgesetzt**. Ein Projektplan für die Umsetzung entfällt; Aufwand
   entsteht für Einführung, Pilotbetrieb und Abnahme an echten Standorten.
2. **Schulungen** (je zwei für Administration und Anwendung, Videokonferenz), **Schulungsunterlagen**,
   **Fehlerbehebung und neue Programmversionen nach der Abnahme** sowie Leistungen nach Aufwand
   (Änderungswünsche, Anwenderunterstützung, Beratung, Datenmigration) sind Dienstleistungen und nicht Teil
   der Software. Die Dokumentation bildet die Grundlage für die Schulungsunterlagen.
3. **Hosting und Betrieb** der Knoten übernehmen die OSP selbst oder ein von ihnen beauftragter
   Dienstleister.

### Umgebung

4. Jeder Pilotstandort stellt einen Server bzw. eine VM, einen DNS-Namen und die nötigen Firewall-Freigaben
   bereit ([Mitwirkung](mitwirkung.md)).
5. Jeder Knoten erhält einen **eigenen PostgreSQL-Cluster** (Datenbankrollen gelten clusterweit).
6. Die Knoten der Partner-OSP sind untereinander über HTTPS erreichbar (Internet oder Verbandsnetz).
7. Die Zahl der Nutzenden und Daten je OSP entspricht dem Mengengerüst eines Stützpunkts (einige tausend
   Personen, zehn- bis hunderttausende Messwerte je Datensatz).

### Datenquellen

8. Messsysteme und Fachanwendungen liefern ihre Daten als **CSV- oder Excel-Datei** oder über eine
   **HTTP-Schnittstelle mit JSON**, erreichbar mit Token oder OAuth2 Client Credentials. Systeme mit anderen
   Protokollen (z. B. SOAP, proprietäre Binärformate, Datenbankzugriff) brauchen einen Export als Datei oder
   eine Erweiterung des Connectors.
9. Für die API-Anbindung stellen Hersteller bzw. Betreiber eine Schnittstellenbeschreibung und einen
   Testzugang bereit.

### Datenschutz

10. Einwilligungen werden – wie in der Ausschreibung vorgesehen – **außerhalb des Systems** eingeholt; das
    System dokumentiert sie optional und wertet sie bei Freigaben aus.
11. Verantwortlichkeitsmodell, Rechtsgrundlagen, Einwilligungstexte, Austauschvereinbarung und
    Aufbewahrungsfristen legen die beteiligten Stellen fest; die Konzepte machen dazu Vorschläge, keine
    Rechtsberatung.

### Rechte

12. Der Auftraggeber erhält den vollständigen Quellcode unter der **EUPL-1.2**. Sie gewährt jedermann das
    Recht zur Nutzung, Änderung, Weiterentwicklung, zum Betrieb und zur Weitergabe; veränderte Fassungen,
    die weitergegeben werden, bleiben offen. Damit gibt es keine faktische Bindung an den Auftragnehmer.
13. Alle ausgelieferten npm-Pakete stehen unter freizügigen Open-Source-Lizenzen (MIT, ISC, BSD,
    Apache-2.0; die Schrift unter der SIL Open Font License), die eine Bündelung mit der EUPL-1.2 erlauben.
    Das Container-Abbild enthält zusätzlich Debian-Pakete unter eigenen Lizenzen (u. a. GPL), die als
    eigenständige Programme mitgeliefert werden.
    Eine abschließende rechtliche Prüfung der Lizenzkompatibilität wird empfohlen ([Lizenzen](../lizenzen.md)).

## Was geprüft ist

| Prüfung | Ergebnis |
|---|---|
| Automatisierte Tests (Unit, Integration) | 847 Tests bestanden |
| Abläufe im Browser gegen echte Knoten (Desktop, 1000 px, 390 px) | 12 Abläufe bestanden, fünf Läufe in Folge |
| Demo mit drei Knoten, drei PostgreSQL-Clustern und echtem HTTP | 57 Prüfungen bestanden: Import aus fünf CSV-Dateien und einer API, Freigaben, Austausch, Widerruf, Exporte, BI-Zugang, Audit, Sicherungen |
| Neuinstallation nur nach Dokumentation | nativ und mit Docker durchgeführt; Mängel der Dokumentation behoben |
| Docker-Bereitstellung | `deploy/verify-deployment.sh`: TLS, Netztrennung, Proxy-Vertrauen, BI-Zugang, Superset |
| Superset | alle 13 Diagramme der drei Dashboards liefern Daten (lokal und im Container, auch über HTTPS) |
| BI-Schnittstellen | mit Python/pandas, DuckDB und psql geprüft; Power-Query-Code syntaktisch geprüft |
| Sicherheit | mehrere interne Sicherheitsreviews des Codes, alle Befunde behoben und mit Regressionstests abgesichert |

Einzelnachweise je Anforderung: [Anforderungen und Nachverfolgbarkeit](../requirements.md).

## Was nicht geprüft ist

- **Pilotstandorte:** Die drei Knoten liefen bisher lokal, nicht an echten OSP.
- **Echte Messsysteme:** Die API-Anbindung ist mit einem simulierten Messsystem geprüft, nicht mit einem
  Gerät eines bestimmten Herstellers.
- **Excel, Power BI, Tableau, SAP Analytics Cloud und R** selbst wurden nicht ausgeführt (nur ihre
  Schnittstellen).
- **Betriebsumgebung:** Server mit Intel-/AMD-Prozessor (geprüft auf ARM), öffentliche Domain mit
  automatischem Zertifikat, Betrieb als systemd-Dienst.

## Was vor einem Echtbetrieb noch zu tun ist

1. Pilotbetrieb an drei Standorten mit echten Quellen (Abnahmekriterien AK1, AK2 an Pilotstandorten).
2. Externer Penetrationstest.
3. Rechtliche Prüfung des Datenschutzkonzepts, Datenschutz-Folgenabschätzung.
4. Zwei-Faktor-Anmeldung bzw. Anbindung an einen Verzeichnisdienst.
5. Festlegung der Aufbewahrungsfristen und Ausfüllen der Kontakte für die Incident Response.
