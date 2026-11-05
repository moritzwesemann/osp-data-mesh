# Datenmodell

Jeder Knoten hat eine eigene PostgreSQL-Datenbank (Standardname `mesh`). Das Schema entsteht
ausschließlich durch versionierte Migrationen in `migrations/` (aktuell `0001_core.sql`,
`0300_bi_view_names.sql`, `0500_exchange_delivery_basis.sql`, `0700_connector_xlsx.sql` – Quellart
`xlsx_upload`); die Rechte setzt `migrations/grants.sql`. Diese Seite beschreibt Zweck und
wichtige Spalten jeder Tabelle, die Beziehungen und die JSON-Strukturen, die in JSONB-Spalten gespeichert
werden. Maßgeblich im Detail sind die SQL-Dateien und der HTTP-Vertrag (`src/shared/contract/`).

## Schemata

| Schema | Inhalt | Zugriff |
|---|---|---|
| `public` | alle Fachtabellen, Audit-Log, Migrationshistorie `schema_migration` | `mesh_owner` (Eigentümer), `mesh_app` |
| `bi` | je BI-Freigabe eine typisierte View (Name = Kürzel des Datenprodukts) | `mesh_app` legt an, `mesh_bi` liest |
| `bi_data` | materialisierte Tabellen `r_<12 Hex-Zeichen der Freigabe-ID>` hinter den Views, mit verborgener Personenspalte `_subject` (nie in der View) | nur `mesh_app` |

## Konventionen

- Primärschlüssel `uuid` (`gen_random_uuid()`), bei Protokolltabellen `bigserial`.
- Zeitpunkte `timestamptz` (UTC), reine Daten `date`. `updated_at` wird per Trigger `set_updated_at()`
  gepflegt.
- Spaltennamen `snake_case`; die REST-API verwendet `camelCase`.
- Wertebereiche als `CHECK`-Constraints (z. B. Rollen, Kaderstatus, Status-Felder); Fremdschlüssel mit
  bewusst gewähltem Verhalten (`cascade` für abhängige Daten, `restrict` für Freigaben, `set null` für
  „angelegt von“).
- Personenbezogene Messwerte liegen nicht in dynamischen Tabellen, sondern als JSONB je Eintrag mit
  typisierten Felddefinitionen ([ADR 0003](adr/0003-jsonb-datensaetze.md)).

## Beziehungen (Übersicht)

```text
 app_user ─┬─< user_session
           └─< api_token
   (created_by, recorded_by, trusted_by … vieler Tabellen verweisen optional auf app_user)

 athlete ─┬─< athlete_identifier
          ├─< consent_record
          └─< dataset_record >──── dataset ─┬─< connector ─< import_run ─< import_error
                    │                       │                   ▲
                    └── import_run_id ──────┼───────────────────┘   (Herkunft, optional)
                                            │
                                            └─< data_product ─< data_release ─── bi_view (0..1)
   athlete ist Quelle von data_product, wenn source_type = athletes        ▲
                                                                           │ recipient_peer_id
 peer ─┬─< data_release ───────────────────────────────────────────────────┘
       ├─< outbox_message
       ├─< exchange_log        (release_id verweist ohne Fremdschlüssel auf data_release)
       └─< received_product ─< received_row

 Einzeltabellen: node_identity (genau 1 Zeile), setting, purpose, app_error, backup_run,
                 audit_log, federation_nonce, schema_migration

 Legende:  A ─< B = ein A hat viele B;   B >── A = viele B gehören zu einem A
```

## Tabellen

### Knoten und Betrieb

| Tabelle | Zweck | Wichtige Spalten |
|---|---|---|
| `node_identity` | Identität des Knotens, genau eine Zeile (`id = 1`) | `node_id` (unveränderlich), `display_name`, `base_url`, `public_key` (Ed25519, base64), `private_key_enc` und `pseudonym_secret_enc` (mit Master-Key verschlüsselt), `previous_public_key` (bisheriger Schlüssel während der Übergangszeit eines Wechsels, sonst `null`), `key_created_at` |
| `node_key_rotation` | Verlauf der eigenen Schlüsselwechsel ([ADR 0013](adr/0013-knotenschluessel-rotation.md)); höchstens ein laufender (`finished_at is null`, partieller eindeutiger Index) | `id`, `mode` (`routine`/`compromised`), `old_public_key`, `new_public_key`, `old_private_key_enc` (bisheriger privater Schlüssel, verschlüsselt mit AAD `node_key_rotation.old_private_key:<id>`, nur während der Übergangszeit; danach `null`), `statement` (exakt signierte Rotationsaussage, JSON), `signature_old`, `signature_new`, `rotated_at`, `grace_until`, `finished_at`, `rotated_by` |
| `node_key_rotation_peer` | Benachrichtigung und Bestätigung je Partner | `rotation_id`, `peer_id`, `outbox_message_id`, `confirmed_at` (signierte Antwort des Partners; bis dahin signiert der Knoten für ihn mit dem bisherigen Schlüssel) |
| `setting` | Schlüssel-Wert-Einstellungen | `key`, `value` (JSONB) |
| `app_error` | Protokoll unerwarteter Fehler (für *System › Letzte Fehler*) | `at`, `request_id`, `method`, `path`, `status`, `code`, `message`, `user_id` |
| `backup_run` | Sicherungsläufe | `started_at`, `finished_at`, `status` (`running`/`ok`/`failed`), `file_name`, `size_bytes`, `sha256`, `trigger` (`manual`/`schedule`/`cli`), `error_code` |
| `schema_migration` | angewandte Migrationen | `version`, `name`, `sha256` (Prüfsumme; Änderung einer angewandten Datei wird erkannt), `applied_at` |

### Benutzer und Zugang

| Tabelle | Zweck | Wichtige Spalten |
|---|---|---|
| `app_user` | Personen mit Zugang | `email` (eindeutig, klein), `display_name`, `password_hash` (Argon2id), `roles` (Teilmenge von `admin`, `data_steward`, `analyst`, `coach`, `auditor`), `locale`, `active`, `failed_logins`, `locked_until`, `must_change_password`, `last_login_at` |
| `user_session` | Anmeldesitzungen | `id` = SHA-256 des Tokens (Token selbst nie gespeichert), `user_id`, `expires_at`, `last_seen_at`, `ip`, `user_agent` |
| `api_token` | Tokens für Werkzeuge | `user_id`, `name`, `token_hash` (SHA-256), `prefix` (Wiedererkennung), `expires_at`, `last_used_at`, `revoked_at` |

### Personen und Einwilligungen

| Tabelle | Zweck | Wichtige Spalten |
|---|---|---|
| `athlete` | Athletenkern | `last_name`, `first_name`, `date_of_birth`, `sport`, `squad_status` (`OK`, `PK`, `EK`, `NK1`, `NK2`, `LK`, `none`), `sex` (`f`/`m`/`d`), `club`, `discipline`; eindeutig über (Nachname, Vorname, Geburtsdatum) |
| `athlete_identifier` | Kennungen der Person in Quellsystemen (Zuordnung bei Importen) | `athlete_id`, `system`, `value`; Primärschlüssel (`system`, `value`) |
| `consent_record` | außerhalb eingeholte, hier dokumentierte Einwilligungen | `athlete_id`, `purpose` (Code oder `*`), `data_category` (Kategorie oder `*`), `status` (`granted`/`withdrawn`), `valid_from`, `valid_until`, `evidence_note`, `withdrawn_at` |
| `purpose` | Zweck-Vokabular der Zweckbindung (6 vorbelegte Zwecke) | `code`, `label_de`, `label_en`, `description`, `active` |

Löschen einer Person entfernt per `on delete cascade` Kennungen, Einwilligungen und alle
`dataset_record`-Einträge. In derselben Transaktion (Ereignis `athlete.deleted`) entfernt der Knoten die
Person außerdem aus offenen Importläufen (vorgemerkte Zeilen, Vorschauzeilen, Rohwerte im
Fehlerprotokoll; Audit `import.erase`) und aus den BI-Tabellen (Spalte `_subject`); Partner, die Daten
der Person erhalten haben, erhalten eine Löschmitteilung über das Ausgangspostfach.

### Datensätze, Quellen, Importe

| Tabelle | Zweck | Wichtige Spalten |
|---|---|---|
| `dataset` | Struktur einer Datenart (z. B. Sprungkraft) | `slug`, `name`, `category` (`master`, `performance`, `training`, `health`, `competition`, `other`), `special_category` (Art. 9; bei `health` erzwungen), `shareability` (`internal`/`on_request`), `version`, `fields` (JSONB, `FieldDef[]`), `key_fields` (fachlicher Schlüssel), `observed_at_field` (Messdatum), `owner_contact` |
| `dataset_record` | ein Eintrag (Messung) einer Person | `dataset_id`, `athlete_id`, `record_key` (aus `key_fields`), `observed_at`, `data` (JSONB: Feldname → Wert), `import_run_id`; eindeutig je (Datensatz, Person, Schlüssel) → erneuter Import aktualisiert statt zu duplizieren |
| `connector` | wiederverwendbare Quelle mit Zuordnung | `slug`, `kind` (`csv_upload`/`xlsx_upload`/`http_api`), `target_type` (`athletes`/`dataset`), `target_dataset_id`, `config` (JSONB, CSV-, Excel- bzw. API-Einstellungen ohne Geheimnisse), `mapping` (JSONB, `FieldMapping[]`), `athlete_match` (Zuordnung über Name+Geburtsdatum oder Kennung), `secret_enc` (verschlüsseltes API-Geheimnis: Token, Header-Wert oder OAuth2-Client-Geheimnis), `on_error` (`skip_row`/`abort`), `version`, `active` |
| `import_run` | ein Importlauf (Vorschau → Übernahme oder Verwerfen) | `connector_id`, `connector_version`, `status` (`previewed`, `committed`, `discarded`, `failed`), `source_name`, `source_sha256`, `source_size`, `staged` (JSONB `{ rows, subjects }`: vorgemerkte, geprüfte Zeilen und je Zeile der Personenbezug, siehe unten; nur im Status `previewed`, danach `null`), `preview` (JSONB `{ sourceColumns, rows }`, höchstens 50 Zeilen; `rows` wird bei Übernahme, Verwerfen und Ablauf geleert), Zähler (`total_rows`, `valid_rows`, `error_rows`, `warning_rows`, `inserted_rows`, `updated_rows`), `failure_code` |
| `import_error` | Fehlerprotokoll je Zeile und Feld | `run_id`, `row_number` (1-basiert ohne Kopfzeile), `field`, `code` (übersetzbarer Fehlercode), `severity` (`error`/`warning`), `raw_value` (Rohwert, höchstens 500 Zeichen; nur solange der Lauf im Status `previewed` ist, danach `null`; bei Zuordnungsfehlern nie Name, Geburtsdatum oder Kennung), `params` |

**Personenbezogene Daten in Importläufen** gibt es nur, solange ein Lauf im Status `previewed` ist:
`staged`, `preview.rows` und `import_error.raw_value`. Übernahme, Verwerfen und der Ablauf nach 7 Tagen
(Hintergrundaufgabe, stündlich, Audit `import.expire`) leeren sie; danach bleiben Zähler, Prüfsumme,
Spaltennamen und das Fehlerprotokoll aus Zeile, Feld und Code. Damit die Löschung einer Person ihre Zeilen
auch in offenen Vorschauen findet, enthält `staged.subjects` je Quellzeile den **Personenbezug**
`{ r, a?, k?, e? }`: `r` = Zeilennummer, `a` = ID der zugeordneten Person, sonst `k` = gekürzter SHA-256
(32 Hex-Zeichen) des natürlichen Schlüssels (Nachname, Vorname, Geburtsdatum) und `e` = gekürzter
SHA-256 von Quellsystem und Kennung – keine Klartexte. Läufe aus älteren Versionen speichern in `staged`
nur das Array der Zeilen; sie werden weiterhin gelesen, bei einer Löschung werden ihre Vorschau und alle
Rohwerte vorsorglich vollständig geleert.

### Datenprodukte und Freigaben

| Tabelle | Zweck | Wichtige Spalten |
|---|---|---|
| `data_product` | definierte Sicht auf einen Datensatz oder den Athletenkern | `slug` (zugleich Name der BI-View), `name`, `source_type` (`athletes`/`dataset`), `dataset_id`, `columns` (JSONB, `ProductColumn[]`), `filters` (JSONB, `Condition[]`, Basisfilter), `shareability`, `version` (steigt bei Änderung von Spalten/Filtern), `status` (`active`/`retired`) |
| `data_release` | Freigabe eines Produkts für genau einen Empfänger; unveränderlich (Änderung = neue Freigabe) | `product_id`, `product_version` (Version bei Erteilung), `recipient_type` (`role`/`peer`), `recipient_role` (`analyst`, `coach`, `data_steward`, `auditor`, `bi`), `recipient_peer_id`, `purposes` (Text-Array), `columns` (Text-Array), `row_filter` (JSONB, `Condition[]`), `data_from`/`data_until` (Datenzeitraum), `valid_from`/`valid_until` (Gültigkeit), `requires_consent`, `legal_basis`, `note`, `revoked_at`, `revoked_by`, `revocation_reason` |
| `bi_view` | Zustand der BI-Materialisierung je BI-Freigabe | `release_id` (Primärschlüssel), `view_name` (= Produktkürzel; eindeutig nur unter nicht entfernten Views: partieller eindeutiger Index `bi_view_view_name_live … where status <> 'dropped'`, Migration 0300 – nach Widerruf oder Ablauf kann eine neue BI-Freigabe desselben Produkts den Namen wieder belegen, die Zeile der entfernten View bleibt als Historie), `table_name` (eindeutig), `status` (`ok`/`error`/`dropped`), `row_count`, `error_code`, `refreshed_at` |

### Föderation

| Tabelle | Zweck | Wichtige Spalten |
|---|---|---|
| `peer` | Partnerknoten | `node_id` (eindeutig), `display_name`, `base_url`, `public_key`, `fingerprint`, `status` (`pending`/`trusted`/`suspended`), `trusted_at`, `trusted_by`, `last_seen_at`, `last_error`, `previous_public_key` und `previous_key_valid_until` (bisheriger Schlüssel nach einer Rotationsmitteilung des Partners, angenommen bis zu diesem Zeitpunkt; danach geleert), `key_rotated_at` (Migration 0600) |
| `federation_nonce` | Replay-Schutz: gesehene Nachrichten-IDs je Absender (15 min) | `node_id`, `nonce`, `seen_at` |
| `outbox_message` | Ausgangspostfach für signierte Mitteilungen | `peer_id`, `type`, `body` (JSONB, `NoticeBody`: `release_revoked`, `subjects_withdrawn`, `key_rotated`, `audit_checkpoint`), `status` (`pending`/`delivered`/`failed`), `attempts`, `next_attempt_at`, `last_error`, `delivered_at` |
| `exchange_log` | Austauschprotokoll (gesendet und empfangen) | `direction` (`outgoing`/`incoming`), `peer_id`, `peer_node_id`, `release_id` (eigene Freigabe) bzw. `remote_release_id`, `product_ref`, `purpose`, `outcome` (`delivered`/`denied`/`error`), `deny_reason`, `row_count`, `columns`, `subjects` (übermittelte Pseudonyme, nur ausgehend), `data_category` (Datenkategorie bei Lieferung: Kategorie des Datensatzes bzw. `master` für den Athletenkern), `consent_applied` (Einwilligungspflicht bei Lieferung: `true`, wenn nur Personen mit gültiger Einwilligung für Zweck und Kategorie geliefert wurden – Einwilligungspflicht der Freigabe oder besondere Kategorie), `payload_sha256`, `request_id`, `at`. `data_category` und `consent_applied` sind nur bei gelieferten ausgehenden Datenabrufen gesetzt (Migration 0500; für ältere Lieferungen hat die Migration sie bestmöglich aus dem Stand zum Zeitpunkt der Migration nachgetragen, frühere Einstufungen sind nicht bekannt). Ein Einwilligungswiderruf wird gegen diese Angaben geprüft, nicht gegen die heutige Einstufung |
| `received_product` | empfangene Kopie eines Partnerprodukts (je Partner, Freigabe und Zweck) | `peer_id`, `remote_release_id`, `remote_product_id`, `remote_product_slug`, `title`, `purpose`, `columns` (JSONB, `ColumnDef[]`), `product_version`, `special_category`, `release_valid_until`, `status` (`active`/`revoked`/`expired`/`deleted`), `row_count`, `payload_sha256` und `response_signature` (Herkunftsnachweis), `last_pulled_at`, `status_reason` |
| `received_row` | Zeilen der empfangenen Kopie | `received_product_id`, `subject` (Pseudonym; vom Datenhalter freigabebezogen erzeugt, aktuell 32 Hex-Zeichen, siehe [ADR 0009](adr/0009-freigabebezogene-pseudonyme.md)), `data` (JSONB) |

### Audit-Log

| Tabelle | Zweck | Wichtige Spalten |
|---|---|---|
| `audit_log` | nur anhängbares Protokoll mit Hash-Kette | `seq` (lückenlose Position), `at`, `actor_type` (`user`/`peer`/`system`/`anonymous`), `actor_id`, `actor_label`, `action` (`<bereich>.<vorgang>`), `object_type`, `object_id`, `outcome` (`success`/`denied`/`error`), `details` (JSONB, keine Rohdaten), `ip`, `request_id`, `prev_hash`, `hash`, `digest_version` (Version der Hash-Eingabe: 1 = Einträge vor Migration 0620, 2 = alle neuen; nie fallend) |

Datenbankfunktionen und Trigger:

- `audit_log_chain()` (vor `INSERT`): serialisiert Einträge (Advisory-Lock), vergibt `seq`, setzt
  `prev_hash`, `digest_version = 2` und berechnet `hash = SHA-256(audit_digest_input(Zeile))`.
- `audit_digest_input()`: Eingabe des Hashes je `digest_version` – Version 1: Felder mit `|` verbunden
  (`concat_ws`, mehrdeutig); Version 2 (Migration 0620): `'osp-audit-digest@2'` und je Feld `'|'` +
  (`'~'` für `NULL`, sonst UTF-8-Byte-Länge `:` Wert; Hilfsfunktion `audit_digest_field()`), eindeutig
  ([ADR 0006, Nachtrag](adr/0006-db-rollen-audit-hashkette.md)). Die Prüfung im Programm
  (`modules/audit/chain.ts`) rechnet beide Byte für Byte gleich nach.
- `audit_log_immutable()` (vor `UPDATE`/`DELETE`/`TRUNCATE`): bricht mit Fehler ab – das Log ist nur
  anhängbar.
- `audit_verify()`: prüft die gesamte Kette (auch: Version fällt nie zurück); liefert `checked` und
  `first_broken_seq`.

Externe Verankerung ([ADR 0014](adr/0014-externe-verankerung-audit-kette.md), Migrationen 0600, 0610 und
0630). `peer_audit_checkpoint` ist für `mesh_app` nur lesbar und anhängbar; `audit_checkpoint` nur lesbar,
neue eigene Prüfpunkte nur über die Funktion `audit_checkpoint_append()` (`SECURITY DEFINER`, Eigentümer
`mesh_owner`: nur aktuelle Epoche, nur eine vorhandene Laufnummer mit ihrem gespeicherten Hash, `created_at`
setzt die Datenbank); der Epochenverlauf nur lesbar (`grants.sql`; geschrieben nur von Migration und
`restore` als `mesh_owner`). In `node_key_rotation` darf `mesh_app` nur `finished_at` und
`old_private_key_enc` ändern (Spaltenrechte); der Trigger `node_key_rotation_guard` macht `finished_at`
endgültig (nicht vor `rotated_at`) und lässt einen verworfenen bisherigen Schlüssel nicht zurückkehren. Für
`mesh_bi` ist nichts davon zugänglich. Keine personenbezogenen Daten.

| Tabelle | Zweck | Wichtige Spalten |
|---|---|---|
| `audit_chain_epoch` | Epochen der eigenen Audit-Kette: die erste aus der Migration, jede Wiederherstellung beginnt eine neue (die aktuelle ist die mit der höchsten `n`; eine wiederhergestellte Datenbank bringt den Verlauf der Sicherung mit, `restore` trägt danach die neue ein) | `n`, `epoch` (UUID), `started_at`, `reason` (`initial`/`restore`), `previous_epoch`, `restored_seq` (höchste aus der Sicherung übernommene Laufnummer: Einträge bis dahin stammen aus der vorigen Epoche), `backup_sha256`, `backup_created_at`, `pre_restore_epoch`, `pre_restore_seq`, `pre_restore_hash` (Kopf der Kette der ersetzten Datenbank unmittelbar vor der Wiederherstellung, Migration 0630; `null` = leer/unbekannt) |
| `audit_checkpoint` | eigene signierte Prüfpunkte des Kettenkopfs (an alle vertrauenswürdigen Partner gesendet) | `epoch`, `seq` (eindeutig je Epoche), `hash`, `at`, `statement` (exakt signierte Aussage `{format, nodeId, epoch, seq, hash, at}`), `signature`, `public_key`, `trigger` (`schedule`/`manual`/`cli`), `peers` |
| `peer_audit_checkpoint` | von Partnern hinterlegte Prüfpunkte ihrer Audit-Kette | `peer_id`, `epoch` (aus der Aussage; `null` bei Aussagen von Knoten vor Migration 0610), `seq` (eindeutig je Partner und Epoche, `nulls not distinct`; ein zweiter Prüfpunkt mit anderem Hash wird abgewiesen, je Partner, Epoche und signierendem Schlüssel nur steigend, Index `peer_audit_checkpoint_key_order`), `hash`, `checkpoint_at`, `statement`, `signature`, `public_key` (Schlüssel des Partners, mit dem geprüft wurde), `message_id`, `received_at` (Index je Partner für die Grenze `MESH_AUDIT_CHECKPOINT_MAX_PER_DAY`) |

Das **Anker-Profil** (`audit-anchor-profile`) ist keine Tabelle, sondern eine JSON-Datei außerhalb der
Datenbank (`osp-data-mesh/audit-anchor-profile@1`): `nodeId`, `createdAt`, `minPartners`, `keys[]`
(`publicKey`, `fingerprint`, `validFrom`, `validUntil`, `retired`), `epochs[]` (wie `audit_chain_epoch`:
`epoch`, `n`, `startedAt`, `reason`, `previousEpoch`, `restoredSeq`, `backupSha256`, `backupCreatedAt`,
`preRestoreEpoch`, `preRestoreSeq`, `preRestoreHash`; die letzten fünf fehlen in älteren Profilen),
`partners[]` (`nodeId`, `displayName`, `baseUrl`, `publicKey`, `fingerprint`).

## JSON-Strukturen

Die folgenden Strukturen sind im HTTP-Vertrag als zod-Schemas definiert und werden unverändert in den
JSONB-Spalten gespeichert.

### FieldDef (`dataset.fields`)

Felddefinition eines Datensatzes mit Format- und Plausibilitätsregeln.

| Feld | Typ | Bedeutung |
|---|---|---|
| `name` | Text `^[a-z][a-z0-9_]{0,40}$` | technischer Feldname |
| `label` | Text (1–200) | Anzeigename |
| `type` | `string`, `integer`, `number`, `date`, `datetime`, `boolean`, `enum` | Datentyp |
| `unit` | Text, optional | Einheit, z. B. `cm`, `W` |
| `required` | Boolesch (Standard `false`) | Pflichtfeld beim Import |
| `min`, `max` | Zahl, optional | Plausibilitätsgrenzen (inklusive) für `integer`/`number` |
| `enumValues` | Text-Liste, optional | zulässige Werte bei `enum` |
| `description` | Text, optional | Beschreibung |

```json
{ "name": "jump_height_cm", "label": "Sprunghöhe", "type": "number", "unit": "cm",
  "required": true, "min": 5, "max": 120 }
```

### FieldMapping (`connector.mapping`)

Zuordnung einer Quellspalte zu einem Ziel.

| Feld | Typ | Bedeutung |
|---|---|---|
| `source` | Text | Spaltenüberschrift (CSV, Excel) bzw. Punkt-Pfad im JSON-Eintrag (API), z. B. `athlete.id` |
| `target` | `athlete.<feld>`, `athlete.external_id` oder `data.<feld>` | Feld des Athletenkerns (`last_name`, `first_name`, `date_of_birth`, `sport`, `squad_status`, `sex`, `club`, `discipline`), Kennung im Quellsystem oder Feld des Ziel-Datensatzes |
| `transform` | `none`, `trim` (Standard), `upper`, `lower` | einfache Umformung |
| `valueMap` | Objekt Text → Text, optional | Wertübersetzung, z. B. `{"Olympiakader": "OK"}` |
| `defaultValue` | Text, optional | Ersatzwert bei leerer Quelle |

```json
{ "source": "Kader", "target": "athlete.squad_status", "transform": "trim",
  "valueMap": { "Olympiakader": "OK", "Perspektivkader": "PK" } }
```

### ProductColumn (`data_product.columns`)

| Feld | Typ | Bedeutung |
|---|---|---|
| `key` | Text `^[a-z][a-z0-9_]{0,40}$` | Spaltenname im Produkt (und in Exporten, BI-Views, Partnerdaten) |
| `label` | Text (1–200) | Anzeigename |
| `source` | `athlete.<feld>`, `record.observed_at` oder `data.<feld>` | Herkunft: Athletenkern (inkl. abgeleitetem `athlete.birth_year`), Messdatum des Eintrags oder Feld des Datensatzes |

Typ und Einheit einer Spalte ergeben sich aus der Quelle (Felddefinition bzw. Athletenkern).

```json
{ "key": "birth_year", "label": "Geburtsjahr", "source": "athlete.birth_year" }
```

### Condition (`data_product.filters`, `data_release.row_filter`)

Zeilenbedingung; mehrere Bedingungen sind UND-verknüpft.

| Feld | Typ | Bedeutung |
|---|---|---|
| `column` | Text | Produktspalte |
| `op` | `eq`, `neq`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `is_null`, `not_null` | Vergleich |
| `value` | Skalar oder Liste (bei `in`/`nin`); entfällt bei `is_null`/`not_null` | Vergleichswert |

Vergleiche nur zwischen gleichen Typen (Zahl/Zahl, Text/Text inkl. ISO-Datum, Boolesch/Boolesch);
`null` erfüllt nur `is_null`. Details: [Freigaberegeln](freigaberegeln.md#zeilenregeln).

```json
[ { "column": "squad_status", "op": "in", "value": ["OK", "PK"] },
  { "column": "measured_at", "op": "gte", "value": "2026-01-01" } ]
```

### Weitere Strukturen

- `ColumnDef` (`received_product.columns`, Antworten): `{ key, label, type, unit? }` – Spaltenbeschreibung,
  wie Empfänger sie sehen.
- `connector.config`: CSV (`delimiter`, `encoding`, `decimalSeparator`, `dateFormat`), Excel (`type: "xlsx"`,
  `sheet` – Name des Tabellenblatts, leer = erstes Blatt; `headerRow` – Kopfzeile ist die erste nicht leere
  Zeile ab dieser Zeilennummer; `decimalSeparator` und `dateFormat` für Werte, die als Text gespeichert sind,
  Standard Komma und `DD.MM.YYYY`) oder HTTP-API (`url`, `itemsPath`, `auth` ohne Geheimnis, `pagination`,
  `query`, `dateFormat`, `timeoutMs`). `auth` ist `none`, `bearer`, `header` (`headerName`) oder
  `oauth2_client_credentials` (`tokenUrl`, `clientId`, optional `scope`, `audience`, `clientAuth`
  `basic`/`body`); das Geheimnis steht nie in `config`, sondern verschlüsselt in `secret_enc`.
  OAuth2-Zugriffstoken werden nicht gespeichert (nur im Arbeitsspeicher des Knotens, siehe
  [Sicherheit](sicherheit.md#schutz-vor-server-side-request-forgery-ssrf)).
- `outbox_message.body`: `NoticeBody` des [Föderationsprotokolls](protokoll.md#nachrichten)
  (`release_revoked` oder `subjects_withdrawn`).

## BI-Views

Für jede gültige Freigabe an die Rolle `bi` legt der Server eine Tabelle `bi_data.r_<id>` (`r_` und die
ersten 12 Hex-Zeichen der Freigabe-ID) mit den freigegebenen Zeilen und eine View `bi.<produktkürzel>`
mit den freigegebenen Spalten an. Die Tabelle enthält zusätzlich die **verborgene Spalte `_subject`**
(`uuid`, ID der Person; leer bei Zeilen ohne Personenbezug), die nie in der View erscheint: Über sie
entfernen Einwilligungswiderruf und Löschung die Zeilen einer Person in der auslösenden Transaktion. Spaltentypen:
`string`/`enum` → `text`, `integer` → `bigint`, `number` → `double precision`, `date` → `date`, `datetime`
→ `timestamptz`, `boolean` → `boolean`. Jede View prüft bei jeder Abfrage, ob die Freigabe noch gilt
(SQL-Zeitwächter, [ADR 0007](adr/0007-bi-materialisierung-zeitwaechter.md)). Siehe [BI-Anbindung](bi.md).

## Migrationen

- Dateien `NNNN_name.sql`, jede in einer eigenen Transaktion, ausgeführt als `mesh_owner` mit
  `bun --env-file=.env --env-file=.env.owner run cli migrate` (nativ; Docker: Dienst `migrate`), nie
  durch den Server.
- **Nur vorwärts:** keine Rückwärtsmigrationen; Prüfsumme jeder angewandten Datei wird verglichen.
- Nach jedem Lauf wird `grants.sql` (idempotent) ausgeführt.
- Der Server meldet über `/readyz` (`schema: false`), wenn Migrationen fehlen.
- Vorhandene Migrationen: `0001_core.sql` (Grundschema), `0300_bi_view_names.sql` (ersetzt die
  Eindeutigkeit von `bi_view.view_name` durch den partiellen Index `bi_view_view_name_live` über nicht
  entfernte Views), `0500_exchange_delivery_basis.sql` (Spalten `data_category` und `consent_applied` im
  Austauschprotokoll: Einstufung, unter der eine Lieferung an einen Partner erfolgte),
  `0600_node_key_rotation_audit_anchor.sql` (Wechsel des Knotenschlüssels: `node_key_rotation`,
  `node_key_rotation_peer`, Spalten `previous_public_key`, `previous_key_valid_until`, `key_rotated_at` in
  `peer`; Prüfpunkte der Audit-Kette: `audit_checkpoint`, `peer_audit_checkpoint`),
  `0610_audit_anchor_epochs.sql` (Epochen der Audit-Kette `audit_chain_epoch` mit erster Epoche; Spalte
  `epoch` in `audit_checkpoint` und `peer_audit_checkpoint`, Eindeutigkeit je Epoche, Index für die
  Ratenbegrenzung), `0620_audit_digest_v2.sql` (Spalte `audit_log.digest_version`, eindeutige Hash-Eingabe
  Version 2 für neue Einträge, `audit_digest_field()`, `audit_verify()` mit Versionsprüfung),
  `0630_audit_anchor_hardening.sql` (`audit_checkpoint_append()`, Kopf vor der Wiederherstellung in
  `audit_chain_epoch` samt Nachtrag aus `backup.restore`, Trigger `node_key_rotation_guard`, Index für die
  Reihenfolge je Schlüssel beim Partner).
