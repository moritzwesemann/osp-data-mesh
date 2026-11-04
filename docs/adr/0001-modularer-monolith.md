# ADR 0001: Modularer Monolith je Knoten

## Status

angenommen

Datum: 2026-11-04

## Kontext

Jeder Olympiastützpunkt betreibt einen eigenen Knoten, häufig ohne eigenes Entwicklungsteam und mit
begrenzten Betriebsressourcen (Anforderungen K1, K2, K6). Der Funktionsumfang ist breit (Import,
Katalog, Datenprodukte, Freigaben, Föderation, BI, Audit), das Mengengerüst je OSP aber klein (tausende,
nicht Millionen Datensätze). Alternativen waren Microservices je Fachbereich oder ein einzelnes Programm
ohne innere Struktur.

## Entscheidung

Ein Knoten ist ein **modularer Monolith**: ein Server-Prozess mit einer PostgreSQL-Datenbank, der
Oberfläche, REST-API, Föderationsprotokoll und Hilfe ausliefert. Fachlich ist er in Module gegliedert
(`auth`, `audit`, `system`, `athletes`, `datasets`, `connectors`, `products`, `releases`, `bi`, `catalog`,
`federation`) mit klaren Regeln:

- jedes Modul schreibt nur in eigene Tabellen;
- Querbeziehungen über definierte Dienste (`deps.services`, z. B. der Policy Enforcement Point) oder
  Ereignisse (`deps.events`, in derselben Transaktion oder nach dem Commit);
- alle HTTP-Routen stehen im gemeinsamen Vertrag ([ADR 0002](0002-stack-bun-hono-kysely-react.md)).

## Konsequenzen

- Einfacher Betrieb: ein Prozess, eine Datenbank, ein Container; Transaktionen über Modulgrenzen ohne
  verteilte Protokolle (z. B. Widerruf + Audit-Eintrag + Ausgangspostfach atomar).
- Module können später herausgelöst werden, weil sie nur über Dienste und Ereignisse kommunizieren.
- Skalierung nur vertikal bzw. durch mehrere Knoten; für das Mengengerüst ausreichend.
- Disziplin bei Modulgrenzen ist nötig (Code-Review, Architekturdokumentation).
