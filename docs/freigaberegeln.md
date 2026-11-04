# Freigabe- und Einwilligungsregeln

Die Regeln sind in `src/server/modules/releases/engine.ts` als reine Funktionen umgesetzt und in
`tests/unit/release-engine.test.ts` vollständig getestet. Jede Datenausgabe – Abruf in der Oberfläche,
Export (CSV/JSON/XML), REST-Abruf durch Werkzeuge, BI-Schnittstelle, Abruf durch Partnerknoten – läuft über
den **Policy Enforcement Point** (`services.pep.serve`), der diese Regeln anwendet.

## Grundsatz: deny by default

Ohne passende, gültige Freigabe werden keine Daten ausgegeben. Jede fehlende oder unklare Angabe führt zur
Ablehnung (z. B. unbekannter Zweck, fehlendes Datum bei Zeitbeschränkung, fehlende Einwilligung).
Neue Spalten eines Produkts sind nicht automatisch freigegeben. Administration und Revision haben keinen
impliziten Datenzugriff.

## Freigabe

Eine Freigabe verbindet **ein Datenprodukt** mit **einem Empfänger**:

| Empfänger | Bedeutung |
|---|---|
| Rolle `analyst`, `coach`, `data_steward`, `auditor` | Personen dieses Knotens mit der Rolle |
| Rolle `bi` | BI-Schnittstelle (Schema `bi`, read-only Datenbankrolle); genau ein Zweck |
| Partnerknoten | ein vertrauenswürdiger anderer Knoten (per Knotenkarte aufgenommen) |

und beschränkt die Daten in allen geforderten Dimensionen:

| Dimension | Feld | Regel |
|---|---|---|
| Spalten | `columns` | nur diese Produktspalten (Schnittmenge, Reihenfolge des Produkts) |
| Zeilen | `rowFilter` | alle Bedingungen müssen gelten (UND); auch auf nicht freigegebene Spalten |
| Datenzeitraum | `dataFrom`/`dataUntil` | Beobachtungsdatum innerhalb (inklusive); Zeilen ohne Datum entfallen |
| Gültigkeit | `validFrom`/`validUntil` | Zugriff nur im Zeitraum (`validUntil` exklusiv) |
| Zweck | `purposes` | Anfrage muss einen der Zwecke angeben (Zweckbindung) |
| Einwilligung | `requiresConsent` | nur Personen mit gültiger Einwilligung für Zweck und Datenkategorie |

## Prüfreihenfolge (Ablehnungsgründe)

1. `release_not_found` – Freigabe existiert nicht
2. `product_mismatch` – Freigabe gehört nicht zum Produkt
3. `recipient_mismatch` – Anfragende sind nicht Empfänger (vor allen weiteren Prüfungen: Nicht-Empfänger
   erfahren nichts über Status oder Gültigkeit)
4. `peer_not_trusted` – Partner ist ausstehend oder gesperrt
5. `revoked` – widerrufen
6. `not_yet_valid` / `expired` – außerhalb der Gültigkeit
7. `product_inactive` – Produkt stillgelegt
8. `product_changed` – Produkt wurde nach der Freigabe geändert (Version); Freigabe muss neu erteilt werden
9. `not_shareable` – internes Produkt an Partner
10. `purpose_not_allowed` – Zweck nicht freigegeben
11. `special_category_requires_consent` – Art.-9-Daten ohne Einwilligungspflicht (Verteidigung in der Tiefe)
12. `no_columns` – keine der freigegebenen Spalten existiert noch

Partnerknoten erhalten für 1–3 einheitlich `not_found`, damit Freigabe-IDs nicht ausgespäht werden können.

## Zeilenregeln

Reihenfolge je Zeile: Datenzeitraum → Zeilenbeschränkung → Einwilligung → Spaltenprojektion.

**Bedingungen**: `eq`, `neq`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `is_null`, `not_null`.
Vergleiche nur zwischen gleichen Typen (Zahl/Zahl, Text/Text inkl. ISO-Datum, Boolesch/Boolesch).
`null` und fehlende Spalten erfüllen nur `is_null` (fehlende Spalten nicht einmal das).

**Einwilligung** (wenn gefordert oder bei besonderen Kategorien immer): Es muss ein Eintrag existieren mit
Status `granted`, Zweck = angefragter Zweck oder `*`, Kategorie = Datenkategorie des Produkts oder `*`,
`validFrom ≤ Stichtag ≤ validUntil` (Stichtag in Europe/Berlin, Grenzen inklusive). Widerrufene Einträge
zählen nicht. Zeilen ohne Personenbezug können keine Einwilligung nachweisen und entfallen.

## Besondere Kategorien (Art. 9 DSGVO)

Datensätze der Kategorie `health` sind immer besondere Kategorie (Datenbank-Constraint); andere können
so markiert werden. Freigaben solcher Produkte **müssen** `requiresConsent = true` haben (Prüfung beim
Erteilen und nochmals bei jeder Ausgabe).

## Erteilen, Ändern, Widerrufen

- Beim Erteilen prüft `validateRelease` alle Angaben gegen das Produkt (Spalten, Filtertypen, Zwecke,
  Zeitfenster, Teilbarkeit, Art. 9). Die Vorschau (`releases.preview`) zeigt vorab die Wirkung.
- Freigaben sind unveränderlich. Änderung = neue Freigabe erteilen, alte widerrufen.
- Ändert sich ein Produkt (Spalten/Filter), werden bestehende Freigaben "veraltet" (`product_changed`)
  und liefern nichts mehr, bis sie neu erteilt sind. So kann eine Produktänderung nie unbemerkt mehr
  Daten freigeben.
- Widerruf wirkt sofort für künftige Abrufe. Bei Partnerfreigaben wird eine signierte Widerrufsmitteilung
  über das Ausgangspostfach zugestellt (mit Wiederholung); der Empfänger löscht seine Kopie. Siehe
  [Widerruf und Weitergabe](widerruf-und-weitergabe.md).
