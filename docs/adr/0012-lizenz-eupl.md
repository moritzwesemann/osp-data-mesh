# ADR 0012: Lizenz EUPL-1.2 (vorläufig)

## Status

angenommen (vorläufig)

Datum: 2026-11-04

## Kontext

Die Ausschreibung verlangt eine Open-Source-Lizenz gemäß den Vorgaben von openCode (U11) und
Anbieterunabhängigkeit. Alle ausgelieferten Drittkomponenten stehen unter freizügigen Lizenzen (MIT, ISC,
BSD, Apache-2.0; siehe [Lizenzen](../lizenzen.md)). Zur Wahl standen u. a. EUPL-1.2, Apache-2.0, MIT und
AGPL-3.0.

## Entscheidung

Das Projekt steht **vorläufig** unter der **European Union Public Licence 1.2 (EUPL-1.2)**
(`LICENSE`, `package.json`):

- von der EU-Kommission herausgegeben, in allen EU-Amtssprachen rechtsgleich verfügbar (auch Deutsch);
- Copyleft mit Kompatibilitätsklausel (Weiterentwicklungen bleiben offen, Kombination mit anderen
  Open-Source-Lizenzen möglich); deckt auch die Bereitstellung über ein Netzwerk ab;
- verbreitet im öffentlichen Sektor und mit openCode vereinbar.

Die **endgültige Lizenzentscheidung trifft Moritz vor jeder Veröffentlichung**; bis dahin wird der Code
nicht veröffentlicht.

## Konsequenzen

- Alle verwendeten Drittlizenzen sind mit der EUPL-1.2 vereinbar; die Lizenzseite und die SBOM werden mit
  `bun scripts/licenses.ts` bzw. `bun run sbom` aktuell gehalten.
- Bei einer anderen Lizenzwahl sind `LICENSE`, `package.json` (`license`), Lizenzseite, SBOM und diese ADR
  anzupassen (neue ADR, diese als „ersetzt“ markieren).
