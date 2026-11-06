import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { type Bom, type CdxComponent, getProperty, loadConfig } from '../../scripts/sbom.ts';
import {
  declaredLicenseChoices,
  dep5ToSpdx,
  enrichImageBom,
  type ImageFacts,
  licenseRefOf,
  MANUAL_DEBIAN_LICENSES,
  packageLicense,
  parseDep5,
  parseImageProbe,
  renameRef,
} from '../../scripts/sbom-image.ts';
import { generateSigningKeyPair, signBom, verifyBom } from '../../scripts/sbom-sign.ts';

const DEP5 = `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: beispiel
Source: https://example.org/beispiel

Files: *
Copyright: 1999-2024 Jemand <jemand@example.org>
           2020 Andere
License: GPL-2+
 This program is free software; you can redistribute it
 .
 and/or modify it.

Files: lib/*
Copyright: 2001 Bibliothek
License: LGPL-2.1+ or Expat

Files: debian/*
Copyright: 2024 Debian
License: GPL-2+

License: GPL-2+
 On Debian systems, the complete text is in /usr/share/common-licenses/GPL-2.

License: Expat
 Permission is hereby granted ...
`;

describe('DEP-5 (copyright-Dateien der Debian-Pakete)', () => {
  test('Lizenzfelder der Files-Absätze, ohne Duplikate und ohne eigenständige Lizenzabsätze', () => {
    expect(parseDep5(DEP5)).toEqual({ machineReadable: true, licenses: ['GPL-2+', 'LGPL-2.1+ or Expat'] });
  });

  test('ohne Files-Absätze gilt die Lizenz des Kopfabsatzes; CRLF und Kommentare', () => {
    const text =
      'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\r\n# Kommentar\r\nLicense: MIT\r\n';
    expect(parseDep5(text)).toEqual({ machineReadable: true, licenses: ['MIT'] });
  });

  test('Freitext (kein Format-Feld) ist nicht maschinenlesbar', () => {
    const text = 'This package was debianized by X.\n\nCopyright: (C) MIT\nLicense: irgendwas\n';
    expect(parseDep5(text)).toEqual({ machineReadable: false, licenses: [] });
  });
});

describe('Abbildung DEP-5 → SPDX', () => {
  test('Kurznamen und Ausdrücke: "and" bindet stärker als "or", Komma trennt mit niedrigstem Vorrang', () => {
    expect(dep5ToSpdx('Expat').expression).toBe('MIT');
    expect(dep5ToSpdx('GPL-2+ or LGPL-2.1+ and BSD-3-clause').expression).toBe(
      'GPL-2.0-or-later OR (LGPL-2.1-or-later AND BSD-3-Clause)',
    );
    expect(dep5ToSpdx('GPL-2+ or Artistic, and BSD-3-clause')).toMatchObject({
      expression: '(GPL-2.0-or-later OR Artistic-1.0-Perl) AND BSD-3-Clause',
      conjuncts: ['GPL-2.0-or-later OR Artistic-1.0-Perl', 'BSD-3-Clause'],
      unmapped: [],
    });
    expect(dep5ToSpdx('GPL-2, or MIT').expression).toBe('GPL-2.0-only OR MIT');
  });

  test('Ausnahmen: bekannte als SPDX WITH, Autoconf je nach GPL-Version, Bindestrich-Schreibweise', () => {
    expect(dep5ToSpdx('GPL-3+ with Bison exception').expression).toBe(
      'GPL-3.0-or-later WITH Bison-exception-2.2',
    );
    expect(dep5ToSpdx('GPL-3+-with-Bison-exception').expression).toBe(
      'GPL-3.0-or-later WITH Bison-exception-2.2',
    );
    expect(dep5ToSpdx('GPL-2+ with Autoconf exception').expression).toBe(
      'GPL-2.0-or-later WITH Autoconf-exception-2.0',
    );
    expect(dep5ToSpdx('GPL-3+ with autoconf exception').expression).toBe(
      'GPL-3.0-or-later WITH Autoconf-exception-3.0',
    );
    // unbekannte Ausnahme: ganzer Begriff als LicenseRef, nicht stillschweigend ohne Ausnahme
    expect(dep5ToSpdx('GPL-2+ with OpenSSL exception')).toMatchObject({
      expression: 'LicenseRef-Debian-GPL-2-or-later-with-OpenSSL-exception',
      unmapped: ['GPL-2+ with OpenSSL exception'],
    });
  });

  test('nicht abbildbare Namen werden LicenseRef-Debian-… (gültige SPDX-idstring)', () => {
    expect(licenseRefOf('public-domain')).toBe('LicenseRef-Debian-public-domain');
    expect(licenseRefOf('Custom-pg_dump')).toBe('LicenseRef-Debian-Custom-pg-dump');
    expect(licenseRefOf('MIT/X11')).toBe('LicenseRef-Debian-MIT-X11');
    expect(licenseRefOf('GPL-2+')).toMatch(/^LicenseRef-[A-Za-z0-9.-]+$/);
    expect(dep5ToSpdx('public-domain and ISC')).toMatchObject({
      expression: 'LicenseRef-Debian-public-domain AND ISC',
      unmapped: ['public-domain'],
    });
  });

  test('Paket: alle Lizenzfelder UND-verknüpft, flach, ohne Duplikate, sortiert', () => {
    expect(packageLicense([])).toBeNull();
    expect(packageLicense(['ISC', 'ISC and LGPL-2.1+', 'LGPL-2.1+'])?.expression).toBe(
      'ISC AND LGPL-2.1-or-later',
    );
    expect(packageLicense(['GPL-2+', 'LGPL-2.1+ or Expat'])?.expression).toBe(
      'GPL-2.0-or-later AND (LGPL-2.1-or-later OR MIT)',
    );
  });

  test('CycloneDX-Form: Kennung, Name oder Ausdruck, immer acknowledgement declared', () => {
    const one = (fields: string[]) => declaredLicenseChoices(packageLicense(fields)!, fields);
    expect(one(['Expat'])).toEqual([{ license: { id: 'MIT', acknowledgement: 'declared' } }]);
    expect(one(['public-domain'])).toEqual([
      { license: { name: 'public-domain', acknowledgement: 'declared' } },
    ]);
    expect(one(['GPL-2+', 'Expat'])).toEqual([
      { expression: 'GPL-2.0-or-later AND MIT', acknowledgement: 'declared' },
    ]);
    expect(one(['GPL-3+ with Bison exception'])).toEqual([
      { expression: 'GPL-3.0-or-later WITH Bison-exception-2.2', acknowledgement: 'declared' },
    ]);
  });
});

const MARK = '@@OSP-SBOM-IMAGE@@';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const KRB_TEXT = 'Freitext der krb5-copyright-Datei\n';

function probeOutput(copyright: Record<string, string>, bun = '1.4.3'): string {
  return [
    `${MARK} bun-version`,
    bun,
    `${MARK} bun-sha512`,
    `${'ab'.repeat(64)}  /usr/local/bin/bun`,
    `${MARK} dpkg`,
    'apt\tapt\t3.0.3\t3.0.3',
    'libpq5\tpostgresql-18\t18.6-1\t18.6-1',
    'libkrb5-3\tkrb5\t1.21.3-5\t1.21.3-5',
    'libgone\tgone\t1.0\t1.0',
    ...Object.entries(copyright).flatMap(([pkg, text]) => [`${MARK} copyright ${pkg}`, text]),
  ].join('\n');
}

const deb = (name: string, version: string, source = false): CdxComponent => ({
  type: 'library',
  'bom-ref': `pkg:deb/debian/${name}@${version}?arch=arm64`,
  group: 'debian',
  name,
  version,
  purl: `pkg:deb/debian/${name}@${version}?arch=arm64`,
  ...(source ? { tags: ['source'] } : {}),
});

function fixtureBom(): Bom {
  const root = 'pkg:oci/osp-data-mesh@sha256:1234';
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000000',
    version: 1,
    metadata: {
      timestamp: '2026-11-05T10:00:00Z',
      authors: [{ name: 'OWASP Foundation' }],
      lifecycles: [{ phase: 'pre-build' }, { phase: 'post-build' }],
      tools: { components: [{ type: 'application', name: 'cdxgen', version: '12.9.0' }] },
      component: { type: 'container', 'bom-ref': root, name: 'osp-data-mesh', version: 'local', purl: root },
      properties: [{ name: 'oci:image:Id', value: 'sha256:1234' }],
    },
    components: [
      deb('apt', '3.0.3'),
      deb('libpq5', '18.6-1'),
      deb('postgresql-18', '18.6-1', true),
      deb('libkrb5-3', '1.21.3-5'),
      deb('libgone', '1.0'),
      {
        type: 'file',
        'bom-ref': 'pkg:generic/bun',
        name: 'bun',
        purl: 'pkg:generic/bun',
        hashes: [{ alg: 'SHA-1', content: 'd2dc' }],
        properties: [{ name: 'SrcFile', value: '/usr/local/bin/bun' }],
      },
    ],
    dependencies: [
      { ref: root, dependsOn: ['pkg:deb/debian/apt@3.0.3?arch=arm64'] },
      { ref: 'pkg:generic/bun', dependsOn: [] },
    ],
    annotations: [{ subjects: [root, 'pkg:generic/bun'], text: 'x' }],
  };
}

describe('Daten aus dem Abbild', () => {
  test('Ausgabe des Prüfskripts: Bun-Version, SHA-512, dpkg-Quellen, copyright-Dateien', () => {
    const facts = parseImageProbe(probeOutput({ apt: DEP5, 'libkrb5-3': KRB_TEXT }));
    expect(facts.bunVersion).toBe('1.4.3');
    expect(facts.bunSha512).toBe('ab'.repeat(64));
    expect(facts.dpkg).toContainEqual({
      package: 'libpq5',
      source: 'postgresql-18',
      version: '18.6-1',
      sourceVersion: '18.6-1',
    });
    expect(facts.copyright.get('apt')).toContain('Files: lib/*');
    expect([...facts.copyright.keys()]).toEqual(['apt', 'libkrb5-3']);
  });

  test('ohne bun im Abbild bleibt die Version leer', () => {
    const facts = parseImageProbe(`${MARK} bun-version\n\n${MARK} dpkg\n`);
    expect(facts.bunVersion).toBeNull();
    expect(facts.dpkg).toEqual([]);
  });
});

describe('Anreicherung der Abbild-SBOM', () => {
  const cfg = loadConfig();
  const krbEntry = MANUAL_DEBIAN_LICENSES.krb5!;

  function run(copyright: Record<string, string>, opts: { bun?: string; dockerfile?: string } = {}) {
    const bom = fixtureBom();
    const facts: ImageFacts = parseImageProbe(probeOutput(copyright, opts.bun));
    const result = enrichImageBom(bom, facts, cfg, {
      projectVersion: '0.1.0',
      dockerfileBunVersion: opts.dockerfile ?? '1.4.3',
      imageTag: 'osp-data-mesh:0.1.0',
    });
    const byName = (n: string) => bom.components.find((c) => c.name === n)!;
    return { bom, result, byName };
  }

  test('Metadaten: SBOM-Ersteller, Hersteller, Lieferant, Sicherheitskontakt aus der Konfiguration', () => {
    const { bom, result } = run({ apt: DEP5 });
    expect(result.placeholders).toEqual([]);
    const md = bom.metadata;
    expect(md.authors).toEqual([{ name: cfg.sbomAuthor!.name }]);
    expect(md.manufacturer?.url).toEqual([cfg.sbomAuthor!.url!]);
    expect(md.supplier?.name).toBe(cfg.supplier!.name);
    expect(md.lifecycles).toEqual([{ phase: 'post-build' }]);
    expect(md.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(md.tools?.components?.map((t) => t.name)).toEqual(['cdxgen', 'osp-data-mesh/scripts/sbom.ts']);
    const c = md.component!;
    expect(c.version).toBe('0.1.0');
    expect(c.manufacturer?.name).toBe(cfg.manufacturer.name);
    expect(c.supplier?.name).toBe(cfg.supplier!.name);
    expect(c.externalReferences).toContainEqual({ type: 'security-contact', url: cfg.securityContact.url! });
    expect(c.licenses).toBeUndefined(); // das Abbild als Ganzes hat keine einzelne Lizenz
    expect(getProperty(md, 'osp:sbom-status')).toBe('Angaben vollständig');
  });

  test('Debian-Lizenzen: eigenes Paket, Quellpaket über seine Binärpakete, Paket derselben Quelle', () => {
    const pgCopyright =
      'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\n\nFiles: *\nCopyright: PGDG\nLicense: PostgreSQL\n';
    const { byName, result } = run({ apt: DEP5, libpq5: pgCopyright });
    expect(byName('apt').licenses).toEqual([
      { expression: 'GPL-2.0-or-later AND (LGPL-2.1-or-later OR MIT)', acknowledgement: 'declared' },
    ]);
    expect(getProperty(byName('apt'), 'osp:license-source')).toBe(
      'debian-copyright:/usr/share/doc/apt/copyright',
    );
    expect(getProperty(byName('apt'), 'osp:debian-license')).toBe('GPL-2+ | LGPL-2.1+ or Expat');
    expect(byName('libpq5').licenses).toEqual([
      { license: { id: 'PostgreSQL', acknowledgement: 'declared' } },
    ]);
    // Quellpaket postgresql-18 hat keine eigene copyright-Datei: Lizenz des Binärpakets libpq5
    expect(byName('postgresql-18').licenses).toEqual(byName('libpq5').licenses!);
    expect(getProperty(byName('postgresql-18'), 'osp:license-source')).toContain('libpq5/copyright');
    // Lücken: krb5 ohne Datei, libgone ohne Datei
    expect(result.stats).toMatchObject({ debPackages: 5, debWithLicense: 3, debSpdxOnly: 3 });
    expect(result.gaps.join('\n')).toContain(
      'ohne copyright-Datei im Abbild: libkrb5-3@1.21.3-5, libgone@1.0',
    );
  });

  test('Freitext-Dateien: von Hand gelesene Lizenz nur bei unverändertem Inhalt (SHA-256)', () => {
    // passende Prüfsumme simulieren: Eintrag für den Test auf den Testtext umstellen
    const original = krbEntry.sha256;
    krbEntry.sha256 = sha(KRB_TEXT);
    try {
      const { byName, result } = run({ apt: DEP5, 'libkrb5-3': KRB_TEXT });
      expect(byName('libkrb5-3').licenses?.[0]?.license?.acknowledgement).toBe('declared');
      expect(byName('libkrb5-3').licenses?.[0]?.license?.name).toStartWith('MIT Kerberos');
      expect(getProperty(byName('libkrb5-3'), 'osp:license-source')).toStartWith(
        'manual:/usr/share/doc/libkrb5-3/copyright',
      );
      expect(result.stats.debManual).toBe(1);
    } finally {
      krbEntry.sha256 = original;
    }
    // geänderte Datei: keine Lizenz, Hinweis auf neu zu prüfenden Eintrag
    const { byName, result } = run({ apt: DEP5, 'libkrb5-3': `${KRB_TEXT}geändert\n` });
    expect(byName('libkrb5-3').licenses).toBeUndefined();
    expect(result.gaps.join('\n')).toContain('MANUAL_DEBIAN_LICENSES neu prüfen: krb5');
    expect(result.gaps.join('\n')).toContain('ohne maschinenlesbare copyright-Datei (DEP-5)');
  });

  test('nicht abbildbare Lizenznamen werden gemeldet', () => {
    const text =
      'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/\n\nFiles: *\nCopyright: x\nLicense: public-domain\n';
    const { byName, result } = run({ apt: text });
    expect(byName('apt').licenses).toEqual([
      { license: { name: 'public-domain', acknowledgement: 'declared' } },
    ]);
    expect(result.gaps.join('\n')).toContain('LicenseRef-Debian-<Name> (1 Namen, u. a. public-domain');
  });

  test('Bun: Version, purl, SHA-512, Lizenz, Hersteller; Verweise umbenannt, Kante von der Hauptkomponente', () => {
    const { bom, byName, result } = run({ apt: DEP5 });
    const bun = byName('bun');
    expect(bun).toMatchObject({
      'bom-ref': 'pkg:generic/bun@1.4.3',
      purl: 'pkg:generic/bun@1.4.3',
      version: '1.4.3',
      manufacturer: { name: 'Oven' },
    });
    expect(bun.hashes).toEqual([
      { alg: 'SHA-1', content: 'd2dc' },
      { alg: 'SHA-512', content: 'ab'.repeat(64) },
    ]);
    expect(bun.licenses).toContainEqual({ license: { id: 'MIT', acknowledgement: 'declared' } });
    expect(getProperty(bun, 'bsi:component:executable')).toBe('executable');
    expect(getProperty(bun, 'osp:version-source')).toBe('bun --version im Abbild');
    const refs = JSON.stringify(bom);
    expect(refs).not.toContain('"pkg:generic/bun"');
    const root = bom.dependencies!.find((d) => d.ref === bom.metadata.component!['bom-ref'])!;
    expect(root.dependsOn).toContain('pkg:generic/bun@1.4.3');
    expect((bom.annotations as { subjects: string[] }[])[0]!.subjects).toContain('pkg:generic/bun@1.4.3');
    expect(result.stats.bunVersion).toBe('1.4.3');
    expect(result.gaps.join('\n')).not.toContain('Bun');
  });

  test('Bun-Version: Abweichung vom Dockerfile wird gemeldet; ohne Angabe im Abbild gilt das Dockerfile', () => {
    expect(run({ apt: DEP5 }, { bun: '1.4.4' }).result.gaps.join('\n')).toContain(
      'Bun-Version im Abbild (1.4.4) weicht von deploy/Dockerfile (ARG BUN_VERSION=1.4.3) ab',
    );
    const { byName, result } = run({ apt: DEP5 }, { bun: '' });
    expect(byName('bun').version).toBe('1.4.3');
    expect(getProperty(byName('bun'), 'osp:version-source')).toBe('deploy/Dockerfile');
    expect(result.gaps.join('\n')).toContain('aus deploy/Dockerfile übernommen');
  });

  test('angereicherte Abbild-SBOM lässt sich signieren und prüfen', () => {
    const { bom } = run({ apt: DEP5 });
    const kp = generateSigningKeyPair();
    const signed = signBom(bom as unknown as Record<string, unknown>, kp.privateKeyPem);
    expect(verifyBom(signed, kp.publicKeyPem)).toMatchObject({ ok: true, pinned: true });
  });

  test('renameRef ersetzt Verweise in Graph, Vollständigkeit und Anmerkungen', () => {
    const bom = fixtureBom();
    bom.compositions = [{ aggregate: 'complete', dependencies: ['pkg:generic/bun'] }];
    renameRef(bom, 'pkg:generic/bun', 'pkg:generic/bun@1');
    const bun = bom.components.find((c) => c.name === 'bun')!;
    expect(bun['bom-ref']).toBe('pkg:generic/bun@1');
    expect(bun.purl).toBe('pkg:generic/bun'); // purl ist keine Referenz und bleibt unverändert
    expect(JSON.stringify([bom.dependencies, bom.annotations])).not.toContain('"pkg:generic/bun"');
    expect(bom.compositions[0]!.dependencies).toEqual(['pkg:generic/bun@1']);
  });
});
