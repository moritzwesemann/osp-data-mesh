# Sicherheitskonzept (Kurzfassung)

Kurzfassung für das Angebot: Verschlüsselung, Authentifizierung, Rollen und Rechte,
Schlüsselverwaltung, Trennung der Dienste und Schwachstellenmanagement. Die vollständige Fassung mit allen
Parametern, Restrisiken und Verweisen auf den Code ist das [Sicherheitskonzept](../sicherheit.md).

## Schutzbedarf

Ein Knoten verarbeitet personenbezogene Daten von Athletinnen und Athleten, auch Minderjähriger, darunter
**Gesundheitsdaten (Art. 9 DSGVO)**. Schutzbedarf: **hoch** für Vertraulichkeit und Integrität, **normal** für
Verfügbarkeit (der Trainingsbetrieb hängt nicht vom System ab). Die Maßnahmen orientieren sich am
BSI IT-Grundschutz.

## Grundsätze

| Grundsatz | Umsetzung |
|---|---|
| Deny by default | ohne gültige Freigabe keine Daten, ohne passende Rolle kein Aufruf |
| Ein einziger Ausgabeweg | alle Ausgaben an Empfänger von Freigaben (Oberfläche, Export, REST, BI, Partner) laufen durch den Policy Enforcement Point; Ausnahme sind die protokollierten Pflegeansichten der Datenverantwortung |
| Geringste Rechte | getrennte Datenbankrollen; die Rollen Administration und Revision haben keinen Zugriff auf Fachdaten |
| Verteidigung in der Tiefe | z. B. Art.-9-Regel beim Erteilen **und** bei jeder Ausgabe geprüft; Ausgaben gegen das Antwortschema gefiltert |
| Nachvollziehbarkeit | manipulationsgeschütztes Audit-Log, extern bei Partnern verankert |
| Keine eigene Kryptografie | nur geprüfte Verfahren aus der Laufzeit (`node:crypto`, Argon2id) |

## Verschlüsselung

**Bei der Übertragung**

| Strecke | Schutz |
|---|---|
| Browser, Werkzeuge → Knoten | HTTPS (TLS 1.2/1.3) über Caddy, automatische Zertifikate (ACME) oder interne CA, HSTS |
| Knoten ↔ Knoten | HTTPS **und** Ed25519-Signatur auf jeder Anfrage und Antwort, Schutz vor Wiederholung (Zeitfenster ± 5 min, Nachrichten-ID) |
| BI-Werkzeuge → Datenbank | nur wenn freigeschaltet, dann ausschließlich mit PostgreSQL-TLS oder VPN |
| Knoten → Messsysteme | Zugangsgeheimnisse nur über HTTPS; Ziele nur aus einer Positivliste |
| intern (Proxy → Server → Datenbank) | Loopback bzw. interne Container-Netze ohne Außenverbindung |

**Im Ruhezustand**

- Privater Knotenschlüssel, Pseudonym-Schlüssel und Zugangsdaten von Quellen: **AES-256-GCM** mit einem
  Master-Key, der nur aus der Umgebung kommt, nie aus der Datenbank.
- **Sicherungen** vollständig verschlüsselt (AES-256-GCM, eigener Schlüssel).
- Passwörter nur als **Argon2id**-Hash; Sitzungs- und API-Token nur als SHA-256.
- Fachdaten liegen in der Datenbank unverschlüsselt; gefordert ist deshalb **Datenträgerverschlüsselung**
  für Datenbank und Sicherungen beim Betreiber (z. B. LUKS oder verschlüsselte Volumes).

## Authentifizierung

- Anmeldung mit E-Mail und Passwort (mindestens 12 Zeichen); Initialpasswort muss bei der ersten Anmeldung
  geändert werden.
- **Kontosperre** nach 5 Fehlversuchen für 15 Minuten, **Ratenbegrenzung** je IP-Adresse; einheitliche
  Fehlermeldung, damit niemand erfährt, ob ein Konto existiert.
- **Sitzungen** im Cookie `__Host-osp_session` (`HttpOnly`, `Secure`, `SameSite=Strict`), Ablauf nach 12
  Stunden; zusätzlicher CSRF-Schutz.
- **API-Tokens** für Werkzeuge (Excel, Power BI, Python): einmalig angezeigt, befristet (1–365 Tage),
  widerrufbar, mit den Rechten der Person; Passwortwechsel und Deaktivierung widerrufen alle Tokens.
- **Partnerknoten** authentifizieren sich ausschließlich über ihren Ed25519-Schlüssel; Vertrauen nur nach
  manuellem Abgleich des Fingerabdrucks über einen zweiten Kanal.
- **Noch nicht umgesetzt:** Zwei-Faktor-Anmeldung und Single Sign-on (SAML/OIDC) mit dem
  Verzeichnisdienst des OSP – vor einem Echtbetrieb empfohlen (siehe unten).

## Rollen und Rechte

Fünf Rollen – Administration, Datenverantwortung, Analyse, Trainerteam, Revision – und eine technische
BI-Rolle. Jede Schnittstelle legt im HTTP-Vertrag fest, welche Rollen sie aufrufen dürfen; der Server prüft
das vor jeder Verarbeitung und protokolliert Abweisungen. **Fachdaten erhalten Rollen nur über
Freigaben**; die Datenverantwortung sieht zur Pflege die Rohdaten ihres Knotens (protokolliert). Die
Administration vergibt Rollen – auch sich selbst; jede Rollenänderung ist protokolliert und für die Revision
sichtbar. Ausführlich: [Rollen-, Zugriffs- und Freigabekonzept](rollen-und-freigabekonzept.md).

## Schlüsselverwaltung

| Schlüssel | Aufbewahrung | Wechsel |
|---|---|---|
| Master-Key | Umgebung (Datei mit Rechten 0600), Passwortverwaltung, Offline-Kopie | Kommandozeile `rotate-master-key`, verschlüsselt alle Geheimnisse um |
| Sicherungsschlüssel | wie oben, getrennt von den Sicherungen | neuer Schlüssel für neue Sicherungen |
| Knotenschlüssel (Ed25519) | Datenbank, verschlüsselt | planmäßig mit signierter Mitteilung an alle Partner und Übergangsfrist; bei Kompromittierung ohne Mitteilung, Abgleich per Telefon ([ADR 0013](../adr/0013-knotenschluessel-rotation.md)) |
| Datenbankpasswörter | Umgebung, Passwortverwaltung | `db-bootstrap --rotate-passwords` |
| TLS-Zertifikate | Caddy | automatisch |

Organisatorisch: Zugriff auf Master- und Sicherungsschlüssel nur für benannte Personen (mindestens zwei),
Vier-Augen-Prinzip, Wechsel beim Ausscheiden einer berechtigten Person.

## Trennung externer und interner Dienste

- **Nur Caddy** ist von außen erreichbar (Ports 80/443). Superset läuft unter einem eigenen Hostnamen,
  damit Sitzungs-Cookies nicht geteilt werden.
- Datenbank in einem **internen Netz** ohne Zugang von außen und ohne Verbindung nach außen.
- Getrennte Datenbankrollen: Schema und Migrationen (`mesh_owner`, nur Kommandozeile), Anwendung
  (`mesh_app`, Audit-Log nur anhängen), BI (`mesh_bi`, nur lesend, nur BI-Sichten).
- **Eigener PostgreSQL-Cluster je Knoten**, weil Rollen clusterweit gelten.
- Schutz vor Server-Side Request Forgery: Abrufe nur zu freigegebenen Hosts, keine Weiterleitungen,
  Größen- und Zeitgrenzen.
- Empfehlung: Server in einer DMZ bzw. eigenem VLAN; ausgehend nur HTTPS zu Partnern und Quellen.

Geprüft mit `deploy/verify-deployment.sh`: Datenbank aus dem Frontend-Netz, aus fremden Netzen und vom Host
nicht erreichbar, kein Ausgang; gefälschte `X-Forwarded-For`-Kopfzeilen werden ignoriert.

## Integrität und Nachvollziehbarkeit

- **Audit-Log** nur anhängbar (Datenbank-Trigger sperren Ändern und Löschen), mit **Hash-Kette**.
- **Externe Verankerung:** stündlich signierte Prüfpunkte der Kette liegen bei allen Partnern. Ein Abgleich
  erkennt, wenn jemand mit vollen Datenbankrechten Einträge abschneidet oder umschreibt
  ([ADR 0014](../adr/0014-externe-verankerung-audit-kette.md)).
- Austausch beidseitig protokolliert, mit Herkunftsnachweis (Signatur und Prüfsumme der Antwort).

## Sichere Entwicklung und Eingabeverarbeitung

- Jede Anfrage wird gegen ein Schema geprüft, jede Antwort gegen ein Schema gefiltert.
- SQL ausschließlich parametrisiert; Content-Security-Policy ohne fremde Skripte, `frame-ancestors 'none'`.
- Größengrenzen für Uploads, API- und Partneranfragen; Excel-Dateien werden als feindliche Eingabe
  behandelt (ZIP-Bomben, XML-Entitäten, Formeln werden nie ausgewertet).
- Mehrere interne Sicherheitsreviews des Codes; alle Befunde behoben und mit Regressionstests
  (`tests/**/fix-*.test.ts`) abgesichert. Ein externer Penetrationstest steht aus.

## Schwachstellenmanagement

Das Verfahren ist festgelegt und dokumentiert; Werkzeuge und SBOM sind vorhanden. Eingerichtet werden
CI-Job und Abonnements mit dem ersten Release beim Betreiber.

| Schritt | Vorgehen |
|---|---|
| Bestandsaufnahme | **SBOM** (CycloneDX 1.6 nach BSI TR-03183-2) für Quellcode, gebaute Oberfläche und Container-Abbild; wenige, verbreitete Abhängigkeiten, festgeschrieben mit SHA-512 |
| Erkennen | mindestens wöchentlich und vor jedem Release `bun audit`, Abgleich der SBOM mit der OSV-Datenbank, Scan des Container-Abbilds (z. B. Trivy, Grype); Sicherheitsmeldungen von Bun, PostgreSQL, Caddy, Debian und Superset abonnieren |
| Melden von außen | vertraulich über GitHub Security Advisories (`SECURITY.md`) |
| Bewerten und beheben | kritisch (CVSS ≥ 9,0) binnen 72 Stunden, hoch binnen 14 Tagen, sonst mit dem monatlichen Update |
| Ausliefern | Tests, neue SBOM (signiert mit dem Projektschlüssel), Release, Information der Betreiber |

## Fehlerbehandlung

Fehler sind **sichtbar und protokolliert**: Fachliche Fehler liefern einen Code aus einer festen Liste und
eine Request-ID; die Oberfläche zeigt dazu eine verständliche deutsche Meldung. Interne Details (z. B.
Datenbankmeldungen) erreichen die Nutzenden nie, sondern stehen im Fehlerprotokoll und im Betriebslog.
Zustellfehler an Partner werden angezeigt und wiederholt.

## Nachweise

`security.test.ts`, `crypto.test.ts`, `audit-anchors.test.ts`, `federation-protocol.test.ts`,
`federation-key-rotation.test.ts`, `errors.test.ts`, die Regressionstests `fix-*.test.ts` und
`deploy/verify-deployment.sh`; Zuordnung je Anforderung (S1–S11) in den
[Anforderungen](../requirements.md#rollen-rechte-datenschutz-sicherheit).

## Vor einem Echtbetrieb

1. Externer **Penetrationstest** und Code-Review der Sicherheitsfunktionen.
2. **Zwei-Faktor-Anmeldung** bzw. Anbindung an das Identitätsmanagement des OSP.
3. Datenträgerverschlüsselung und Härtung des Hosts nach BSI IT-Grundschutz (SYS.1.3, APP.4.3).
4. Knotenschlüssel in einem HSM bzw. Schlüsseldienst statt verschlüsselt in der Datenbank (optional).
5. Ratenbegrenzung über mehrere Prozesse hinweg (heute im Speicher eines Prozesses).
