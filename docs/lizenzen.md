# Drittkomponenten und Lizenzen

> Diese Seite wird mit `bun scripts/licenses.ts` aus `bun.lock` und den `package.json`-Dateien unter
> `node_modules` erzeugt. Bitte nicht von Hand bearbeiten, sondern nach jeder Abhängigkeitsänderung neu
> erzeugen. Die maschinenlesbare Stückliste (SBOM, CycloneDX) liegt unter `sbom/osp-data-mesh.cdx.json`
> (`bun run sbom`, siehe [Sicherheitskonzept](sicherheit.md#sbom-und-bsi-tr-03183-2)).

## Lizenz des Projekts

osp-data-mesh 0.1.0 steht **vorläufig** unter der **European Union Public Licence
1.2 (EUPL-1.2)** (Datei `LICENSE`).
Die EUPL ist eine von der EU-Kommission herausgegebene, OSI-anerkannte Copyleft-Lizenz mit
Kompatibilitätsklausel und erfüllt die Anforderungen von openCode an Open-Source-Lizenzen.

**Die endgültige Lizenzwahl steht noch aus** und wird vor jeder Veröffentlichung durch den
Auftraggeber bzw. Moritz getroffen (siehe [ADR 0012](adr/0012-lizenz-eupl.md)).

## Zusammenfassung

- Pakete insgesamt (direkt und transitiv, laut `bun.lock`): **111**
- davon zur Laufzeit ausgeliefert (Server oder gebündelt in der Web-Oberfläche): **27**
- davon nur für Build und Entwicklung: **84**
- Pakete ohne ermittelbare Lizenz: **0**

| Lizenz | Anzahl Pakete |
|---|---|
| MIT | 61 |
| Apache-2.0 | 23 |
| MPL-2.0 | 12 |
| MIT OR Apache-2.0 | 11 |
| ISC | 3 |
| BSD-3-Clause | 1 |

Alle zur Laufzeit ausgelieferten npm-Pakete stehen unter freizügigen Lizenzen (MIT, ISC, BSD, Apache-2.0),
die mit der EUPL-1.2 vereinbar sind. Die MPL-2.0 (`lightningcss`) betrifft nur ein Build-Werkzeug,
das nicht ausgeliefert wird. Eine abschließende rechtliche Prüfung der Lizenzkompatibilität vor einer
Veröffentlichung wird empfohlen.

## Zur Laufzeit ausgelieferte Pakete

"Server (Laufzeit)" = im Container bzw. auf dem Server installiert (`bun install --production`).
"Web-Oberfläche (gebündelt)" = in die ausgelieferten JavaScript-Dateien unter `dist/ui` übernommen.

| Paket | Version | Lizenz | Verwendung | Art |
|---|---|---|---|---|
| `@remix-run/route-pattern` | 0.22.1 | MIT | Web-Oberfläche (gebündelt) | transitiv |
| `@tanstack/query-core` | 5.106.0 | MIT | Web-Oberfläche (gebündelt) | transitiv |
| `@tanstack/react-query` | 5.106.0 | MIT | Web-Oberfläche (gebündelt) | direkt |
| `cookie-es` | 3.1.1 | MIT | Web-Oberfläche (gebündelt) | transitiv |
| `fflate` | 0.8.3 | MIT | Server (Laufzeit) | direkt |
| `hono` | 4.13.16 | MIT | Server (Laufzeit) | direkt |
| `kysely` | 0.29.8 | MIT | Server (Laufzeit) | direkt |
| `papaparse` | 5.7.0 | MIT | Server (Laufzeit) | direkt |
| `pg` | 8.23.1 | MIT | Server (Laufzeit) | direkt |
| `pg-cloudflare` | 1.4.1 | MIT | Server (Laufzeit) | transitiv |
| `pg-connection-string` | 2.14.1 | MIT | Server (Laufzeit) | transitiv |
| `pg-int8` | 1.0.1 | ISC | Server (Laufzeit) | transitiv |
| `pg-pool` | 3.14.0 | MIT | Server (Laufzeit) | transitiv |
| `pg-protocol` | 1.16.1 | MIT | Server (Laufzeit) | transitiv |
| `pg-types` | 2.2.0 | MIT | Server (Laufzeit) | transitiv |
| `pgpass` | 1.0.5 | MIT | Server (Laufzeit) | transitiv |
| `postgres-array` | 2.0.0 | MIT | Server (Laufzeit) | transitiv |
| `postgres-bytea` | 1.0.1 | MIT | Server (Laufzeit) | transitiv |
| `postgres-date` | 1.0.7 | MIT | Server (Laufzeit) | transitiv |
| `postgres-interval` | 1.2.0 | MIT | Server (Laufzeit) | transitiv |
| `react` | 19.3.1 | MIT | Web-Oberfläche (gebündelt) | direkt |
| `react-dom` | 19.3.1 | MIT | Web-Oberfläche (gebündelt) | direkt |
| `react-router` | 8.5.1 | MIT | Web-Oberfläche (gebündelt) | direkt |
| `scheduler` | 0.28.0 | MIT | Web-Oberfläche (gebündelt) | transitiv |
| `split2` | 4.2.0 | ISC | Server (Laufzeit) | transitiv |
| `xtend` | 4.0.2 | MIT | Server (Laufzeit) | transitiv |
| `zod` | 4.6.7 | MIT | Server (Laufzeit), Web-Oberfläche (gebündelt) | direkt |

## Copyright-Vermerke der ausgelieferten Pakete

Aus den Dateien `LICENSE`/`COPYING`/`NOTICE` der installierten Pakete gelesen (auch in der SBOM im Feld
`copyright` je Komponente). Die Lizenztexte selbst liegen in `node_modules/<paket>/`; bei einer
Weitergabe der gebündelten Web-Oberfläche sind Vermerk und Lizenztext der MIT-/ISC-/BSD-Pakete beizufügen.

| Paket | Version | Copyright-Vermerk |
|---|---|---|
| `@remix-run/route-pattern` | 0.22.1 | Copyright (c) 2025 Shopify Inc. |
| `@tanstack/query-core` | 5.106.0 | Copyright (c) 2021-present Tanner Linsley |
| `@tanstack/react-query` | 5.106.0 | Copyright (c) 2021-present Tanner Linsley |
| `cookie-es` | 3.1.1 | Copyright (c) 2012-2014 Roman Shtylman <shtylman@gmail.com><br>Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com><br>Copyright (c) 2015 Nathan Friedly <nathan@nfriedly.com> (http://nfriedly.com/) |
| `fflate` | 0.8.3 | Copyright (c) 2026 Arjun Barrett |
| `hono` | 4.13.16 | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors |
| `kysely` | 0.29.8 | Copyright (c) 2022 Sami Koskimäki |
| `papaparse` | 5.7.0 | Copyright (c) 2015 Matthew Holt |
| `pg` | 8.23.1 | Copyright (c) 2010 - 2021 Brian Carlson |
| `pg-cloudflare` | 1.4.1 | Copyright (c) 2010 - 2021 Brian Carlson |
| `pg-connection-string` | 2.14.1 | Copyright (c) 2014 Iced Development |
| `pg-int8` | 1.0.1 | Copyright © 2017, Charmander <~@charmander.me> |
| `pg-pool` | 3.14.0 | Copyright (c) 2017 Brian M. Carlson |
| `pg-protocol` | 1.16.1 | Copyright (c) 2010 - 2021 Brian Carlson |
| `pg-types` | 2.2.0 | *kein Vermerk in den Lizenzdateien des Pakets* |
| `pgpass` | 1.0.5 | *kein Vermerk in den Lizenzdateien des Pakets* |
| `postgres-array` | 2.0.0 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) |
| `postgres-bytea` | 1.0.1 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) |
| `postgres-date` | 1.0.7 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) |
| `postgres-interval` | 1.2.0 | Copyright (c) Ben Drucker <bvdrucker@gmail.com> (bendrucker.me) |
| `react` | 19.3.1 | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `react-dom` | 19.3.1 | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `react-router` | 8.5.1 | Copyright (c) React Training LLC 2015-2019<br>Copyright (c) Remix Software Inc. 2020-2021<br>Copyright (c) Shopify Inc. 2022-2023 |
| `scheduler` | 0.28.0 | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `split2` | 4.2.0 | Copyright (c) 2014-2018, Matteo Collina <hello@matteocollina.com> |
| `xtend` | 4.0.2 | Copyright (c) 2012-2014 Raynos. |
| `zod` | 4.6.7 | Copyright (c) 2025 Colin McDonnell |

## Nur für Build und Entwicklung

Diese Pakete werden zum Bauen, Prüfen und Testen verwendet und nicht ausgeliefert. Plattformspezifische
Binärpakete für andere Betriebssysteme sind im Lockfile verzeichnet, aber nur für die jeweilige Plattform
installiert; ihre Lizenz wurde vom einbindenden Paket übernommen.

| Paket | Version | Lizenz | Verwendung | Art |
|---|---|---|---|---|
| `@biomejs/biome` | 2.6.5 | MIT OR Apache-2.0 | Build/Entwicklung | direkt |
| `@biomejs/cli-android-arm64` | 2.6.5 | MIT OR Apache-2.0 (übernommen von @biomejs/biome@2.6.5) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@biomejs/cli-android-x64` | 2.6.5 | MIT OR Apache-2.0 (übernommen von @biomejs/biome@2.6.5) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@biomejs/cli-darwin-arm64` | 2.6.5 | MIT OR Apache-2.0 | Build/Entwicklung | transitiv, plattformspezifisch |
| `@biomejs/cli-darwin-x64` | 2.6.5 | MIT OR Apache-2.0 (übernommen von @biomejs/biome@2.6.5) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@biomejs/cli-linux-arm64` | 2.6.5 | MIT OR Apache-2.0 (übernommen von @biomejs/biome@2.6.5) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@biomejs/cli-linux-arm64-musl` | 2.6.5 | MIT OR Apache-2.0 (übernommen von @biomejs/biome@2.6.5) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@biomejs/cli-linux-x64` | 2.6.5 | MIT OR Apache-2.0 (übernommen von @biomejs/biome@2.6.5) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@biomejs/cli-linux-x64-musl` | 2.6.5 | MIT OR Apache-2.0 (übernommen von @biomejs/biome@2.6.5) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@biomejs/cli-win32-arm64` | 2.6.5 | MIT OR Apache-2.0 (übernommen von @biomejs/biome@2.6.5) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@biomejs/cli-win32-x64` | 2.6.5 | MIT OR Apache-2.0 (übernommen von @biomejs/biome@2.6.5) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@oxc-project/types` | 0.156.0 | MIT | Build/Entwicklung | transitiv |
| `@rolldown/binding-android-arm-eabi` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-android-arm64` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-darwin-arm64` | 1.2.16 | MIT | Build/Entwicklung | transitiv, plattformspezifisch |
| `@rolldown/binding-darwin-x64` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-freebsd-x64` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-linux-arm-gnueabihf` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-linux-arm64-gnu` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-linux-arm64-musl` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-linux-ppc64-gnu` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-linux-s390x-gnu` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-linux-x64-gnu` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-linux-x64-musl` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-openharmony-arm64` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-win32-arm64-msvc` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/binding-win32-x64-msvc` | 1.2.16 | MIT (übernommen von rolldown@1.2.16) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@rolldown/pluginutils` | 1.0.1 | MIT | Build/Entwicklung | transitiv |
| `@types/bun` | 1.4.4 | MIT | Build/Entwicklung | direkt |
| `@types/node` | 26.6.6 | MIT | Build/Entwicklung | transitiv |
| `@types/papaparse` | 5.5.2 | MIT | Build/Entwicklung | direkt |
| `@types/pg` | 8.23.1 | MIT | Build/Entwicklung | direkt |
| `@types/react` | 19.3.0 | MIT | Build/Entwicklung | direkt |
| `@types/react-dom` | 19.3.0 | MIT | Build/Entwicklung | direkt |
| `@typescript/typescript-aix-ppc64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-darwin-arm64` | 7.0.2 | Apache-2.0 | Build/Entwicklung | transitiv, plattformspezifisch |
| `@typescript/typescript-darwin-x64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-freebsd-arm64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-freebsd-x64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-linux-arm` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-linux-arm64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-linux-loong64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-linux-mips64el` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-linux-ppc64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-linux-riscv64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-linux-s390x` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-linux-x64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-netbsd-arm64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-netbsd-x64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-openbsd-arm64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-openbsd-x64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-sunos-x64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-win32-arm64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@typescript/typescript-win32-x64` | 7.0.2 | Apache-2.0 (übernommen von typescript@7.0.2) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `@vitejs/plugin-react` | 6.2.1 | MIT | Build/Entwicklung | direkt |
| `bun-types` | 1.4.4 | MIT | Build/Entwicklung | transitiv |
| `csstype` | 3.2.3 | MIT | Build/Entwicklung | transitiv |
| `detect-libc` | 2.1.2 | Apache-2.0 | Build/Entwicklung | transitiv |
| `fdir` | 6.5.0 | MIT | Build/Entwicklung | transitiv |
| `fsevents` | 2.3.3 | MIT | Build/Entwicklung | transitiv, plattformspezifisch |
| `lightningcss` | 1.33.0 | MPL-2.0 | Build/Entwicklung | transitiv |
| `lightningcss-android-arm64` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `lightningcss-darwin-arm64` | 1.33.0 | MPL-2.0 | Build/Entwicklung | transitiv, plattformspezifisch |
| `lightningcss-darwin-x64` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `lightningcss-freebsd-x64` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `lightningcss-linux-arm-gnueabihf` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `lightningcss-linux-arm64-gnu` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `lightningcss-linux-arm64-musl` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `lightningcss-linux-x64-gnu` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `lightningcss-linux-x64-musl` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `lightningcss-win32-arm64-msvc` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `lightningcss-win32-x64-msvc` | 1.33.0 | MPL-2.0 (übernommen von lightningcss@1.33.0) | Build/Entwicklung | transitiv, plattformspezifisch, hier nicht installiert |
| `marked` | 18.1.3 | MIT | Build/Entwicklung | direkt |
| `nanoid` | 3.3.20 | MIT | Build/Entwicklung | transitiv |
| `picocolors` | 1.1.1 | ISC | Build/Entwicklung | transitiv |
| `picomatch` | 4.0.7 | MIT | Build/Entwicklung | transitiv |
| `playwright-core` | 1.61.1 | Apache-2.0 | Build/Entwicklung | direkt |
| `postcss` | 8.5.32 | MIT | Build/Entwicklung | transitiv |
| `rolldown` | 1.2.16 | MIT | Build/Entwicklung | transitiv |
| `source-map-js` | 1.2.2 | BSD-3-Clause | Build/Entwicklung | transitiv |
| `tinyglobby` | 0.2.17 | MIT | Build/Entwicklung | transitiv |
| `typescript` | 7.0.2 | Apache-2.0 | Build/Entwicklung | direkt |
| `undici-types` | 8.9.0 | MIT | Build/Entwicklung | transitiv |
| `vite` | 8.3.5 | MIT | Build/Entwicklung | direkt |

## Komponenten außerhalb von npm

Nicht automatisch erfasst (nicht in `bun.lock`), aber für Betrieb bzw. Container-Bereitstellung verwendet:

| Komponente | Verwendung | Lizenz | Bezugsquelle |
|---|---|---|---|
| Bun (Laufzeitumgebung) | Server, CLI, Build | MIT (enthält Komponenten unter weiteren Lizenzen, u. a. JavaScriptCore: LGPL-2.1) | https://bun.sh |
| PostgreSQL 18 (Server, Client-Werkzeuge pg_dump/pg_restore/psql) | Datenbank, Sicherung | PostgreSQL | https://www.postgresql.org |
| Caddy 2 | TLS-Reverse-Proxy | Apache-2.0 | https://caddyserver.com |
| Container-Basisabbilder oven/bun (Debian), postgres, caddy | Container-Betrieb | je Abbild verschieden (Debian-Pakete: überwiegend GPL/LGPL/BSD/MIT) | Docker Hub |
| Apache Superset (optional, Profil „bi“) | BI-Referenz-Dashboards | Apache-2.0 | https://superset.apache.org |
| psycopg2-binary (optional, im Superset-Abbild) | PostgreSQL-Treiber für Superset | LGPL-3.0-or-later (mit Ausnahmen) | https://www.psycopg.org |

Die Betriebssystempakete des Container-Abbilds beschreibt eine eigene Abbild-SBOM
(`sbom/osp-data-mesh.image.cdx.json`, Befehl in [Betrieb](betrieb.md)); die gebaute Web-Oberfläche die
Build-SBOM (`bun run sbom -- build-ui`, siehe [Sicherheitskonzept](sicherheit.md#sbom-und-bsi-tr-03183-2)).
