# Datenschutzkonzept (Kurzfassung)

Kurzfassung für das Angebot: wie OSP-Data-Mesh mit personenbezogenen Daten und Einwilligungen umgeht. Die
vollständige Fassung mit Datenkategorien, Betroffenenrechten und offenen Rechtsfragen ist das
[Datenschutzkonzept](../datenschutz.md).

> **Hinweis.** Die Software setzt Datenschutz technisch um („Privacy by Design“, Art. 25 DSGVO). Die
> rechtliche Bewertung – Verantwortlichkeiten, Rechtsgrundlagen, Einwilligungstexte, Fristen – treffen die
> beteiligten Stellen mit ihren Datenschutzbeauftragten. Die Aussagen dazu sind Vorschläge, keine
> Rechtsberatung.

## Grundsätze und ihre Umsetzung

| Grundsatz (Art. 5 DSGVO) | Umsetzung |
|---|---|
| Rechtmäßigkeit, Transparenz | Rechtsgrundlage je Freigabe dokumentierbar (Feld `legalBasis`, derzeit optional – Pflichtangabe empfohlen); jede Übermittlung im Audit- und Austauschprotokoll |
| Zweckbindung | festes Zweck-Vokabular; **jeder Abruf nennt einen Zweck**, nicht freigegebene Zwecke werden abgelehnt |
| Datenminimierung | Datenprodukte mit ausgewählten Spalten; Freigaben beschränken weiter nach Spalten, Zeilen, Zeitraum, Zweck und Gültigkeit; abgeleitete Werte wie *Geburtsjahr* statt Geburtsdatum |
| Richtigkeit | Prüfung jedes Imports auf Format und Plausibilität; Berichtigungen erreichen Partner mit dem nächsten Abruf |
| Speicherbegrenzung | befristete Freigaben, automatische Löschung abgelaufener Kopien beim Empfänger, Importvorschauen nach höchstens 7 Tagen gelöscht |
| Integrität und Vertraulichkeit | siehe [Sicherheitskonzept](sicherheitskonzept.md) |
| Rechenschaftspflicht | manipulationsgeschütztes Audit-Log aller Zugriffe, Freigaben, Widerrufe und Übermittlungen |

## Verantwortlichkeit

Es gibt **keine zentrale Stelle**, an der Daten mehrerer OSP zusammenlaufen. Jeder OSP ist für seinen
Knoten **Verantwortlicher**. Übermittelt ein OSP Daten an einen anderen, ist das eine Übermittlung an einen
weiteren Verantwortlichen auf Grundlage einer **Vereinbarung zum Datenaustausch** (Zwecke, Löschpflichten,
Weitergabeverbot). Betreibt ein Dienstleister den Knoten, ist das **Auftragsverarbeitung** nach Art. 28.
Legen der Landessportverband und die OSP Zwecke und Mittel des Netzes gemeinsam fest, kommt eine
gemeinsame Verantwortlichkeit nach Art. 26 in Betracht – zu klären vor dem Echtbetrieb.

## Personenbezogene Daten im System

| Betroffene | Daten |
|---|---|
| Athletinnen und Athleten (auch Minderjährige) | Athletenkern (Name, Vorname, Geburtsdatum, Sportart, Kaderstatus; optional Geschlecht, Verein, Disziplin), Kennungen in Quellsystemen, Mess- und Fachdaten je Datensatz, Einwilligungsnachweise |
| | **Gesundheitsdaten** (Art. 9) in Datensätzen der Kategorie Gesundheit oder als besondere Kategorie markierten Datensätzen |
| | von Partnern empfangene Daten – nur Pseudonyme und freigegebene Spalten |
| Nutzende (Beschäftigte der OSP) | E-Mail, Name, Rollen, Anmeldezeitpunkte, IP-Adresse und Browserkennung der Sitzung, Protokolldaten |

Quelldateien von Importen werden **nicht** gespeichert, nur Prüfsumme, Größe, Dateiname und Spaltennamen
(Dateien deshalb nicht nach Personen benennen). Protokolle enthalten
keine Fachdaten, nur IDs, Zähler und Codes.

## Besondere Kategorien (Art. 9 DSGVO)

- Datensätze der Kategorie **Gesundheit** sind technisch immer besondere Kategorie (Datenbank-Constraint);
  andere lassen sich so markieren (Empfehlung: leistungsdiagnostische Werte mit medizinischem Bezug).
- Freigaben solcher Daten **müssen eine Einwilligungsprüfung haben**. Das prüft das System beim Erteilen
  und erneut bei jeder Ausgabe.
- Wird ein Datensatz nachträglich zur besonderen Kategorie, werden alle Partnerfreigaben darauf
  **widerrufen**, und die Partner löschen ihre Kopien.

## Einwilligungen

Einwilligungen werden – wie in der Ausschreibung vorgesehen – **außerhalb des Systems eingeholt** (Papier
oder digitales Formular; bei Minderjährigen über die Sorgeberechtigten) und können **im System dokumentiert**
werden:

- je Person: Zweck (oder alle), Datenkategorie (oder alle), Gültigkeit von/bis und ein Vermerk zum
  Nachweis (z. B. „Formular v3 vom 12.09.2026, Ablage Sekretariat“) – nicht das Dokument selbst;
- **Freigaben mit Einwilligungsprüfung** liefern nur Personen mit gültiger, nicht widerrufener Einwilligung
  für genau den angefragten Zweck und die Datenkategorie;
- ein **Widerruf** wird mit Zeitpunkt erfasst und wirkt **sofort**: Die Person entfällt bei allen
  betroffenen Ausgaben, BI-Zeilen werden entfernt, und alle Partner, die Daten der Person auf Grundlage
  dieser Einwilligung erhalten haben, bekommen eine signierte Löschmitteilung.

## Pseudonymisierung im Austausch

Partner erhalten statt der internen Personen-ID ein **freigabebezogenes Pseudonym** (HMAC mit einem
Schlüssel, den nur der Datenhalter kennt). Daten verschiedener Freigaben lassen sich beim Empfänger nicht
über eine gemeinsame ID verknüpfen; der Datenhalter kann trotzdem gezielt Löschmitteilungen für einzelne
Personen senden ([ADR 0009](../adr/0009-freigabebezogene-pseudonyme.md)). Enthält ein Produkt Namen, sind die
Daten beim Empfänger nicht pseudonym; auch Merkmalskombinationen in kleinen Kadern können Personen
bestimmbar machen. Das berücksichtigen Datenverantwortliche bei der Gestaltung der Produkte.

## Rechte der betroffenen Personen

| Recht | Unterstützung |
|---|---|
| Auskunft (Art. 15) | Personendetail mit Stammdaten, Kennungen, Einwilligungen und Einträgen; das Austauschprotokoll zeigt je Freigabe, welcher Partner wann welche Spalten erhalten hat. Eine Gesamtauskunft wird aus diesen Ansichten zusammengestellt (nicht auf Knopfdruck) |
| Berichtigung (Art. 16) | Bearbeiten oder erneuter Import; Partner erhalten den korrigierten Stand beim nächsten Abruf |
| Löschung (Art. 17) und Mitteilung (Art. 19) | *Person löschen* entfernt alle Daten der Person und sendet **signierte Löschmitteilungen** an alle Partner, die Daten von ihr erhalten haben; Zustellung mit Wiederholung und Nachweis |
| Datenübertragbarkeit (Art. 20) | Export als CSV, JSON oder XML |
| Widerruf der Einwilligung (Art. 7 Abs. 3), Widerspruch (Art. 21) | Widerruf erfassen, sofort wirksam, Mitteilung an betroffene Partner |

Gelöschte Daten bleiben in verschlüsselten Sicherungen bis zu deren Ablauf (Standard: 14 Sicherungen);
nach einer Wiederherstellung sind spätere Löschungen erneut auszuführen. Das ist im Verzeichnis der
Verarbeitungstätigkeiten zu vermerken.

## Widerrufene und weitergegebene Daten

- Widerruf einer Freigabe wirkt **sofort** für alle künftigen Abrufe; der Partner erhält eine signierte
  Mitteilung und löscht seine Kopie automatisch.
- Befristete Freigaben löscht der Empfänger bei Ablauf **selbstständig**, auch ohne Verbindung zum
  Datenhalter.
- **Empfangene Daten lassen sich im System nicht erneut freigeben**: Wer sie braucht, benötigt eine eigene
  Freigabe des Datenhalters. Exporte zur Auswertung sind protokolliert; ihre Weitergabe untersagt die
  Austauschvereinbarung.
- Reagiert ein Partner nicht, ist das sichtbar (Ausgangspostfach, Austauschprotokoll); der weitere Weg ist
  organisatorisch in der Austauschvereinbarung geregelt.

Ausführlich: [Widerruf und Weitergabe](../widerruf-und-weitergabe.md).

## Protokollierung

Protokolliert werden jede Anmeldung, jeder **lesende** Zugriff auf Personendaten, jede Freigabe und jeder
Widerruf, Einwilligungen, Löschungen, jeder Austausch (geliefert, empfangen, abgelehnt – mit Spalten,
Zeilenzahl, Zweck und übermittelten Pseudonymen) und abgewiesene Zugriffe. Einsehen und prüfen können das
Revision und Administration, **exportieren nur die Revision** (z. B. die Datenschutzbeauftragten).

## Empfänger und Drittländer

Empfänger sind Personen des OSP nach Rolle und Freigabe, BI-Werkzeuge über die nur lesende Rolle, andere OSP
mit Freigabe und gegenseitigem Vertrauen sowie Hosting-Dienstleister als Auftragsverarbeiter. Das System
selbst übermittelt **nicht in Drittländer**; bei Cloud-Betrieb ist ein Standort in der EU bzw. im EWR zu
wählen.

## Datenpannen

Vorgehen und Meldung nach Art. 33/34 DSGVO binnen 72 Stunden: [Incident Response](../incident-response.md)
und [Betriebskonzept](betriebskonzept.md#incident-response).

## Vor einem Echtbetrieb zu klären

1. Verantwortlichkeitsmodell zwischen den OSP und Rolle des Landessportverbands.
2. Rechtsgrundlagen je Zweck; Muster für Einwilligungen (auch Minderjährige).
3. Einordnung leistungsdiagnostischer Werte als Gesundheitsdaten.
4. Aufbewahrungsfristen für Fachdaten, Einwilligungsnachweise, Audit-Log und Sicherungen.
5. Muster einer Vereinbarung zum Datenaustausch.
6. **Datenschutz-Folgenabschätzung** (Art. 35) – empfohlen wegen Gesundheitsdaten, Minderjähriger und
   Austausch zwischen Stellen; die nötigen Angaben liefert das [Datenschutzkonzept](../datenschutz.md).
