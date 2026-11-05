/**
 * Software-Stückliste (SBOM) im Format CycloneDX 1.6 (JSON) nach BSI TR-03183-2 v2.1.0.
 *
 *   bun run sbom                        Quell-SBOM (Lebenszyklus pre-build): cdxgen (über `bun x`, versioniert)
 *                                       liest bun.lock, danach Anreicherung → sbom/osp-data-mesh.cdx.json
 *   bun run sbom -- --builtin           ohne cdxgen (z. B. offline): eigener Generator aus bun.lock
 *   bun run sbom -- --offline           ohne Abruf der Registry-Manifeste nicht installierter Pakete
 *   bun run sbom -- --no-validate       ohne anschließende Schema-Prüfung (mit --builtin nur bei --validate)
 *   bun run sbom -- --sign-key <pem>    zusätzlich signieren (JSF, eingebettet); alternativ Umgebungsvariable
 *                                       OSP_SBOM_SIGNING_KEY=<Pfad zum privaten Schlüssel>
 *   bun run sbom -- --release           streng: Abbruch bei Platzhaltern, fehlender Signatur oder TR-Lücken
 *   bun run sbom -- build-ui [--out-dir <dir>] [--output <datei>]
 *                                       Build-SBOM der Web-Oberfläche (baut dist/ui bzw. <dir>), siehe sbom-build.ts
 *   bun run sbom -- verify [<datei>] [--public-key <pem>]
 *                                       Signatur prüfen (Standard-Schlüssel: signing.publicKey aus der Konfiguration)
 *   bun run sbom -- keygen <verzeichnis außerhalb des Repositorys>
 *                                       Ed25519-Schlüsselpaar für die Signatur erzeugen
 *
 * Hersteller, Lieferant, SBOM-Ersteller und Sicherheitskontakt stehen in sbom/sbom.config.json
 * (Platzhalter, bis der Eigentümer entscheidet). Abbildung der TR-Felder: docs/sicherheit.md, Abschnitt SBOM.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  buildInventory,
  type Component,
  type Inventory,
  normalizeLicense,
  normalizeRepo,
  parseAuthor,
  ROOT,
} from './licenses.ts';
import { generateSigningKeyPair, signBom, verifyBom } from './sbom-sign.ts';

export const CDXGEN = '@cyclonedx/cdxgen@12.9.0';
export const TR_VERSION = 'BSI TR-03183-2 v2.1.0';
const OUT_DIR = join(ROOT, 'sbom');
export const OUT_FILE = join(OUT_DIR, 'osp-data-mesh.cdx.json');
export const CONFIG_FILE = join(OUT_DIR, 'sbom.config.json');

// ---------------------------------------------------------------------------------------------------
// Typen (Ausschnitt CycloneDX 1.6)

export interface Property {
  name: string;
  value: string;
}
export interface ExternalReference {
  type: string;
  url: string;
  hashes?: { alg: string; content: string }[];
  comment?: string;
}
export interface LicenseChoice {
  license?: { id?: string; name?: string; acknowledgement?: 'declared' | 'concluded' };
  expression?: string;
  acknowledgement?: 'declared' | 'concluded';
}
export interface OrgEntity {
  name?: string;
  url?: string[];
  contact?: { name?: string; email?: string }[];
}
export interface CdxComponent {
  type: string;
  'bom-ref'?: string;
  group?: string;
  name: string;
  version?: string;
  description?: string;
  scope?: 'required' | 'optional' | 'excluded';
  purl?: string;
  cpe?: string;
  hashes?: { alg: string; content: string }[];
  licenses?: LicenseChoice[];
  copyright?: string;
  authors?: { name?: string; email?: string }[];
  supplier?: OrgEntity;
  manufacturer?: OrgEntity;
  externalReferences?: ExternalReference[];
  properties?: Property[];
  [key: string]: unknown;
}
export interface Bom {
  bomFormat: 'CycloneDX';
  specVersion: string;
  serialNumber?: string;
  version: number;
  metadata: {
    timestamp?: string;
    lifecycles?: { phase: string }[];
    tools?: { components?: CdxComponent[] };
    authors?: { name?: string; email?: string }[];
    supplier?: OrgEntity;
    manufacturer?: OrgEntity;
    component?: CdxComponent;
    properties?: Property[];
    [key: string]: unknown;
  };
  components: CdxComponent[];
  dependencies?: { ref: string; dependsOn?: string[] }[];
  compositions?: { aggregate: string; dependencies?: string[] }[];
  signature?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------------
// Konfiguration: Hersteller, Lieferant, SBOM-Ersteller, Sicherheitskontakt

export interface Party {
  name: string;
  email?: string | null;
  url?: string | null;
}
export interface SbomConfig {
  manufacturer: Party;
  supplier?: Party | null;
  sbomAuthor?: Party | null;
  securityContact: { email?: string | null; securityTxtUrl?: string | null; url?: string | null };
  sourceCodeUrl?: string | null;
  signing?: { publicKey?: string | null } | null;
}

function cleanParty(p: unknown, where: string): Party {
  if (!p || typeof p !== 'object') throw new Error(`${where}: Objekt erwartet`);
  const o = p as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) throw new Error(`${where}.name fehlt`);
  const str = (v: unknown, k: string) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw new Error(`${where}.${k}: Zeichenkette erwartet`);
    return v.trim();
  };
  return { name: o.name.trim(), email: str(o.email, 'email'), url: str(o.url, 'url') };
}

export function parseConfig(raw: unknown): SbomConfig {
  if (!raw || typeof raw !== 'object') throw new Error('sbom.config.json: Objekt erwartet');
  const o = raw as Record<string, unknown>;
  const sc = (o.securityContact ?? {}) as Record<string, unknown>;
  const opt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    manufacturer: cleanParty(o.manufacturer, 'manufacturer'),
    supplier: o.supplier ? cleanParty(o.supplier, 'supplier') : null,
    sbomAuthor: o.sbomAuthor ? cleanParty(o.sbomAuthor, 'sbomAuthor') : null,
    securityContact: { email: opt(sc.email), securityTxtUrl: opt(sc.securityTxtUrl), url: opt(sc.url) },
    sourceCodeUrl: opt(o.sourceCodeUrl),
    signing: { publicKey: opt((o.signing as Record<string, unknown> | undefined)?.publicKey) },
  };
}

export function loadConfig(file = CONFIG_FILE): SbomConfig {
  return parseConfig(JSON.parse(readFileSync(file, 'utf8')));
}

/** Platzhalter: "tbd", "TODO", "Platzhalter" oder reservierte Domain .invalid (RFC 2606). */
export function isPlaceholder(value: string | null | undefined): boolean {
  if (!value) return false;
  return /\btbd\b|\btodo\b|platzhalter|placeholder|\.invalid(?![\w-])/i.test(value);
}

/** Liste der Konfigurationsfelder, die noch Platzhalter sind oder fehlen (für Warnungen und --release). */
export function placeholderFindings(cfg: SbomConfig): string[] {
  const out: string[] = [];
  const party = (p: Party, label: string) => {
    if (isPlaceholder(p.name)) out.push(`${label}.name = "${p.name}"`);
    if (isPlaceholder(p.email)) out.push(`${label}.email = "${p.email}"`);
    if (isPlaceholder(p.url)) out.push(`${label}.url = "${p.url}"`);
    const real = [p.email, p.url].filter((v) => v && !isPlaceholder(v));
    if (!real.length) out.push(`${label}: weder echte E-Mail noch URL (TR-03183-2 verlangt eins davon)`);
  };
  party(cfg.manufacturer, 'manufacturer');
  if (cfg.supplier) party(cfg.supplier, 'supplier');
  if (cfg.sbomAuthor) party(cfg.sbomAuthor, 'sbomAuthor');
  const sc = cfg.securityContact;
  for (const [k, v] of Object.entries(sc)) if (isPlaceholder(v)) out.push(`securityContact.${k} = "${v}"`);
  if (![sc.email, sc.url].some((v) => v && !isPlaceholder(v)))
    out.push('securityContact: kein echter Kontakt für Schwachstellenmeldungen (email oder url)');
  return out;
}

export function orgEntity(p: Party): OrgEntity {
  return {
    name: p.name,
    ...(p.url ? { url: [p.url] } : {}),
    ...(p.email ? { contact: [{ email: p.email }] } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------
// Hilfsfunktionen

export function purlOf(name: string, version: string): string {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

export function refOf(name: string, version: string): string {
  return `pkg:npm/${name}@${version}`;
}

export function sriToHex(integrity: string | null): { alg: string; content: string } | null {
  if (!integrity) return null;
  const m = integrity.match(/^(sha512|sha384|sha256|sha1)-(.+)$/);
  if (!m) return null;
  const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1] as 'sha512'];
  return { alg, content: Buffer.from(m[2]!, 'base64').toString('hex') };
}

export function tarballUrl(name: string, version: string): string {
  const base = name.includes('/') ? name.split('/')[1]! : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

/**
 * Lizenzangaben nach TR-03183-2 v2.1.0 (8.2): Distributionslizenz = `acknowledgement: concluded`,
 * Originallizenz = `declared`. CycloneDX 1.6 erlaubt je Komponente nur EINEN Lizenzausdruck; bei
 * Ausdrücken (z. B. "MIT OR Apache-2.0") steht deshalb nur die Distributionslizenz in `licenses`.
 */
export function licenseChoices(license: string, declaredKnown: boolean): LicenseChoice[] {
  const expr = license.replace(/^\((.*)\)$/, '$1');
  if (/^[A-Za-z0-9.+-]+$/.test(expr)) {
    return [
      ...(declaredKnown ? [{ license: { id: expr, acknowledgement: 'declared' as const } }] : []),
      { license: { id: expr, acknowledgement: 'concluded' as const } },
    ];
  }
  return [{ expression: expr, acknowledgement: 'concluded' }];
}

export function setProperty(c: { properties?: Property[] }, name: string, value: string) {
  c.properties ??= [];
  const existing = c.properties.find((p) => p.name === name);
  if (existing) existing.value = value;
  else c.properties.push({ name, value });
}

export function getProperty(c: { properties?: Property[] }, name: string): string | undefined {
  return c.properties?.find((p) => p.name === name)?.value;
}

function addRef(c: CdxComponent, ref: ExternalReference | null) {
  if (!ref?.url) return;
  c.externalReferences ??= [];
  const existing = c.externalReferences.find((r) => r.type === ref.type);
  if (!existing) c.externalReferences.push(ref);
  else if (ref.hashes && !existing.hashes) existing.hashes = ref.hashes;
}

/** Urheber (TR: Component creator): E-Mail, sonst URL des Urhebers bzw. Projekts; Fallback npm-Seite. */
export function creatorOf(c: Component): { entity: OrgEntity; source: string } {
  const a = c.meta.author;
  const url = a?.url ?? c.meta.homepage ?? c.meta.repository ?? `https://www.npmjs.com/package/${c.name}`;
  const source = a?.email
    ? 'author-email'
    : a?.url
      ? 'author-url'
      : c.meta.homepage
        ? 'homepage'
        : c.meta.repository
          ? 'repository'
          : 'npm-package-page';
  return {
    entity: {
      ...(a?.name ? { name: a.name } : {}),
      url: [url],
      ...(a?.email ? { contact: [{ ...(a.name ? { name: a.name } : {}), email: a.email }] } : {}),
    },
    source,
  };
}

/** Füllt eine npm-Komponente mit allen Feldern nach TR-03183-2 (für Quell- und Build-SBOM). */
export function describeNpmComponent(comp: CdxComponent, c: Component, gaps: Set<string>) {
  const fullName = c.name;
  if (!comp.group) delete comp.group;
  comp.purl ??= purlOf(c.name, c.version);
  comp['bom-ref'] ??= refOf(c.name, c.version);
  const hash = sriToHex(c.integrity);
  if (hash && !comp.hashes?.some((h) => h.alg === hash.alg)) comp.hashes = [...(comp.hashes ?? []), hash];
  const sha512 = comp.hashes?.find((h) => h.alg === 'SHA-512');
  if (!sha512) gaps.add(`${fullName}@${c.version}: kein SHA-512`);
  // Distributionsform (npm-Archiv) mit Hash: TR 8.2 "Hash value of the deployable component"
  addRef(comp, {
    type: 'distribution',
    url: tarballUrl(c.name, c.version),
    ...(sha512 ? { hashes: [sha512] } : {}),
  });
  if (c.meta.license) {
    const declared = c.meta.licenseSource === 'package.json' || c.meta.licenseSource === 'registry';
    comp.licenses = licenseChoices(c.meta.license, declared);
    if (comp.licenses[0]?.expression && declared)
      setProperty(comp, 'osp:declared-license', comp.licenses[0].expression);
  } else gaps.add(`${fullName}@${c.version}: Lizenz unbekannt`);
  if (c.meta.description && !comp.description) comp.description = c.meta.description;
  const a = c.meta.author;
  if (a && (a.name || a.email)) {
    comp.authors = [{ ...(a.name ? { name: a.name } : {}), ...(a.email ? { email: a.email } : {}) }];
  }
  const creator = creatorOf(c);
  comp.manufacturer = creator.entity;
  setProperty(comp, 'osp:creator-source', creator.source);
  if (c.meta.copyright.length) comp.copyright = c.meta.copyright.join('\n');
  addRef(comp, c.meta.homepage ? { type: 'website', url: c.meta.homepage } : null);
  addRef(comp, c.meta.repository ? { type: 'vcs', url: c.meta.repository } : null);
  // Quellcode-URI (TR 5.2.4): Repository (ein Versions-Tag ist aus den Paketdaten nicht sicher ableitbar)
  addRef(comp, c.meta.repository ? { type: 'source-distribution', url: c.meta.repository } : null);
  const base = c.name.includes('/') ? c.name.split('/')[1]! : c.name;
  setProperty(comp, 'bsi:component:filename', `${base}-${c.version}.tgz`);
  // ausführbar = enthält Code, der von einer Laufzeitumgebung ausgeführt wird (TR 8.1.4: auch Skriptcode);
  // nicht installierte plattformspezifische Pakete enthalten native Programme bzw. Module
  const executable = c.meta.executableCode ?? true;
  setProperty(comp, 'bsi:component:executable', executable ? 'executable' : 'non-executable');
  setProperty(comp, 'bsi:component:archive', 'archive');
  setProperty(comp, 'bsi:component:structured', 'structured');
  setProperty(
    comp,
    'osp:executable-source',
    c.meta.executableCode === null ? 'assumed:not-installed' : 'inspected:package-files',
  );
  setProperty(
    comp,
    'osp:license-source',
    c.meta.licenseSource === 'inherited' ? `inherited:${c.meta.inheritedFrom}` : c.meta.licenseSource,
  );
  if (c.platformSpecific)
    setProperty(comp, 'osp:platform-specific', c.meta.installed ? 'installed' : 'not-installed');
}

function bunVersionFromDockerfile(): string {
  try {
    const df = readFileSync(join(ROOT, 'deploy', 'Dockerfile'), 'utf8');
    const m = df.match(/ARG BUN_VERSION=([0-9][0-9A-Za-z.+-]*)/);
    if (m?.[1]) return m[1];
  } catch {
    // ignorieren: Fallback auf die laufende Bun-Version
  }
  return Bun.version;
}

/** Laufzeitumgebung Bun und PostgreSQL: identifizierte Komponenten (TR 3.2.4) außerhalb dieser SBOM. */
export function platformComponents(): CdxComponent[] {
  const bunVersion = bunVersionFromDockerfile();
  return [
    {
      type: 'platform',
      'bom-ref': `pkg:generic/bun@${bunVersion}`,
      name: 'bun',
      version: bunVersion,
      description:
        'JavaScript-Laufzeitumgebung (Server, CLI, Build); im Container über das Basisabbild oven/bun, nativ separat installiert',
      scope: 'required',
      purl: `pkg:generic/bun@${bunVersion}`,
      licenses: licenseChoices('MIT', true),
      manufacturer: { name: 'Oven', url: ['https://bun.sh'] },
      supplier: { name: 'Oven', url: ['https://bun.sh'] },
      externalReferences: [
        { type: 'website', url: 'https://bun.sh' },
        { type: 'vcs', url: 'https://github.com/oven-sh/bun' },
        { type: 'source-distribution', url: `https://github.com/oven-sh/bun/tree/bun-v${bunVersion}` },
        { type: 'distribution', url: `https://github.com/oven-sh/bun/releases/tag/bun-v${bunVersion}` },
      ],
      properties: [
        { name: 'bsi:component:filename', value: 'bun' },
        { name: 'bsi:component:executable', value: 'executable' },
        { name: 'bsi:component:archive', value: 'no archive' },
        { name: 'bsi:component:structured', value: 'unstructured' },
        { name: 'osp:usage', value: 'server' },
        { name: 'osp:tr03183:level', value: 'identified' },
        {
          name: 'osp:license-note',
          value: 'Bun selbst MIT; enthält Komponenten unter weiteren Lizenzen (u. a. JavaScriptCore, LGPL)',
        },
        {
          name: 'osp:described-by',
          value: 'Container-Abbild: sbom/osp-data-mesh.image.cdx.json (Hash der Binärdatei je Plattform)',
        },
      ],
    },
    {
      type: 'platform',
      'bom-ref': 'pkg:generic/postgresql@18',
      name: 'postgresql',
      version: '18',
      description:
        'Datenbankserver und Client-Werkzeuge (psql, pg_dump, pg_restore); nicht im Lieferumfang, separat zu beziehen (Mindestversion 18)',
      scope: 'required',
      purl: 'pkg:generic/postgresql@18',
      cpe: 'cpe:2.3:a:postgresql:postgresql:18:*:*:*:*:*:*:*',
      licenses: licenseChoices('PostgreSQL', true),
      manufacturer: { name: 'PostgreSQL Global Development Group', url: ['https://www.postgresql.org'] },
      externalReferences: [
        { type: 'website', url: 'https://www.postgresql.org' },
        { type: 'vcs', url: 'https://git.postgresql.org/gitweb/?p=postgresql.git' },
        { type: 'distribution', url: 'https://www.postgresql.org/download/' },
        { type: 'rfc-9116', url: 'https://www.postgresql.org/.well-known/security.txt' },
      ],
      properties: [
        { name: 'osp:usage', value: 'server' },
        { name: 'osp:tr03183:level', value: 'identified' },
        { name: 'osp:delivery', value: 'not-delivered' },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------------------------------
// Registry-Metadaten für nicht installierte Pakete

/**
 * Plattformspezifische Pakete für andere Betriebssysteme sind lokal nicht installiert. Ihre Angaben
 * (deklarierte Lizenz, Urheber, Repository) stehen im Paketmanifest der npm-Registry; dessen Integrität
 * muss mit bun.lock übereinstimmen. Ohne Netz bleibt es bei der vom einbindenden Paket geerbten Lizenz.
 */
export async function fillFromRegistry(
  inv: Inventory,
  fetchImpl: typeof fetch = fetch,
): Promise<{ filled: number; failed: string[] }> {
  const missing = [...inv.components.values()].filter((c) => !c.meta.installed);
  const failed: string[] = [];
  let filled = 0;
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(
      missing.slice(i, i + 8).map(async (c) => {
        const url = `https://registry.npmjs.org/${c.name.replace('/', '%2f')}/${encodeURIComponent(c.version)}`;
        try {
          const res = await fetchImpl(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const m = (await res.json()) as Record<string, unknown>;
          const integrity = (m.dist as { integrity?: string } | undefined)?.integrity;
          if (m.name !== c.name || m.version !== c.version)
            throw new Error('Manifest passt nicht zu Name/Version');
          if (!c.integrity || integrity !== c.integrity)
            throw new Error('Integrität der Registry weicht von bun.lock ab');
          const license = normalizeLicense(m);
          if (!license) throw new Error('keine Lizenz im Manifest');
          c.meta.license = license;
          c.meta.licenseSource = 'registry';
          delete c.meta.inheritedFrom;
          c.meta.author = parseAuthor(m.author) ?? c.meta.author;
          c.meta.homepage = typeof m.homepage === 'string' ? m.homepage : c.meta.homepage;
          c.meta.repository = normalizeRepo(m.repository) ?? c.meta.repository;
          if (typeof m.description === 'string') c.meta.description = m.description;
          filled++;
        } catch (err) {
          failed.push(`${c.name}@${c.version}: ${(err as Error).message}`);
        }
      }),
    );
  }
  return { filled, failed };
}

// ---------------------------------------------------------------------------------------------------
// Generatoren

/** cdxgen über `bun x` ausführen. Gibt null zurück, wenn das Werkzeug nicht verfügbar ist. */
function runCdxgen(): Bom | null {
  const dir = mkdtempSync(join(tmpdir(), 'osp-sbom-'));
  const out = join(dir, 'bom.json');
  try {
    const proc = Bun.spawnSync(
      ['bun', 'x', CDXGEN, '-t', 'js', '--spec-version', '1.6', '--no-install-deps', '-o', out, ROOT],
      {
        cwd: ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, FETCH_LICENSE: 'false', CDXGEN_DEBUG_MODE: '' },
      },
    );
    if (proc.exitCode !== 0) {
      console.warn(`cdxgen fehlgeschlagen (Exit ${proc.exitCode}); verwende eingebauten Generator.`);
      console.warn(proc.stderr.toString().slice(-2000));
      return null;
    }
    return JSON.parse(readFileSync(out, 'utf8')) as Bom;
  } catch (err) {
    console.warn(`cdxgen nicht verfügbar (${(err as Error).message}); verwende eingebauten Generator.`);
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Eigener Generator (Fallback): Komponenten und Abhängigkeitsgraph direkt aus bun.lock. */
export function builtinBom(inv: Inventory): Bom {
  const rootRef = refOf(inv.project.name, inv.project.version);
  const components: CdxComponent[] = [];
  for (const c of inv.components.values()) {
    const [group, name] = c.name.startsWith('@') ? (c.name.split('/') as [string, string]) : ['', c.name];
    components.push({
      type: 'library',
      'bom-ref': refOf(c.name, c.version),
      ...(group ? { group } : {}),
      name,
      version: c.version,
      purl: purlOf(c.name, c.version),
      properties: [{ name: 'SrcFile', value: 'bun.lock' }],
    });
  }
  const byKey = inv.components;
  const dependencies = [
    {
      ref: rootRef,
      dependsOn: [...inv.directDependencies, ...inv.directDevDependencies]
        .map((k) => byKey.get(k))
        .filter((c): c is Component => !!c)
        .map((c) => refOf(c.name, c.version)),
    },
    ...[...byKey.values()].map((c) => ({
      ref: refOf(c.name, c.version),
      dependsOn: [...new Set([...c.resolvedDeps, ...c.resolvedPeers])]
        .map((k) => byKey.get(k)!)
        .map((d) => refOf(d.name, d.version)),
    })),
  ];
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [] },
      lifecycles: [{ phase: 'pre-build' }],
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: inv.project.name,
        version: inv.project.version,
        purl: purlOf(inv.project.name, inv.project.version),
      },
    },
    components,
    dependencies,
  };
}

/** Metadaten und Hauptkomponente nach TR-03183-2 (für Quell- und Build-SBOM gemeinsam). */
export function applyMetadata(
  bom: Bom,
  cfg: SbomConfig,
  opts: { toolDescription: string; toolVersion: string; status: string },
) {
  const author = cfg.sbomAuthor ?? cfg.manufacturer;
  const supplier = cfg.supplier ?? cfg.manufacturer;
  const md = bom.metadata;
  md.timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  md.tools ??= {};
  md.tools.components ??= [];
  md.tools.components.push({
    type: 'application',
    name: 'osp-data-mesh/scripts/sbom.ts',
    version: opts.toolVersion,
    description: opts.toolDescription,
  });
  // TR 8.2 "Creator of the SBOM" → metadata.manufacturer (url bzw. contact.email)
  md.manufacturer = orgEntity(author);
  md.authors = [{ name: author.name, ...(author.email ? { email: author.email } : {}) }];
  md.supplier = orgEntity(supplier);
  md.properties ??= [];
  setProperty(
    md,
    'osp:standard',
    `CycloneDX 1.6; ${TR_VERSION} (Abbildung nach Abschnitt 8.2), siehe docs/sicherheit.md`,
  );
  setProperty(md, 'osp:sbom-status', opts.status);
}

/** Sicherheitskontakt und Lizenz der Hauptkomponente. */
export function describePrimary(comp: CdxComponent, cfg: SbomConfig, license: string) {
  const supplier = cfg.supplier ?? cfg.manufacturer;
  comp.manufacturer = orgEntity(cfg.manufacturer);
  comp.supplier = orgEntity(supplier);
  comp.licenses = licenseChoices(license, true);
  const sc = cfg.securityContact;
  if (sc.email) addRef(comp, { type: 'security-contact', url: `mailto:${sc.email}` });
  else if (sc.url) addRef(comp, { type: 'security-contact', url: sc.url });
  if (sc.securityTxtUrl) addRef(comp, { type: 'rfc-9116', url: sc.securityTxtUrl });
  if (cfg.sourceCodeUrl) {
    addRef(comp, { type: 'vcs', url: cfg.sourceCodeUrl });
    addRef(comp, { type: 'source-distribution', url: cfg.sourceCodeUrl });
  }
  setProperty(comp, 'osp:tr03183:level', 'logical');
}

/** Graph vervollständigen (jede Komponente mit Eintrag) und Vollständigkeit angeben (TR 5.2.2). */
export function finishGraph(bom: Bom, rootRef: string, unknownRefs: string[]) {
  bom.dependencies ??= [];
  const known = new Set(bom.dependencies.map((d) => d.ref));
  for (const ref of [rootRef, ...bom.components.map((c) => c['bom-ref']!)])
    if (!known.has(ref)) bom.dependencies.push({ ref, dependsOn: [] });
  for (const d of bom.dependencies) d.dependsOn = [...new Set(d.dependsOn ?? [])].sort();
  bom.components.sort((a, b) => String(a['bom-ref']).localeCompare(String(b['bom-ref'])));
  bom.dependencies.sort((a, b) => a.ref.localeCompare(b.ref));
  const unknown = new Set(unknownRefs);
  bom.compositions = [
    {
      aggregate: 'complete',
      dependencies: [rootRef, ...bom.components.map((c) => c['bom-ref']!).filter((r) => !unknown.has(r))],
    },
    ...(unknown.size ? [{ aggregate: 'unknown', dependencies: [...unknown] }] : []),
  ];
}

export function enrich(
  bom: Bom,
  inv: Inventory,
  cfg: SbomConfig,
  generator: 'cdxgen' | 'builtin',
): { gaps: string[]; placeholders: string[] } {
  const placeholders = placeholderFindings(cfg);
  applyMetadata(bom, cfg, {
    toolDescription: `Anreicherung nach ${TR_VERSION} (Hersteller, Lizenzen, Urheber, Copyright, TR-Eigenschaften, Vollständigkeit)`,
    toolVersion: inv.project.version,
    status: placeholders.length
      ? `ENTWURF: Platzhalter für Hersteller/Lieferant/SBOM-Ersteller/Sicherheitskontakt (${placeholders.length} Felder), Entscheidung des Eigentümers offen`
      : 'Angaben vollständig',
  });
  const md = bom.metadata;
  md.lifecycles = [{ phase: 'pre-build' }];
  const rootRef = md.component?.['bom-ref'] ?? refOf(inv.project.name, inv.project.version);
  md.component = {
    ...(md.component ?? {}),
    type: 'application',
    'bom-ref': rootRef,
    name: inv.project.name,
    version: inv.project.version,
    description: inv.project.description,
    purl: purlOf(inv.project.name, inv.project.version),
  };
  delete md.component.group;
  describePrimary(md.component, cfg, inv.project.license);
  setProperty(
    md.component,
    'osp:license-status',
    'vorläufig; endgültige Lizenzwahl vor Veröffentlichung offen',
  );
  setProperty(
    md,
    'osp:sbom-generator',
    generator === 'cdxgen' ? `${CDXGEN} + scripts/sbom.ts` : 'scripts/sbom.ts (builtin)',
  );
  setProperty(
    md,
    'osp:related-sbom:build-ui',
    'bun run sbom -- build-ui (Build-SBOM der gebündelten Web-Oberfläche)',
  );
  setProperty(
    md,
    'osp:related-sbom:image',
    'sbom/osp-data-mesh.image.cdx.json (Container-Abbild, siehe docs/betrieb.md)',
  );

  const byNameVersion = new Map<string, Component>();
  for (const c of inv.components.values()) byNameVersion.set(`${c.name}@${c.version}`, c);

  const gaps = new Set<string>();
  for (const comp of bom.components) {
    const fullName = comp.group ? `${comp.group}/${comp.name}` : comp.name;
    const c = byNameVersion.get(`${fullName}@${comp.version}`);
    if (!c) {
      gaps.add(`Komponente ${fullName}@${comp.version} nicht in bun.lock gefunden (nicht angereichert)`);
      continue;
    }
    const shipped = c.usage.has('server') || c.usage.has('ui');
    comp.scope = shipped ? 'required' : 'excluded';
    describeNpmComponent(comp, c, gaps);
    setProperty(comp, 'osp:usage', [...c.usage].join(','));
  }
  const withoutCopyright = bom.components.filter((c) => c.purl?.startsWith('pkg:npm/') && !c.copyright);
  if (withoutCopyright.length)
    gaps.add(
      `${withoutCopyright.length} npm-Komponenten ohne Copyright-Vermerk (nicht installierte Plattformpakete oder kein Vermerk in LICENSE/NOTICE)`,
    );

  // Bun und PostgreSQL (identifiziert, Abhängigkeiten außerhalb dieser SBOM unbekannt)
  const platform = platformComponents();
  for (const p of platform)
    if (!bom.components.some((c) => c['bom-ref'] === p['bom-ref'])) bom.components.push(p);
  const platformRefs = platform.map((p) => p['bom-ref']!);

  // Graph: Hauptkomponente hängt von direkten Abhängigkeiten, Bun und PostgreSQL ab
  bom.dependencies ??= [];
  let rootDeps = bom.dependencies.find((d) => d.ref === rootRef);
  if (!rootDeps) {
    rootDeps = { ref: rootRef, dependsOn: [] };
    bom.dependencies.push(rootDeps);
  }
  rootDeps.dependsOn ??= [];
  for (const key of [...inv.directDependencies, ...inv.directDevDependencies]) {
    const c = inv.components.get(key);
    if (c) rootDeps.dependsOn.push(refOf(c.name, c.version));
  }
  rootDeps.dependsOn.push(...platformRefs);
  finishGraph(bom, rootRef, platformRefs);

  // Konsistenz: alle Verweise im Graphen müssen existieren
  const refs = new Set([rootRef, ...bom.components.map((c) => c['bom-ref'])]);
  for (const d of bom.dependencies) {
    if (!refs.has(d.ref)) gaps.add(`Abhängigkeitsgraph: unbekannte Referenz ${d.ref}`);
    for (const r of d.dependsOn ?? [])
      if (!refs.has(r)) gaps.add(`Abhängigkeitsgraph: unbekannte Referenz ${r}`);
  }
  if (!cfg.sourceCodeUrl)
    gaps.add('Quellcode-URI der Hauptkomponente: kein öffentliches Repository festgelegt (sourceCodeUrl)');
  return { gaps: [...gaps], placeholders };
}

// ---------------------------------------------------------------------------------------------------
// Selbstprüfung gegen die Pflichtfelder der TR-03183-2 v2.1.0 (Abschnitte 5.2.1, 5.2.2, 3.2.2, 3.2.4)

const BSI_VALUES: Record<string, string[]> = {
  'bsi:component:executable': ['executable', 'non-executable'],
  'bsi:component:archive': ['archive', 'no archive'],
  'bsi:component:structured': ['structured', 'unstructured'],
};

function hasCreator(e: OrgEntity | undefined): boolean {
  return !!e && (!!e.url?.some((u) => u) || !!e.contact?.some((c) => c.email));
}

/** Gibt fehlende Pflichtangaben zurück (leer = alle Pflichtfelder vorhanden). Platzhalter prüft placeholderFindings. */
export function checkTr03183(bom: Bom): string[] {
  const issues: string[] = [];
  const md = bom.metadata;
  if (!hasCreator(md.manufacturer))
    issues.push('SBOM: Ersteller (metadata.manufacturer mit E-Mail oder URL) fehlt');
  if (!md.timestamp || !/Z$/.test(md.timestamp)) issues.push('SBOM: Zeitstempel (UTC) fehlt');
  if (!bom.serialNumber) issues.push('SBOM: SBOM-URI (serialNumber) fehlt');
  if (!['1.6', '1.7'].includes(bom.specVersion)) issues.push(`SBOM: CycloneDX ${bom.specVersion} < 1.6`);
  const graph = new Map((bom.dependencies ?? []).map((d) => [d.ref, d]));
  const covered = new Set((bom.compositions ?? []).flatMap((c) => c.dependencies ?? []));
  const all = [...(md.component ? [md.component] : []), ...bom.components];
  for (const comp of all) {
    const id = comp['bom-ref'] ?? comp.name;
    const level = getProperty(comp, 'osp:tr03183:level') ?? 'full';
    if (!hasCreator(comp.manufacturer))
      issues.push(`${id}: Urheber (manufacturer mit E-Mail oder URL) fehlt`);
    if (!comp.name) issues.push(`${id}: Name fehlt`);
    if (!comp.version) issues.push(`${id}: Version fehlt`);
    if (level === 'identified') {
      if (!comp.purl && !comp.cpe) issues.push(`${id}: eindeutige Kennung (purl/cpe) fehlt`);
      continue;
    }
    if (!graph.has(id)) issues.push(`${id}: kein Eintrag im Abhängigkeitsgraphen`);
    if (!covered.has(id))
      issues.push(`${id}: Vollständigkeit der Abhängigkeiten nicht angegeben (compositions)`);
    const concluded = comp.licenses?.some(
      (l) => l.acknowledgement === 'concluded' || l.license?.acknowledgement === 'concluded',
    );
    if (!concluded) issues.push(`${id}: Distributionslizenz (acknowledgement concluded) fehlt`);
    if (level === 'logical') continue;
    if (!getProperty(comp, 'bsi:component:filename')) issues.push(`${id}: Dateiname fehlt`);
    const dist = comp.externalReferences?.find((r) => r.type === 'distribution');
    if (!dist?.hashes?.some((h) => h.alg === 'SHA-512' && /^[0-9a-f]{128}$/.test(h.content)))
      issues.push(`${id}: SHA-512 der auslieferbaren Form (externalReferences distribution) fehlt`);
    for (const [prop, allowed] of Object.entries(BSI_VALUES)) {
      const values = (comp.properties ?? []).filter((p) => p.name === prop).map((p) => p.value);
      if (values.length !== 1 || !allowed.includes(values[0]!))
        issues.push(`${id}: ${prop} muss genau einmal mit ${allowed.join('|')} vorkommen`);
    }
  }
  if (JSON.stringify(bom).includes('"vulnerabilities"'))
    issues.push('SBOM enthält Schwachstelleninformationen (TR 3.1: nicht erlaubt)');
  return issues;
}

// ---------------------------------------------------------------------------------------------------
// Schema-Prüfung, Signatur, Ausgabe

/** Pfad zur Anzeige: relativ zum Repository, außerhalb absolut. */
export function displayPath(p: string): string {
  const rel = relative(ROOT, p);
  return rel.startsWith('..') || isAbsolute(rel) ? p : rel;
}

export function validate(file: string): boolean {
  const proc = Bun.spawnSync(
    [
      'bun',
      'x',
      '-p',
      CDXGEN,
      'cdx-validate',
      '-i',
      file,
      '--no-deep',
      '--no-include-manual',
      '--strict',
      '--fail-severity',
      'critical',
    ],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  if (proc.exitCode === 0) {
    console.log(`Schema-Prüfung (cdx-validate): ok – ${displayPath(file)}`);
    return true;
  }
  console.error(`Schema-Prüfung (cdx-validate) fehlgeschlagen (Exit ${proc.exitCode}):\n${out.slice(-3000)}`);
  return false;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function resolveSigningKey(args: string[]): string | null {
  const path = argValue(args, '--sign-key') ?? process.env.OSP_SBOM_SIGNING_KEY;
  if (!path) return null;
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new Error(`Signaturschlüssel nicht gefunden: ${abs}`);
  return readFileSync(abs, 'utf8');
}

export function trustedPublicKey(cfg: SbomConfig, args: string[]): { pem: string; path: string } | null {
  const path = argValue(args, '--public-key') ?? cfg.signing?.publicKey ?? null;
  if (!path) return null;
  const abs = isAbsolute(path) ? path : resolve(ROOT, path);
  if (!existsSync(abs)) throw new Error(`öffentlicher Schlüssel nicht gefunden: ${abs}`);
  return { pem: readFileSync(abs, 'utf8'), path: abs };
}

/** Signiert (falls Schlüssel angegeben), prüft gegen den veröffentlichten Schlüssel und schreibt die Datei. */
export function signAndWrite(bom: Bom, file: string, cfg: SbomConfig, args: string[]): boolean {
  const key = resolveSigningKey(args);
  let out: Bom = bom;
  if (key) {
    out = signBom(bom, key) as Bom;
    const trusted = trustedPublicKey(cfg, args);
    const check = verifyBom(out, trusted?.pem);
    if (!check.ok) throw new Error(`Signatur nach dem Signieren ungültig: ${check.reason}`);
    console.log(
      `Signiert (JSF ${check.algorithm}, Schlüssel sha256:${check.keyFingerprint})${trusted ? ', geprüft gegen den veröffentlichten Schlüssel' : ''}`,
    );
  }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  return !!key;
}

export function warnPlaceholders(placeholders: string[]) {
  if (!placeholders.length) return;
  const line = '!'.repeat(100);
  console.warn(`\n${line}`);
  console.warn('!! ACHTUNG: Die SBOM enthält PLATZHALTER für Angaben, die der Eigentümer festlegen muss.');
  console.warn(
    '!! Vor einer Veröffentlichung in sbom/sbom.config.json eintragen (Anleitung: docs/sicherheit.md):',
  );
  for (const p of placeholders) console.warn(`!!   - ${p}`);
  console.warn(`${line}\n`);
}

function cmdVerify(args: string[]) {
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--public-key') ?? OUT_FILE;
  const cfg = loadConfig();
  const trusted = trustedPublicKey(cfg, args);
  const bom = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8')) as Record<string, unknown>;
  const r = verifyBom(bom, trusted?.pem);
  if (!r.ok) {
    console.error(`Signatur UNGÜLTIG (${file}): ${r.reason}`);
    process.exit(1);
  }
  console.log(`Signatur gültig (${file}): JSF ${r.algorithm}, Schlüssel sha256:${r.keyFingerprint}`);
  if (r.pinned)
    console.log(`Herkunft bestätigt: signiert mit dem vertrauenswürdigen Schlüssel ${trusted?.path}`);
  else
    console.warn(
      'Nur Unversehrtheit geprüft (eingebetteter Schlüssel). Herkunft: Fingerabdruck mit dem veröffentlichten vergleichen oder --public-key <pem> angeben.',
    );
}

function cmdKeygen(args: string[]) {
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir)
    throw new Error('Verzeichnis angeben: bun run sbom -- keygen <verzeichnis außerhalb des Repositorys>');
  const abs = resolve(process.cwd(), dir);
  const rel = relative(ROOT, abs);
  if (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith('.local'))
    throw new Error(
      `Der private Schlüssel darf nicht ins Repository (${abs}); Verzeichnis außerhalb wählen.`,
    );
  mkdirSync(abs, { recursive: true });
  const keyFile = join(abs, 'sbom-signing.key');
  const pubFile = join(abs, 'sbom-signing.pub.pem');
  if (existsSync(keyFile)) throw new Error(`${keyFile} existiert bereits (nicht überschrieben)`);
  const kp = generateSigningKeyPair();
  writeFileSync(keyFile, kp.privateKeyPem, { mode: 0o600 });
  writeFileSync(pubFile, kp.publicKeyPem);
  console.log(`Privater Schlüssel: ${keyFile} (0600, geheim halten)`);
  console.log(`Öffentlicher Schlüssel: ${pubFile} → nach sbom/signing-key.pub.pem kopieren und in`);
  console.log('sbom/sbom.config.json unter signing.publicKey eintragen; Fingerabdruck veröffentlichen:');
  console.log(`  sha256:${kp.fingerprint}`);
}

async function main(args: string[]) {
  if (args[0] === 'verify') return cmdVerify(args.slice(1));
  if (args[0] === 'keygen') return cmdKeygen(args.slice(1));
  if (args[0] === 'build-ui') {
    const { buildUiSbom } = await import('./sbom-build.ts');
    return buildUiSbom(args.slice(1));
  }
  const release = args.includes('--release');
  const cfg = loadConfig();
  const inv = buildInventory();
  let generator: 'cdxgen' | 'builtin' = 'builtin';
  let bom: Bom | null = null;
  if (!args.includes('--builtin')) {
    bom = runCdxgen();
    if (bom) generator = 'cdxgen';
  }
  bom ??= builtinBom(inv);
  const registryNotes: string[] = [];
  if (!args.includes('--offline') && !args.includes('--builtin')) {
    const { filled, failed } = await fillFromRegistry(inv);
    if (filled)
      registryNotes.push(
        `${filled} nicht installierte Pakete: Lizenz/Urheber aus dem npm-Registry-Manifest (Integrität = bun.lock)`,
      );
    for (const f of failed) registryNotes.push(`Registry: ${f} (Lizenz bleibt geerbt)`);
  }
  const { gaps, placeholders } = enrich(bom, inv, cfg, generator);
  gaps.unshift(...registryNotes);
  const issues = checkTr03183(bom);
  mkdirSync(OUT_DIR, { recursive: true });
  const signed = signAndWrite(bom, OUT_FILE, cfg, args);
  const shipped = bom.components.filter((c) => c.scope === 'required').length;
  console.log(
    `SBOM geschrieben: sbom/osp-data-mesh.cdx.json (CycloneDX ${bom.specVersion}, Generator: ${generator}, ` +
      `${bom.components.length} Komponenten, davon ${shipped} zur Laufzeit benötigt, ${bom.dependencies?.length ?? 0} Graph-Einträge)`,
  );
  console.log(
    issues.length
      ? `TR-03183-2-Selbstprüfung: ${issues.length} fehlende Pflichtangaben:\n${issues.map((i) => `  - ${i}`).join('\n')}`
      : `TR-03183-2-Selbstprüfung (${TR_VERSION}, Pflichtfelder): ok`,
  );
  if (gaps.length) {
    console.log('Hinweise:');
    for (const g of gaps) console.log(`  - ${g}`);
  }
  if (!signed) console.warn('Nicht signiert (kein --sign-key bzw. OSP_SBOM_SIGNING_KEY).');
  warnPlaceholders(placeholders);
  let ok = true;
  // eingebauter Generator (offline): Schema-Prüfung nur auf Wunsch (--validate), da sie cdxgen lädt
  const wantValidate =
    !args.includes('--no-validate') && (generator === 'cdxgen' || args.includes('--validate'));
  if (wantValidate && !validate(OUT_FILE)) ok = false;
  if (release && (placeholders.length || issues.length || !signed)) {
    console.error('--release: abgebrochen (Platzhalter, TR-Lücken oder fehlende Signatur, siehe oben).');
    ok = false;
  }
  if (!ok) process.exit(1);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
