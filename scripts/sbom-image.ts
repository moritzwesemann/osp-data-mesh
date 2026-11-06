/**
 * SBOM des Container-Abbilds (CycloneDX-Lebenszyklus "post-build"): cdxgen beschreibt das gebaute Abbild,
 * dieses Skript ergänzt, was cdxgen dort nicht liefert.
 *
 *   bun run sbom -- image <abbild>                    cdxgen -t docker <abbild>, Anreicherung, Prüfung
 *                                                      → sbom/osp-data-mesh.image.cdx.json
 *   bun run sbom -- image <abbild> --input <datei>    vorhandene cdxgen-Ausgabe anreichern (cdxgen nicht ausführen)
 *   bun run sbom -- image <abbild> --output <datei>   anderer Ausgabepfad
 *   (dazu wie bei der Quell-SBOM: --sign-key <pem> bzw. OSP_SBOM_SIGNING_KEY, --no-validate, --release)
 *
 * Ergänzt wird:
 *  - Lizenzen der Debian-Pakete aus /usr/share/doc/<paket>/copyright im Abbild (maschinenlesbares Format
 *    DEP-5): die Lizenzfelder aller Files-Absätze, nach SPDX abgebildet (SPDX-Ausdruck; nicht abbildbare
 *    Namen als LicenseRef-Debian-…), `acknowledgement: declared`. Quellpakete erhalten die Lizenzen ihrer
 *    Binärpakete (Zuordnung über dpkg-query im Abbild);
 *  - Version, Lizenz, Hersteller und SHA-512 der Bun-Binärdatei (Version aus `bun --version` im Abbild,
 *    abgeglichen mit `ARG BUN_VERSION` in deploy/Dockerfile);
 *  - Metadaten wie in der Quell-SBOM: SBOM-Ersteller, Hersteller, Lieferant, Sicherheitskontakt
 *    (sbom/sbom.config.json), dazu Signatur mit dem Projektschlüssel.
 *
 * Docker muss erreichbar sein (mit Colima: DOCKER_HOST=unix://$HOME/.colima/default/docker.sock).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildInventory, ROOT } from './licenses.ts';
import {
  applyMetadata,
  type Bom,
  bunVersionFromDockerfile,
  CDXGEN,
  type CdxComponent,
  describeProjectComponent,
  displayPath,
  type LicenseChoice,
  loadConfig,
  placeholderFindings,
  platformComponents,
  type SbomConfig,
  setProperty,
  signAndWrite,
  TR_VERSION,
  validate,
  warnPlaceholders,
} from './sbom.ts';

export const IMAGE_OUT_FILE = join(ROOT, 'sbom', 'osp-data-mesh.image.cdx.json');

// ---------------------------------------------------------------------------------------------------
// DEP-5 (https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/)

export interface Dep5 {
  /** Datei im maschinenlesbaren Format (Kopfabsatz mit Format: …copyright-format/1.0 bzw. dep5) */
  machineReadable: boolean;
  /** Lizenzfelder (erste Zeile, Kurzname bzw. Ausdruck) der Files-Absätze, ohne Duplikate, in Reihenfolge */
  licenses: string[];
}

/** Zerlegt eine Steuerdatei im Debian-Format in Absätze (Feldname klein → Wert, Folgezeilen angehängt). */
export function parseControlParagraphs(text: string): Map<string, string>[] {
  const paragraphs: Map<string, string>[] = [];
  let current: Map<string, string> | null = null;
  let last: string | null = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) {
      if (current?.size) paragraphs.push(current);
      current = null;
      last = null;
      continue;
    }
    if (/^[ \t]/.test(raw)) {
      if (current && last) current.set(last, `${current.get(last)}\n${raw.trim()}`);
      continue;
    }
    if (raw.startsWith('#')) continue;
    const m = raw.match(/^([!-9;-~][!-9;-~]*):[ \t]*(.*)$/);
    if (!m) continue; // keine Feldzeile (z. B. Freitext in nicht maschinenlesbaren Dateien)
    current ??= new Map();
    last = m[1]!.toLowerCase();
    current.set(last, m[2]!.trim());
  }
  if (current?.size) paragraphs.push(current);
  return paragraphs;
}

export function parseDep5(text: string): Dep5 {
  const paragraphs = parseControlParagraphs(text);
  const header = paragraphs[0];
  const format = header?.get('format') ?? '';
  const machineReadable = /copyright-format\/1\.0|\bdep-?5\b/i.test(format);
  if (!machineReadable) return { machineReadable, licenses: [] };
  const firstLine = (v: string | undefined) => (v ?? '').split('\n')[0]!.trim();
  const fromFiles = paragraphs
    .filter((p) => p.has('files') && p.has('license'))
    .map((p) => firstLine(p.get('license')))
    .filter(Boolean);
  // ohne Files-Absätze: Lizenz des Kopfabsatzes (Zusammenfassung für das ganze Paket)
  const licenses = fromFiles.length ? fromFiles : [firstLine(header?.get('license'))].filter(Boolean);
  return { machineReadable, licenses: [...new Set(licenses)] };
}

// ---------------------------------------------------------------------------------------------------
// Abbildung der Debian-Kurznamen auf SPDX

/** Debian-Kurzname (klein geschrieben) → SPDX-Kennung, soweit eindeutig. */
const DEBIAN_TO_SPDX: Record<string, string> = {
  'apache-2': 'Apache-2.0',
  'apache-2.0': 'Apache-2.0',
  artistic: 'Artistic-1.0-Perl', // /usr/share/common-licenses/Artistic = Artistic License der Perl-Distribution
  'artistic-1': 'Artistic-1.0-Perl',
  'artistic-2': 'Artistic-2.0',
  'artistic-2.0': 'Artistic-2.0',
  'bsd-2-clause': 'BSD-2-Clause',
  'bsd-3-clause': 'BSD-3-Clause',
  'bsd-4-clause': 'BSD-4-Clause',
  'bsd-4-clause-uc': 'BSD-4-Clause-UC',
  beerware: 'Beerware',
  'bsl-1.0': 'BSL-1.0',
  'boost-1.0': 'BSL-1.0',
  cc0: 'CC0-1.0',
  'cc0-1.0': 'CC0-1.0',
  'cc-by-3.0': 'CC-BY-3.0',
  'cc-by-4.0': 'CC-BY-4.0',
  'cc-by-sa-3.0': 'CC-BY-SA-3.0',
  'cc-by-sa-4.0': 'CC-BY-SA-4.0',
  curl: 'curl',
  expat: 'MIT',
  mit: 'MIT',
  'mit-0': 'MIT-0',
  fsfap: 'FSFAP',
  fsful: 'FSFUL',
  fsfullr: 'FSFULLR',
  'gpl-1': 'GPL-1.0-only',
  'gpl-1+': 'GPL-1.0-or-later',
  'gpl-2': 'GPL-2.0-only',
  'gpl-2.0': 'GPL-2.0-only',
  'gpl-2+': 'GPL-2.0-or-later',
  'gpl-2.0+': 'GPL-2.0-or-later',
  'gpl-3': 'GPL-3.0-only',
  'gpl-3.0': 'GPL-3.0-only',
  'gpl-3+': 'GPL-3.0-or-later',
  'gpl-3.0+': 'GPL-3.0-or-later',
  'lgpl-2': 'LGPL-2.0-only',
  'lgpl-2+': 'LGPL-2.0-or-later',
  'lgpl-2.0': 'LGPL-2.0-only',
  'lgpl-2.0+': 'LGPL-2.0-or-later',
  'lgpl-2.1': 'LGPL-2.1-only',
  'lgpl-2.1+': 'LGPL-2.1-or-later',
  'lgpl-3': 'LGPL-3.0-only',
  'lgpl-3+': 'LGPL-3.0-or-later',
  'lgpl-3.0': 'LGPL-3.0-only',
  'lgpl-3.0+': 'LGPL-3.0-or-later',
  'agpl-3': 'AGPL-3.0-only',
  'agpl-3+': 'AGPL-3.0-or-later',
  'gfdl-1.2': 'GFDL-1.2-only',
  'gfdl-1.2+': 'GFDL-1.2-or-later',
  'gfdl-1.3': 'GFDL-1.3-only',
  'gfdl-1.3+': 'GFDL-1.3-or-later',
  'gfdl-niv-1.3': 'GFDL-1.3-no-invariants-only',
  'gfdl-niv-1.3+': 'GFDL-1.3-no-invariants-or-later',
  hpnd: 'HPND',
  isc: 'ISC',
  kazlib: 'Kazlib',
  latex2e: 'Latex2e',
  libpng: 'Libpng',
  'libpng-2.0': 'libpng-2.0',
  'mit-cmu': 'MIT-CMU',
  'mpl-1.1': 'MPL-1.1',
  'mpl-2.0': 'MPL-2.0',
  'ms-pl': 'MS-PL',
  openssl: 'OpenSSL',
  'openldap-2.8': 'OLDAP-2.8',
  postgresql: 'PostgreSQL',
  'psf-2': 'PSF-2.0',
  'psf-2.0': 'PSF-2.0',
  'python-2.0': 'Python-2.0',
  ruby: 'Ruby',
  sleepycat: 'Sleepycat',
  sunpro: 'SunPro',
  tcl: 'TCL',
  'unicode-dfs-2016': 'Unicode-DFS-2016',
  'unicode-3.0': 'Unicode-3.0',
  unlicense: 'Unlicense',
  x11: 'X11',
  zlib: 'Zlib',
  '0bsd': '0BSD',
};

/** Ausnahmen ("<lizenz> with <name> exception") → SPDX-Ausnahme, soweit eindeutig. */
const DEBIAN_EXCEPTION_TO_SPDX: Record<string, string> = {
  'autoconf-2.0': 'Autoconf-exception-2.0',
  'autoconf-3.0': 'Autoconf-exception-3.0',
  bison: 'Bison-exception-2.2',
  'bison-2.2': 'Bison-exception-2.2',
  'classpath-2.0': 'Classpath-exception-2.0',
  'font-2.0': 'Font-exception-2.0',
  'gcc-runtime-library-3.1': 'GCC-exception-3.1',
  'gcc-3.1': 'GCC-exception-3.1',
  libtool: 'Libtool-exception',
  'linux-syscall-note': 'Linux-syscall-note',
  llvm: 'LLVM-exception',
  texinfo: 'Texinfo-exception',
};

/** Nicht abbildbarer Name → LicenseRef (SPDX: idstring aus Buchstaben, Ziffern, "." und "-"). */
export function licenseRefOf(name: string): string {
  const id = name
    .trim()
    .replace(/\+/g, '-or-later')
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `LicenseRef-Debian-${id || 'unknown'}`;
}

interface Term {
  spdx: string;
  mapped: boolean;
}

function mapTerm(raw: string): Term {
  // auch "GPL-3+-with-Bison-exception" (Bindestriche statt Leerzeichen)
  const t = raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(\S+?)-with-(\S+?)-exception$/i, '$1 with $2 exception');
  const exc = t.match(/^(\S+) with (.+?)(?: exception)?$/i);
  if (exc) {
    const base = DEBIAN_TO_SPDX[exc[1]!.toLowerCase()];
    let name = exc[2]!
      .toLowerCase()
      .replace(/[-\s]+exception$/, '')
      .replace(/\s+/g, '-');
    // Autoconf-Ausnahme ohne Version: GPL-2 → 2.0, GPL-3 → 3.0 (so heißen die beiden Fassungen)
    if (name === 'autoconf' && base) name = base.startsWith('GPL-3') ? 'autoconf-3.0' : 'autoconf-2.0';
    const ex = DEBIAN_EXCEPTION_TO_SPDX[name];
    if (base && ex) return { spdx: `${base} WITH ${ex}`, mapped: true };
    return { spdx: licenseRefOf(t), mapped: false };
  }
  const id = DEBIAN_TO_SPDX[t.toLowerCase()];
  return id ? { spdx: id, mapped: true } : { spdx: licenseRefOf(t), mapped: false };
}

export interface SpdxResult {
  /** SPDX-Ausdruck (nicht abbildbare Teile als LicenseRef-Debian-…) */
  expression: string;
  /** Teile ohne SPDX-Entsprechung (Originalschreibweise) */
  unmapped: string[];
  /** oberste UND-Glieder des Ausdrucks (zum Zusammenführen mehrerer Lizenzfelder ohne Verschachtelung) */
  conjuncts: string[];
}

const wrap = (s: string) => (/ (AND|OR) /.test(s) ? `(${s})` : s);

function joinUnique(parts: string[], op: 'AND' | 'OR'): string {
  const uniq = [...new Set(parts)];
  return uniq.length === 1 ? uniq[0]! : uniq.map(wrap).join(` ${op} `);
}

/**
 * Lizenzfeld nach DEP-5 → SPDX. Vorrang: "and" bindet stärker als "or"; ein Komma trennt mit niedrigstem
 * Vorrang (Standard "and", "…, or …" möglich), z. B. "GPL-2+ or Artistic, and BSD-3-clause".
 */
export function dep5ToSpdx(field: string): SpdxResult {
  const unmapped: string[] = [];
  const segments = field.split(/\s*,\s*/).filter(Boolean);
  let conjuncts: string[] = [];
  for (const [i, seg0] of segments.entries()) {
    const opMatch = i > 0 ? seg0.match(/^(and|or)\s+/i) : null;
    const op = opMatch?.[1]?.toUpperCase() === 'OR' ? 'OR' : 'AND';
    const seg = opMatch ? seg0.slice(opMatch[0].length) : seg0;
    const alternatives = seg.split(/\s+or\s+/i).map((alt) => [
      ...new Set(
        alt.split(/\s+and\s+/i).map((raw) => {
          const term = mapTerm(raw);
          if (!term.mapped) unmapped.push(raw.trim());
          return term.spdx;
        }),
      ),
    ]);
    const uniqAlts = [...new Map(alternatives.map((a) => [a.join(' AND '), a])).values()];
    const segConjuncts =
      uniqAlts.length === 1
        ? uniqAlts[0]!
        : [
            joinUnique(
              uniqAlts.map((a) => joinUnique(a, 'AND')),
              'OR',
            ),
          ];
    if (i === 0 || op === 'AND') conjuncts.push(...segConjuncts);
    else conjuncts = [`${wrap(joinUnique(conjuncts, 'AND'))} OR ${wrap(joinUnique(segConjuncts, 'AND'))}`];
  }
  conjuncts = [...new Set(conjuncts)];
  return { expression: joinUnique(conjuncts, 'AND'), unmapped: [...new Set(unmapped)], conjuncts };
}

/**
 * Lizenzen eines Pakets: alle Lizenzfelder (verschiedene Dateien) gelten zusammen → UND-Verknüpfung der
 * obersten UND-Glieder, ohne Duplikate, sortiert.
 */
export function packageLicense(fields: string[]): SpdxResult | null {
  if (!fields.length) return null;
  const results = fields.map(dep5ToSpdx);
  const conjuncts = [...new Set(results.flatMap((r) => r.conjuncts))].sort();
  return {
    expression: joinUnique(conjuncts, 'AND'),
    unmapped: [...new Set(results.flatMap((r) => r.unmapped))].sort(),
    conjuncts,
  };
}

/** CycloneDX-Lizenzangabe (deklariert): Einzelkennung als id, ein einzelner unbekannter Name als name, sonst Ausdruck. */
export function declaredLicenseChoices(result: SpdxResult, fields: string[]): LicenseChoice[] {
  const { expression } = result;
  if (!/ (AND|OR|WITH) /.test(expression)) {
    if (expression.startsWith('LicenseRef-') && fields.length === 1)
      return [{ license: { name: fields[0]!, acknowledgement: 'declared' } }];
    if (!expression.startsWith('LicenseRef-'))
      return [{ license: { id: expression, acknowledgement: 'declared' } }];
  }
  return [{ expression, acknowledgement: 'declared' }];
}

/**
 * Quellpakete, deren copyright-Datei NICHT maschinenlesbar ist (Freitext): Lizenz von Hand aus der Datei
 * gelesen (05.11.2026, Debian 13 "trixie"). Gilt nur, solange die Datei byteweise gleich ist (SHA-256);
 * ändert Debian sie, fällt das Paket als Lücke auf und der Eintrag ist neu zu prüfen.
 */
export const MANUAL_DEBIAN_LICENSES: Record<
  string,
  { sha256: string; license: { name: string } | { expression: string }; note: string }
> = {
  'debian-archive-keyring': {
    sha256: '8f918c0bebd1454a084698a95c09d9a03cec8453dad1fc6eab9e6427da9d33a9',
    license: { expression: 'GPL-2.0-or-later' },
    note: 'Schlüssel nicht urheberrechtlich geschützt; Debian-Hilfsdateien GPL v2 oder später',
  },
  'gcc-14': {
    sha256: '20390f8a6f3b1e4d7cb45dd8652dabb259bbef688cbad839bcdb0b9ba7252f79',
    license: { expression: 'GPL-3.0-or-later WITH GCC-exception-3.1' },
    note: 'Laufzeitbibliotheken (libgcc, libstdc++): GPL v3 oder später mit GCC Runtime Library Exception 3.1',
  },
  libxcrypt: {
    sha256: '5a5e7ca0e9f3f9679977e3a3e9ede45ad92885a3297ea78e766979f9866c5a16',
    license: {
      expression:
        'LGPL-2.1-or-later AND BSD-3-Clause AND BSD-2-Clause AND 0BSD AND LicenseRef-Debian-public-domain',
    },
    note: 'Gesamtlizenz LGPL v2.1 oder später; Algorithmen unter BSD-3/BSD-2/0BSD bzw. gemeinfrei (Build-Hilfsdateien nicht im Binärpaket)',
  },
  krb5: {
    sha256: '936728f4181718f42951b881c1e8f1386bf6b2723c4fbc533c374d6f42c71816',
    license: {
      name: 'MIT Kerberos (Wortlaut wie BSD-2-Clause); einzelne Dateien unter weiteren freien Lizenzen, siehe copyright-Datei',
    },
    note: 'keine SPDX-Kennung für die Gesamtlizenz; Einzellizenzen u. a. MIT-artig, OpenLDAP, ISC',
  },
};

// ---------------------------------------------------------------------------------------------------
// Daten aus dem Abbild

export interface DpkgEntry {
  package: string;
  source: string;
  version: string;
  sourceVersion: string;
}

export interface ImageFacts {
  bunVersion: string | null;
  bunSha512: string | null;
  dpkg: DpkgEntry[];
  /** Paketname (Verzeichnis unter /usr/share/doc) → Inhalt der copyright-Datei */
  copyright: Map<string, string>;
}

const MARK = '@@OSP-SBOM-IMAGE@@';

/** Shell-Skript, das im Abbild läuft (nur Lesen; Abschnitte durch MARK getrennt). */
export const IMAGE_PROBE_SCRIPT = [
  `echo "${MARK} bun-version"`,
  'bun --version 2>/dev/null || true',
  `echo "${MARK} bun-sha512"`,
  'sha512sum "$(command -v bun)" 2>/dev/null || true',
  `echo "${MARK} dpkg"`,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Shell- bzw. dpkg-query-Syntax, kein Template
  "dpkg-query -W -f='${Package}\\t${source:Package}\\t${Version}\\t${source:Version}\\n'",
  'for f in /usr/share/doc/*/copyright; do',
  '  [ -r "$f" ] || continue',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Shell- bzw. dpkg-query-Syntax, kein Template
  '  d=${f%/copyright}',
  `  echo "${MARK} copyright \${d##*/}"`,
  '  cat "$f"',
  'done',
].join('\n');

export function parseImageProbe(output: string): ImageFacts {
  const facts: ImageFacts = { bunVersion: null, bunSha512: null, dpkg: [], copyright: new Map() };
  const sections = output.split(new RegExp(`^${MARK} `, 'm')).slice(1);
  for (const sec of sections) {
    const nl = sec.indexOf('\n');
    const head = (nl < 0 ? sec : sec.slice(0, nl)).trim();
    const body = nl < 0 ? '' : sec.slice(nl + 1);
    if (head === 'bun-version') facts.bunVersion = body.trim().match(/^\d[\w.+-]*/)?.[0] ?? null;
    else if (head === 'bun-sha512') facts.bunSha512 = body.trim().match(/^[0-9a-f]{128}\b/)?.[0] ?? null;
    else if (head === 'dpkg')
      for (const line of body.split('\n')) {
        const [pkg, source, version, sourceVersion] = line.split('\t');
        if (!pkg || !version) continue;
        facts.dpkg.push({
          package: pkg,
          source: source || pkg,
          version,
          sourceVersion: sourceVersion || version,
        });
      }
    else if (head.startsWith('copyright ')) facts.copyright.set(head.slice('copyright '.length), body);
  }
  return facts;
}

// ---------------------------------------------------------------------------------------------------
// Anreicherung

/** Ersetzt eine bom-ref überall (Komponenten, Graph, Vollständigkeit, Anmerkungen). */
export function renameRef(bom: Bom, from: string, to: string) {
  if (from === to) return;
  const visit = (c: CdxComponent) => {
    if (c['bom-ref'] === from) c['bom-ref'] = to;
    for (const sub of (c.components as CdxComponent[] | undefined) ?? []) visit(sub);
  };
  for (const c of bom.components) visit(c);
  if (bom.metadata.component) visit(bom.metadata.component);
  for (const d of bom.dependencies ?? []) {
    if (d.ref === from) d.ref = to;
    if (d.dependsOn) d.dependsOn = d.dependsOn.map((r) => (r === from ? to : r));
  }
  for (const c of bom.compositions ?? [])
    if (c.dependencies) c.dependencies = c.dependencies.map((r) => (r === from ? to : r));
  for (const a of (bom.annotations as { subjects?: string[] }[] | undefined) ?? [])
    if (a.subjects) a.subjects = a.subjects.map((r) => (r === from ? to : r));
}

function isSourcePackage(c: CdxComponent): boolean {
  return Array.isArray(c.tags) && (c.tags as string[]).includes('source');
}

export interface ImageEnrichResult {
  gaps: string[];
  placeholders: string[];
  stats: {
    debPackages: number;
    debWithLicense: number;
    debSpdxOnly: number;
    debManual: number;
    bunVersion: string | null;
  };
}

/**
 * Reichert die cdxgen-SBOM eines Abbilds an (ohne Docker, testbar). `facts` stammt aus dem Abbild,
 * `dockerfileBunVersion` aus deploy/Dockerfile.
 */
export function enrichImageBom(
  bom: Bom,
  facts: ImageFacts,
  cfg: SbomConfig,
  opts: { projectVersion: string; dockerfileBunVersion: string; imageTag?: string },
): ImageEnrichResult {
  const placeholders = placeholderFindings(cfg);
  const gaps: string[] = [];
  applyMetadata(bom, cfg, {
    toolDescription: `Anreicherung der Abbild-SBOM nach ${TR_VERSION} (Lizenzen der Debian-Pakete, Bun, Hersteller, Kontakt)`,
    toolVersion: opts.projectVersion,
    status: placeholders.length
      ? `ENTWURF: Platzhalter für Hersteller/Lieferant/SBOM-Ersteller/Sicherheitskontakt (${placeholders.length} Felder), Entscheidung des Eigentümers offen`
      : 'Angaben vollständig',
  });
  const md = bom.metadata;
  md.lifecycles = [{ phase: 'post-build' }];
  if (md.component) {
    describeProjectComponent(md.component, cfg);
    const tag = opts.imageTag?.split(':').slice(1).join(':');
    if (tag && (md.component.version === 'local' || !md.component.version)) md.component.version = tag;
    md.component.description ??= 'Container-Abbild eines OSP-Data-Mesh-Knotens (deploy/Dockerfile)';
  }
  setProperty(md, 'osp:sbom-generator', `${CDXGEN} -t docker + scripts/sbom-image.ts`);
  setProperty(md, 'osp:related-sbom:source', 'sbom/osp-data-mesh.cdx.json (Quell-SBOM, pre-build)');

  // --- Debian-Pakete: Lizenzen aus /usr/share/doc/<paket>/copyright
  const bySource = new Map<string, string[]>();
  for (const e of facts.dpkg) {
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source)!.push(e.package);
  }
  const dep5Of = new Map<string, Dep5>();
  const dep5 = (pkg: string): Dep5 | null => {
    if (!facts.copyright.has(pkg)) return null;
    if (!dep5Of.has(pkg)) dep5Of.set(pkg, parseDep5(facts.copyright.get(pkg)!));
    return dep5Of.get(pkg)!;
  };
  const debs = bom.components.filter((c) => c.purl?.startsWith('pkg:deb/'));
  let withLicense = 0;
  let spdxOnly = 0;
  let manualCount = 0;
  let withUnmapped = 0;
  const unmappedNames = new Set<string>();
  const staleManual = new Set<string>();
  const notMachineReadable: string[] = [];
  const noCopyright: string[] = [];
  for (const comp of debs) {
    const source = isSourcePackage(comp);
    // Kandidaten: eigenes Paket; bei Quellpaketen die daraus gebauten Binärpakete; sonst Pakete derselben Quelle
    const ownSource = facts.dpkg.find((e) => e.package === comp.name)?.source;
    const candidates = source
      ? [comp.name, ...(bySource.get(comp.name) ?? [])]
      : [comp.name, ...(ownSource ? (bySource.get(ownSource) ?? []) : [])];
    let used: { pkg: string; d: Dep5 } | null = null;
    let sawCopyright = false;
    for (const pkg of [...new Set(candidates)]) {
      const d = dep5(pkg);
      if (!d) continue;
      sawCopyright = true;
      if (d.machineReadable && d.licenses.length) {
        used = { pkg, d };
        break;
      }
    }
    if (!used) {
      const srcName = source ? comp.name : (ownSource ?? comp.name);
      const manual = MANUAL_DEBIAN_LICENSES[srcName];
      const match = manual
        ? [...new Set(candidates)].find(
            (pkg) =>
              facts.copyright.has(pkg) &&
              createHash('sha256').update(facts.copyright.get(pkg)!).digest('hex') === manual.sha256,
          )
        : undefined;
      if (manual && match) {
        comp.licenses =
          'expression' in manual.license
            ? [{ expression: manual.license.expression, acknowledgement: 'declared' }]
            : [{ license: { ...manual.license, acknowledgement: 'declared' } }];
        setProperty(
          comp,
          'osp:license-source',
          `manual:/usr/share/doc/${match}/copyright (Freitext, von Hand gelesen; sha256:${manual.sha256})`,
        );
        setProperty(comp, 'osp:license-note', manual.note);
        withLicense++;
        manualCount++;
        continue;
      }
      if (manual) staleManual.add(srcName);
      (sawCopyright ? notMachineReadable : noCopyright).push(`${comp.name}@${comp.version}`);
      continue;
    }
    const result = packageLicense(used.d.licenses)!;
    comp.licenses = declaredLicenseChoices(result, used.d.licenses);
    setProperty(comp, 'osp:debian-license', used.d.licenses.join(' | '));
    setProperty(
      comp,
      'osp:license-source',
      used.pkg === comp.name
        ? `debian-copyright:/usr/share/doc/${comp.name}/copyright`
        : `debian-copyright:/usr/share/doc/${used.pkg}/copyright (${source ? 'Binärpaket dieser Quelle' : 'Paket derselben Quelle'})`,
    );
    withLicense++;
    if (!result.unmapped.length) spdxOnly++;
    else {
      withUnmapped++;
      for (const u of result.unmapped) unmappedNames.add(u);
    }
  }
  if (staleManual.size)
    gaps.push(
      `copyright-Datei geändert, Eintrag in MANUAL_DEBIAN_LICENSES neu prüfen: ${[...staleManual].sort().join(', ')}`,
    );
  if (noCopyright.length)
    gaps.push(
      `${noCopyright.length} Debian-Pakete ohne copyright-Datei im Abbild: ${noCopyright.join(', ')}`,
    );
  if (notMachineReadable.length)
    gaps.push(
      `${notMachineReadable.length} Debian-Pakete ohne maschinenlesbare copyright-Datei (DEP-5), Lizenz nicht gesetzt: ${notMachineReadable.join(', ')}`,
    );
  if (unmappedNames.size)
    gaps.push(
      `${withUnmapped} Debian-Pakete nennen (auch) Lizenzen ohne SPDX-Kennung, übernommen als LicenseRef-Debian-<Name> ` +
        `(${unmappedNames.size} Namen, u. a. ${[...unmappedNames].sort().slice(0, 8).join(', ')} …)`,
    );

  // --- Bun: Version, Lizenz, Hersteller, SHA-512
  const bunVersion = facts.bunVersion ?? opts.dockerfileBunVersion;
  if (!facts.bunVersion)
    gaps.push(`Bun-Version nicht im Abbild ermittelt; aus deploy/Dockerfile übernommen (${bunVersion})`);
  else if (facts.bunVersion !== opts.dockerfileBunVersion)
    gaps.push(
      `Bun-Version im Abbild (${facts.bunVersion}) weicht von deploy/Dockerfile (ARG BUN_VERSION=${opts.dockerfileBunVersion}) ab`,
    );
  const bun = bom.components.find((c) => c.name === 'bun' && /^pkg:generic\/bun(@|$|\?)/.test(c.purl ?? ''));
  if (!bun) gaps.push('Bun-Binärdatei nicht in der cdxgen-Ausgabe gefunden');
  else {
    const template = platformComponents().find((c) => c.name === 'bun')!;
    const ref = `pkg:generic/bun@${bunVersion}`;
    renameRef(bom, bun['bom-ref'] ?? '', ref);
    bun['bom-ref'] = ref;
    bun.purl = ref;
    bun.version = bunVersion;
    bun.description = 'JavaScript-Laufzeitumgebung (Basisabbild oven/bun), /usr/local/bin/bun';
    bun.licenses = template.licenses;
    bun.manufacturer = template.manufacturer;
    bun.supplier = template.supplier;
    bun.externalReferences = (template.externalReferences ?? []).map((r) => ({ ...r }));
    if (facts.bunSha512) {
      bun.hashes = [
        ...(bun.hashes ?? []).filter((h) => h.alg !== 'SHA-512'),
        { alg: 'SHA-512', content: facts.bunSha512 },
      ];
    } else gaps.push('SHA-512 der Bun-Binärdatei nicht ermittelt');
    for (const p of [
      'bsi:component:filename',
      'bsi:component:executable',
      'bsi:component:archive',
      'bsi:component:structured',
      'osp:license-note',
    ])
      setProperty(bun, p, template.properties!.find((x) => x.name === p)!.value);
    setProperty(
      bun,
      'osp:version-source',
      facts.bunVersion ? 'bun --version im Abbild' : 'deploy/Dockerfile',
    );
    bom.dependencies ??= [];
    if (!bom.dependencies.some((d) => d.ref === ref)) bom.dependencies.push({ ref, dependsOn: [] });
    // das Abbild enthält Bun (cdxgen führt die Binärdatei ohne Kante von der Hauptkomponente)
    const rootRef = md.component?.['bom-ref'];
    const root = rootRef ? bom.dependencies.find((d) => d.ref === rootRef) : undefined;
    if (root && !root.dependsOn?.includes(ref)) root.dependsOn = [...(root.dependsOn ?? []), ref];
  }

  if (JSON.stringify(bom).includes('"vulnerabilities"'))
    gaps.push('SBOM enthält Schwachstelleninformationen (TR 3.1: nicht erlaubt)');
  return {
    gaps,
    placeholders,
    stats: {
      debPackages: debs.length,
      debWithLicense: withLicense,
      debSpdxOnly: spdxOnly,
      debManual: manualCount,
      bunVersion: bun ? bunVersion : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Ausführung

function docker(args: string[]): { ok: boolean; out: string; err: string } {
  const proc = Bun.spawnSync(['docker', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  return { ok: proc.exitCode === 0, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function runCdxgenDocker(image: string, out: string) {
  const proc = Bun.spawnSync(
    ['bun', 'x', '-p', CDXGEN, 'cdxgen', '-t', 'docker', '--spec-version', '1.6', image, '-o', out],
    {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, FETCH_LICENSE: 'false' },
    },
  );
  if (proc.exitCode !== 0)
    throw new Error(
      `cdxgen -t docker ${image} fehlgeschlagen (Exit ${proc.exitCode}):\n${proc.stderr.toString().slice(-2000)}`,
    );
}

export function probeImage(image: string): ImageFacts {
  const r = docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    '/bin/sh',
    image,
    '-c',
    IMAGE_PROBE_SCRIPT,
  ]);
  if (!r.ok) throw new Error(`Abbild ${image} konnte nicht gelesen werden:\n${r.err.slice(-2000)}`);
  return parseImageProbe(r.out);
}

export async function imageSbom(args: string[]) {
  const val = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const optsWithValue = new Set(['--input', '--output', '--sign-key', '--public-key']);
  const image = args.find((a, i) => !a.startsWith('--') && !optsWithValue.has(args[i - 1] ?? ''));
  if (!image) throw new Error('Abbild angeben: bun run sbom -- image <abbild:tag> [--input <cdxgen.json>]');
  const output = resolve(process.cwd(), val('--output') ?? IMAGE_OUT_FILE);
  const input = val('--input');
  let bom: Bom;
  if (input) bom = JSON.parse(readFileSync(resolve(process.cwd(), input), 'utf8')) as Bom;
  else {
    const dir = mkdtempSync(join(tmpdir(), 'osp-sbom-image-'));
    try {
      const out = join(dir, 'image.cdx.json');
      console.log(`cdxgen -t docker ${image} …`);
      runCdxgenDocker(image, out);
      bom = JSON.parse(readFileSync(out, 'utf8')) as Bom;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  delete bom.signature;
  const facts = probeImage(image);
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', image]).out.trim();
  const bomImageId = bom.metadata.properties?.find((p) => p.name === 'oci:image:Id')?.value;
  if (imageId && bomImageId && imageId !== bomImageId)
    throw new Error(`cdxgen-Ausgabe beschreibt ein anderes Abbild (${bomImageId}) als ${image} (${imageId})`);
  const cfg = loadConfig();
  const inv = buildInventory();
  const { gaps, placeholders, stats } = enrichImageBom(bom, facts, cfg, {
    projectVersion: inv.project.version,
    dockerfileBunVersion: bunVersionFromDockerfile(),
    imageTag: image,
  });
  mkdirSync(dirname(output), { recursive: true });
  const signed = signAndWrite(bom, output, cfg, args, { compact: true });
  console.log(
    `Abbild-SBOM geschrieben: ${displayPath(output)} (CycloneDX ${bom.specVersion}, ${bom.components.length} Komponenten; ` +
      `Debian-Pakete: ${stats.debWithLicense} von ${stats.debPackages} mit Lizenz, davon ${stats.debSpdxOnly} vollständig SPDX, ${stats.debManual} aus Freitext von Hand; Bun ${stats.bunVersion ?? '?'})`,
  );
  if (gaps.length) {
    console.log('Hinweise:');
    for (const g of gaps) console.log(`  - ${g}`);
  }
  if (!signed) console.warn('Nicht signiert (kein --sign-key bzw. OSP_SBOM_SIGNING_KEY).');
  warnPlaceholders(placeholders);
  let ok = true;
  if (!args.includes('--no-validate') && !validate(output)) ok = false;
  const incomplete = stats.debWithLicense < stats.debPackages || !stats.bunVersion;
  if (args.includes('--release') && (placeholders.length || !signed || incomplete)) {
    console.error(
      '--release: abgebrochen (Platzhalter, fehlende Signatur, Debian-Pakete ohne Lizenz oder Bun ohne Version, siehe oben).',
    );
    ok = false;
  }
  if (!ok) process.exit(1);
}
