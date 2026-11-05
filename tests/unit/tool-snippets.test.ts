/**
 * Code-Beispiele der Oberfläche (Meine Daten › Zugriff aus Excel, Power BI oder Python): passen zur
 * REST-API und sind syntaktisch gültig. Die Ausführung gegen einen echten Knoten ist in docs/bi.md belegt.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildToolSnippets } from '../../src/ui/components/products/toolSnippets.ts';
import { createTranslator } from '../../src/ui/i18n/index.tsx';

const URL_ =
  'https://mesh.osp-beispiel.example.de/api/v1/access/5f0c2a8e-1c2d-4e5f-9a8b-7c6d5e4f3a2b/data?purpose=training_steering&format=csv';

function snippets(lang: 'de' | 'en') {
  const { t } = createTranslator(lang);
  return buildToolSnippets({
    url: URL_,
    fileBase: 'kader_uebersicht',
    token: t('myData.tokenPlaceholder'),
    powerQueryAuthHint: t('myData.powerQueryAuthHint'),
  });
}

describe('Code-Beispiele für den REST-Abruf', () => {
  test('curl: Bearer-Token, Adresse in Anführungszeichen, --fail, gültige Shell-Syntax', () => {
    const { curl } = snippets('de');
    expect(curl).toContain('-H "Authorization: Bearer IHR-API-TOKEN"');
    expect(curl).toContain(`"${URL_}"`);
    expect(curl).toContain('--fail');
    expect(curl.endsWith('-o kader_uebersicht.csv')).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'osp-snippet-'));
    try {
      writeFileSync(join(dir, 'c.sh'), curl);
      expect(Bun.spawnSync(['sh', '-n', join(dir, 'c.sh')]).exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Python: BOM-sicheres Einlesen, Fehlerprüfung, gültige Syntax', () => {
    const { python } = snippets('en');
    expect(python).toContain(`URL = "${URL_}"`);
    expect(python).toContain('TOKEN = "YOUR-API-TOKEN"');
    expect(python).toContain('resp.raise_for_status()');
    expect(python).toContain('decode("utf-8-sig")');
    const py = Bun.which('python3');
    if (!py) return; // ohne Python nur die Strukturprüfung
    const dir = mkdtempSync(join(tmpdir(), 'osp-snippet-'));
    try {
      writeFileSync(join(dir, 's.py'), python);
      const r = Bun.spawnSync([py, '-I', '-m', 'py_compile', join(dir, 's.py')], { stderr: 'pipe' });
      expect(r.stderr.toString()).toBe('');
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Power Query M: Anmeldehinweis als Kommentar, Header, CSV-Optionen', () => {
    for (const lang of ['de', 'en'] as const) {
      const { powerQuery } = snippets(lang);
      const lines = powerQuery.split('\n');
      expect(lines[0]!.startsWith('// ')).toBe(true);
      expect(lines[0]).toContain(lang === 'de' ? 'Anonym' : 'Anonymous');
      expect(lines[1]).toBe('let');
      expect(powerQuery).toContain(`Web.Contents("${URL_}", [Headers = [Authorization = "Bearer `);
      expect(powerQuery).toContain(
        'Csv.Document(Quelle, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv])',
      );
      expect(powerQuery).toContain('Table.PromoteHeaders(Tabelle, [PromoteAllScalars = true])');
    }
    // Zeilenumbrüche im Hinweis können den Kommentar nicht verlassen
    const evil = buildToolSnippets({ url: URL_, fileBase: 'x', token: 't', powerQueryAuthHint: 'a\nin 1' });
    expect(evil.powerQuery.split('\n')[0]).toBe('// a in 1');
  });
});
