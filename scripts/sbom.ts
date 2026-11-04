/**
 * Software-Stückliste (SBOM) im Format CycloneDX 1.6 (JSON), angereichert für BSI TR-03183-2.
 *
 *   bun run sbom                  cdxgen (über `bun x`, versioniert) liest bun.lock; danach Anreicherung
 *   bun run sbom -- --builtin     ohne cdxgen (z. B. offline): eigener Generator aus bun.lock
 *   bun run sbom -- --no-validate ohne anschließende Schema-Prüfung
 *
 * Ergebnis: sbom/osp-data-mesh.cdx.json
 *
 * Anreicherung (siehe docs/sicherheit.md, Abschnitt SBOM):
 *  - Metadaten: Zeitstempel, Werkzeuge, Hersteller/Lieferant (Platzhalter "Auftragnehmer (tbd)"),
 *    Hauptkomponente mit Lizenz EUPL-1.2
 *  - je Komponente: Lizenz (aus node_modules/<paket>/package.json, sonst vom einbindenden Paket geerbt),
 *    SHA-512 (Integrität aus bun.lock), purl, Urheber, Verweise (Website, Quellcode, Download),
 *    Geltungsbereich (required = ausgeliefert, excluded = nur Build/Entwicklung),
 *    TR-03183-2-Eigenschaften bsi:component:filename/executable/archive/structured
 *  - Abhängigkeitsgraph
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInventory, type Component, type Inventory, ROOT } from './licenses.ts';

const CDXGEN = '@cyclonedx/cdxgen@12.9.0';
const OUT_DIR = join(ROOT, 'sbom');
const OUT_FILE = join(OUT_DIR, 'osp-data-mesh.cdx.json');
const SUPPLIER_PLACEHOLDER = 'Auftragnehmer (tbd)';

interface Property {
  name: string;
  value: string;
}
interface ExternalReference {
  type: string;
  url: string;
}
interface LicenseChoice {
  license?: { id?: string; name?: string };
  expression?: string;
}
interface CdxComponent {
  type: string;
  'bom-ref'?: string;
  group?: string;
  name: string;
  version?: string;
  description?: string;
  scope?: 'required' | 'optional' | 'excluded';
  purl?: string;
  hashes?: { alg: string; content: string }[];
  licenses?: LicenseChoice[];
  authors?: { name?: string; email?: string }[];
  supplier?: { name: string; url?: string[] };
  manufacturer?: { name: string; url?: string[] };
  externalReferences?: ExternalReference[];
  properties?: Property[];
  [key: string]: unknown;
}
interface Bom {
  bomFormat: 'CycloneDX';
  specVersion: string;
  serialNumber?: string;
  version: number;
  metadata: {
    timestamp?: string;
    tools?: { components?: CdxComponent[] };
    authors?: { name?: string; email?: string }[];
    supplier?: { name: string; url?: string[] };
    manufacturer?: { name: string; url?: string[] };
    component?: CdxComponent;
    properties?: Property[];
    [key: string]: unknown;
  };
  components: CdxComponent[];
  dependencies?: { ref: string; dependsOn?: string[] }[];
  [key: string]: unknown;
}

function purlOf(name: string, version: string): string {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

function refOf(name: string, version: string): string {
  return `pkg:npm/${name}@${version}`;
}

function sriToHex(integrity: string | null): { alg: string; content: string } | null {
  if (!integrity) return null;
  const m = integrity.match(/^(sha512|sha384|sha256|sha1)-(.+)$/);
  if (!m) return null;
  const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1] as 'sha512'];
  return { alg, content: Buffer.from(m[2]!, 'base64').toString('hex') };
}

function tarballUrl(name: string, version: string): string {
  const base = name.includes('/') ? name.split('/')[1]! : name;
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

function licenseChoices(license: string): LicenseChoice[] {
  const simple = /^[A-Za-z0-9.+-]+$/.test(license);
  return simple ? [{ license: { id: license } }] : [{ expression: license.replace(/^\((.*)\)$/, '$1') }];
}

function setProperty(c: { properties?: Property[] }, name: string, value: string) {
  c.properties ??= [];
  const existing = c.properties.find((p) => p.name === name);
  if (existing) existing.value = value;
  else c.properties.push({ name, value });
}

function addRef(c: CdxComponent, type: string, url: string | null) {
  if (!url) return;
  c.externalReferences ??= [];
  if (!c.externalReferences.some((r) => r.type === type)) c.externalReferences.push({ type, url });
}

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
function builtinBom(inv: Inventory): Bom {
  const rootRef = refOf(inv.project.name, inv.project.version);
  const components: CdxComponent[] = [];
  for (const c of inv.components.values()) {
    const [group, name] = c.name.startsWith('@') ? (c.name.split('/') as [string, string]) : ['', c.name];
    const hash = sriToHex(c.integrity);
    components.push({
      type: 'library',
      'bom-ref': refOf(c.name, c.version),
      ...(group ? { group } : {}),
      name,
      version: c.version,
      purl: purlOf(c.name, c.version),
      ...(hash ? { hashes: [hash] } : {}),
      externalReferences: [{ type: 'distribution', url: tarballUrl(c.name, c.version) }],
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
      dependsOn: c.resolvedDeps.map((k) => byKey.get(k)!).map((d) => refOf(d.name, d.version)),
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

function enrich(bom: Bom, inv: Inventory, generator: 'cdxgen' | 'builtin'): { gaps: string[] } {
  const supplier = { name: SUPPLIER_PLACEHOLDER };
  const md = bom.metadata;
  md.timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  md.tools ??= {};
  md.tools.components ??= [];
  md.tools.components.push({
    type: 'application',
    name: 'osp-data-mesh/scripts/sbom.ts',
    version: inv.project.version,
    description: 'Anreicherung für BSI TR-03183-2 (Lizenzen, Urheber, TR-Eigenschaften, Geltungsbereich)',
  });
  md.authors = [{ name: SUPPLIER_PLACEHOLDER }];
  md.supplier = supplier;
  md.manufacturer = supplier;
  const rootRef = md.component?.['bom-ref'] ?? refOf(inv.project.name, inv.project.version);
  md.component = {
    ...(md.component ?? {}),
    type: 'application',
    'bom-ref': rootRef,
    name: inv.project.name,
    version: inv.project.version,
    description: inv.project.description,
    purl: purlOf(inv.project.name, inv.project.version),
    licenses: [{ license: { id: inv.project.license } }],
    supplier,
    manufacturer: supplier,
  };
  delete md.component.group;
  setProperty(
    md.component,
    'osp:license-status',
    'vorläufig; endgültige Lizenzwahl vor Veröffentlichung offen',
  );
  md.properties ??= [];
  setProperty(
    md,
    'osp:sbom-generator',
    generator === 'cdxgen' ? `${CDXGEN} + scripts/sbom.ts` : 'scripts/sbom.ts (builtin)',
  );
  setProperty(
    md,
    'osp:standard',
    'CycloneDX 1.6; Anreicherung nach BSI TR-03183-2 (Abschnitt 5.2), siehe docs/sicherheit.md',
  );

  const byNameVersion = new Map<string, Component>();
  for (const c of inv.components.values()) byNameVersion.set(`${c.name}@${c.version}`, c);

  const gaps = new Set<string>();
  let noCreator = 0;
  for (const comp of bom.components) {
    const fullName = comp.group ? `${comp.group}/${comp.name}` : comp.name;
    const c = byNameVersion.get(`${fullName}@${comp.version}`);
    if (!c) {
      gaps.add(`Komponente ${fullName}@${comp.version} nicht in bun.lock gefunden (nicht angereichert)`);
      continue;
    }
    if (!comp.group) delete comp.group;
    comp.purl ??= purlOf(c.name, c.version);
    comp['bom-ref'] ??= refOf(c.name, c.version);
    const shipped = c.usage.has('server') || c.usage.has('ui');
    comp.scope = shipped ? 'required' : 'excluded';
    const hash = sriToHex(c.integrity);
    if (hash && !comp.hashes?.some((h) => h.alg === hash.alg)) comp.hashes = [...(comp.hashes ?? []), hash];
    if (!comp.hashes?.some((h) => h.alg === 'SHA-512')) gaps.add(`${fullName}@${c.version}: kein SHA-512`);
    if (c.meta.license) comp.licenses = licenseChoices(c.meta.license);
    else gaps.add(`${fullName}@${c.version}: Lizenz unbekannt`);
    if (c.meta.description && !comp.description) comp.description = c.meta.description;
    const a = c.meta.author;
    if (a && (a.name || a.email)) {
      comp.authors = [{ ...(a.name ? { name: a.name } : {}), ...(a.email ? { email: a.email } : {}) }];
    }
    addRef(comp, 'website', c.meta.homepage ?? a?.url ?? null);
    addRef(comp, 'vcs', c.meta.repository);
    addRef(comp, 'distribution', tarballUrl(c.name, c.version));
    if (!a?.email && !a?.url && !c.meta.homepage && !c.meta.repository) noCreator++;
    const base = c.name.includes('/') ? c.name.split('/')[1]! : c.name;
    setProperty(comp, 'bsi:component:filename', `${base}-${c.version}.tgz`);
    setProperty(
      comp,
      'bsi:component:executable',
      c.platformSpecific || c.hasBin ? 'executable' : 'non-executable',
    );
    setProperty(comp, 'bsi:component:archive', 'archive');
    setProperty(comp, 'bsi:component:structured', 'structured');
    setProperty(comp, 'osp:usage', [...c.usage].join(','));
    setProperty(
      comp,
      'osp:license-source',
      c.meta.licenseSource === 'inherited' ? `inherited:${c.meta.inheritedFrom}` : c.meta.licenseSource,
    );
    if (c.platformSpecific)
      setProperty(comp, 'osp:platform-specific', c.meta.installed ? 'installed' : 'not-installed');
  }
  if (noCreator)
    gaps.add(`${noCreator} Komponenten ohne Urheber-E-Mail/-URL (TR-03183-2: Component creator)`);

  // Laufzeitumgebung Bun als Plattform-Komponente
  const bunVersion = bunVersionFromDockerfile();
  const bunRef = `pkg:generic/bun@${bunVersion}`;
  if (!bom.components.some((c) => c['bom-ref'] === bunRef)) {
    bom.components.push({
      type: 'platform',
      'bom-ref': bunRef,
      name: 'bun',
      version: bunVersion,
      description:
        'JavaScript-Laufzeitumgebung (Server, CLI, Build); im Container über das Basisabbild oven/bun',
      scope: 'required',
      purl: `pkg:generic/bun@${bunVersion}`,
      licenses: [{ license: { id: 'MIT' } }],
      supplier: { name: 'Oven', url: ['https://bun.sh'] },
      externalReferences: [
        { type: 'website', url: 'https://bun.sh' },
        { type: 'vcs', url: 'https://github.com/oven-sh/bun' },
      ],
      properties: [
        { name: 'bsi:component:filename', value: 'bun' },
        { name: 'bsi:component:executable', value: 'executable' },
        { name: 'bsi:component:archive', value: 'no archive' },
        { name: 'bsi:component:structured', value: 'unstructured' },
        { name: 'osp:usage', value: 'server' },
      ],
    });
    gaps.add(
      'bun: kein Hash (Binärdatei stammt aus dem Container-Basisabbild bzw. der lokalen Installation)',
    );
  }

  // Abhängigkeitsgraph: Hauptkomponente hängt von direkten Abhängigkeiten und Bun ab
  bom.dependencies ??= [];
  let rootDeps = bom.dependencies.find((d) => d.ref === rootRef);
  if (!rootDeps) {
    rootDeps = { ref: rootRef, dependsOn: [] };
    bom.dependencies.push(rootDeps);
  }
  rootDeps.dependsOn ??= [];
  for (const key of [...inv.directDependencies, ...inv.directDevDependencies]) {
    const c = inv.components.get(key);
    if (c && !rootDeps.dependsOn.includes(refOf(c.name, c.version)))
      rootDeps.dependsOn.push(refOf(c.name, c.version));
  }
  if (!rootDeps.dependsOn.includes(bunRef)) rootDeps.dependsOn.push(bunRef);
  if (!bom.dependencies.some((d) => d.ref === bunRef)) bom.dependencies.push({ ref: bunRef, dependsOn: [] });

  // Konsistenz: alle Verweise im Graphen müssen existieren
  const refs = new Set([rootRef, ...bom.components.map((c) => c['bom-ref'])]);
  for (const d of bom.dependencies) {
    if (!refs.has(d.ref)) gaps.add(`Abhängigkeitsgraph: unbekannte Referenz ${d.ref}`);
    for (const r of d.dependsOn ?? [])
      if (!refs.has(r)) gaps.add(`Abhängigkeitsgraph: unbekannte Referenz ${r}`);
  }

  bom.components.sort((a, b) => String(a['bom-ref']).localeCompare(String(b['bom-ref'])));
  bom.dependencies.sort((a, b) => a.ref.localeCompare(b.ref));
  gaps.add('Hersteller/Lieferant und SBOM-Ersteller: Platzhalter "Auftragnehmer (tbd)" ohne E-Mail/URL');
  return { gaps: [...gaps] };
}

function validate(file: string): boolean {
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
    console.log('Schema-Prüfung (cdx-validate): ok');
    return true;
  }
  console.error(`Schema-Prüfung (cdx-validate) fehlgeschlagen (Exit ${proc.exitCode}):\n${out.slice(-3000)}`);
  return false;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const inv = buildInventory();
  let generator: 'cdxgen' | 'builtin' = 'builtin';
  let bom: Bom | null = null;
  if (!args.includes('--builtin')) {
    bom = runCdxgen();
    if (bom) generator = 'cdxgen';
  }
  bom ??= builtinBom(inv);
  const { gaps } = enrich(bom, inv, generator);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(bom, null, 2)}\n`);
  const shipped = bom.components.filter((c) => c.scope === 'required').length;
  console.log(
    `SBOM geschrieben: sbom/osp-data-mesh.cdx.json (CycloneDX ${bom.specVersion}, Generator: ${generator}, ` +
      `${bom.components.length} Komponenten, davon ${shipped} ausgeliefert, ${bom.dependencies?.length ?? 0} Graph-Einträge)`,
  );
  if (gaps.length) {
    console.log('Offene Punkte (TR-03183-2):');
    for (const g of gaps) console.log(`  - ${g}`);
  }
  if (!args.includes('--no-validate') && generator === 'cdxgen' && !validate(OUT_FILE)) process.exit(1);
}
