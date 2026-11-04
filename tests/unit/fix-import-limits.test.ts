/**
 * Regression: Eine einzelne Quelle (CSV-Kopfzeile, API-Antwort) darf den Knoten nicht blockieren:
 * lineares Umbenennen doppelter Spaltennamen, Obergrenzen für Spalten, Zeilen und Antwortgröße.
 */
import { describe, expect, test } from 'bun:test';
import {
  flattenItem,
  MAX_SOURCE_COLUMNS,
  MAX_SOURCE_ROWS,
  parseCsv,
  tableFromItems,
  uniqueColumnNames,
} from '../../src/server/modules/connectors/pipeline.ts';
import {
  fetchApiItems,
  MAX_API_BYTES,
  secureTransport,
} from '../../src/server/modules/connectors/source-http.ts';
import { HttpApiConfig } from '../../src/shared/contract/connectors.ts';

/** bisheriges (kubisches) Verfahren als Referenz für die Ergebnisse */
function referenceNames(cells: string[]): string[] {
  const columns: string[] = [];
  for (const cell of cells) {
    let name = cell.trim() || `Spalte ${columns.length + 1}`;
    if (columns.includes(name)) {
      let i = 2;
      while (columns.includes(`${name} (${i})`)) i++;
      name = `${name} (${i})`;
    }
    columns.push(name);
  }
  return columns;
}

describe('doppelte Spaltennamen', () => {
  test('gleiche Ergebnisse wie bisher, auch bei Kollisionen mit vorhandenen Namen', () => {
    const cases = [
      ['a', 'a', 'a'],
      ['a', 'a (3)', 'a', 'a', 'a (2)'],
      ['a', 'a', 'a (2)', 'a (2)'],
      ['', '', 'Spalte 1', 'Spalte 3'],
      [' x ', 'x', 'x (2) ', 'x'],
    ];
    for (const c of cases) expect(uniqueColumnNames(c)).toEqual(referenceNames(c));
  });

  test('linear: 50 000 gleiche Namen in Millisekunden', () => {
    const t0 = performance.now();
    const names = uniqueColumnNames(Array.from({ length: 50_000 }, () => 'x'));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(new Set(names).size).toBe(50_000);
    expect(names.at(-1)).toBe('x (50000)');
  });
});

describe('CSV-Obergrenzen', () => {
  test('Kopfzeile mit 2 000 gleichen Spalten blockiert nicht (too_many_columns)', () => {
    const header = Array.from({ length: 2000 }, () => 'x').join(';');
    const t0 = performance.now();
    const t = parseCsv(`${header}\n${'1;'.repeat(1999)}1\n`, ';');
    expect(performance.now() - t0).toBeLessThan(500);
    expect(t.limit).toBe('too_many_columns');
    expect(t.rows).toEqual([]);
  });

  test('16 KB Kopfzeile (auch in Anführungszeichen, automatisches Trennzeichen)', () => {
    const header = Array.from({ length: 8000 }, () => '"a"').join(',');
    const t0 = performance.now();
    const t = parseCsv(`${header}\n1\n`, 'auto');
    expect(performance.now() - t0).toBeLessThan(500);
    expect(t.limit).toBe('too_many_columns');
  });

  test(`genau ${MAX_SOURCE_COLUMNS} Spalten sind zulässig`, () => {
    const header = Array.from({ length: MAX_SOURCE_COLUMNS }, (_, i) => `c${i}`).join(';');
    const t = parseCsv(`${header}\n1\n`, ';');
    expect(t.limit).toBeUndefined();
    expect(t.columns.length).toBe(MAX_SOURCE_COLUMNS);
  });

  test('Zeilenobergrenze; Leerzeilen zählen nicht', () => {
    const body = Array.from({ length: 5 }, (_, i) => `${i}`).join('\n\n\n');
    const exact = parseCsv(`a\n${body}\n`, ';', { maxRows: 5 });
    expect(exact.limit).toBeUndefined();
    expect(exact.rows.map((r) => r.raw.a)).toEqual(['0', '1', '2', '3', '4']);
    const over = parseCsv(`a\n${body}\n6\n`, ';', { maxRows: 5 });
    expect(over.limit).toBe('too_many_rows');
    expect(over.rows.length).toBe(5);
    const big = parseCsv(`a\n${'1\n'.repeat(MAX_SOURCE_ROWS + 1)}`, ';');
    expect(big.limit).toBe('too_many_rows');
  });

  test('kurze Zeilen erzeugen keine Platzhalter je Spalte (keine Vervielfachung)', () => {
    const header = Array.from({ length: MAX_SOURCE_COLUMNS }, (_, i) => `c${i}`).join(';');
    const t = parseCsv(`${header}\n${'x\n'.repeat(1000)}`, ';');
    expect(t.rows.length).toBe(1000);
    expect(Object.keys(t.rows[0]!.raw)).toEqual(['c0']);
    expect(t.issues.length).toBe(1000);
  });
});

describe('API-Quellen: Obergrenzen', () => {
  const config = (over: Record<string, unknown> = {}) =>
    HttpApiConfig.parse({ type: 'http_api', url: 'https://measure.mesh.test/v1', ...over });
  const fetchVia =
    (handler: (req: Request) => Response | Promise<Response>) =>
    (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handler(input instanceof Request ? input : new Request(String(input), init)));

  test('eine einzelne Seite mit zu vielen Einträgen: too_many_rows statt Absturz', async () => {
    const body = `[${new Array(MAX_SOURCE_ROWS * 2).fill('0').join(',')}]`;
    const r = await fetchApiItems(
      fetchVia(() => new Response(body)),
      config(),
      null,
    );
    expect(r).toMatchObject({ ok: false, code: 'too_many_rows', params: { max: MAX_SOURCE_ROWS } });
  });

  test('übergroße Antwort wird beim Lesen abgebrochen (auch ohne Content-Length)', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 80) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const r = await fetchApiItems(
      fetchVia(() => new Response(stream)),
      config(),
      null,
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_response', params: { reason: 'too_large' } });
    expect(pulled).toBeLessThanOrEqual(MAX_API_BYTES / chunk.byteLength + 2);
    const declared = await fetchApiItems(
      fetchVia(() => new Response('[]', { headers: { 'content-length': String(MAX_API_BYTES + 1) } })),
      config(),
      null,
    );
    expect(declared).toMatchObject({ ok: false, params: { reason: 'too_large' } });
  });

  test('zu viele verschiedene Felder: too_many_columns', () => {
    const item = Object.fromEntries(Array.from({ length: MAX_SOURCE_COLUMNS + 1 }, (_, i) => [`k${i}`, i]));
    expect(tableFromItems([item]).limit).toBe('too_many_columns');
    expect(tableFromItems([{ a: 1 }]).limit).toBeUndefined();
  });

  test('tief verschachtelte Einträge führen nicht zum Stapelüberlauf', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 20_000; i++) deep = { a: deep };
    const flat = flattenItem({ id: 1, deep });
    expect(flat.id).toBe('1');
    expect(Object.keys(flat).length).toBe(2);
  });

  test('Geheimnisse nur über https oder Loopback', async () => {
    expect(secureTransport('https://measure.mesh.test/x', false)).toBe(true);
    expect(secureTransport('http://measure.mesh.test/x', false)).toBe(false);
    expect(secureTransport('http://measure.mesh.test/x', true)).toBe(true);
    for (const local of ['http://127.0.0.1:4410/x', 'http://[::1]:4410/x', 'http://localhost/x']) {
      expect(secureTransport(local, false)).toBe(true);
    }
    expect(secureTransport('http://127.0.0.1.evil.test/x', false)).toBe(false);
    let called = false;
    await expect(
      fetchApiItems(
        () => {
          called = true;
          return Promise.resolve(Response.json([]));
        },
        config({ url: 'http://measure.mesh.test/v1', auth: { type: 'bearer' } }),
        'geheim',
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
