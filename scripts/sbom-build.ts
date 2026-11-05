/**
 * Build-SBOM der Web-Oberfläche (TR-03183-2, 8.4.3; CycloneDX-Lebenszyklus "build").
 *
 *   bun run sbom -- build-ui                      baut dist/ui neu, schreibt dist/sbom/osp-data-mesh-ui.build.cdx.json
 *   bun run sbom -- build-ui --out-dir <dir>      baut nach <dir> (z. B. zum Prüfen, ohne dist/ui anzufassen)
 *   bun run sbom -- build-ui --output <datei>     anderer Ausgabepfad der SBOM
 *   (dazu wie bei der Quell-SBOM: --sign-key <pem>, --no-validate, --release)
 *
 * Vite/Rolldown baut mit der Projektkonfiguration; ein zusätzliches Plugin liest je ausgegebener Datei die
 * enthaltenen Module. Daraus entsteht:
 *  - je ausgelieferter Datei (dist/ui/…) eine Komponente vom Typ "file" mit SHA-512, Dateiname und den
 *    TR-Eigenschaften (gebündeltes JavaScript: ausführbar, kein Archiv, unstrukturiert);
 *  - je in die Dateien gebündeltem npm-Paket eine Komponente mit allen TR-Feldern (wie in der Quell-SBOM),
 *    Eigenschaft osp:bundled-in = Dateien, in denen es steckt (TR 3.2.1: zusammengeführte Komponenten);
 *  - der Graph: Oberfläche → Dateien, Datei → importierte Dateien und enthaltene Pakete, Paket → Pakete.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { buildInventory, type Component, type Inventory, ROOT } from './licenses.ts';
import {
  applyMetadata,
  type Bom,
  type CdxComponent,
  checkTr03183,
  describeNpmComponent,
  describePrimary,
  displayPath,
  finishGraph,
  licenseChoices,
  loadConfig,
  orgEntity,
  placeholderFindings,
  refOf,
  setProperty,
  signAndWrite,
  TR_VERSION,
  validate,
  warnPlaceholders,
} from './sbom.ts';

export interface ChunkInfo {
  /** Pfad relativ zum Ausgabeverzeichnis, z. B. assets/index-abc.js */
  file: string;
  moduleIds: string[];
  imports: string[];
  isEntry: boolean;
  importedCss: string[];
}

export interface OutputFile {
  file: string;
  sha512: string;
  size: number;
}

/** Ordnet eine Modul-ID dem npm-Paket zu (name@version) oder "first-party"; null = unbekannt. */
export function packageOfModule(
  id: string,
  root = ROOT,
): { name: string; version: string } | 'first-party' | null {
  if (id.startsWith('\0')) {
    // virtuelle Module der Build-Werkzeuge (Laufzeithilfen, die in das Bündel übernommen werden)
    if (/^\0vite\//.test(id)) return readPkg(join(root, 'node_modules', 'vite'));
    if (/rolldown|commonjsHelpers|runtime/.test(id)) return readPkg(join(root, 'node_modules', 'rolldown'));
    return null;
  }
  const clean = id.split('?')[0]!;
  const marker = `${sep}node_modules${sep}`;
  const at = clean.lastIndexOf(marker);
  if (at >= 0) {
    const rest = clean.slice(at + marker.length).split(sep);
    const name = rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]!;
    return readPkg(join(clean.slice(0, at + marker.length), ...name.split('/')));
  }
  if (clean.startsWith(join(root, 'src') + sep)) return 'first-party';
  return null;
}

function readPkg(dir: string): { name: string; version: string } | null {
  try {
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    return { name: pj.name, version: pj.version };
  } catch {
    return null;
  }
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

export function hashFiles(dir: string): OutputFile[] {
  return listFiles(dir).map((file) => {
    const data = readFileSync(join(dir, file));
    return { file, size: data.length, sha512: createHash('sha512').update(data).digest('hex') };
  });
}

const CODE = new Set(['.js', '.mjs', '.cjs', '.wasm']);

function gitVersion(base: string): string {
  const rev = Bun.spawnSync(['git', 'rev-parse', '--short=12', 'HEAD'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (rev.exitCode !== 0) return base;
  const dirty = Bun.spawnSync(
    ['git', 'status', '--porcelain', '--', 'src', 'package.json', 'bun.lock', 'vite.config.ts'],
    {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const d = dirty.exitCode === 0 && dirty.stdout.toString().trim() ? '.dirty' : '';
  return `${base}+g${rev.stdout.toString().trim()}${d}`;
}

function licenseExpression(parts: string[]): string {
  const uniq = [...new Set(parts)].sort();
  return uniq
    .map((l) => (/\s/.test(l) && uniq.length > 1 ? `(${l.replace(/^\((.*)\)$/, '$1')})` : l))
    .join(' AND ');
}

/** Baut die Build-SBOM aus den Chunk-Informationen und den ausgegebenen Dateien (ohne Vite, testbar). */
export function composeBuildBom(input: {
  inv: Inventory;
  chunks: ChunkInfo[];
  files: OutputFile[];
  version: string;
  tools: CdxComponent[];
}): { bom: Bom; gaps: string[]; placeholders: string[] } {
  const { inv, chunks, files, version } = input;
  const cfg = loadConfig();
  const placeholders = placeholderFindings(cfg);
  const gaps = new Set<string>();
  const byNameVersion = new Map<string, Component>();
  for (const c of inv.components.values()) byNameVersion.set(`${c.name}@${c.version}`, c);

  const rootRef = `osp-data-mesh-ui@${version}`;
  const fileRef = (f: string) => `file:${f}`;
  const bundledIn = new Map<string, Set<string>>(); // Paketschlüssel → Dateien
  const chunkPkgs = new Map<string, Set<string>>(); // Datei → Paketschlüssel
  const chunkFirstParty = new Set<string>();
  for (const ch of chunks) {
    const pkgs = new Set<string>();
    for (const id of ch.moduleIds) {
      const p = packageOfModule(id);
      if (p === 'first-party') chunkFirstParty.add(ch.file);
      else if (!p) gaps.add(`Modul ohne Zuordnung in ${ch.file}: ${id.replace(ROOT, '.')}`);
      else {
        const c = byNameVersion.get(`${p.name}@${p.version}`);
        if (!c) {
          gaps.add(`gebündeltes Paket ${p.name}@${p.version} nicht in bun.lock`);
          continue;
        }
        pkgs.add(c.key);
        if (!bundledIn.has(c.key)) bundledIn.set(c.key, new Set());
        bundledIn.get(c.key)!.add(ch.file);
      }
    }
    chunkPkgs.set(ch.file, pkgs);
  }

  const supplier = cfg.supplier ?? cfg.manufacturer;
  const components: CdxComponent[] = [];
  const dependencies: { ref: string; dependsOn: string[] }[] = [];
  for (const f of files) {
    const ext = extname(f.file).toLowerCase();
    const chunk = chunks.find((c) => c.file === f.file);
    const pkgs = [...(chunkPkgs.get(f.file) ?? [])].map((k) => inv.components.get(k)!);
    const licenseParts = [
      ...(chunk && !chunkFirstParty.has(f.file) ? [] : [inv.project.license]),
      ...pkgs.map((c) => c.meta.license ?? 'NOASSERTION'),
    ];
    const comp: CdxComponent = {
      type: 'file',
      'bom-ref': fileRef(f.file),
      name: f.file,
      version,
      description: chunk
        ? `gebündeltes JavaScript der Web-Oberfläche${pkgs.length ? ` mit ${pkgs.length} npm-Paket(en)` : ''}`
        : 'Datei der Web-Oberfläche',
      scope: 'required',
      hashes: [{ alg: 'SHA-512', content: f.sha512 }],
      manufacturer: orgEntity(cfg.manufacturer),
      supplier: orgEntity(supplier),
      licenses: licenseChoices(licenseExpression(licenseParts), false),
      externalReferences: [
        {
          type: 'distribution',
          url: f.file,
          comment:
            'relativ zum Wurzelverzeichnis der Web-Oberfläche (dist/ui, ausgeliefert unter https://<knoten>/)',
          hashes: [{ alg: 'SHA-512', content: f.sha512 }],
        },
      ],
      properties: [
        { name: 'bsi:component:filename', value: basename(f.file) },
        { name: 'bsi:component:executable', value: CODE.has(ext) ? 'executable' : 'non-executable' },
        { name: 'bsi:component:archive', value: 'no archive' },
        { name: 'bsi:component:structured', value: 'unstructured' },
        { name: 'osp:size-bytes', value: String(f.size) },
      ],
    };
    components.push(comp);
    const deps = new Set<string>();
    if (chunk) {
      for (const i of [...chunk.imports, ...chunk.importedCss]) deps.add(fileRef(i));
      for (const c of pkgs) deps.add(refOf(c.name, c.version));
    } else if (f.file.endsWith('.html')) {
      for (const ch of chunks.filter((c) => c.isEntry))
        for (const r of [ch.file, ...ch.importedCss]) deps.add(fileRef(r));
    }
    dependencies.push({ ref: fileRef(f.file), dependsOn: [...deps].filter((r) => r !== fileRef(f.file)) });
  }
  for (const ch of chunks)
    if (!files.some((f) => f.file === ch.file))
      gaps.add(`Chunk ${ch.file} nicht im Ausgabeverzeichnis gefunden`);

  const pkgKeys = [...bundledIn.keys()];
  for (const key of pkgKeys) {
    const c = inv.components.get(key)!;
    const [group, name] = c.name.startsWith('@') ? (c.name.split('/') as [string, string]) : ['', c.name];
    const comp: CdxComponent = {
      type: 'library',
      ...(group ? { group } : {}),
      name,
      version: c.version,
      scope: 'required',
    };
    describeNpmComponent(comp, c, gaps);
    setProperty(comp, 'osp:bundled-in', [...bundledIn.get(key)!].sort().join(','));
    components.push(comp);
    dependencies.push({
      ref: refOf(c.name, c.version),
      dependsOn: [...c.resolvedDeps, ...c.resolvedPeers]
        .filter((k) => bundledIn.has(k))
        .map((k) => inv.components.get(k)!)
        .map((d) => refOf(d.name, d.version)),
    });
  }
  dependencies.push({ ref: rootRef, dependsOn: files.map((f) => fileRef(f.file)) });

  const bom: Bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      lifecycles: [{ phase: 'build' }],
      tools: { components: input.tools },
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: 'osp-data-mesh-ui',
        version,
        description: `Web-Oberfläche von ${inv.project.name} ${inv.project.version} (gebaut mit Vite, Verzeichnis dist/ui)`,
      },
    },
    components,
    dependencies,
  };
  applyMetadata(bom, cfg, {
    toolDescription: `Build-SBOM der Web-Oberfläche nach ${TR_VERSION} (Dateien mit SHA-512, gebündelte Pakete)`,
    toolVersion: inv.project.version,
    status: placeholders.length
      ? `ENTWURF: Platzhalter für Hersteller/Lieferant/SBOM-Ersteller/Sicherheitskontakt (${placeholders.length} Felder), Entscheidung des Eigentümers offen`
      : 'Angaben vollständig',
  });
  describePrimary(bom.metadata.component!, cfg, inv.project.license);
  setProperty(bom.metadata, 'osp:related-sbom:source', 'sbom/osp-data-mesh.cdx.json (Quell-SBOM, pre-build)');
  finishGraph(bom, rootRef, []);
  return { bom, gaps: [...gaps], placeholders };
}

function toolComponent(name: string): CdxComponent {
  const p = readPkg(join(ROOT, 'node_modules', ...name.split('/')));
  return {
    type: 'application',
    name,
    ...(p ? { version: p.version, purl: `pkg:npm/${name.replace(/^@/, '%40')}@${p.version}` } : {}),
  };
}

export async function buildUiSbom(args: string[]) {
  const val = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outDir = resolve(process.cwd(), val('--out-dir') ?? join(ROOT, 'dist', 'ui'));
  const output = resolve(
    process.cwd(),
    val('--output') ?? join(dirname(outDir), 'sbom', 'osp-data-mesh-ui.build.cdx.json'),
  );
  const { build } = await import('vite');
  const chunks: ChunkInfo[] = [];
  await build({
    configFile: join(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
    plugins: [
      {
        name: 'osp-sbom-collect',
        generateBundle(_options, bundle) {
          for (const [file, item] of Object.entries(bundle)) {
            if (item.type !== 'chunk') continue;
            const meta = (item as { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata;
            chunks.push({
              file,
              moduleIds: [...item.moduleIds],
              imports: [...item.imports, ...item.dynamicImports],
              isEntry: item.isEntry,
              importedCss: [...(meta?.importedCss ?? [])],
            });
          }
        },
      },
    ],
  });
  if (!existsSync(outDir)) throw new Error(`Build-Ausgabe fehlt: ${outDir}`);
  const inv = buildInventory();
  const files = hashFiles(outDir);
  const version = gitVersion(inv.project.version);
  const { bom, gaps, placeholders } = composeBuildBom({
    inv,
    chunks,
    files,
    version,
    tools: [toolComponent('vite'), toolComponent('rolldown'), toolComponent('@vitejs/plugin-react')],
  });
  const issues = checkTr03183(bom);
  mkdirSync(dirname(output), { recursive: true });
  const cfg = loadConfig();
  const signed = signAndWrite(bom, output, cfg, args);
  const libs = bom.components.filter((c) => c.type === 'library').length;
  console.log(
    `Build-SBOM geschrieben: ${displayPath(output)} (${files.length} Dateien aus ${displayPath(outDir)}, ${libs} gebündelte npm-Pakete, Version ${version})`,
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
  if (!args.includes('--no-validate') && !validate(output)) ok = false;
  if (args.includes('--release') && (placeholders.length || issues.length || !signed)) {
    console.error('--release: abgebrochen (Platzhalter, TR-Lücken oder fehlende Signatur, siehe oben).');
    ok = false;
  }
  if (!ok) process.exit(1);
}
