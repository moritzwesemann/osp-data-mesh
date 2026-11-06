# Incident Response

Vorgehen bei Sicherheitsvorfällen und Datenschutzverletzungen an einem Knoten. Ziel: Schaden begrenzen,
Beweise sichern, gesetzliche Meldefristen einhalten, Wiederholung verhindern.

> Diese Seite vor einem Echtbetrieb mit den Kontaktdaten des OSP ausfüllen und ausgedruckt beim
> IT-Betrieb hinterlegen (das System kann im Ernstfall nicht verfügbar sein).

## Kontakte (Vorlage)

| Funktion | Name | Telefon | E-Mail | Vertretung |
|---|---|---|---|---|
| IT-Betrieb / Knoten-Administration | | | | |
| Informationssicherheitsbeauftragte/r | | | | |
| Datenschutzbeauftragte/r | | | | |
| Leitung des OSP (Entscheidung, Meldung) | | | | |
| Hosting-Dienstleister (falls Auftragsverarbeitung) | | | | |
| Administrationen der Partnerknoten | siehe Austauschvereinbarung | | | |
| Zuständige Datenschutz-Aufsichtsbehörde (Baden-Württemberg: LfDI BW) | | | | |
| BSI / CERT (bei Bedarf) | | | | |

## Erkennen

| Quelle | Hinweis auf |
|---|---|
| `verify-audit` ≠ 0 bzw. *Audit › Integrität prüfen* nicht ok | Manipulation des Audit-Logs oder Datenbankbeschädigung |
| `verify-audit --with-partners` Exit 1 bzw. *Audit › Mit Partnern abgleichen*: „Manipulation erkannt“ | Audit-Log abgeschnitten oder umgeschrieben (Eigentümer- bzw. Superuser-Rechte an der Datenbank) |
| `verify-audit --with-partners` Exit 4 bzw. „Klärung nötig“ | jeden Hinweis erklären: „durch Wiederherstellung verloren“ und „Epoche nicht im Profil“ nur mit einer dokumentierten Wiederherstellung (Protokoll, Audit `backup.restore`, beim Partner `audit.checkpoint.epoch_changed`) – sonst vorgetäuschte Wiederherstellung, also Manipulation; „nicht beweiskräftig“ = Abweichung mit einem als kompromittiert abgelösten Schlüssel signiert (Fälschung mit dem gestohlenen Schlüssel oder Manipulation – Abgleich mit Prüfpunkten anderer Schlüssel und Exporten); „Partner in der Datenbank nicht vertrauenswürdig“ bzw. „weicht vom Profil ab“ ohne bekannte Änderung = Partnerliste manipuliert |
| `verify-audit --with-partners` ohne `--profile` „ok“, mit Profil nicht | Partnerliste, Partneradressen/-schlüssel oder eigener Schlüsselverlauf in der Datenbank verändert (Prüfung ohne Profil ist nicht unabhängig von der Datenbank) |
| beim Partner `audit.checkpoint.conflict` oder abgelehnte Rotationsmitteilungen (`peer.key_rotation.rejected`) | widersprüchliche Prüfpunkte bzw. gefälschte oder veraltete Schlüsselwechsel des Partners – beim Partner nachfragen |
| Audit-Log: gehäufte `auth.login` mit `outcome = denied`, `rate_limited`, Kontosperren | Passwort-Angriffe |
| Audit-Log: `access.forbidden`, `exchange.pull.denied`, ungewöhnliche `access.data`-Mengen oder Zeiten | Rechteausweitung, Datenabfluss, kompromittiertes Konto oder API-Token |
| Austauschprotokoll: Abrufe eines Partners außerhalb üblicher Zeiten oder Zwecke | kompromittierter Partnerknoten |
| Föderations-Ablehnungen `federation.request.rejected` (`bad_signature`, `replay`, `unknown_node`, `rate_limited`) im Audit-Log – zusammengefasst: erste je Quelle und Code in 5 Minuten, `suppressed` = seither nur im Betriebslog; vollständig im Betriebslog (`federation request rejected`) | gefälschte Anfragen, Angriff auf das Protokoll, Überflutung |
| `system.status`: `errors24h` steigt, `outbox.failed > 0`, fehlgeschlagene Sicherungen | Störung, Angriff auf Verfügbarkeit, ausbleibende Löschmitteilungen |
| Betriebslog (JSON), Caddy-Zugriffslog, Firewall, Virenschutz/EDR | Angriffe von außen |
| Meldungen von Nutzenden, Partnern, Betroffenen, Schwachstellenmeldungen (SBOM/`bun audit`) | alle Arten |

## Einstufen

| Stufe | Beispiele | Reaktion |
|---|---|---|
| **1 – niedrig** | einzelne fehlgeschlagene Anmeldungen, Fehlkonfiguration ohne Datenbezug | im Regelbetrieb beheben, dokumentieren |
| **2 – mittel** | kompromittiertes Konto ohne Datenzugriff, Partner nicht erreichbar mit offenen Löschmitteilungen, ausnutzbare Schwachstelle ohne Hinweis auf Ausnutzung | binnen 1 Arbeitstag; Datenschutzbeauftragte informieren |
| **3 – hoch** | unbefugter Zugriff auf Personendaten, Abfluss von Daten, kompromittierter Master-Key, Knotenschlüssel, Datenbank- oder Administrationszugang, gebrochene Audit-Kette | **sofort**; Leitung und Datenschutzbeauftragte informieren; Meldepflicht prüfen (72 h) |

Gesundheitsdaten (Art. 9) erhöhen das Risiko für Betroffene; im Zweifel höher einstufen.

## Erste Schritte (Stufe 2 und 3)

1. **Zeitpunkt festhalten** und ein Vorfallprotokoll beginnen (wer, wann, was beobachtet, welche
   Maßnahme). Ab Kenntnis läuft die 72-Stunden-Frist.
2. **Beweise sichern, bevor geändert wird:**
   - Audit-Log exportieren (*Audit › Export*, Rolle `auditor`) und Prüfwert notieren
     (`verify-audit`, letzter `hash`);
   - Betriebslogs sichern (`journalctl -u osp-data-mesh > …` bzw. `docker compose logs --no-color > …`),
     Caddy-Logs;
   - eine **Sicherung** erstellen (`cli backup`) und separat aufbewahren;
   - bei Verdacht auf Systemkompromittierung: Abbild des Datenträgers bzw. Snapshot der VM.
3. **Eindämmen** – je nach Lage:

| Maßnahme | Vorgehen |
|---|---|
| Konto sperren | *Benutzer* → Konto deaktivieren: beendet alle Sitzungen und **widerruft alle API-Tokens** der Person (Audit `token.revoke` je Token, auch nach einer Reaktivierung bleiben sie ungültig). Passwort zurücksetzen beendet ebenfalls alle Sitzungen und widerruft alle API-Tokens |
| API-Token sperren | Person widerruft unter *Konto › API-Tokens*; bei fremden Konten: Konto deaktivieren oder Passwort zurücksetzen (beides widerruft alle Tokens der Person). Mit einem Token lassen sich keine weiteren Tokens erzeugen |
| Partner sperren | *Partner › Sperren* (Rolle `admin`): Abrufe, Katalog und Verbindungstest des Partners werden sofort abgewiesen. **Mitteilungen** (`notice`) des gesperrten Partners werden weiter angenommen: Sie können nur Kopien löschen, die von ihm selbst stammen (Widerruf, Löschung), und eine Sperre soll Löschungen nicht verhindern. Eigene Widerrufsmitteilungen werden auch an gesperrte Partner zugestellt |
| Freigaben widerrufen | *Freigaben › (Freigabe öffnen) › Freigabe widerrufen* (Rolle `data_steward`); Partner erhalten Löschmitteilungen |
| Datenprodukt stilllegen | *Datenprodukte › Stilllegen*: alle Freigaben des Produkts enden |
| Knoten vom Netz | Caddy stoppen (`systemctl stop caddy` bzw. `docker compose stop caddy`) – Oberfläche, API und Föderation sind dann nicht mehr erreichbar; der Knoten selbst kann für Analysen weiterlaufen |
| Knoten stoppen | `systemctl stop osp-data-mesh` bzw. `docker compose stop node` |

4. **Partner informieren**, wenn der eigene Knoten kompromittiert sein kann (sie sollen den Knoten
   sperren) oder ein Partner verdächtig ist.

## Schlüssel und Zugänge erneuern

| Kompromittiert | Maßnahmen |
|---|---|
| Benutzerpasswort / Sitzung | Passwort zurücksetzen (beendet alle Sitzungen und widerruft alle API-Tokens der Person, auch solche, die mit einer gestohlenen Sitzung erzeugt wurden), Audit-Log der Person prüfen (`token.create`, `access.data`) |
| API-Token | Token widerrufen (oder Passwort zurücksetzen, widerruft alle Tokens der Person); Zugriffe im Audit-Log prüfen: Akteur ist die Person, Datenabrufe tragen `details.via = token`; welches Token zuletzt benutzt wurde, zeigt `lastUsedAt` unter *Konto › API-Tokens* |
| Datenbankpasswort | neue Passwörter, `db-bootstrap --rotate-passwords`, `MESH_DB_URL` anpassen, Neustart ([Betrieb](betrieb.md#datenbankpasswörter-ändern)) |
| `MESH_MASTER_KEY` | Master-Key rotieren ([Betrieb](betrieb.md#master-key-rotieren)); da der private Knotenschlüssel und die Zugangsdaten der API-Quellen mit dem alten Schlüssel entschlüsselbar waren: Zugangsdaten der Quellen beim Quellsystem erneuern und neu setzen; Knotenschlüssel wie in der nächsten Zeile behandeln |
| Ed25519-Knotenschlüssel | Partner telefonisch informieren, sie sperren den Knoten sofort. **Keinen planmäßigen Wechsel** verwenden (dessen Mitteilung wäre mit dem verdächtigen Schlüssel signiert), sondern den Schlüssel ohne Mitteilung ersetzen: *Partner › Schlüssel wechseln* mit Anlass „Verdacht auf Kompromittierung“ bzw. `rotate-node-key --compromised --yes`. Neue Knotenkarte an alle Partner; sie tragen sie unter *Neuen Schlüssel eintragen* ein und bestätigen das Vertrauen erst nach telefonischem Abgleich des neuen Fingerprints ([Betrieb](betrieb.md#knotenschlüssel-ed25519), [ADR 0013](adr/0013-knotenschluessel-rotation.md)) |
| Audit-Log (Verdacht auf Abschneiden oder Umschreiben) | `verify-audit --with-partners --profile <offline verwahrtes Anker-Profil>` mit unveränderter Software von einem sauberen Rechner aus (nicht die Oberfläche: sie nutzt die Partnerliste der verdächtigen Datenbank); Prüfsumme des Profils mit dem notierten Wert vergleichen; erste Abweichung (Laufnummer, Epoche) notieren; Partner um die bei ihnen verwahrten Prüfpunkte und Einträge `audit.checkpoint.conflict` bzw. `audit.checkpoint.epoch_changed` bitten; Sicherungen vor dem Zeitpunkt mit `verify-audit --checkpoint … --profile …` gegen exportierte Prüfpunkte prüfen ([ADR 0014](adr/0014-externe-verankerung-audit-kette.md)) |
| `MESH_BACKUP_KEY` | neuen Schlüssel setzen; vorhandene Sicherungskopien an allen Ablageorten als offengelegt betrachten, ggf. löschen und neu sichern |
| TLS-Schlüssel | Caddy-Datenverzeichnis löschen bzw. Zertifikat widerrufen; Caddy stellt neu aus |

## Wiederherstellen

1. Ursache beseitigen (Schwachstelle schließen, Update, Konfiguration korrigieren).
2. Bei manipulierten oder zerstörten Daten: **Wiederherstellung aus einer Sicherung vor dem Vorfall**
   ([Betrieb › Wiederherstellung](betrieb.md#wiederherstellung)). Danach Löschungen und Widerrufe seit dem
   Sicherungszeitpunkt wiederholen, Audit-Kette prüfen. Die Wiederherstellung beginnt eine neue **Epoche**
   der Audit-Kette; die bei Partnern verwahrten Prüfpunkte nach dem Sicherungszeitpunkt gelten danach als
   „durch Wiederherstellung verloren“ (`verify-audit --with-partners` Exit 4). Wiederherstellung im
   Vorfallbericht dokumentieren (Datei, SHA-256, neue Epoche, übernommene Laufnummer aus der Ausgabe von
   `restore`), Partner informieren und das Anker-Profil neu exportieren (`audit-anchor-profile --previous`).
   Eine neue Epoche ohne solche Dokumentation ist selbst ein Vorfall.
3. Bei kompromittiertem Host: auf frischem System neu installieren ([Installation](installation.md)),
   Daten aus Sicherung zurückspielen, alle Schlüssel und Passwörter erneuern.
4. Funktionsprüfung (`readyz`, Anmeldung, `verify-audit`, Partner-`ping`), Partner über Wiederaufnahme
   informieren, Sperren gezielt aufheben.

## Meldepflichten nach DSGVO

- **Art. 33 – Meldung an die Aufsichtsbehörde** binnen **72 Stunden** nach Bekanntwerden einer Verletzung
  des Schutzes personenbezogener Daten, es sei denn, sie führt voraussichtlich nicht zu einem Risiko.
  Entscheidung durch die verantwortliche Stelle mit der/dem Datenschutzbeauftragten; die Begründung wird
  auch bei Nichtmeldung dokumentiert. Verspätete Meldungen sind zu begründen.
  Inhalt: Art der Verletzung, Kategorien und ungefähre Zahl der Betroffenen und Datensätze, Kontakt,
  wahrscheinliche Folgen, ergriffene Maßnahmen. Nachreichen ist zulässig.
- **Art. 34 – Benachrichtigung der Betroffenen** unverzüglich, wenn ein **hohes Risiko** besteht (bei
  Gesundheitsdaten regelmäßig zu prüfen), in klarer Sprache; bei Minderjährigen an die Sorgeberechtigten.
- **Auftragsverarbeiter** melden Verletzungen unverzüglich an den Verantwortlichen (Art. 33 Abs. 2).
- **Partner-OSP:** Betrifft der Vorfall übermittelte Daten, informieren sich Datenhalter und Empfänger
  gegenseitig unverzüglich (Austauschvereinbarung); jeder Verantwortliche prüft seine eigene Meldepflicht.

Hilfen zur Ermittlung der Betroffenen: Audit-Log (Zugriffe nach Zeitraum, Person, Objekt),
Austauschprotokoll (welche Pseudonyme wurden an wen geliefert), Personendetail (Datenbestand je Person).

## Nachbereitung

Binnen zwei Wochen nach Abschluss eine Nachbesprechung ohne Schuldzuweisung durchführen und dokumentieren:

1. Zeitlinie (Erkennung, Eindämmung, Behebung, Meldungen).
2. Ursache und begünstigende Faktoren.
3. Was hat funktioniert, was nicht (Erkennung, Erreichbarkeit, Dokumentation, Werkzeuge)?
4. Maßnahmen mit Verantwortlichen und Terminen (Technik, Prozesse, Schulung, Verträge).
5. Aktualisierung dieser Seite, des Sicherheitskonzepts und ggf. der Datenschutz-Folgenabschätzung.
6. Ablage des Vorfallprotokolls (Nachweis nach Art. 33 Abs. 5 DSGVO).
