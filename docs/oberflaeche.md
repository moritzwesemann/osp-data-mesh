# Oberfläche

Rundgang durch die wichtigsten Seiten der Web-Oberfläche eines Knotens. Die Bildschirmfotos stammen aus
der lokalen Demo (`bun run demo -- --keep-running`, Knoten `osp-nord` und `osp-mitte`, synthetische
Beispieldaten ohne echte Personen; Übersicht der Bilder in `docs/screenshots/README.md`). Welche
Menüpunkte jemand sieht, hängt von den Rollen ab ([Rollen und Rechte](rollen.md)); die Oberfläche blendet
nicht erlaubte Bereiche aus, der Server prüft jede Aktion zusätzlich.

Die Oberfläche ist auf Deutsch (umschaltbar auf Englisch unter *Konto*), funktioniert auf Bildschirmen ab
Smartphone-Breite und ist per Tastatur bedienbar. Die Hilfe (diese Dokumentation) ist über *Hilfe* in der
Navigation erreichbar.

## Anmelden

![Anmeldeseite mit E-Mail-Adresse und Passwort](screenshots/01-anmeldung.png)

Anmeldung mit E-Mail-Adresse und Passwort. Bei falschen Angaben, einem inaktiven oder vorübergehend
gesperrten Konto erscheint immer dieselbe Meldung (nach 5 Fehlversuchen in Folge ist das Konto für
15 Minuten gesperrt; die Administration kann die Sperre unter *Benutzer* aufheben). Wer mit einem
erzeugten Initialpasswort angemeldet ist, muss zuerst ein eigenes Passwort festlegen (mindestens
12 Zeichen).

## Übersicht

![Übersicht mit Knotenangaben, Fingerprint, Rollen und Schnellzugriffen](screenshots/02-uebersicht.png)

Die Startseite zeigt den Knoten (Name, Knoten-ID, Fingerprint), die eigenen Rollen und – je nach Rolle –
Schnellzugriffe, die für die Person freigegebenen Datenprodukte, Kennzahlen der Datenpflege (Athleten,
Quellen, aktive Freigaben, letzte Importe) und den Systemstatus (Datenbank, Audit-Kette, letzte
Sicherung, ausstehende Mitteilungen). Links steht die Navigation, gruppiert nach *Datenpflege*,
*Nutzung*, *Netzwerk* und *Verwaltung*.

## Athleten und Einwilligungen

![Athletenliste mit Suche und Filtern nach Sportart und Kaderstatus](screenshots/03-athleten.png)

*Athleten* (Rolle `data_steward`) listet den Athletenkern mit Suche und Filtern nach Sportart und
Kaderstatus. Jeder Lesezugriff auf Personendaten wird protokolliert.

Im Personendetail stehen Stammdaten, Kennungen in Quellsystemen und die **Einwilligungen** (Zweck,
Datenkategorie, Gültigkeit, Nachweis). *Widerruf erfassen* beendet eine Einwilligung sofort: Die Person
entfällt aus allen Freigaben mit Einwilligungsprüfung, BI-Tabellen werden bereinigt, und Partner, die
Daten der Person erhalten haben, bekommen eine Löschmitteilung
([Widerruf und Weitergabe](widerruf-und-weitergabe.md)). *Person endgültig löschen* setzt das Recht auf
Löschung um.

## Quellen und Importe

*Quellen* verwaltet Connectoren für CSV-Uploads und HTTP-APIs (Messsysteme): Konfiguration,
Feldzuordnung, Zuordnung zu Personen und das Ziel (Athletenkern oder Datensatz). Vorlagen erleichtern
den Einstieg; Definitionen lassen sich als JSON exportieren und in anderen Knoten importieren (ohne
Zugangsgeheimnisse). *Beispiel abrufen* zeigt die ersten Zeilen einer Quelle für die Zuordnung.

![Importlauf als Vorschau mit Zählern, Fehlerübersicht, Vorschauzeilen und Fehlerprotokoll](screenshots/04-quelle-import-vorschau.png)

Jeder Import beginnt als **Vorschau**: Zähler (gesamt, gültig, mit Warnung, fehlerhaft), Angaben zum Lauf
(Datei, Größe, SHA-256), die Fehlerübersicht je Prüfung und Feld, die ersten Zeilen mit Rohwerten und
zugeordneten Werten sowie das Fehlerprotokoll je Zeile und Feld mit Prüfcode, Grenzwerten und Rohwert.
Erst *Übernehmen* speichert die Daten; *Verwerfen* löscht die Vorschau. Rohwerte gibt es nur, solange der
Lauf in der Vorschau ist; nicht übernommene Vorschauen verfallen nach 7 Tagen
([Datenmodell](datenmodell.md#datensätze-quellen-importe)).

## Datensätze und Datenprodukte

Ein **Datensatz** beschreibt die Struktur einer Datenart (Felder mit Typen, Einheiten und Prüfregeln,
fachlicher Schlüssel, Beobachtungsdatum) und ihre Einstufung (Kategorie, besondere Kategorie nach
Art. 9 DSGVO, Teilbarkeit). Eine Änderung der Einstufung wirkt auf alle darauf aufbauenden Produkte und
Freigaben ([Freigaberegeln](freigaberegeln.md#erteilen-ändern-widerrufen)).

![Datenprodukt „Leistungsdiagnostik“ mit Angaben und Spalten](screenshots/05-datenprodukt.png)

Ein **Datenprodukt** ist eine definierte Sicht auf einen Datensatz oder den Athletenkern: ausgewählte
Spalten (auch abgeleitete wie *Geburtsjahr*) und ein Basisfilter. Die Vorschau zeigt, welche Zeilen das
Produkt enthält. Jede Änderung von Spalten oder Filtern erhöht die Version; bestehende Freigaben werden
dadurch *veraltet* und müssen neu erteilt werden.

## Freigaben

![Formular „Freigabe erteilen“ mit Zeilen-, Zeit- und Zweckbeschränkung und Prüfung der Wirkung](screenshots/06-freigabe-erstellen.png)

*Freigabe erteilen* verbindet ein Datenprodukt mit genau einem Empfänger – einer Rolle dieses Knotens,
der BI-Schnittstelle oder einem Partnerknoten – und beschränkt Spalten, Zeilen, Datenzeitraum,
Gültigkeit und Zwecke, optional mit Einwilligungspflicht (bei Art.-9-Daten Pflicht). **Wirkung prüfen**
zeigt vor dem Erteilen, welche Daten der Empfänger für einen Zweck erhielte und wie viele Zeilen durch
Zeilenbeschränkung, Zeitraum oder fehlende Einwilligung entfallen.

![Liste der Freigaben mit Empfänger, Zwecken, Gültigkeit und Status](screenshots/07-freigaben-liste.png)

Die Liste zeigt jede Freigabe mit Empfänger, Zwecken, Gültigkeit und Status (*aktiv*, *geplant*,
*abgelaufen*, *veraltet*, *widerrufen*). Freigaben sind unveränderlich; *Freigabe widerrufen* (in der
Detailansicht, mit Begründung) wirkt sofort, Partner erhalten eine signierte Widerrufsmitteilung. Die
Rolle `auditor` sieht Freigaben nur lesend.

## Meine Daten

![„Meine Daten“: Zweckwahl, freigegebene Daten und Downloads als CSV, JSON und XML](screenshots/08-meine-daten.png)

*Meine Daten* listet die Datenprodukte, die für die eigenen Rollen freigegeben sind. Nach Wahl des
**Zwecks** (Zweckbindung) werden die freigegebenen Zeilen angezeigt und lassen sich als CSV, JSON oder
XML herunterladen. Angezeigt wird nur die Zahl der gelieferten Zeilen – nichts über Zeilen außerhalb der
Freigabe. Unter *Zugriff aus Werkzeugen* stehen fertige Aufrufe für curl, Python und Power BI/Excel; das
nötige API-Token entsteht unter *Konto* ([REST-API](api.md)).

## Partner, Katalog und empfangene Daten

![Partnerverwaltung mit Anleitung zur Aufnahme und eigener Knotenkarte mit Fingerprint](screenshots/09-partner-knotenkarte.png)

*Partner* (Rollen `admin`, `data_steward`; aufnehmen, vertrauen und sperren nur `admin`) zeigt die
Schritte der Partneraufnahme, die eigene **Knotenkarte** mit Fingerprint (herunterladen oder als JSON
kopieren), darunter die Partnerknoten mit Status (*ausstehend*, *vertrauenswürdig*, *gesperrt*) und –
für `admin` – das **Ausgangspostfach** mit Widerrufs- und Löschmitteilungen. Die Aufnahme erfolgt in
vier Schritten: Karten austauschen, *Partner aufnehmen*, Fingerprint telefonisch abgleichen, *Vertrauen
bestätigen* ([Installation](installation.md#vertrauen-mit-einem-partnerknoten-herstellen)). *Jetzt
zustellen* stellt ausstehende und fehlgeschlagene Mitteilungen sofort zu.

![Partnerkatalog bei osp-mitte mit Angeboten von osp-nord zum Abrufen](screenshots/10-katalog-discovery.png)

Der **Katalog** zeigt die Metadaten dieses Knotens; der **Partnerkatalog** (Discovery, Rollen
`data_steward`, `analyst`) fragt alle vertrauenswürdigen Partner nach Angeboten, die für diesen Knoten
freigegeben sind – nur Metadaten, keine Personendaten. *Abrufen* (Rolle `data_steward`) holt die Daten
signiert und pseudonymisiert ab.

![Empfangene Daten bei osp-mitte mit Herkunftsnachweis](screenshots/11-empfangene-daten-herkunft.png)

*Empfangene Daten* zeigt abgerufene Kopien mit **Herkunftsnachweis** (Quellknoten, Fingerprint des
Datenhalters, Freigabe, Zweck, Zeitpunkt, Prüfsumme und Signatur der Antwort). Kopien werden bei
Widerruf, Ablauf der Freigabe oder Löschmitteilung automatisch gelöscht; empfangene Daten können nicht
weitergegeben werden.

## Audit, System und Benutzer

![Audit-Log nach erfolgreicher Prüfung der Hash-Kette, mit Filtern und Export](screenshots/12-audit.png)

*Audit* (Rollen `auditor`, `admin`) durchsucht das Audit-Log nach Zeitraum, Vorgang, Ergebnis und
Person, prüft die **Integrität** der Hash-Kette und exportiert als CSV oder JSON (nur `auditor`). Der
Reiter *Austauschprotokoll* zeigt jede Lieferung an und von Partnern mit Spalten, Zeilenzahl und
Prüfsumme.

![Systemstatus mit Version, Datenbank, Audit-Kette, Sicherung, Ausgangspostfach und BI-Schnittstelle](screenshots/13-system.png)

*System* (Rolle `admin`) zeigt Version, Datenbank- und Migrationsstand, Audit-Kette, die letzte
Sicherung, das Ausgangspostfach (ausstehend/fehlgeschlagen), die BI-Schnittstelle und die Fehler der
letzten 24 Stunden; darunter Knotenangaben, die Sicherungen (*Sicherung erstellen*), die letzten Fehler
mit Request-ID sowie die BI-Views mit Verbindungsdaten ([Betrieb](betrieb.md#überwachung)).

![Benutzerverwaltung mit Rollen, Status und letzter Anmeldung](screenshots/14-benutzer.png)

*Benutzer* (Rolle `admin`) legt Konten an, ändert Rollen, deaktiviert Konten, setzt Passwörter zurück und
hebt Sperren auf; Deaktivieren und Zurücksetzen beenden die Sitzungen und widerrufen die API-Tokens der
Person. Unter *Konto* ändert jede Person ihr Passwort und verwaltet eigene API-Tokens.

## Mobil

![Aufgeklapptes Menü auf dem Smartphone](screenshots/15-mobil-navigation.png)
![„Meine Daten“ auf dem Smartphone](screenshots/16-mobil-meine-daten.png)

Auf schmalen Bildschirmen klappt die Navigation in ein Menü ein; Tabellen lassen sich seitlich scrollen.
So können etwa Trainerinnen und Trainer freigegebene Daten unterwegs ansehen.
