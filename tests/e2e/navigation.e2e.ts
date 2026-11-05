/**
 * Seitenleiste: Name beim Überfahren (mit der Maus erreichbar, Escape blendet aus), aufgeklappt bleibt sie
 * auf breiten Bildschirmen nach dem Neuladen; mittlere Breite: die Leiste liegt über dem Inhalt und schließt
 * mit Escape (Fokus bleibt auf der Taste) oder wenn der Fokus sie per Tab verlässt.
 */
import { describe, expect } from 'bun:test';
import { uiTest } from './harness/ui.ts';

describe('Seitenleiste', () => {
  uiTest('breit: Name beim Überfahren, Escape blendet aus; Aufklappen bleibt nach Neuladen', async (t) => {
    const s = await t.session('nord', { viewport: { width: 1440, height: 900 } });
    const { page } = s;
    await s.signIn('steward');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    const tip = page.locator('.rail-tip');

    await nav.getByRole('link', { name: 'Katalog' }).hover();
    await tip.waitFor();
    expect(await tip.getAttribute('data-label')).toBe('Katalog');
    // die Maus erreicht den Namen, ohne dass er verschwindet
    await tip.hover();
    await page.waitForTimeout(100);
    expect(await tip.count()).toBe(1);
    await page.keyboard.press('Escape');
    await tip.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Seitenleiste aufklappen' }).click();
    await page.getByRole('button', { name: 'Seitenleiste zuklappen', expanded: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Seitenleiste zuklappen', expanded: true }).waitFor();
  });

  uiTest('mittlere Breite: Leiste über dem Inhalt schließt mit Escape und bei Tab hinaus', async (t) => {
    const s = await t.session('nord', { viewport: { width: 1000, height: 760 } });
    const { page } = s;
    await s.signIn('steward');
    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    const opened = page.getByRole('button', { name: 'Seitenleiste zuklappen', expanded: true });
    const closed = page.getByRole('button', { name: 'Seitenleiste aufklappen', expanded: false });
    const focusInNav = () => page.evaluate(() => Boolean(document.activeElement?.closest('#app-nav')));

    await closed.focus();
    await page.keyboard.press('Enter');
    await opened.waitFor();
    await page.keyboard.press('Escape');
    await closed.waitFor();
    expect(await page.evaluate(() => document.activeElement?.classList.contains('rail-toggle'))).toBe(true);

    await page.keyboard.press('Enter');
    await opened.waitFor();
    await nav.getByRole('button', { name: 'Abmelden' }).focus();
    expect(await focusInNav()).toBe(true);
    await page.keyboard.press('Tab');
    await closed.waitFor();
    expect(await focusInNav()).toBe(false);
  });
});
