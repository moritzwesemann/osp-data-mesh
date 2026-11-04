/**
 * Drittkomponenten und Lizenzen.
 *
 *   bun scripts/licenses.ts            erzeugt docs/lizenzen.md
 *   bun scripts/licenses.ts --check    prüft nur (Exit-Code 1 bei unbekannten Lizenzen)
 *
 * Grundlage sind bun.lock (vollständiger Abhängigkeitsbaum inkl. SHA-512-Integrität) und die
 * package.json-Dateien unter node_modules (Lizenz, Urheber, Repository). Nicht installierte
 * plattformspezifische Pakete (z. B. Binärpakete für andere Betriebssysteme) erben die Lizenz des
 * Pakets, das sie als optionale Abhängigkeit einbindet; das wird in der Tabelle gekennzeichnet.
 *
 * Die Funktionen werden auch von scripts/sbom.ts verwendet.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '..');

/** Pakete, die in die Web-Oberfläche (dist/ui) gebündelt und damit ausgeliefert werden. */
export const UI_BUNDLE_ROOTS = ['react', 'react-dom', 'react-router', '@tanstack/react-query', 'zod'];

export type Usage = 'server' | 'ui' | 'dev';

export interface LockPackage {
  /** Schlüssel in bun.lock (bei Versionskonflikten verschachtelt, z. B. "a/b") */
  key: string;
  name: string;
  version: string;
  /** SRI-Integrität aus bun.lock, z. B. "sha512-…" */
  integrity: string | null;
  dependencies: string[];
  optionalDependencies: string[];
  /** Paket ist auf bestimmte Plattformen beschränkt (os/cpu in bun.lock) */
  platformSpecific: boolean;
  hasBin: boolean;
}

export interface PackageMeta {
  license: string | null;
  /** Herkunft der Lizenzangabe */
  licenseSource: 'package.json' | 'inherited' | 'unknown';
  inheritedFrom?: string;
  installed: boolean;
  description: string | null;
  author: { name?: string; email?: string; url?: string } | null;
  homepage: string | null;
  repository: string | null;
}

export interface Component extends LockPackage {
  usage: Set<Usage>;
  direct: boolean;
  meta: PackageMeta;
  /** aufgelöste Abhängigkeiten (Lock-Schlüssel) */
  resolvedDeps: string[];
}

export interface Inventory {
  project: { name: string; version: string; license: string; description: string };
  components: Map<string, Component>;
  directDependencies: string[];
  directDevDependencies: string[];
}

type LockEntry = [string, string, Record<string, unknown>, string?];

interface LockFile {
  lockfileVersion: number;
  workspaces: Record<
    string,
    { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  >;
  packages: Record<string, LockEntry>;
}

function splitNameVersion(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec, version: '' };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

export function readLock(root = ROOT): LockFile {
  const text = readFileSync(join(root, 'bun.lock'), 'utf8');
  return Bun.JSONC.parse(text) as LockFile;
}

export function parseLockPackages(lock: LockFile): Map<string, LockPackage> {
  const out = new Map<string, LockPackage>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const [spec, , info = {}, integrity] = entry;
    const { name, version } = splitNameVersion(spec);
    const deps = Object.keys((info.dependencies as Record<string, string> | undefined) ?? {});
    const optional = Object.keys((info.optionalDependencies as Record<string, string> | undefined) ?? {});
    out.set(key, {
      key,
      name,
      version,
      integrity: typeof integrity === 'string' && integrity.length > 0 ? integrity : null,
      dependencies: deps,
      optionalDependencies: optional,
      platformSpecific: 'os' in info || 'cpu' in info,
      hasBin: 'bin' in info,
    });
  }
  return out;
}

/** Löst eine Abhängigkeit wie Bun auf: zuerst verschachtelt unter dem Elternschlüssel, dann aufwärts. */
export function resolveDep(
  packages: Map<string, LockPackage>,
  parentKey: string,
  dep: string,
): string | null {
  let prefix = parentKey;
  while (prefix) {
    const candidate = `${prefix}/${dep}`;
    if (packages.has(candidate)) return candidate;
    const parent = packages.get(prefix);
    if (!parent) break;
    const cut = prefix.length - parent.name.length - 1;
    prefix = cut > 0 ? prefix.slice(0, cut) : '';
  }
  return packages.has(dep) ? dep : null;
}

function nodeModulesPath(root: string, pkg: LockPackage): string {
  // "a/b" (b verschachtelt unter a) → node_modules/a/node_modules/b
  const parts: string[] = [];
  let key = pkg.key;
  let name = pkg.name;
  while (key !== name) {
    parts.unshift(name);
    key = key.slice(0, key.length - name.length - 1);
    // Name des Elternpakets: Schlüssel endet auf dessen Namen (mit Scope zwei Segmente)
    const segs = key.split('/');
    name =
      segs.length >= 2 && segs[segs.length - 2]?.startsWith('@') ? segs.slice(-2).join('/') : segs.at(-1)!;
  }
  parts.unshift(name);
  return join(root, 'node_modules', parts.join('/node_modules/'), 'package.json');
}

function normalizeLicense(pj: Record<string, unknown>): string | null {
  const lic = pj.license;
  if (typeof lic === 'string' && lic.trim()) return lic.trim();
  if (lic && typeof lic === 'object' && typeof (lic as { type?: unknown }).type === 'string') {
    return (lic as { type: string }).type;
  }
  if (Array.isArray(pj.licenses)) {
    const types = pj.licenses
      .map((l) => (l && typeof l === 'object' ? (l as { type?: unknown }).type : l))
      .filter((t): t is string => typeof t === 'string');
    if (types.length === 1) return types[0]!;
    if (types.length > 1) return `(${types.join(' OR ')})`;
  }
  return null;
}

function parseAuthor(a: unknown): PackageMeta['author'] {
  if (!a) return null;
  if (typeof a === 'string') {
    const m = a.match(/^([^<(]*?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?$/);
    const name = m?.[1]?.trim();
    return {
      ...(name ? { name } : {}),
      ...(m?.[2] ? { email: m[2] } : {}),
      ...(m?.[3] ? { url: m[3] } : {}),
    };
  }
  if (typeof a === 'object') {
    const o = a as Record<string, unknown>;
    return {
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(typeof o.email === 'string' ? { email: o.email } : {}),
      ...(typeof o.url === 'string' ? { url: o.url } : {}),
    };
  }
  return null;
}

function normalizeRepo(r: unknown): string | null {
  let url: string | null = null;
  if (typeof r === 'string') url = r;
  else if (r && typeof r === 'object' && typeof (r as { url?: unknown }).url === 'string')
    url = (r as { url: string }).url;
  if (!url) return null;
  url = url
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  if (url.startsWith('github:')) url = `https://github.com/${url.slice(7)}`;
  return url;
}

function readMeta(root: string, pkg: LockPackage): PackageMeta {
  const path = nodeModulesPath(root, pkg);
  if (existsSync(path)) {
    const pj = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (pj.version === pkg.version) {
      const license = normalizeLicense(pj);
      return {
        license,
        licenseSource: license ? 'package.json' : 'unknown',
        installed: true,
        description: typeof pj.description === 'string' ? pj.description : null,
        author: parseAuthor(pj.author),
        homepage: typeof pj.homepage === 'string' ? pj.homepage : null,
        repository: normalizeRepo(pj.repository),
      };
    }
  }
  return {
    license: null,
    licenseSource: 'unknown',
    installed: false,
    description: null,
    author: null,
    homepage: null,
    repository: null,
  };
}

/** Liest Lockfile + node_modules und klassifiziert jede Komponente nach Verwendung. */
export function buildInventory(root = ROOT): Inventory {
  const pj = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license: string;
    description?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const lock = readLock(root);
  const packages = parseLockPackages(lock);
  const directDeps = Object.keys(pj.dependencies ?? {});
  const directDev = Object.keys(pj.devDependencies ?? {});

  const components = new Map<string, Component>();
  for (const pkg of packages.values()) {
    const resolvedDeps = [...pkg.dependencies, ...pkg.optionalDependencies]
      .map((d) => resolveDep(packages, pkg.key, d))
      .filter((k): k is string => k !== null);
    components.set(pkg.key, {
      ...pkg,
      usage: new Set(),
      direct: directDeps.includes(pkg.key) || directDev.includes(pkg.key),
      meta: readMeta(root, pkg),
      resolvedDeps,
    });
  }

  const mark = (rootKeys: string[], usage: Usage) => {
    const stack = rootKeys.filter((k) => components.has(k));
    const seen = new Set<string>();
    while (stack.length) {
      const key = stack.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = components.get(key)!;
      c.usage.add(usage);
      stack.push(...c.resolvedDeps);
    }
  };
  mark(directDeps, 'server');
  mark(
    UI_BUNDLE_ROOTS.filter((n) => directDev.includes(n) || directDeps.includes(n)),
    'ui',
  );
  for (const c of components.values()) if (c.usage.size === 0) c.usage.add('dev');

  // Nicht installierte plattformspezifische Pakete: Lizenz vom einbindenden Paket erben
  for (const c of components.values()) {
    if (c.meta.license) continue;
    const parent = [...components.values()].find(
      (p) => p.meta.license && p.optionalDependencies.includes(c.name) && p.resolvedDeps.includes(c.key),
    );
    if (parent) {
      c.meta.license = parent.meta.license;
      c.meta.licenseSource = 'inherited';
      c.meta.inheritedFrom = `${parent.name}@${parent.version}`;
      c.meta.repository ??= parent.meta.repository;
      c.meta.homepage ??= parent.meta.homepage;
    }
  }

  return {
    project: {
      name: pj.name,
      version: pj.version,
      license: pj.license,
      description: pj.description ?? '',
    },
    components,
    directDependencies: directDeps,
    directDevDependencies: directDev,
  };
}

export const USAGE_LABEL: Record<Usage, string> = {
  server: 'Server (Laufzeit)',
  ui: 'Web-Oberfläche (gebündelt)',
  dev: 'Build/Entwicklung',
};

/** Komponenten außerhalb von npm, die zur Laufzeit bzw. im Container-Betrieb verwendet werden. */
export const EXTERNAL_COMPONENTS: { name: string; use: string; license: string; source: string }[] = [
  {
    name: 'Bun (Laufzeitumgebung)',
    use: 'Server, CLI, Build',
    license: 'MIT (enthält Komponenten unter weiteren Lizenzen, u. a. JavaScriptCore: LGPL-2.1)',
    source: 'https://bun.sh',
  },
  {
    name: 'PostgreSQL 18 (Server, Client-Werkzeuge pg_dump/pg_restore/psql)',
    use: 'Datenbank, Sicherung',
    license: 'PostgreSQL',
    source: 'https://www.postgresql.org',
  },
  { name: 'Caddy 2', use: 'TLS-Reverse-Proxy', license: 'Apache-2.0', source: 'https://caddyserver.com' },
  {
    name: 'Container-Basisabbilder oven/bun (Debian), postgres, caddy',
    use: 'Container-Betrieb',
    license: 'je Abbild verschieden (Debian-Pakete: überwiegend GPL/LGPL/BSD/MIT)',
    source: 'Docker Hub',
  },
  {
    name: 'Apache Superset (optional, Profil „bi“)',
    use: 'BI-Referenz-Dashboards',
    license: 'Apache-2.0',
    source: 'https://superset.apache.org',
  },
  {
    name: 'psycopg2-binary (optional, im Superset-Abbild)',
    use: 'PostgreSQL-Treiber für Superset',
    license: 'LGPL-3.0-or-later (mit Ausnahmen)',
    source: 'https://www.psycopg.org',
  },
];

function md(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export function renderLicensesMarkdown(inv: Inventory): string {
  const comps = [...inv.components.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
  const runtime = comps.filter((c) => c.usage.has('server') || c.usage.has('ui'));
  const dev = comps.filter((c) => !c.usage.has('server') && !c.usage.has('ui'));
  const byLicense = new Map<string, number>();
  for (const c of comps) {
    const l = c.meta.license ?? 'unbekannt';
    byLicense.set(l, (byLicense.get(l) ?? 0) + 1);
  }
  const unknown = comps.filter((c) => !c.meta.license);

  const row = (c: Component) => {
    const usage = [...c.usage].map((u) => USAGE_LABEL[u]).join(', ');
    const lic = c.meta.license ? md(c.meta.license) : '**unbekannt**';
    const licNote =
      c.meta.licenseSource === 'inherited' ? ` (übernommen von ${md(c.meta.inheritedFrom ?? '')})` : '';
    const notes = [
      c.direct ? 'direkt' : 'transitiv',
      c.platformSpecific
        ? c.meta.installed
          ? 'plattformspezifisch'
          : 'plattformspezifisch, hier nicht installiert'
        : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `| \`${c.name}\` | ${c.version} | ${lic}${licNote} | ${usage} | ${notes} |`;
  };
  const table = (list: Component[]) =>
    ['| Paket | Version | Lizenz | Verwendung | Art |', '|---|---|---|---|---|', ...list.map(row)].join('\n');

  return `# Drittkomponenten und Lizenzen

> Diese Seite wird mit \`bun scripts/licenses.ts\` aus \`bun.lock\` und den \`package.json\`-Dateien unter
> \`node_modules\` erzeugt. Bitte nicht von Hand bearbeiten, sondern nach jeder Abhängigkeitsänderung neu
> erzeugen. Die maschinenlesbare Stückliste (SBOM, CycloneDX) liegt unter \`sbom/osp-data-mesh.cdx.json\`
> (\`bun run sbom\`, siehe [Sicherheitskonzept](sicherheit.md#sbom-und-bsi-tr-03183-2)).

## Lizenz des Projekts

${inv.project.name} ${inv.project.version} steht **vorläufig** unter der **European Union Public Licence
${inv.project.license === 'EUPL-1.2' ? '1.2 (EUPL-1.2)' : `(${inv.project.license})`}** (Datei \`LICENSE\`).
Die EUPL ist eine von der EU-Kommission herausgegebene, OSI-anerkannte Copyleft-Lizenz mit
Kompatibilitätsklausel und erfüllt die Anforderungen von openCode an Open-Source-Lizenzen.

**Die endgültige Lizenzwahl steht noch aus** und wird vor jeder Veröffentlichung durch den
Auftraggeber bzw. Moritz getroffen (siehe [ADR 0012](adr/0012-lizenz-eupl.md)).

## Zusammenfassung

- Pakete insgesamt (direkt und transitiv, laut \`bun.lock\`): **${comps.length}**
- davon zur Laufzeit ausgeliefert (Server oder gebündelt in der Web-Oberfläche): **${runtime.length}**
- davon nur für Build und Entwicklung: **${dev.length}**
- Pakete ohne ermittelbare Lizenz: **${unknown.length}**${unknown.length ? ` (${unknown.map((c) => `\`${c.name}@${c.version}\``).join(', ')})` : ''}

| Lizenz | Anzahl Pakete |
|---|---|
${[...byLicense.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([l, n]) => `| ${md(l)} | ${n} |`)
  .join('\n')}

Alle zur Laufzeit ausgelieferten npm-Pakete stehen unter freizügigen Lizenzen (MIT, ISC, BSD, Apache-2.0),
die mit der EUPL-1.2 vereinbar sind. Die MPL-2.0 (\`lightningcss\`) betrifft nur ein Build-Werkzeug,
das nicht ausgeliefert wird. Eine abschließende rechtliche Prüfung der Lizenzkompatibilität vor einer
Veröffentlichung wird empfohlen.

## Zur Laufzeit ausgelieferte Pakete

"Server (Laufzeit)" = im Container bzw. auf dem Server installiert (\`bun install --production\`).
"Web-Oberfläche (gebündelt)" = in die ausgelieferten JavaScript-Dateien unter \`dist/ui\` übernommen.

${table(runtime)}

## Nur für Build und Entwicklung

Diese Pakete werden zum Bauen, Prüfen und Testen verwendet und nicht ausgeliefert. Plattformspezifische
Binärpakete für andere Betriebssysteme sind im Lockfile verzeichnet, aber nur für die jeweilige Plattform
installiert; ihre Lizenz wurde vom einbindenden Paket übernommen.

${table(dev)}

## Komponenten außerhalb von npm

Nicht automatisch erfasst (nicht in \`bun.lock\`), aber für Betrieb bzw. Container-Bereitstellung verwendet:

| Komponente | Verwendung | Lizenz | Bezugsquelle |
|---|---|---|---|
${EXTERNAL_COMPONENTS.map((e) => `| ${md(e.name)} | ${md(e.use)} | ${md(e.license)} | ${e.source} |`).join('\n')}

Für die Container-Abbilder selbst (Betriebssystempakete) kann nach dem Bauen eine eigene SBOM erzeugt
werden, z. B. \`bun x @cyclonedx/cdxgen -t docker osp-data-mesh:latest\` (nicht lokal verifiziert, da auf der
Entwicklungsmaschine kein Docker installiert ist).
`;
}

if (import.meta.main) {
  const inv = buildInventory();
  const unknown = [...inv.components.values()].filter((c) => !c.meta.license);
  if (process.argv.includes('--check')) {
    if (unknown.length) {
      console.error(`Pakete ohne Lizenz: ${unknown.map((c) => `${c.name}@${c.version}`).join(', ')}`);
      process.exit(1);
    }
    console.log(`ok: ${inv.components.size} Pakete, alle mit Lizenzangabe`);
  } else {
    const out = join(ROOT, 'docs', 'lizenzen.md');
    writeFileSync(out, renderLicensesMarkdown(inv));
    console.log(
      `docs/lizenzen.md geschrieben (${inv.components.size} Pakete, ${unknown.length} ohne Lizenz)`,
    );
  }
}
