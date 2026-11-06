# Rollen-, Zugriffs- und Freigabekonzept

Dieses Konzept beschreibt, wer im System was darf, wie Daten freigegeben werden, wie Einwilligungen
berücksichtigt werden und was dabei protokolliert wird. Einzelheiten: [Rollen und Rechte](../rollen.md),
[Freigaberegeln](../freigaberegeln.md).

## Zwei Ebenen der Zugriffssteuerung

1. **Rollen** steuern, welche **Funktionen** eine Person aufrufen darf (z. B. Quellen pflegen, Freigaben
   erteilen, Audit-Log lesen).
2. **Freigaben** steuern, welche **Daten** eine Rolle, die BI-Schnittstelle oder ein Partner-OSP erhält.

Rollen allein geben keinen Zugriff auf Fachdaten. Die Rolle Administration sieht keine Athletendaten und
kann keine Freigaben empfangen; die Revision nur über eine Freigabe. Einzige Ausnahme ist die
Datenverantwortung, die die Rohdaten ihres eigenen Knotens pflegt – jeder dieser Lesezugriffe wird
protokolliert.

## Rollen

| Rolle | Wer | Darf | Fachdaten |
|---|---|---|---|
| Administration (`admin`) | IT-Betrieb | Benutzer und Rollen, Partner aufnehmen und sperren, Knotenschlüssel, System, Sicherungen | keine |
| Datenverantwortung (`data_steward`) | Datenverantwortliche des OSP | Athleten, Einwilligungen, Datensätze, Quellen, Importe, Datenprodukte, **Freigaben**, Abrufe bei Partnern | Rohdaten des eigenen Knotens (protokolliert), empfangene Daten |
| Analyse (`analyst`) | Analyse, Wissenschaft | Discovery bei Partnern, Auswertung | nur über Freigaben; empfangene Daten |
| Trainerteam (`coach`) | Trainerinnen und Trainer | Nutzung freigegebener Produkte | nur über Freigaben |
| Revision (`auditor`) | Datenschutz, Revision | Audit-Log, Austauschprotokoll und Freigaben lesen, Integrität prüfen, exportieren | nur über Freigaben |
| BI (`bi`, technisch) | BI-Werkzeuge über die Datenbankrolle `mesh_bi` | Lesen der BI-Sichten | nur BI-Freigaben; keiner Person zuweisbar |

Eine Person kann mehrere Rollen haben. Jede Schnittstelle legt im HTTP-Vertrag fest, welche Rollen sie
aufrufen dürfen; der Server prüft das vor jeder Verarbeitung und protokolliert Abweisungen
(`access.forbidden`). Die vollständige Matrix aller Vorgänge leitet sich aus dem Vertrag ab
([Rollen und Rechte](../rollen.md#detail-alle-vorgänge-der-rest-api)).

**Trennung der Aufgaben:** Administration (Benutzer, Partner) und Datenverantwortung (Freigaben) sind
getrennte Rollen; niemand kann das Audit-Log verändern; die Revision prüft beide. Die Administration kann
Rollen vergeben – technisch auch sich selbst. Die Trennung ist deshalb **organisatorisch festzulegen**
(empfohlen: Administration und Datenverantwortung nie in einer Person) und wird durch die Revision geprüft:
jede Rollenänderung steht mit alter und neuer Rolle im Audit-Log (`user.update`). Für kleine OSP mit wenig
Personal sind Rollenkombinationen möglich und ebenso sichtbar.

## Zugang zum System

- Personen melden sich mit E-Mail und Passwort an (Kontosperre, Ratenbegrenzung, Sitzungen mit sicheren
  Cookies). Anlegen, Rollen ändern, Deaktivieren und Zurücksetzen nur durch die Administration, jeweils
  protokolliert.
- Werkzeuge (Excel, Power BI, Python) nutzen **persönliche API-Tokens** mit den Rechten der Person,
  befristet und widerrufbar.
- BI-Werkzeuge mit Datenbankzugang nutzen die **nur lesende Rolle** `mesh_bi`, die ausschließlich die zu
  BI-Freigaben gehörenden Sichten sieht.
- Partner-OSP greifen nur über das signierte Föderationsprotokoll zu – nach manuellem Vertrauensaufbau mit
  Abgleich des Fingerabdrucks, sofort sperrbar.

## Freigaben

### Grundsatz

**Deny by default:** Was nicht ausdrücklich freigegeben ist, verlässt den Knoten nicht. Neue Spalten eines
Produkts sind nicht automatisch freigegeben; jede unklare Angabe führt zur Ablehnung.

### Inhalt einer Freigabe

Eine Freigabe verbindet **ein Datenprodukt** mit **genau einem Empfänger** – mindestens je Datensatz und
Empfängerrolle, wie gefordert – und beschränkt die Daten in allen Dimensionen:

| Dimension | Wirkung |
|---|---|
| Empfänger | eine Rolle des eigenen OSP, die BI-Schnittstelle oder ein Partner-OSP |
| Spalten | nur die ausgewählten Spalten des Produkts |
| Zeilen | Bedingungen, die alle gelten müssen (z. B. nur Olympiakader, nur eine Sportart) |
| Datenzeitraum | nur Beobachtungen in einem Zeitraum |
| Gültigkeit | Zugriff nur von/bis; danach löschen Partner ihre Kopie selbstständig |
| Zweck | Abruf nur für die genannten Zwecke (z. B. Trainingssteuerung, Leistungsdiagnostik) |
| Einwilligung | nur Personen mit gültiger Einwilligung für Zweck und Datenkategorie – Pflicht bei Gesundheitsdaten |
| Rechtsgrundlage | dokumentierbar je Freigabe (derzeit optional) |

### Lebenszyklus

1. **Vorschau:** Vor dem Erteilen zeigt das System, welche Spalten und wie viele Zeilen die Freigabe
   liefern würde.
2. **Erteilen** durch die Datenverantwortung; das System prüft alle Angaben gegen das Produkt (Spalten,
   Bedingungen, Zwecke, Zeitfenster, Teilbarkeit, Art. 9).
3. **Unveränderlich:** Eine Änderung ist ein Widerruf und eine neue Freigabe – beides protokolliert.
4. **Veraltet** bei Produktänderung: Die Freigabe liefert nichts mehr, bis sie neu erteilt ist. So kann eine
   Produktänderung nie unbemerkt mehr Daten freigeben.
5. **Widerruf** wirkt sofort für alle künftigen Abrufe; Partner erhalten eine signierte Mitteilung und
   löschen ihre Kopie, BI-Sichten verschwinden in derselben Transaktion.

### Durchsetzung

Jede Ausgabe – Oberfläche, Export, REST, BI und Partnerabruf – läuft durch **eine einzige Stelle**, den
Policy Enforcement Point. Er prüft in fester Reihenfolge: Freigabe vorhanden → richtiger Empfänger →
Partner vertrauenswürdig → nicht widerrufen → gültig → Produkt aktiv und unverändert → teilbar → Zweck
erlaubt → Einwilligungspflicht bei Art.-9-Daten → Spalten vorhanden. Danach je Zeile: Datenzeitraum →
Zeilenbedingungen → Einwilligung → Spaltenauswahl. Die Regeln sind als reine Funktionen umgesetzt und mit
Zufallstests abgesichert ([ADR 0004](../adr/0004-freigabelogik-reine-funktionen.md)).

Partner, die nicht Empfänger einer Freigabe sind, erfahren nicht, ob sie existiert (einheitlich „nicht
gefunden“); Empfänger
sehen nur die Zahl gelieferter Zeilen, nicht wie viele wegen fehlender Einwilligung entfallen sind.

## Einwilligungen

- Einwilligungen werden außerhalb des Systems eingeholt und **optional im System dokumentiert**: je Person
  Zweck, Datenkategorie, Gültigkeit und ein Vermerk zum Nachweis.
- Nur Freigaben mit **Einwilligungsprüfung** werten sie aus; bei Gesundheitsdaten und anderen besonderen
  Kategorien ist die Prüfung Pflicht und wird bei jeder Ausgabe erneut erzwungen.
- Ein **Widerruf** wirkt sofort: Die Person entfällt bei allen betroffenen Ausgaben, und alle Partner, die
  ihre Daten auf Grundlage dieser Einwilligung erhalten haben, bekommen eine Löschmitteilung.

## Protokollierung

| Was | Wo | Wer sieht es |
|---|---|---|
| Anmeldungen (auch fehlgeschlagen), Benutzer- und Rollenänderungen, API-Tokens | Audit-Log | Revision, Administration |
| jeder lesende Zugriff auf Personendaten, jeder Datenabruf mit Zweck | Audit-Log | Revision, Administration |
| Freigaben erteilt, widerrufen, veraltet | Audit-Log | Revision, Administration |
| Einwilligungen und Widerrufe, Löschungen | Audit-Log | Revision, Administration |
| jeder Austausch mit Partnern (geliefert, empfangen, abgelehnt) mit Spalten, Zeilenzahl, Zweck, Pseudonymen, Prüfsumme | Austauschprotokoll und Audit-Log beider Seiten | Revision, Datenverantwortung |
| Importe mit Prüfsumme und Ergebnis | Audit-Log, Importlauf | Revision, Datenverantwortung |
| abgewiesene Zugriffe | Audit-Log (`outcome = denied`) | Revision, Administration |

Das Audit-Log ist **nur anhängbar**, durch eine **Hash-Kette** gesichert und **bei den Partnern verankert**.
Es enthält keine Fachdaten, nur IDs, Zähler und Codes. Revision und Administration können es durchsuchen
und seine Integrität prüfen; exportieren (CSV, JSON) kann nur die Revision.

## Typischer Ablauf

1. Die Datenverantwortung des OSP Nord importiert Sprungkraftwerte und definiert ein Produkt „Sprungkraft
   Olympiakader“ ohne Namen, mit Geburtsjahr.
2. Sie erteilt eine Freigabe an das eigene Trainerteam (Zweck Trainingssteuerung) und eine an den OSP Süd
   (Zweck Leistungsdiagnostik, nur 2026, gültig bis Jahresende, mit Einwilligungsprüfung).
3. Die Analyse des OSP Süd findet das Angebot über die Discovery; die Datenverantwortung des OSP Süd ruft
   es ab, die Analyse wertet die empfangenen Daten aus. Sie enthalten Pseudonyme und nur die freigegebenen
   Spalten; beide Seiten protokollieren den Abruf.
4. Eine Athletin widerruft ihre Einwilligung: Der OSP Nord erfasst den Widerruf, der OSP Süd erhält
   automatisch eine Löschmitteilung und entfernt ihre Zeilen.
5. Die Revision beider OSP kann jeden Schritt im Audit-Log nachvollziehen.
