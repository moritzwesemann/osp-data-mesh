/**
 * Analyse (osp-nord): Meine Daten → Datentabelle der Freigabe → CSV-Download mit genau den freigegebenen
 * Spalten.
 */
import { describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { env, uiTest } from './harness/ui.ts';

describe('Analyse', () => {
  uiTest('Meine Daten → Datentabelle → CSV-Download', async (t) => {
    const s = await t.session('nord');
    const { page } = s;
    await s.signIn('analyst');

    await s.open('/meine-daten', 'Meine Daten');
    const card = page.getByRole('link', { name: new RegExp(env.seed.kaderProductName) });
    await card.getByText('Zweck: Trainingssteuerung').waitFor();
    await card.click();
    await page.waitForURL(/\/meine-daten\/[0-9a-f-]{36}$/);
    await page.getByRole('heading', { level: 1, name: env.seed.kaderProductName }).waitFor();

    // nur die freigegebenen Spalten (kein Geburtsjahr, kein Verein)
    const table = page.getByRole('table', { name: env.seed.kaderProductName });
    await table.waitFor();
    expect((await table.getByRole('columnheader').allInnerTexts()).map((x) => x.trim())).toEqual([
      '#',
      'Nachname',
      'Vorname',
      'Sportart',
      'Kaderstatus',
    ]);
    await page.getByText(`${env.seed.nordAthletes} Zeilen`, { exact: true }).waitFor();
    await table.getByRole('row').filter({ hasText: 'Wolf' }).filter({ hasText: 'Clara' }).waitFor();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'CSV herunterladen' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('kader_uebersicht.csv');
    expect(await download.failure()).toBeNull();
    const csv = readFileSync((await download.path())!, 'utf8');
    // UTF-8 mit BOM (Excel erkennt die Kodierung), Zeilenende CRLF
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
    const lines = csv
      .slice(1)
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    expect(lines[0]).toBe(env.seed.analystColumns.join(','));
    expect(lines.length).toBe(env.seed.nordAthletes + 1);
    expect(lines).toContain('Wolf,Clara,Ringen,NK2');
  });
});
