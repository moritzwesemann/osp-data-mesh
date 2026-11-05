# ADR 0014: Externe Verankerung der Audit-Hash-Kette bei den Partnern

## Status

angenommen

Datum: 2026-11-05

## Kontext

Das Audit-Log ist nur anhängbar und durch eine SHA-256-Hash-Kette gesichert
([ADR 0006](0006-db-rollen-audit-hashkette.md)). Die Kette erkennt das Ändern einzelner Einträge. Wer aber
Eigentümer- oder Superuser-Rechte an der Datenbank hat, kann die Trigger abschalten, das **Ende
abschneiden** oder die Kette ab einem Eintrag **vollständig neu berechnen** – `audit_verify()` meldet danach
wieder „intakt“. Bisher war dagegen nur organisatorisch vorgesorgt („Prüfwert monatlich extern
notieren“). Eine zentrale Stelle (Zeitstempeldienst, gemeinsames Register) gibt es im Netz bewusst nicht;
die Partnerknoten sind aber unabhängig betriebene Systeme mit eigenen Datenbanken und eigenen
Verantwortlichen.

## Entscheidung

- **Prüfpunkt**: Der Knoten signiert regelmäßig (`MESH_AUDIT_CHECKPOINT_HOURS`, Standard stündlich, 0 =
  nur auf Anforderung) und auf Anforderung (*Audit › Externe Verankerung › Prüfpunkt jetzt senden*,
  `anchors.create`, CLI `audit-checkpoint`) die Aussage `{format, nodeId, seq, hash, at}` über den Kopf
  seiner Audit-Kette (exakt signierte JSON-Zeichenkette, Ed25519 mit dem Knotenschlüssel). Fällig ist ein
  geplanter Prüfpunkt nur, wenn die Kette seit dem letzten gewachsen ist. Eigene Prüfpunkte stehen in
  `audit_checkpoint`.
- **Hinterlegung**: Der Prüfpunkt geht als Mitteilung `audit_checkpoint` über das Ausgangspostfach an alle
  vertrauenswürdigen Partner (Wiederholungen). Ein noch nicht zugestellter älterer Prüfpunkt an denselben
  Partner entfällt: der neuere schließt ihn über die Hash-Kette ein.
- **Verwahrung beim Partner** (`peer_audit_checkpoint`, nur anhängbar für `mesh_app`, kein Zugriff für
  `mesh_bi`): nur von vertrauenswürdigen Partnern, Signatur mit deren (aktuellem bzw. in der Übergangszeit
  bisherigem) Schlüssel geprüft, Empfang protokolliert (`audit.checkpoint.received`). Keine
  personenbezogenen Daten: Laufnummer, Hash, Zeit, Signatur, Schlüssel. Ein zweiter, gültig signierter
  Prüfpunkt **mit derselben Laufnummer und anderem Hash** ist ein Beleg für Manipulation: er wird
  abgelehnt, das Original bleibt, Audit `audit.checkpoint.conflict` (`outcome = denied`).
- **Rückgabe**: neue Nachricht `checkpoints` (signiert, nur vertrauenswürdige Partner, seitenweise je 1 000):
  ein Partner erhält nur die Prüfpunkte, die er selbst hinterlegt hat (Audit `audit.checkpoint.served`).
- **Prüfung** (*Audit › Mit Partnern abgleichen*, `anchors.verify`, CLI `verify-audit --with-partners`):
  lokale Kette mit `audit_verify()`, dann je vertrauenswürdigem Partner alle hinterlegten Prüfpunkte holen,
  Signatur mit einem der eigenen (heutigen oder früheren, [ADR 0013](0013-knotenschluessel-rotation.md))
  Schlüssel prüfen und verlangen, dass die lokale Kette **genau diese Paare (seq, hash)** enthält.
  Fehlt eine Laufnummer, wurde die Kette abgeschnitten; weicht der Hash ab, wurde sie umgeschrieben. Da jeder
  Hash alle vorherigen Einträge einschließt, schützt der letzte hinterlegte Prüfpunkt die ganze Kette bis
  dahin. Ergebnis `ok` (intakt und bei mindestens einem Partner bestätigt), `manipulated` oder `unanchored`
  (kein Partner konnte bestätigen); protokolliert als `audit.anchor.verify` (`outcome = error`, wenn nicht
  `ok`). CLI-Exit-Codes 0 / 1 / 3. Prüfpunkte mit ungültiger Signatur (vom Partner verfälscht) zählen nicht
  als Beleg gegen die eigene Kette, sondern als Fehler des Partners.
- **Export** (*Prüfpunkt herunterladen*, `anchors.latest`, `audit-checkpoint --out`): letzter Prüfpunkt mit
  Aussage, Signatur, öffentlichem Schlüssel und Fingerprint als JSON – für eine Verankerung außerhalb des
  Netzes (z. B. Ablage beim Datenschutzbeauftragten). Prüfung offline mit `verify-audit --checkpoint
  <datei>` oder mit OpenSSL ([Betrieb](../betrieb.md#prüfung-der-audit-kette)).

## Konsequenzen

- Abschneiden und Umschreiben der Kette durch den Datenbank-Eigentümer werden erkennbar, solange
  mindestens ein Partner einen Prüfpunkt verwahrt, der hinter der manipulierten Stelle liegt. Ungeschützt
  bleibt der Teil nach dem letzten zugestellten Prüfpunkt (Standard: höchstens etwa eine Stunde).
- Die Prüfung muss mit unveränderter Software laufen: Wer Datenbank **und** Programm des Knotens
  kontrolliert, kann auch das Prüfergebnis fälschen. Dagegen hilft der Export an Dritte und die Prüfung
  durch die Revision von einem sauberen Stand aus.
- Je Partner und Prüfpunkt ein Audit-Eintrag beim Partner (stündlich je Partner) und ein Eintrag beim
  erzeugenden Knoten; Zustellungen selbst werden nicht einzeln auditiert (Status im Ausgangspostfach,
  endgültige Fehlschläge als `exchange.notice.failed`).
- Ein Partner kann Prüfpunkte nur zurückhalten (dann `unanchored` bzw. weniger Belege), nicht fälschen.
- Ältere Knotenversionen kennen `audit_checkpoint` und `checkpoints` nicht; alle Knoten brauchen Migration
  0600.

## Nachtrag (2026-11-05): Härtung nach der Sicherheitsprüfung

Eine Prüfung mit Proof-of-Concept-Tests zeigte, dass die Prüfung oben der geprüften Datenbank an mehreren
Stellen noch vertraute. Ergänzt wurde (Migration 0610, Regressionstests
`tests/integration/fix-audit-anchor-bypass.test.ts`, `fix-audit-anchor-epochs.test.ts`,
`audit-chain-recompute.test.ts`):

- **Hashes im Programm neu berechnen (H1).** Der Vergleich nutzte die gespeicherte Spalte `audit_log.hash`;
  ob Inhalt und Hash zusammenpassen, prüfte nur `audit_verify()` – in der Datenbank, die ihr Eigentümer
  ersetzen kann (Trigger aus, `details` ändern, `hash` stehen lassen, `audit_verify()` meldet immer
  „intakt“). Jetzt berechnet `modules/audit/chain.ts` die Kette aus den Rohspalten neu, Byte für Byte wie
  `audit_digest_input()` (Textform von Zahl und `jsonb` über die eingebauten Typumwandlungen, Zeitstempel
  über `pg_catalog.to_char`/`timezone`; Zusammensetzen und SHA-256 im Programm; ein Test vergleicht beides
  über viele Zeilen mit Umlauten, Emoji, Steuerzeichen, `|`, JSON-Zahlenformen und NULL-Spalten). Jede
  Zeile muss lückenlos nummeriert sein, auf den neu berechneten Vorgänger verweisen und ihren Hash tragen;
  `audit_log` muss eine gewöhnliche Tabelle ohne Zeilensicherheit sein. Prüfpunkte der Partner werden mit
  den **neu berechneten** Hashes verglichen. Gilt für `verify-audit` (auch ohne Partner), `--checkpoint`,
  `--with-partners` und den Abgleich in der Oberfläche.
- **Anker-Profil (H2).** Partnerliste, Partneradressen und -schlüssel und die früheren eigenen Schlüssel
  kamen aus derselben Datenbank (teils von `mesh_app` änderbar): Sperren der Partner ergab „nicht
  verankert“ statt „Manipulation“, eine umgestellte Partneradresse mit eigenem Schlüssel plus ein
  eingetragener „früherer Knotenschlüssel“ ergab „ok“. Neu: `audit-anchor-profile --out` exportiert ein
  Profil (Knoten-ID, eigene Schlüssel mit Gültigkeitszeitraum, Epochen, vertrauenswürdige Partner mit
  Knoten-ID, Adresse, Schlüssel, Fingerprint, Mindestzahl `minPartners`), das offline neben dem
  Sicherungsschlüssel verwahrt wird (SHA-256 notieren). `verify-audit --with-partners --profile <datei>`
  nimmt Partner, Adressen, Partnerschlüssel und eigene Schlüssel **nur** aus dem Profil, fragt genau diese
  Partner, nennt deren Fingerprints und schlägt fehl (Exit 3), wenn ein Partner des Profils nicht bestätigt
  (außer mit `--excuse … --reason …`, protokolliert) oder weniger als `minPartners` bestätigen.
  Abweichungen der Partnerzeilen in der Datenbank vom Profil erscheinen als Hinweis. Ohne Profil prüft der
  Knoten vertrauenswürdige **und gesperrte** Partner aus der Datenbank (gesperrte können Prüfpunkte nur
  zurückgeben, nicht fälschen) und sagt ausdrücklich, dass die Prüfung **nicht unabhängig** von der
  Datenbank ist (`independent: false`); die Oberfläche läuft im Server und ist entsprechend beschriftet.
- **Epochen (M2).** Nach einer Wiederherstellung vergab der Trigger Laufnummern erneut mit anderen Hashes;
  Partner lehnten neue Prüfpunkte als Widerspruch ab, die Prüfung meldete dauerhaft „Manipulation“. Jetzt
  hat die Kette **Epochen** (`audit_chain_epoch`): die erste aus der Migration, jede Wiederherstellung
  beginnt eine neue (`restore` trägt sie in derselben Transaktion ein, mit voriger Epoche und höchster
  übernommener Laufnummer `restored_seq`, protokolliert in `backup.restore`) – die wiederhergestellte
  Datenbank brächte sonst den alten Wert mit. Die Epoche ist Teil der signierten Aussage und des
  Eindeutigkeitsschlüssels beim Partner (Partner, Epoche, Laufnummer); Partner nehmen eine neue Epoche
  eines vertrauenswürdigen Partners an und protokollieren das (`audit.checkpoint.epoch_changed`).
  Prüfung: die aktuelle Epoche streng; ein Prüfpunkt einer früheren Epoche wird verglichen, wenn sein
  Eintrag über die Kette der Wiederherstellungen derselbe ist wie in der aktuellen Kette (Laufnummer ≤
  übernommene) – Abweichung = Manipulation –, sonst ist er „durch Wiederherstellung verloren“: neues
  Ergebnis **`needs_review`** („Klärung nötig“, Exit 4), nie still „ok“. Erklärt ist der Verlust nur mit
  einem Profil, das alle Epochen des Verlaufs dokumentiert; eine Epoche, die nicht im Profil steht, ist ein
  eigener Hinweis. Damit erzeugt auch eine vom Eigentümer **vorgetäuschte** Wiederherstellung (eingefügte
  Epoche) immer eine sichtbare Warnung. Aussagen ohne Epoche (Knoten vor 0610) gelten als Aussagen der
  ersten Epoche; hat ein Partner schon Aussagen mit Epoche gesendet, werden solche ohne abgelehnt.
- **Gültigkeitszeiträume der eigenen Schlüssel (L2).** Ein Prüfpunkt zählt nur, wenn er mit einem eigenen
  Schlüssel signiert ist, dessen Zeitraum den Zeitpunkt der Aussage umfasst (ab dem einführenden Wechsel
  bis zum Ende der Übergangszeit des ablösenden; bei Kompromittierung bis zu deren Zeitpunkt, auch für
  den bisherigen Schlüssel eines dadurch abgebrochenen Übergangs). Abweichungen, die mit einem als
  kompromittiert abgelösten Schlüssel signiert sind, sind „nicht beweiskräftig“ (Klärung nötig) statt
  Beweis für Manipulation.
- **Grenzen beim Partner (L3).** Je Partner und Epoche nur steigende Laufnummern (Wiederholungen werden
  bestätigt) und höchstens `MESH_AUDIT_CHECKPOINT_MAX_PER_DAY` (Standard 48) neue Prüfpunkte in 24
  Stunden; Ablehnungen `checkpoint_not_increasing` bzw. `checkpoint_rate_limited`, im Audit-Log
  zusammengefasst wie die Ablehnungen der Protokollprüfung (erste je Partner und Grund in 5 Minuten,
  `suppressed`).
- Seitenweiser Abruf `checkpoints` nach (Laufnummer, Epoche) mit `afterEpoch`.

**Verbleibende Grenzen** (nicht technisch lösbar, organisatorisch abgedeckt): Wer Datenbank **und**
prüfendes Programm bzw. dessen Rechner kontrolliert, kann das Ergebnis fälschen. Ein Superuser des Clusters
kann eingebaute Typumwandlungen und `pg_catalog`-Funktionen ändern oder dem Prüfprogramm andere Zeilen
zeigen als anderen Lesern (geteilte Sicht); die Prüfung erkennt nur Views und Zeilensicherheit auf
`audit_log`. Die Prüfung ohne Profil (auch in der Oberfläche) bleibt von der Datenbank abhängig. Das
Profil ist nur so gut wie seine Erstellung und Verwahrung: exportiert aus einer bereits manipulierten
Datenbank, ohne Abgleich der Fingerprints, oder unbemerkt verändert (Prüfsumme nicht verglichen), täuscht es
ebenso. Eine vorgetäuschte Wiederherstellung führt zu „Klärung nötig“, nicht zu „Manipulation“ – die
Klärung (Protokoll der Wiederherstellung, `audit.checkpoint.epoch_changed` bei den Partnern) ist Pflicht.
Nach eigenem oder fremdem Schlüsselwechsel und nach Partneränderungen muss das Profil neu exportiert
werden, sonst schlägt die Prüfung fehl (sicherer Fehlschlag).

## Nachtrag 2 (2026-11-05): zweite Prüfrunde

Eine erneute unabhängige Prüfung fand sechs weitere Lücken und belegte sie mit Proof-of-Concept-Tests.
Diese sind jetzt Regressionstests, die den Angriff erkennen (`tests/integration/fix-audit-anchor-review2.test.ts`;
Migrationen 0620 und 0630).

1. **Planer anhalten (mittel).** `mesh_app` durfte `audit_checkpoint` beliebig anhängen; eine Zeile mit
   `created_at` in ferner Zukunft hielt den Planer dauerhaft an, das unverankerte Ende ließ sich danach
   umschreiben, und `verify-audit --profile` meldete „ok“. Jetzt:
   - `mesh_app` hat kein `INSERT` mehr auf `audit_checkpoint`; eigene Prüfpunkte entstehen nur über die
     `SECURITY DEFINER`-Funktion `audit_checkpoint_append()` (Eigentümer `mesh_owner`, fester Suchpfad). Sie
     nimmt nur die **aktuelle Epoche** und eine **vorhandene Laufnummer mit deren gespeichertem Hash** an und
     setzt `created_at` selbst. Signaturen kann die Datenbank nicht prüfen (kein Ed25519).
   - Der Planer, der Export (`anchors/latest`, `audit-checkpoint`) und die Statusanzeige werten nur
     **gültig signierte eigene** Prüfpunkte aus (Aussage passt zur Zeile, Signatur mit einem eigenen Schlüssel,
     der zum Zeitpunkt galt), und der Planer nur solche, deren signierter Zeitpunkt nicht mehr als 5 Minuten
     in der Zukunft liegt. Belegt eine ungültige Zeile den Platz des Kopfes, protokolliert
     `createCheckpoint` das (`audit.checkpoint.invalid_row`, Ergebnis `error`); der Eintrag rückt den Kopf
     weiter, der nächste Versuch signiert den neuen Kopf (höchstens drei Versuche, sonst
     `checkpoint_slot_occupied`).
   - **Lebenszeichen:** Ohne neue Einträge erstellt der Planer nach dem zweifachen Intervall trotzdem einen
     Prüfpunkt.
   - **Veralteter Anker:** `verifyAnchors` meldet `anchor_stale` (Klärung nötig, Exit 4), wenn der jüngste
     von mindestens `requiredPartners` Partnern bestätigte Prüfpunkt älter ist als das **Dreifache** von
     `MESH_AUDIT_CHECKPOINT_HOURS` (ohne Planer, Intervall 0: keine Meldung). Entscheidung: „Klärung nötig“,
     nicht „Manipulation“ – ein Knoten, der lange nicht lief, sieht genauso aus wie einer mit angehaltenem
     Planer; still „ok“ ist es aber nie. Immer gemeldet wird `anchoring`: höchste Laufnummer, die genug Partner
     bestätigen, deren signierter Zeitpunkt und die Zahl der Einträge danach (`unanchoredEntries`) – nur
     diese könnte der Eigentümer der Datenbank unbemerkt ändern oder löschen.
2. **`--previous` übernahm Änderungen der Datenbank still (mittel).** Die Mindestzahl fiel auf 1, in der
   Datenbank gesperrte Partner verschwanden, Angaben der Datenbank (änderbar auch durch `mesh_app`) hatten
   Vorrang. Jetzt ist das alte Profil die Grundlage: Mindestzahl bleibt (außer `--min-partners`), jede
   Abweichung wird angezeigt und muss **je Kategorie ausdrücklich** angenommen werden –
   `--accept-partner-changes` (Partner entfernt, hinzugekommen, Schlüssel oder Adresse geändert),
   `--accept-key-changes` (eigener Schlüssel neu, Gültigkeitszeitraum oder Art der Ablösung geändert),
   `--accept-epochs` (Epoche neu oder geändert). Sonst kein Export, Exit 4, protokolliert
   (`audit.anchor_profile.export`, Ergebnis `denied`). Ohne Annahme gilt bei Widerspruch das alte Profil;
   was nur dort steht (eigene Schlüssel, Epochen), bleibt. `mesh_app` darf `node_key_rotation` nur noch in
   den Spalten `finished_at` und `old_private_key_enc` ändern (Spaltenrechte; Ende der Übergangszeit,
   Abbruch bei Kompromittierung, Neuverschlüsselung); ein Trigger macht `finished_at` endgültig und lässt
   einen verworfenen Schlüssel nicht zurückkehren.
3. **Feldgrenzen der Hash-Eingabe (mittel, aus Migration 0001).** Siehe
   [ADR 0006, Nachtrag](0006-db-rollen-audit-hashkette.md): Version 2 der Hash-Eingabe mit Längenangaben
   für alle neuen Einträge; die Prüfung im Programm rechnet Version 1 und 2, bindet die Version, prüft den
   Aufbau der Tabelle über `pg_attribute` (eingebaute Typen, `NOT NULL`, keine berechneten Spalten) und die
   erlaubten Werte von `actor_type`/`outcome`. Neue Bruchkategorien: `column_changed`, `invalid_value`,
   `digest_version`.
4. **Vorgetäuschte Epoche (gering).** Eine erfundene Wiederherstellung schwächte das Ergebnis nur auf
   „Klärung nötig“, ein routinemäßiger Neuexport machte es „ok“. Jetzt hält `restore` zusätzlich den
   **Kopf der bisherigen Kette** fest (Epoche, Laufnummer, gespeicherter Hash; neben Prüfsumme und Zeitpunkt
   der Sicherung, Migration 0630), das Profil übernimmt diese Angaben je Epoche, und `restore` zeigt sie zum
   Eintrag ins Protokoll an. Mit Profil gilt: eine Epoche, die nicht im Profil steht, **und** dadurch
   „verlorene“ Prüfpunkte = **Manipulation** (der Verlust ist nicht erklärt; nach einer echten
   Wiederherstellung meldet das alte Profil deshalb „Manipulation“, bis es mit `--accept-epochs` neu
   exportiert ist). Ein Prüfpunkt einer früheren Epoche **hinter** dem vor der Wiederherstellung
   festgehaltenen Kopf (oder an dessen Laufnummer mit anderem Hash) ist auch ohne Profil Manipulation
   (`beyond_pre_restore`). Neue Epochen nimmt `--previous` nur mit `--accept-epochs` an (Punkt 2).
5. **Gestohlener Schlüssel blockiert die Epoche (gering).** Mit einem gestohlenen Schlüssel ließ sich ein
   Prüfpunkt mit Laufnummer nahe 2^53 hinterlegen; alle ehrlichen Prüfpunkte der Epoche galten danach als
   „nicht steigend“. Jetzt gilt die Regel „nur steigend“ je Partner, Epoche **und signierendem Schlüssel**.
   Nach einem Wechsel wegen Kompromittierung (Partner trägt den neuen Schlüssel ein, `peers.replaceKey`)
   nimmt der Partner den alten Schlüssel gar nicht mehr an, und dessen Prüfpunkte zählen für die
   Reihenfolge des neuen nicht.
6. **Nebenläufigkeit, Wiederherstellung (Hinweis).** Beim Partner laufen Wiederholungs-, Reihenfolge-,
   Raten- und Epochenprüfung jetzt in derselben Transaktion wie das Verwahren, unter einer Sperre je
   Partner (`pg_advisory_xact_lock(7212201, hashtext(peer_id))`, als Erstes in der Transaktion, siehe
   `core/locks.ts`); gleichzeitige Zustellungen unterlaufen Reihenfolge und Ratenbegrenzung nicht mehr.
   `restore` prüft die Kette danach im Programm (`modules/audit/chain.ts`) und meldet zusätzlich das
   Ergebnis von `audit_verify()` der wiederhergestellten Datenbank (deren Funktion aus der Sicherung
   stammt) zum Vergleich; maßgeblich ist die Neuberechnung.

**Verbleibende Grenzen dieses Nachtrags:** Einträge nach dem letzten Anker kann der Eigentümer der
Datenbank weiterhin unbemerkt löschen oder ändern; erkennbar ist nur, dass es sie gibt bzw. dass der Anker
veraltet ist (`unanchoredEntries`, `anchor_stale`). Wer mit `mesh_app`-Rechten fortlaufend den Platz des
jeweiligen Kopfes vorwegnimmt, kann Prüfpunkte verzögern (jeder Versuch ist protokolliert, nach drei
Versuchen Fehler; die Prüfung meldet dann den veralteten Anker). Mit einem gestohlenen, noch gültigen
Schlüssel lassen sich bis zum Wechsel einzelne künftige Laufnummern beim Partner vorwegnehmen (höchstens
`MESH_AUDIT_CHECKPOINT_MAX_PER_DAY` je Tag); ein ehrlicher Prüfpunkt genau dieser Laufnummer wird dann als
Widerspruch abgelehnt (`audit.checkpoint.conflict`, sichtbar), der nächste mit anderer Laufnummer kommt
durch. Für Einträge der Version 1 bleibt die Mehrdeutigkeit der Feldgrenzen (ADR 0006).
