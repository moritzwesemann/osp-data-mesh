# ADR 0013: Wechsel des Knotenschlüssels mit signierter Mitteilung an die Partner

## Status

angenommen

Datum: 2026-11-05

## Kontext

Jeder Knoten weist sich gegenüber Partnern mit einem Ed25519-Schlüssel aus; Vertrauen entsteht nur durch
den manuellen Fingerprint-Abgleich ([ADR 0005](0005-pull-austausch-ed25519.md)). Bisher gab es keinen Weg,
diesen Schlüssel zu wechseln, ohne dass alle Partner den Knoten neu aufnehmen (S4). Ein planmäßiger
Wechsel (turnusmäßig, Ausscheiden einer Person mit Zugang zu Master-Key und Datenbank) soll ohne erneuten
Telefonabgleich möglich sein und den laufenden Austausch nicht unterbrechen – auch nicht für Partner, die
gerade nicht erreichbar sind. Zugleich darf er keine Hintertür öffnen: Wer einen alten Schlüssel besitzt,
darf damit keinen eigenen Schlüssel durchsetzen können.

Betrachtete Varianten für die Übergangszeit:

1. **Sofort umstellen**: der Knoten signiert ab dem Wechsel mit dem neuen Schlüssel. Partner, die die
   Mitteilung noch nicht verarbeitet haben, lehnen jede Nachricht und jede Antwort ab – ein offline
   gewesener Partner könnte bis zur nächsten Wiederholung des Ausgangspostfachs (bis 1 h) nichts abrufen.
2. **Zwei Signaturen je Nachricht** (alter und neuer Schlüssel in getrennten Kopfzeilen): ändert das
   Protokoll für jede Nachricht und jeden Prüfer.
3. **Global umstellen, wenn alle bestätigt haben**: ein langsamer Partner verzögert den Wechsel für alle;
   Partner, die den Knoten während der Übergangszeit neu aufnehmen (neue Karte), könnten ihn nicht prüfen.
4. **Je Partner umstellen** (gewählt): der Knoten weiß aus der signierten Antwort auf die Mitteilung, welcher
   Partner den neuen Schlüssel kennt.

## Entscheidung

**Planmäßiger Wechsel** (`node.rotateKey` mit `mode: routine`, Oberfläche *Partner › Eigene Knotenkarte ›
Schlüssel wechseln*, CLI `rotate-node-key --routine`):

- Neues Schlüsselpaar; der neue private Schlüssel wird wie bisher mit dem Master-Key verschlüsselt
  gespeichert. Der bisherige bleibt **verschlüsselt** (eigener AAD je Wechsel) bis zum Ende der
  **Übergangszeit** (1–30 Tage, Standard 7) erhalten und wird danach gelöscht (`node_key_rotation`).
- **Rotationsaussage** `{format, nodeId, oldPublicKey, newPublicKey, rotatedAt, graceUntil}` als exakt
  signierte JSON-Zeichenkette, **signiert mit dem bisherigen** (Kontinuität: nur wer den vertrauten
  Schlüssel hat, kann wechseln) **und dem neuen Schlüssel** (Besitz: der neue Schlüssel ist kein fremder).
- Je Partner mit Status `trusted` oder `suspended` (gesperrte erhalten weiter Löschmitteilungen, die sie
  prüfen können müssen) eine Mitteilung `key_rotated` im **Ausgangspostfach** (Wiederholungen wie bei
  Widerrufen). Der **Umschlag** dieser Mitteilung ist ebenfalls mit dem bisherigen Schlüssel signiert.
- **Je Partner** signiert der Knoten (Anfragen und Antworten) mit dem **bisherigen** Schlüssel, solange
  dieser Partner die Mitteilung nicht mit einer gültig signierten Antwort bestätigt hat, sonst mit dem
  neuen (`NodeIdentity.signerFor`). Partner ohne Mitteilung (neu aufgenommen) erhalten den neuen. So bricht
  kein Partner, der die Mitteilung noch nicht verarbeitet hat.
- Nach Ablauf der Übergangszeit (Wartung, minütlich): bisheriger privater Schlüssel gelöscht, offene
  Mitteilungen `failed` mit `key_rotation_expired`, Audit `node.key_rotation.finished` (bei Partnern ohne
  Bestätigung mit `outcome = error` und deren Knoten-IDs).
- Während einer laufenden Übergangszeit ist kein weiterer planmäßiger Wechsel möglich
  (`conflict`, `key_rotation_in_progress`), damit die Kette der Aussagen eindeutig bleibt.

**Empfang** (`key_rotated` beim Partner): angenommen nur, wenn

1. der Absender dort **vertrauenswürdig** ist (gesperrte Partner dürfen nur löschende Mitteilungen senden),
2. die Aussage gültig aufgebaut ist und **beide** Signaturen stimmen,
3. die Aussage beim **heute gespeicherten** Schlüssel beginnt und der **Umschlag mit genau diesem**
   (nicht mit einem bisherigen aus einer Übergangszeit) signiert ist,
4. der neue Schlüssel weder der eigene noch der eines anderen Partners ist.

Dann gilt der neue Schlüssel (Fingerprint neu berechnet), der bisherige wird bis `graceUntil` (höchstens
30 Tage nach Empfang) zusätzlich angenommen – für laufende Nachrichten, aber nie für eine weitere
Rotationsmitteilung. Audit `peer.key_rotated` mit altem und neuem Fingerprint; Ablehnungen
`peer.key_rotation.rejected` (`outcome = denied`). Eine bereits übernommene Aussage (Antwort ging verloren,
Ausgangspostfach wiederholt) wird ohne Änderung bestätigt. Replay eines Umschlags verhindert der
Nonce-Schutz; das Wiedereinspielen einer alten Aussage scheitert an Regel 3.

**Partner, die die Mitteilung verpassen** (offline über die ganze Übergangszeit, Knoten gesperrt oder
ausstehend): nach dem Ende der Übergangszeit lehnen sie Nachrichten des Knotens ab (`bad_signature`) –
sicherer Fehlschlag. Sie tragen die neue Knotenkarte manuell ein (`peers.replaceKey`, *Partner › Neuen
Schlüssel eintragen*): gleiche Knoten-ID erforderlich, bisheriger Schlüssel gilt sofort nicht mehr, Status
`pending`, bis der neue Fingerprint telefonisch abgeglichen und das Vertrauen bestätigt ist.

**Verdacht auf Kompromittierung** (`mode: compromised`, CLI `rotate-node-key --compromised --yes`): Eine mit
dem alten Schlüssel signierte Mitteilung beweist dann nichts – der Angreifer könnte dieselbe senden. Der
Knoten erzeugt einen neuen Schlüssel **ohne Mitteilung und ohne Übergangszeit**; der bisherige wird sofort
verworfen (auch ein laufender planmäßiger Wechsel endet). Vorgehen: Partner telefonisch informieren, sie
sperren den Knoten, Schlüssel ersetzen, neue Knotenkarte senden, Partner tragen sie ein und gleichen den
Fingerprint telefonisch ab. Oberfläche und CLI verlangen die ausdrückliche Wahl des Anlasses und eine
Bestätigung.

## Konsequenzen

- Planmäßige Wechsel ohne Telefonabgleich und ohne Unterbrechung; verspätete Partner werden über die
  Wiederholungen des Ausgangspostfachs erreicht.
- Während der Übergangszeit liegt der bisherige private Schlüssel weiter (verschlüsselt) vor; wer ihn
  stiehlt, kann bis zu deren Ende Nachrichten an noch nicht umgestellte Partner fälschen und wird von
  umgestellten Partnern bis `graceUntil` angenommen. Deshalb nur für planmäßige Wechsel; im Verdachtsfall
  gilt das Vorgehen ohne Mitteilung.
- Der Wechsel aus der CLI wird vom laufenden Server innerhalb weniger Sekunden übernommen
  (`NodeIdentity.refresh` im Takt des Ausgangspostfachs); ohne laufenden Server gehen die Mitteilungen
  beim nächsten Start hinaus.
- Ältere Knotenversionen kennen `key_rotated` nicht (`bad_request`); alle Knoten eines Netzes müssen die
  Version mit Migration 0600 haben.
- Erweiterung denkbar: eine mit dem alten Schlüssel signierte **Sperrmitteilung** („Schlüssel
  kompromittiert, nicht mehr vertrauen“) wäre unbedenklich, weil sie nur Vertrauen entzieht; nicht umgesetzt.

## Nachtrag (2026-11-05): Härtung nach der Sicherheitsprüfung

- **Manuell eingetragener neuer Schlüssel während der Übergangszeit (L1).** Hatte ein Partner die
  Mitteilung verpasst und den neuen Schlüssel mit `peers.replaceKey` eingetragen, signierte der Knoten für
  ihn bis zum Ende der Übergangszeit (bis zu 30 Tage) weiter mit dem bisherigen Schlüssel – die
  Mitteilung wurde ja nie bestätigt –, und der Partner lehnte alles ab. Jetzt wiederholt der Client eine
  Anfrage, die während der Übergangszeit mit dem bisherigen Schlüssel signiert war und vom Partner mit
  `bad_signature` abgelehnt wurde, **einmal mit dem neuen Schlüssel**. Gelingt das, ist bewiesen, dass der
  Partner den neuen Schlüssel kennt: Er gilt als bestätigt (`node.key_rotation.confirmed` mit
  `via: new_key_accepted`), ab dann wird für ihn (Anfragen und Antworten) nur noch mit dem neuen
  Schlüssel signiert. Die noch ausstehende Rotationsmitteilung bestätigt der Partner dann ohne Änderung:
  Ein Empfänger, bei dem der neue Schlüssel der Aussage bereits gespeichert ist, antwortet mit
  `affectedRows: 0`. Das öffnet keinen neuen Weg: Die Wiederholung nutzt den eigenen neuen Schlüssel, den
  der Partner selbst eingetragen und telefonisch abgeglichen hat; scheitert sie, bleibt es beim
  ursprünglichen Fehler (Test `tests/integration/fix-key-rotation-replaced-key.test.ts`).
- **Gültigkeitszeiträume (L2).** Frühere eigene Schlüssel galten für die Prüfung eigener Prüfpunkte der
  Audit-Kette unbegrenzt. `NodeIdentity.keyHistory` liefert jetzt je Schlüssel einen Zeitraum (ab dem
  einführenden Wechsel bis zum Ende der Übergangszeit des ablösenden, bei Kompromittierung bis zu deren
  Zeitpunkt) und die Art der Ablösung; mit einem als kompromittiert abgelösten Schlüssel signierte
  Abweichungen gelten nicht als Beweis ([ADR 0014, Nachtrag](0014-externe-verankerung-audit-kette.md)).
  Das Anker-Profil enthält diesen Verlauf; nach jedem Wechsel ist es neu zu exportieren.
