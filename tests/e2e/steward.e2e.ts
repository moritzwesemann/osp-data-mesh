/**
 * Datenverantwortung (osp-nord): CSV-Import mit Vorschau und Fehlerprotokoll, Athletenseite mit Einträgen
 * je Datensatz und Verlaufsdiagramm, Freigabe mit Einschränkung und „Wirkung prüfen“.
 */
import { describe, expect } from 'bun:test';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { ApiClient, fixtureForm, ROOT } from './harness/api.ts';
import { env, uiTest } from './harness/ui.ts';

const LD_CSV = join(ROOT, 'fixtures/osp-nord/leistungsdiagnostik.csv');

/** Kennzahl eines Importlaufs (Kachel „Zeilen gesamt“, „Gültig“ …) */
async function stat(page: Page, label: string): Promise<string> {
  const tile = page.locator('.stat').filter({ has: page.getByText(label, { exact: true }) });
  return ((await tile.locator('.stat-value').textContent()) ?? '').trim();
}

/**
 * Leistungsdiagnostik über die API übernehmen, falls der Import-Test nicht lief (z. B. mit -t gefiltert),
 * damit die Athletenseite unabhängig prüfbar bleibt.
 */
async function ensureLeistungsdiagnostik(): Promise<void> {
  const nord = env.nodes.nord;
  const st = new ApiClient(nord.url, 'nord/steward');
  await st.login(nord.users.steward!, env.password);
  const datasets = await st.ok<{ items: { slug: string; recordCount: number }[] }>('GET', '/api/v1/datasets');
  if ((datasets.items.find((d) => d.slug === 'leistungsdiagnostik')?.recordCount ?? 0) > 0) return;
  const templates = await st.ok<{ items: { id: string; definition: unknown }[] }>(
    'GET',
    '/api/v1/connector-templates',
  );
  const tpl = templates.items.find((t) => t.id === 'leistungsdiagnostik-csv')!;
  const c = await st.ok<{ id: string }>('POST', '/api/v1/connectors/import', {
    body: { definition: tpl.definition, createDataset: true },
  });
  const run = await st.ok<{ run: { id: string } }>('POST', `/api/v1/connectors/${c.id}/runs`, {
    form: fixtureForm('osp-nord/leistungsdiagnostik.csv'),
  });
  await st.ok('POST', `/api/v1/import-runs/${run.run.id}/commit`);
}

describe('Datenverantwortung', () => {
  uiTest('CSV-Import: Vorlage übernehmen → Vorschau mit Fehlerprotokoll → Übernehmen', async (t) => {
    const s = await t.session('nord');
    const { page } = s;
    await s.signIn('steward');

    await s.open('/quellen', 'Quellen');
    await page.getByRole('button', { name: 'Vorlagen' }).click();
    await page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'Leistungsdiagnostik (CSV)' }) })
      .getByRole('button', { name: 'Vorlage übernehmen' })
      .click();
    await page.waitForURL(/\/quellen\/[0-9a-f-]{36}$/);
    await page.getByRole('heading', { level: 1, name: 'Leistungsdiagnostik (CSV)' }).waitFor();

    const start = page.getByRole('button', { name: 'Import starten' });
    expect(await start.isDisabled()).toBe(true);
    await page.getByLabel('CSV-Datei').setInputFiles(LD_CSV);
    await start.click();
    await page.waitForURL(/\/importe\/[0-9a-f-]{36}$/);
    await page.getByRole('heading', { level: 1, name: 'Importlauf: Leistungsdiagnostik (CSV)' }).waitFor();

    // Vorschau: nichts gespeichert, 2 unplausible Zeilen im Fehlerprotokoll
    await page.getByText('Dies ist eine Vorschau; Daten werden erst mit „Übernehmen“ gespeichert.').waitFor();
    expect(await stat(page, 'Zeilen gesamt')).toBe('80');
    expect(await stat(page, 'Gültig')).toBe('78');
    expect(await stat(page, 'Fehlerhaft')).toBe('2');
    const errors = page.getByRole('table', { name: 'Fehlerprotokoll' }).getByRole('row');
    const vo2 = errors.filter({ has: page.getByRole('cell', { name: '17', exact: true }) });
    expect(await vo2.textContent()).toContain('Wert liegt außerhalb des plausiblen Bereichs.');
    expect(await vo2.textContent()).toContain('140.0');
    const future = errors.filter({ has: page.getByRole('cell', { name: '58', exact: true }) });
    expect(await future.textContent()).toContain('Das Datum liegt in der Zukunft.');
    expect(await future.textContent()).toContain('2099-03-15');
    await page.getByRole('table', { name: 'Vorschau' }).waitFor();

    await page.getByRole('button', { name: 'Übernehmen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import übernehmen' });
    await dialog
      .getByText('78 gültige Zeilen werden übernommen; 2 fehlerhafte Zeilen werden übersprungen.')
      .waitFor();
    await dialog.getByRole('button', { name: 'Übernehmen' }).click();
    await dialog.waitFor({ state: 'detached' });

    await page.locator('.stat').filter({ hasText: 'Neu angelegt' }).waitFor();
    expect(await stat(page, 'Neu angelegt')).toBe('78');
    expect(await stat(page, 'Aktualisiert')).toBe('0');
    await page.locator('#main').getByText('Übernommen', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Übernehmen' }).count()).toBe(0);
  });

  uiTest('Athletenseite zeigt die Einträge der Person je Datensatz und den Verlauf', async (t) => {
    await ensureLeistungsdiagnostik();
    const s = await t.session('nord');
    const { page } = s;
    await s.signIn('steward');

    await s.open('/athleten', 'Athleten');
    await page.getByRole('searchbox', { name: 'Suche' }).fill('Wolf');
    await page.getByRole('button', { name: 'Suchen' }).click();
    const list = page.getByRole('table', { name: 'Liste der Athleten' });
    await list.getByRole('link', { name: 'Wolf, Clara' }).click();
    await page.waitForURL(/\/athleten\/[0-9a-f-]{36}$/);
    await page.getByRole('heading', { level: 1, name: 'Clara Wolf' }).waitFor();

    // Stammdaten aus athleten.csv
    await page.getByText('Ringen · Freistil bis 65 kg').waitFor();
    // Überblick: Einträge je Datensatz
    const overview = page.getByRole('table', { name: 'Daten im Überblick' });
    const ldRow = overview
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: 'Leistungsdiagnostik' }) });
    expect((await ldRow.getByRole('cell').allInnerTexts()).map((x) => x.trim())).toEqual([
      'Leistungsdiagnostik',
      '2',
    ]);

    // Verlaufsdiagramm (SVG mit Textalternative) und Wechsel des Werts
    await page.getByRole('heading', { level: 3, name: 'Verlauf' }).waitFor();
    await page
      .getByRole('img', {
        name: 'Verlauf Maximale Sauerstoffaufnahme (VO2max): 2 Messungen vom 17.10.2024 (51,5 ml/kg/min) bis 25.08.2026 (52,1 ml/kg/min).',
      })
      .waitFor();
    await page
      .getByRole('combobox', { name: 'Wert' })
      .selectOption({ label: 'Maximale Herzfrequenz (1/min)' });
    await page
      .getByRole('img', {
        name: 'Verlauf Maximale Herzfrequenz: 2 Messungen vom 17.10.2024 (179 1/min) bis 25.08.2026 (196 1/min).',
      })
      .waitFor();

    // alle Einträge, neueste zuerst
    const entries = page.getByRole('table', { name: 'Alle Einträge: Leistungsdiagnostik' });
    const rows = entries.locator('tbody tr');
    expect(await rows.count()).toBe(2);
    expect(await rows.nth(0).textContent()).toContain('25.08.2026');
    expect(await rows.nth(1).textContent()).toContain('17.10.2024');
  });

  uiTest(
    'Freigabe erteilen: Produkt, Empfänger, Zweck, Spalten, Einschränkung, „Wirkung prüfen“',
    async (t) => {
      const s = await t.session('nord');
      const { page } = s;
      await s.signIn('steward');

      await s.open('/freigaben', 'Freigaben');
      await page.getByRole('link', { name: 'Freigabe erteilen' }).click();
      await page.getByRole('heading', { level: 1, name: 'Freigabe erteilen' }).waitFor();
      await page
        .getByText('Wählen Sie Datenprodukt, Empfänger, mindestens einen Zweck und eine Spalte.')
        .waitFor();

      await page
        .getByRole('combobox', { name: 'Datenprodukt' })
        .selectOption({ label: env.seed.kaderProductName });
      expect(await page.getByRole('radio', { name: 'Rolle dieses Knotens' }).isChecked()).toBe(true);
      await page.getByRole('combobox', { name: 'Rolle' }).selectOption({ label: 'Trainer/in' });
      await page.getByRole('checkbox', { name: 'Trainingssteuerung' }).check();
      for (const col of ['Nachname', 'Vorname', 'Sportart', 'Kaderstatus']) {
        await page.getByRole('checkbox', { name: col, exact: true }).check();
      }
      await page.getByText('4 von 6 ausgewählt').waitFor();

      // eine Einschränkung: nur Rudern
      await page.getByRole('button', { name: '5. Einschränkungen (optional)' }).click();
      await page.getByRole('button', { name: 'Bedingung hinzufügen' }).click();
      const condition = page.getByRole('listitem').filter({ hasText: 'Bedingung 1' });
      await condition.getByRole('combobox', { name: 'Spalte' }).selectOption({ label: 'Sportart' });
      await condition.getByRole('combobox', { name: 'Bedingung' }).selectOption({ label: 'ist gleich' });
      await condition.getByRole('textbox', { name: 'Wert' }).fill('Rudern');
      await page.getByRole('textbox', { name: 'Rechtsgrundlage' }).fill('E2E: Trainingsvereinbarung Rudern');

      // Wirkung prüfen: was der Empfänger erhalten würde
      const preview = page.waitForResponse((r) => r.url().endsWith('/api/v1/releases/preview'));
      await page.getByRole('button', { name: 'Wirkung prüfen' }).click();
      expect((await preview).status()).toBe(200);
      await page.getByText('Der Zugriff würde gewährt.').waitFor();
      await page.getByText(`6 von ${env.seed.nordAthletes} Zeilen würden geliefert.`).waitFor();
      await page
        .getByText(
          `Ausgeschlossen: ${env.seed.nordAthletes - 6} durch Zeilenbeschränkung, 0 durch Datenzeitraum, 0 wegen fehlender Einwilligung.`,
        )
        .waitFor();
      const sample = page.getByRole('table', { name: 'Beispielzeilen der geprüften Freigabe' });
      expect((await sample.getByRole('columnheader').allInnerTexts()).map((x) => x.trim())).toEqual([
        'Nachname',
        'Vorname',
        'Sportart',
        'Kaderstatus',
      ]);
      const sampleRows = sample.locator('tbody tr');
      expect(await sampleRows.count()).toBe(6);
      for (const row of await sampleRows.all()) expect(await row.textContent()).toContain('Rudern');

      // erteilen → Detailseite
      await page.getByRole('button', { name: 'Freigabe erteilen' }).click();
      await page.waitForURL(/\/freigaben\/[0-9a-f-]{36}$/);
      await page.getByRole('heading', { level: 1, name: env.seed.kaderProductName }).waitFor();
      await page.getByText('Freigabe an Trainer/in').waitFor();
      const main = page.locator('#main');
      // aktiv: kein Statushinweis, Widerruf möglich; Spalten und Einschränkung wie erteilt
      await main.getByRole('button', { name: 'Freigabe widerrufen' }).waitFor();
      await main.getByText('Nachname, Vorname, Sportart, Kaderstatus', { exact: true }).waitFor();
      await main.getByText('Sportart ist gleich Rudern', { exact: true }).waitFor();

      // Wirkung beim Empfänger: die Trainerin sieht genau die 6 Zeilen
      const coach = await t.session('nord');
      await coach.signIn('coach');
      await coach.open('/meine-daten', 'Meine Daten');
      await coach.page.getByRole('link', { name: new RegExp(env.seed.kaderProductName) }).click();
      await coach.page.getByRole('table', { name: env.seed.kaderProductName }).waitFor();
      await coach.page.getByText('6 Zeilen', { exact: true }).waitFor();
    },
  );
});
