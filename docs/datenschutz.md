# Datenschutzkonzept

Dieses Konzept beschreibt, wie OSP-Data-Mesh die Anforderungen der DSGVO technisch unterstützt. Es ersetzt
weder das Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO) noch eine
Datenschutz-Folgenabschätzung (Art. 35 DSGVO) des jeweiligen Olympiastützpunkts, liefert aber die dafür
nötigen Angaben.

> **Rechtliche Prüfung erforderlich.** Insbesondere das Verantwortlichkeitsmodell zwischen den OSP, die
> Rechtsgrundlagen je Zweck, die Einwilligungstexte (auch für Minderjährige) und die Aufbewahrungsfristen
> sind vor einem Echtbetrieb mit den Datenschutzbeauftragten der beteiligten Stellen und ggf. der
> zuständigen Aufsichtsbehörde abzustimmen. Die folgenden Aussagen zu Rollen und Rechtsgrundlagen sind
> Vorschläge, keine Rechtsberatung.

## Verantwortlichkeit

| Konstellation | Einordnung (Vorschlag) |
|---|---|
| Ein OSP verarbeitet Daten seiner Athletinnen/Athleten im eigenen Knoten | der OSP ist **Verantwortlicher** (Art. 4 Nr. 7) |
| Betrieb des Knotens durch einen IT-Dienstleister oder in einer Cloud | **Auftragsverarbeitung** (Art. 28): Vertrag zur Auftragsverarbeitung, Standort EU/EWR, TOM des Dienstleisters prüfen |
| OSP A gibt Daten per Freigabe an OSP B | **Übermittlung** an einen anderen Verantwortlichen: OSP B ist für seine Kopie selbst verantwortlich; Grundlage ist eine Vereinbarung zum Datenaustausch (Zwecke, Löschpflichten, Weitergabeverbot, Nachweise) |
| Gemeinsame Festlegung von Zwecken und Mitteln des Netzes (z. B. durch den Landessportverband und alle OSP) | ggf. **gemeinsame Verantwortlichkeit** (Art. 26) für den Netzbetrieb: Vereinbarung über die Aufgabenverteilung, Informationspflichten, Anlaufstelle für Betroffene |

Das System hat **keine zentrale Stelle**: Es gibt keinen Server, auf dem Daten mehrerer OSP
zusammenlaufen. Jeder Knoten entscheidet selbst über seine Freigaben.

## Betroffene Personen und Datenkategorien

| Betroffene | Daten | Speicherort |
|---|---|---|
| Athletinnen und Athleten (auch **Minderjährige**) | Stammdaten: Nachname, Vorname, Geburtsdatum, Sportart, Kaderstatus, optional Geschlecht, Verein, Disziplin; Kennungen in Quellsystemen | `athlete`, `athlete_identifier` |
| | Mess- und Fachdaten je Datensatz-Kategorie: Leistung (`performance`), Training (`training`), Wettkampf (`competition`), **Gesundheit (`health`, Art. 9)**, Sonstiges | `dataset_record` |
| | Einwilligungsnachweise (Zweck, Kategorie, Gültigkeit, Vermerk zum Nachweis) | `consent_record` |
| | empfangene Daten anderer OSP (nur freigabebezogene Pseudonyme + freigegebene Spalten) | `received_row` |
| | Importvorschauen: geprüfte, noch nicht übernommene Zeilen einer Quelle, Auszug der Rohwerte, Rohwerte fehlerhafter Felder – nur bis zur Übernahme, zum Verwerfen oder höchstens 7 Tage (siehe [Datenminimierung](#datenminimierung)) | `import_run.staged`, `import_run.preview`, `import_error.raw_value` |
| Nutzende des Systems (Beschäftigte des OSP, Partner-Administrationen) | E-Mail, Name, Rollen, Anmeldezeitpunkte, Sperrstatus, IP-Adresse und User-Agent der Sitzung, API-Token-Metadaten | `app_user`, `user_session`, `api_token` |
| | Protokolldaten: Wer hat wann was getan (inkl. IP-Adresse) | `audit_log`, `exchange_log` |

## Besondere Kategorien (Art. 9 DSGVO)

- Datensätze der Kategorie **Gesundheit** sind technisch immer als besondere Kategorie markiert
  (Datenbank-Constraint). Andere Datensätze können als besondere Kategorie markiert werden.
- **Empfehlung:** leistungsdiagnostische Werte mit medizinischem Bezug (z. B. Laktat, Herzfrequenz,
  Verletzungen) im Zweifel als besondere Kategorie markieren; die Einordnung treffen
  Datenverantwortliche mit den Datenschutzbeauftragten.
- Freigaben besonderer Kategorien **müssen** eine Einwilligungsprüfung haben (`requiresConsent`). Das
  wird beim Erteilen und bei jeder Ausgabe erneut geprüft (Verteidigung in der Tiefe, siehe
  [Freigaberegeln](freigaberegeln.md#besondere-kategorien-art-9-dsgvo)).
- Diese Markierung wird an Partner übertragen (`specialCategory`) und dort angezeigt.

## Rechtsgrundlagen und Einwilligungen

Die Rechtsgrundlage ist je Zweck festzulegen (z. B. Einwilligung nach Art. 6 Abs. 1 lit. a / Art. 9 Abs. 2
lit. a, Vertrag bzw. Athletenvereinbarung nach Art. 6 Abs. 1 lit. b, ggf. gesetzliche Aufgaben). Jede
Freigabe hat ein Feld **Rechtsgrundlage** (`legalBasis`), in dem die gewählte Grundlage dokumentiert wird.

**Einwilligungen werden außerhalb des Systems eingeholt** (Papier oder digitales Formular; bei
Minderjährigen nach den Vorgaben für die Einwilligung der Sorgeberechtigten bzw. Art. 8 DSGVO) und können
**optional im System dokumentiert** werden:

- je Person: Zweck (oder `*` für alle), Datenkategorie (oder `*`), gültig von/bis, Vermerk zum Nachweis
  (z. B. „Formular v3 vom 12.09.2026, Ablage Sekretariat“) – nicht das Dokument selbst;
- **Widerruf** wird mit Zeitpunkt und Person erfasst und wirkt sofort (siehe
  [Widerruf und Weitergabe](widerruf-und-weitergabe.md)).

Nur Freigaben mit Einwilligungsprüfung werten diese Einträge aus: Dann werden ausschließlich Personen mit
gültiger, nicht widerrufener Einwilligung für den angefragten Zweck und die Datenkategorie ausgegeben.

## Zweckbindung

Das System kennt ein festes Zweck-Vokabular (Tabelle `purpose`):

| Code | Zweck |
|---|---|
| `training_steering` | Trainingssteuerung |
| `performance_diagnostics` | Leistungsdiagnostik |
| `medical_care` | Medizinische Betreuung |
| `talent_development` | Talententwicklung |
| `reporting` | Berichtswesen (aggregierte Auswertungen, BI) |
| `research` | Forschung (mit gesonderter Einwilligung) |

Jede Freigabe nennt die zulässigen Zwecke. **Jeder Abruf muss einen Zweck angeben** (Oberfläche, REST,
Partner); ein nicht freigegebener Zweck führt zur Ablehnung (`purpose_not_allowed`). Der Zweck wird im
Audit- bzw. Austauschprotokoll festgehalten.

## Datenminimierung

- **Datenprodukte** enthalten nur ausgewählte Spalten eines Datensatzes; abgeleitete Werte wie
  *Geburtsjahr* statt Geburtsdatum stehen zur Verfügung.
- **Freigaben** beschränken zusätzlich nach Spalten, Zeilen (Bedingungen), Datenzeitraum,
  Gültigkeitsdauer und Zweck. Was nicht freigegeben ist, wird nicht ausgegeben (*deny by default*); neue
  Spalten eines Produkts sind nicht automatisch freigegeben.
- **Produkt- und Datensatzänderungen** machen bestehende Freigaben ungültig, bis sie neu erteilt werden –
  eine Ausweitung kann nicht unbemerkt geschehen ([ADR 0010](adr/0010-produktaenderung-invalidiert-freigaben.md)).
  Wird ein Datensatz neu besondere Kategorie, wechselt ein Datensatz besonderer Kategorie die Kategorie
  oder wird er intern, werden alle Partnerfreigaben der betroffenen Produkte widerrufen
  (`dataset_reclassified`) und die Partner löschen ihre Kopien.
- **Abrufstatistik:** Empfänger sehen beim Abruf (`access.data`) nur die Zahl der gelieferten Zeilen,
  nicht, wie viele Zeilen durch Zeilenbeschränkung, Zeitraum oder fehlende Einwilligung entfallen (daraus
  ließe sich etwa ablesen, für wie viele Personen keine Einwilligung vorliegt); diese Zahlen zeigen nur die
  Vorschauen für Datenverantwortliche.
- **Vorschau** (`releases.preview`) zeigt vor dem Erteilen, wie viele Zeilen und welche Spalten eine
  Freigabe liefern würde.
- **Keine Gesamtsynchronisation:** Partner erhalten nur einzelne freigegebene Produkte; jeder Abruf
  ersetzt die bisherige Kopie vollständig.
- **Importe:** Die hochgeladene Datei bzw. API-Antwort wird nicht gespeichert (nur Prüfsumme und Größe).
  Geprüfte Zeilen, die Vorschau und die Rohwerte fehlerhafter Felder bleiben nur, solange die Vorschau
  offen ist: Sie werden bei Übernahme oder Verwerfen gelöscht, spätestens nach **7 Tagen** automatisch
  (Audit `import.expire`). Fehler bei der Personenzuordnung (`athlete_not_found`, `athlete_ambiguous`)
  speichern keine Namen, Geburtsdaten oder Kennungen, nur Zeile und Zuordnungsfelder. Dauerhaft bleiben
  nur Zähler, Prüfsumme, Dateiname, Spaltennamen und das Fehlerprotokoll aus Zeile, Feld und Prüfcode.

## Pseudonymisierung im Austausch

Partner erhalten statt der internen Personen-ID ein **freigabebezogenes Pseudonym** (HMAC mit einem nur
dem Datenhalter bekannten Schlüssel über Freigabe-ID und Person). Folgen:

- Der Empfänger kann Daten **verschiedener Freigaben** nicht über eine gemeinsame ID verknüpfen.
- Der Datenhalter kann gezielt Löschmitteilungen für einzelne Personen senden.
- Enthält das Produkt Namen oder andere Identifikatoren, sind die Daten für den Empfänger **nicht**
  pseudonym. Auch Kombinationen wie Sportart + Geburtsjahr + Geschlecht können in kleinen Kadern eine
  Person bestimmbar machen. Pseudonymisierte Daten bleiben personenbezogene Daten (Art. 4 Nr. 5); die
  Produktgestaltung muss das berücksichtigen.

## Zugriffsprotokollierung

Protokolliert werden u. a. jede Anmeldung (auch fehlgeschlagen), jeder lesende Zugriff auf Personendaten
(Athletenliste und -detail, Datensatz-Einträge, Produktvorschau, Datenabruf, empfangene Daten), jede
Freigabe und jeder Widerruf, Einwilligungen und deren Widerruf, Löschungen, jeder Austausch mit Partnern
(geliefert, empfangen, abgelehnt – mit Spalten, Zeilenzahl und übermittelten Pseudonymen) und abgewiesene
Zugriffe. Abgelehnte Föderationsanfragen ohne gültige, frische Signatur werden zusammengefasst
protokolliert (erste je Quelle und Code in 5 Minuten, höchstens 20 je 5 Minuten; alle im Betriebslog). Das Audit-Log ist nur anhängbar und durch eine Hash-Kette gesichert; einsehen und exportieren
kann es die Rolle `auditor` (Datenschutz, Revision). Die Protokolle enthalten keine Fachdaten, nur IDs,
Zähler und Codes.

## Rechte der betroffenen Personen

| Recht | Unterstützung im System |
|---|---|
| Auskunft (Art. 15) | Personendetail (Rolle `data_steward`): Stammdaten, Kennungen, Einwilligungen, Anzahl Einträge je Datensatz; Einträge je Datensatz abrufbar. Empfänger: Austauschprotokoll je Freigabe (welcher Partner hat wann welche Spalten erhalten). Eine Gesamtauskunft „auf Knopfdruck“ ist nicht umgesetzt; sie wird aus diesen Ansichten zusammengestellt. |
| Berichtigung (Art. 16) | Stammdaten und Messwerte ändern bzw. per Import korrigieren. Partner erhalten den berichtigten Stand mit ihrem nächsten Abruf (Pull, vollständiger Ersatz der Kopie); eine aktive Berichtigungsmitteilung gibt es nicht. |
| Löschung (Art. 17) | *Person löschen* entfernt die Person mit allen Einträgen, Kennungen und Einwilligungen und erzeugt **signierte Löschmitteilungen** an alle Partner, die Daten der Person erhalten haben (Art. 19). BI-Zeilen werden in derselben Transaktion entfernt, ebenso die Zeilen der Person in **offenen Importvorschauen** (vorgemerkte Zeilen, Vorschau, Rohwerte im Fehlerprotokoll; Audit `import.erase`), damit eine spätere Übernahme sie nicht wieder anlegt. Übernommene oder verworfene Importläufe enthalten keine Personendaten mehr. Nicht erfasst sind Audit-Log (nur IDs) und Sicherungen (siehe unten). |
| Einschränkung (Art. 18) | kein eigener Status; Umsetzung durch Widerruf der Einwilligung bzw. Ausschluss über Freigabebedingungen und Dokumentation |
| Datenübertragbarkeit (Art. 20) | Export von Datenprodukten als CSV, JSON oder XML |
| Widerspruch (Art. 21), Widerruf der Einwilligung (Art. 7 Abs. 3) | Widerruf erfassen → sofort wirksam für Ausgaben mit Einwilligungsprüfung; Mitteilungen an betroffene Partner |
| Mitteilungspflicht (Art. 19) | Löschung und Einwilligungswiderruf: automatische Mitteilungen über das Ausgangspostfach mit Wiederholung und Zustellnachweis |

**Sicherungen:** Gelöschte Daten bleiben in Sicherungen bis zu deren Ablauf erhalten (Standard 14
Sicherungen). Wird eine Sicherung zurückgespielt, sind Löschungen nach dem Sicherungszeitpunkt erneut
auszuführen ([Betrieb › Wiederherstellung](betrieb.md#wiederherstellung)). Dies ist im Verzeichnis der
Verarbeitungstätigkeiten zu dokumentieren.

## Speicherdauer

Technische Löschregeln und organisatorisch festzulegende Fristen: siehe
[Betrieb › Aufbewahrung](betrieb.md#aufbewahrung-und-löschfristen). Importvorschauen werden nach höchstens
7 Tagen automatisch verworfen. Festzulegen sind insbesondere Fristen
für Mess- und Gesundheitsdaten (z. B. nach Ende der Kaderzugehörigkeit), für Einwilligungsnachweise und für
das Audit-Log (Abwägung zwischen Nachweisfunktion und Datenminimierung).

## Empfänger

- **intern:** Personen des OSP gemäß Rolle und Freigabe (Trainerinnen/Trainer, Analyse,
  Datenverantwortliche); BI-Werkzeuge über die Rolle `mesh_bi` nur für BI-Freigaben;
- **andere OSP** ausschließlich mit Freigabe und gegenseitigem Vertrauen;
- **Dienstleister** (Hosting/Betrieb) als Auftragsverarbeiter;
- **keine Übermittlung in Drittländer** durch das System selbst (bei Cloud-Betrieb Standort beachten).

## Technische und organisatorische Maßnahmen (Art. 32)

Siehe [Sicherheitskonzept](sicherheit.md): Transportverschlüsselung, Signaturen, Authentisierung,
Rollen, Datenbankrollen, Verschlüsselung von Geheimnissen und Sicherungen, Protokollierung, Trennung der
Dienste, Sicherung und Wiederherstellung, Schwachstellenmanagement. Datenpannen:
[Incident Response](incident-response.md) (Meldung nach Art. 33/34 binnen 72 Stunden).

## Angaben für Verzeichnis und Folgenabschätzung

Eine **Datenschutz-Folgenabschätzung wird empfohlen** (umfangreiche Verarbeitung von Gesundheitsdaten,
teilweise Minderjähriger, Austausch zwischen Stellen). Bausteine aus diesem Dokument: Zwecke (Tabelle
oben), Datenkategorien und Betroffene, Empfänger, Fristen, TOM, Pseudonymisierung, Protokollierung,
Verfahren für Widerruf und Löschung.

## Offene Fragen für die rechtliche Prüfung

1. Verantwortlichkeitsmodell zwischen den OSP (getrennte Verantwortliche mit Austauschvereinbarung oder
   gemeinsame Verantwortlichkeit) und Rolle des Landessportverbands.
2. Rechtsgrundlagen je Zweck; Muster für Einwilligungen (inkl. Minderjährige, Widerrufshinweis).
3. Einordnung leistungsdiagnostischer Werte als Gesundheitsdaten.
4. Aufbewahrungsfristen (Fachdaten, Einwilligungsnachweise, Audit-Log, Sicherungen).
5. Ausreichen der Pull-basierten Berichtigung im Hinblick auf Art. 19.
6. Muster einer Vereinbarung zum Datenaustausch (Löschpflicht bei Mitteilung, Weitergabeverbot,
   Nachweis, Prüfrechte).
