/**
 * Schmaler Bildschirm (390 × 844, typisches Smartphone): Klappmenü und kein waagerechter Überlauf der
 * Hauptseiten (breite Tabellen scrollen in ihrem Bereich, nicht die ganze Seite).
 */
import { describe, expect } from 'bun:test';
import { MOBILE, pageOverflowX, type Session, settled, uiTest } from './harness/ui.ts';

async function expectNoOverflow(s: Session, path: string, heading?: string): Promise<void> {
  if (path) await s.open(path, heading);
  await settled(s.page);
  const overflow = await pageOverflowX(s.page);
  expect(`${new URL(s.page.url()).pathname}: ${overflow}px`).toBe(`${new URL(s.page.url()).pathname}: 0px`);
}

describe('Mobil', () => {
  uiTest('Klappmenü öffnet und schließt (Taste, Escape, Navigation)', async (t) => {
    const s = await t.session('nord', { viewport: MOBILE });
    const { page } = s;
    await s.signIn('steward');

    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    const menu = page.getByRole('button', { name: 'Menü' });
    expect(await menu.isVisible()).toBe(true);
    expect(await nav.isVisible()).toBe(false);
    expect(await menu.getAttribute('aria-expanded')).toBe('false');

    await menu.click();
    await nav.waitFor({ state: 'visible' });
    expect(await menu.getAttribute('aria-expanded')).toBe('true');

    // Escape schließt und gibt den Fokus an die Menütaste zurück
    await page.keyboard.press('Escape');
    await nav.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Menü', expanded: false }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-controls'))).toBe('app-nav');

    // Navigation über das Menü schließt es
    await menu.click();
    await nav.getByRole('link', { name: 'Freigaben' }).click();
    await page.waitForURL('**/freigaben');
    await page.getByRole('heading', { level: 1, name: 'Freigaben' }).waitFor();
    await page.getByRole('button', { name: 'Menü', expanded: false }).waitFor();
    await nav.waitFor({ state: 'hidden' });
  });

  uiTest(
    'kein waagerechter Überlauf auf den Hauptseiten (Datenverantwortung, Analyse, Revision)',
    async (t) => {
      const steward = await t.session('nord', { viewport: MOBILE });
      await steward.signIn('steward');

      // Gegenprobe: die Messung erkennt Überlauf (sonst wäre die Prüfung wertlos)
      await steward.page.evaluate(() => {
        const wide = document.createElement('div');
        wide.id = 'e2e-wide';
        wide.style.width = '600px';
        wide.style.height = '1px';
        document.querySelector('#main')?.append(wide);
      });
      expect(await pageOverflowX(steward.page)).toBeGreaterThan(100);
      await steward.page.evaluate(() => document.getElementById('e2e-wide')?.remove());
      expect(await pageOverflowX(steward.page)).toBe(0);

      for (const [path, heading] of [
        ['/', undefined],
        ['/athleten', 'Athleten'],
        ['/quellen', 'Quellen'],
        ['/datensaetze', undefined],
        ['/produkte', undefined],
        ['/freigaben', 'Freigaben'],
        ['/freigaben/neu', 'Freigabe erteilen'],
        ['/katalog', 'Katalog'],
        ['/partner', undefined],
        ['/konto', undefined],
      ] as const) {
        await expectNoOverflow(steward, path, heading);
      }
      // Detailseite einer Person (mit Verlaufsdiagramm, falls Leistungsdiagnostik übernommen)
      await steward.open('/athleten', 'Athleten');
      await steward.page.getByRole('table', { name: 'Liste der Athleten' }).getByRole('link').first().click();
      await steward.page.waitForURL(/\/athleten\/[0-9a-f-]{36}$/);
      await steward.page.getByRole('heading', { level: 2, name: 'Stammdaten' }).waitFor();
      await expectNoOverflow(steward, '');
      // Produkt-Detail
      await steward.open('/produkte');
      await steward.page.locator('#main').getByRole('link', { name: 'Kaderübersicht' }).first().click();
      await steward.page.waitForURL(/\/produkte\/[0-9a-f-]{36}$/);
      await expectNoOverflow(steward, '');

      const analyst = await t.session('nord', { viewport: MOBILE });
      await analyst.signIn('analyst');
      await expectNoOverflow(analyst, '/meine-daten', 'Meine Daten');
      await analyst.page.getByRole('link', { name: /Kaderübersicht/ }).click();
      await analyst.page.getByRole('table', { name: 'Kaderübersicht' }).waitFor();
      await expectNoOverflow(analyst, '');

      const auditor = await t.session('nord', { viewport: MOBILE });
      await auditor.signIn('auditor');
      await expectNoOverflow(auditor, '/audit', 'Audit');
    },
  );
});
