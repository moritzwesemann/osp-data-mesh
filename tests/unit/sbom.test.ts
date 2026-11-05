import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInventory,
  extractCopyrightLines,
  hasExecutableCode,
  type Inventory,
  ROOT,
} from '../../scripts/licenses.ts';
import {
  type Bom,
  builtinBom,
  checkTr03183,
  enrich,
  fillFromRegistry,
  getProperty,
  isPlaceholder,
  licenseChoices,
  loadConfig,
  parseConfig,
  placeholderFindings,
  type SbomConfig,
} from '../../scripts/sbom.ts';
import { composeBuildBom, packageOfModule } from '../../scripts/sbom-build.ts';
import { canonicalize, generateSigningKeyPair, signBom, verifyBom } from '../../scripts/sbom-sign.ts';

const REAL_CONFIG: SbomConfig = parseConfig({
  manufacturer: { name: 'Beispiel GmbH', email: 'sbom@beispiel.de', url: 'https://beispiel.de' },
  securityContact: {
    email: 'security@beispiel.de',
    securityTxtUrl: 'https://beispiel.de/.well-known/security.txt',
  },
});

let inv: Inventory;
let bom: Bom;
/** bom-ref eines npm-Pakets in der installierten Version (unabhängig von Versionssprüngen) */
const ref = (name: string) => `pkg:npm/${name}@${inv.components.get(name)!.version}`;
beforeAll(() => {
  inv = buildInventory();
  bom = builtinBom(inv);
  enrich(bom, inv, loadConfig(), 'builtin');
});

describe('JCS (RFC 8785)', () => {
  test('sortiert Schlüssel nach UTF-16-Codeeinheiten, ohne Leerraum, wie JSON.stringify', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'], '€': 2, '\r': 3 })).toBe(
      '{"\\r":3,"a":[true,null,"x"],"b":1,"€":2}',
    );
    expect(canonicalize({ z: { y: 1e21, x: 0.5 }, n: -0 })).toBe('{"n":0,"z":{"x":0.5,"y":1e+21}}');
    expect(canonicalize({ u: undefined, v: 1 })).toBe('{"v":1}');
  });
});

describe('SBOM-Signatur (JSF)', () => {
  const doc = () => structuredClone(bom) as unknown as Record<string, unknown>;
  const ed = generateSigningKeyPair();
  const other = generateSigningKeyPair();
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecPriv = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const ecPub = ec.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  test('Ed25519: signieren und prüfen (eingebetteter und vorgegebener Schlüssel)', () => {
    const signed = signBom(doc(), ed.privateKeyPem);
    expect(signed.signature.algorithm).toBe('Ed25519');
    expect(signed.signature.keyId).toBe(`sha256:${ed.fingerprint}`);
    expect(verifyBom(signed)).toMatchObject({ ok: true, pinned: false, keyFingerprint: ed.fingerprint });
    expect(verifyBom(signed, ed.publicKeyPem)).toMatchObject({ ok: true, pinned: true });
    // Serialisierung ändert nichts (JCS)
    expect(verifyBom(JSON.parse(JSON.stringify(signed, null, 2)), ed.publicKeyPem).ok).toBe(true);
  });

  test('Manipulation nach dem Signieren wird erkannt', () => {
    const signed = signBom(doc(), ed.privateKeyPem);
    const tampered = structuredClone(signed) as unknown as Bom;
    tampered.components.find((c) => c.name === 'hono')!.version = '9.9.9';
    expect(verifyBom(tampered as never, ed.publicKeyPem)).toMatchObject({ ok: false });
    const added = structuredClone(signed) as unknown as Bom;
    added.components.push({ type: 'library', name: 'boese', version: '1.0.0' });
    expect(verifyBom(added as never).ok).toBe(false);
    const meta = structuredClone(signed) as unknown as Bom;
    meta.metadata.timestamp = '2020-01-01T00:00:00Z';
    expect(verifyBom(meta as never).ok).toBe(false);
    const badValue = structuredClone(signed);
    badValue.signature.value = `${badValue.signature.value.slice(0, -2)}AA`;
    expect(verifyBom(badValue).ok).toBe(false);
  });

  test('falscher vertrauenswürdiger Schlüssel, fehlende Signatur, fremder eingebetteter Schlüssel', () => {
    const signed = signBom(doc(), ed.privateKeyPem);
    expect(verifyBom(signed, other.publicKeyPem)).toMatchObject({
      ok: false,
      reason: 'eingebetteter Schlüssel ist nicht der vertrauenswürdige Schlüssel',
    });
    expect(verifyBom(doc())).toMatchObject({ ok: false, reason: 'keine Signatur vorhanden' });
    // Angreifer signiert mit eigenem Schlüssel neu: Unversehrtheit ok, Herkunft nicht
    const forged = signBom({ ...doc(), version: 2 }, other.privateKeyPem);
    expect(verifyBom(forged).ok).toBe(true);
    expect(verifyBom(forged, ed.publicKeyPem).ok).toBe(false);
    // ohne eingebetteten Schlüssel nur mit vorgegebenem prüfbar
    const { publicKey: _p, ...rest } = signed.signature;
    const noKey = { ...signed, signature: rest };
    expect(verifyBom(noKey).ok).toBe(false);
  });

  test('Algorithmus muss zum Schlüssel passen; HMAC und Mehrfachsignaturen abgelehnt', () => {
    const signed = signBom(doc(), ed.privateKeyPem);
    const wrongAlg = { ...signed, signature: { ...signed.signature, algorithm: 'ES256' } };
    expect(verifyBom(wrongAlg as never).ok).toBe(false);
    const hmac = { ...signed, signature: { ...signed.signature, algorithm: 'HS256' } };
    expect(verifyBom(hmac as never)).toMatchObject({ ok: false });
    expect(verifyBom({ ...signed, signature: { signers: [signed.signature] } }).ok).toBe(false);
  });

  test('ECDSA P-256 (ES256): Roundtrip und Manipulation', () => {
    const signed = signBom(doc(), ecPriv);
    expect(signed.signature.algorithm).toBe('ES256');
    expect(verifyBom(signed, ecPub).ok).toBe(true);
    const tampered = structuredClone(signed) as unknown as Bom;
    tampered.metadata.component!.version = '0.0.1';
    expect(verifyBom(tampered as never, ecPub).ok).toBe(false);
  });
});

describe('Konfiguration und Platzhalter', () => {
  test('ausgelieferte Konfiguration enthält gekennzeichnete Platzhalter', () => {
    const findings = placeholderFindings(loadConfig());
    expect(findings.some((f) => f.startsWith('manufacturer.name'))).toBe(true);
    expect(findings.some((f) => f.startsWith('securityContact'))).toBe(true);
  });

  test('echte Angaben ergeben keine Warnung; fehlender Kontakt schon', () => {
    expect(placeholderFindings(REAL_CONFIG)).toEqual([]);
    const noContact = parseConfig({ manufacturer: { name: 'Beispiel GmbH' }, securityContact: {} });
    expect(placeholderFindings(noContact).length).toBe(2);
  });

  test('Erkennung von Platzhaltern', () => {
    for (const v of ['Auftragnehmer (tbd)', 'x@example.invalid', 'https://example.invalid/a', 'TODO'])
      expect(isPlaceholder(v)).toBe(true);
    for (const v of ['Beispiel GmbH', 'sbom@beispiel.de', 'https://invalidator.de', null])
      expect(isPlaceholder(v)).toBe(false);
  });

  test('ungültige Konfiguration wird abgewiesen', () => {
    expect(() => parseConfig({ securityContact: {} })).toThrow('manufacturer');
    expect(() => parseConfig({ manufacturer: { name: 'A', email: 5 }, securityContact: {} })).toThrow(
      'email',
    );
  });
});

describe('Paketprüfung: Copyright und ausführbarer Code', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'osp-sbom-test-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('Copyright-Zeilen ohne Lizenzvorlagen und Aufzählungspunkte', () => {
    const text = [
      'MIT License',
      '',
      'Copyright (c) 2021 - present, Yusuke Wada and Hono contributors',
      '   Copyright [yyyy] [name of copyright owner]',
      '(c) You must retain, in the Source form of any Derivative Works',
      'The above copyright notice and this permission notice shall be included',
      ' * Copyright 2019 Justin Ridgewell <jridgewell@google.com>',
      'Copyright (c) 2021 - present, Yusuke Wada and Hono contributors',
    ].join('\n');
    expect(extractCopyrightLines(text)).toEqual([
      'Copyright (c) 2021 - present, Yusuke Wada and Hono contributors',
      'Copyright 2019 Justin Ridgewell <jridgewell@google.com>',
    ]);
  });

  test('nur Typdeklarationen = nicht ausführbar; JavaScript oder Programm = ausführbar', () => {
    const types = join(dir, 'types');
    mkdirSync(join(types, 'sub'), { recursive: true });
    writeFileSync(join(types, 'package.json'), '{}');
    writeFileSync(join(types, 'index.d.ts'), 'export {};');
    writeFileSync(join(types, 'sub', 'more.d.mts'), 'export {};');
    writeFileSync(join(types, 'README.md'), '#');
    expect(hasExecutableCode(types)).toBe(false);
    writeFileSync(join(types, 'sub', 'index.js'), 'module.exports = 1;');
    expect(hasExecutableCode(types)).toBe(true);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tool'), '\x7fELF');
    expect(hasExecutableCode(bin)).toBe(false);
    chmodSync(join(bin, 'tool'), 0o755);
    expect(hasExecutableCode(bin)).toBe(true);
  });

  test('echte Pakete: @types/node nicht ausführbar, react ausführbar und mit Copyright', () => {
    expect(inv.components.get('@types/node')?.meta.executableCode).toBe(false);
    const react = inv.components.get('react')!;
    expect(react.meta.executableCode).toBe(true);
    expect(react.meta.copyright).toEqual(['Copyright (c) Meta Platforms, Inc. and affiliates.']);
  });
});

describe('Quell-SBOM nach TR-03183-2 v2.1.0', () => {
  test('Lizenzen: Distributions- (concluded) und Originallizenz (declared)', () => {
    expect(licenseChoices('MIT', true)).toEqual([
      { license: { id: 'MIT', acknowledgement: 'declared' } },
      { license: { id: 'MIT', acknowledgement: 'concluded' } },
    ]);
    expect(licenseChoices('MIT', false)).toEqual([{ license: { id: 'MIT', acknowledgement: 'concluded' } }]);
    expect(licenseChoices('(MIT OR Apache-2.0)', true)).toEqual([
      { expression: 'MIT OR Apache-2.0', acknowledgement: 'concluded' },
    ]);
  });

  test('alle Pflichtfelder vorhanden (Selbstprüfung), Platzhalter gekennzeichnet', () => {
    expect(checkTr03183(bom)).toEqual([]);
    expect(bom.metadata.manufacturer?.name).toBe('Auftragnehmer (tbd)');
    expect(getProperty(bom.metadata, 'osp:sbom-status')).toStartWith('ENTWURF');
    expect(bom.metadata.lifecycles).toEqual([{ phase: 'pre-build' }]);
    const refs = bom.metadata.component?.externalReferences?.map((r) => r.type);
    expect(refs).toContain('security-contact');
    expect(refs).toContain('rfc-9116');
  });

  test('npm-Komponenten: Urheber, Hash der Distributionsform, TR-Eigenschaften', () => {
    const npm = bom.components.filter((c) => c.purl?.startsWith('pkg:npm/'));
    expect(npm.length).toBe(inv.components.size);
    for (const c of npm) {
      expect(c.manufacturer?.url?.length ?? c.manufacturer?.contact?.length).toBeGreaterThan(0);
      const dist = c.externalReferences?.find((r) => r.type === 'distribution');
      expect(dist?.hashes?.[0]?.alg).toBe('SHA-512');
      expect(dist?.hashes?.[0]?.content).toBe(c.hashes?.find((h) => h.alg === 'SHA-512')?.content);
    }
    const byName = (n: string) =>
      bom.components.find((c) => `${c.group ? `${c.group}/` : ''}${c.name}` === n)!;
    expect(getProperty(byName('@types/node'), 'bsi:component:executable')).toBe('non-executable');
    expect(getProperty(byName('react'), 'bsi:component:executable')).toBe('executable');
    expect(byName('hono').scope).toBe('required');
    expect(byName('typescript').scope).toBe('excluded');
  });

  test('Graph enthält Peer-Abhängigkeiten, Plattform-Komponenten und Vollständigkeitsangabe', () => {
    const deps = new Map(bom.dependencies!.map((d) => [d.ref, d.dependsOn ?? []]));
    expect(deps.get(ref('react-dom'))).toContain(ref('react'));
    const root = deps.get(bom.metadata.component!['bom-ref']!)!;
    expect(root.some((r) => r.startsWith('pkg:generic/bun@'))).toBe(true);
    expect(root).toContain('pkg:generic/postgresql@18');
    expect(bom.compositions?.[0]?.aggregate).toBe('complete');
    expect(bom.compositions?.[1]).toMatchObject({ aggregate: 'unknown' });
    expect(bom.compositions![1]!.dependencies).toContain('pkg:generic/postgresql@18');
  });

  test('Selbstprüfung meldet fehlende Pflichtangaben', () => {
    const broken = structuredClone(bom);
    delete broken.metadata.manufacturer;
    const hono = broken.components.find((c) => c.name === 'hono')!;
    hono.externalReferences = hono.externalReferences?.filter((r) => r.type !== 'distribution');
    hono.properties!.push({ name: 'bsi:component:executable', value: 'executable' });
    delete broken.components.find((c) => c.name === 'kysely')!.manufacturer;
    broken.compositions = [];
    const issues = checkTr03183(broken);
    expect(issues).toContain('SBOM: Ersteller (metadata.manufacturer mit E-Mail oder URL) fehlt');
    expect(issues).toContain(
      `${ref('hono')}: SHA-512 der auslieferbaren Form (externalReferences distribution) fehlt`,
    );
    expect(
      issues.some((i) => i.startsWith(`${ref('hono')}: bsi:component:executable muss genau einmal`)),
    ).toBe(true);
    expect(issues).toContain(`${ref('kysely')}: Urheber (manufacturer mit E-Mail oder URL) fehlt`);
    expect(
      issues.some((i) => i.endsWith('Vollständigkeit der Abhängigkeiten nicht angegeben (compositions)')),
    ).toBe(true);
  });
});

describe('Registry-Manifeste nicht installierter Pakete', () => {
  test('deklarierte Lizenz aus der Registry nur bei passender Integrität', async () => {
    const local = buildInventory();
    const missing = [...local.components.values()].filter((c) => !c.meta.installed);
    expect(missing.length).toBeGreaterThan(2);
    const [good, tampered, gone] = missing as [(typeof missing)[0], (typeof missing)[0], (typeof missing)[0]];
    const fake = (async (url: string | URL | Request) => {
      const u = String(url);
      const pick = [good, tampered, gone].find((c) => u.includes(c.name.replace('/', '%2f')));
      if (!pick || pick === gone) return new Response('not found', { status: 404 });
      const integrity = pick === tampered ? 'sha512-AAAA' : pick.integrity;
      return Response.json({
        name: pick.name,
        version: pick.version,
        license: 'Apache-2.0',
        repository: { url: 'git+https://github.com/beispiel/repo.git' },
        dist: { integrity },
      });
    }) as typeof fetch;
    const r = await fillFromRegistry(local, fake);
    expect(good.meta).toMatchObject({
      license: 'Apache-2.0',
      licenseSource: 'registry',
      repository: 'https://github.com/beispiel/repo',
    });
    expect(tampered.meta.licenseSource).not.toBe('registry');
    expect(r.failed.some((f) => f.startsWith(`${tampered.name}@`) && f.includes('Integrität'))).toBe(true);
    expect(r.failed.some((f) => f.startsWith(`${gone.name}@`) && f.includes('HTTP 404'))).toBe(true);
    // in der SBOM: deklarierte und Distributionslizenz
    const b = builtinBom(local);
    enrich(b, local, REAL_CONFIG, 'builtin');
    const comp = b.components.find((c) => c['bom-ref'] === `pkg:npm/${good.name}@${good.version}`)!;
    expect(comp.licenses).toEqual(licenseChoices('Apache-2.0', true));
    expect(getProperty(comp, 'osp:license-source')).toBe('registry');
  });
});

describe('Build-SBOM der Web-Oberfläche', () => {
  const reactEntry = join(ROOT, 'node_modules', 'react', 'index.js');

  test('Modul-IDs werden Paketen zugeordnet', () => {
    expect(packageOfModule(reactEntry)).toEqual({
      name: 'react',
      version: inv.components.get('react')!.version,
    });
    expect(packageOfModule(join(ROOT, 'src', 'ui', 'main.tsx'))).toBe('first-party');
    expect(packageOfModule('\0vite/preload-helper.js')).toMatchObject({ name: 'vite' });
    expect(packageOfModule('/elsewhere/x.js')).toBeNull();
  });

  test('Dateien mit SHA-512, enthaltene Pakete, Graph und Selbstprüfung', () => {
    const hash = 'a'.repeat(128);
    const { bom: b, gaps } = composeBuildBom({
      inv,
      version: '0.1.0+gtest',
      tools: [],
      chunks: [
        {
          file: 'assets/index-x.js',
          moduleIds: [join(ROOT, 'src', 'ui', 'main.tsx'), reactEntry, '/elsewhere/x.js'],
          imports: [],
          isEntry: true,
          importedCss: ['assets/index-x.css'],
        },
      ],
      files: [
        { file: 'assets/index-x.js', sha512: hash, size: 10 },
        { file: 'assets/index-x.css', sha512: hash, size: 5 },
        { file: 'index.html', sha512: hash, size: 1 },
      ],
    });
    expect(checkTr03183(b)).toEqual([]);
    expect(b.metadata.lifecycles).toEqual([{ phase: 'build' }]);
    const js = b.components.find((c) => c.name === 'assets/index-x.js')!;
    expect(js.licenses).toEqual([{ expression: 'EUPL-1.2 AND MIT', acknowledgement: 'concluded' }]);
    expect(getProperty(js, 'bsi:component:executable')).toBe('executable');
    expect(getProperty(js, 'bsi:component:structured')).toBe('unstructured');
    expect(getProperty(b.components.find((c) => c.name === 'index.html')!, 'bsi:component:executable')).toBe(
      'non-executable',
    );
    const react = b.components.find((c) => c.name === 'react')!;
    expect(getProperty(react, 'osp:bundled-in')).toBe('assets/index-x.js');
    const deps = new Map(b.dependencies!.map((d) => [d.ref, d.dependsOn]));
    expect(deps.get('file:assets/index-x.js')).toEqual(['file:assets/index-x.css', ref('react')]);
    expect(deps.get('file:index.html')).toEqual(['file:assets/index-x.css', 'file:assets/index-x.js']);
    expect(gaps.some((g) => g.includes('/elsewhere/x.js'))).toBe(true);
  });
});
