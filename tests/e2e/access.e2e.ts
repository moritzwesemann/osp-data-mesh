/**
 * Zugriffsschutz in der Oberfläche: eine Trainerin sieht keine Seiten der Datenverantwortung (Navigation,
 * direkte Adresse → „Kein Zugriff“), und die API lehnt dieselben Aufrufe ab (Schutz nicht nur im Browser).
 */
import { describe, expect } from 'bun:test';
import { uiTest } from './harness/ui.ts';

describe('Zugriffsschutz', () => {
  uiTest('Trainer/in: keine Seiten der Datenverantwortung (Navigation, direkte Adresse, API)', async (t) => {
    const s = await t.session('nord');
    const { page } = s;
    await s.signIn('coach');
    await page.getByText('Test-OSP Nord · Trainer/in').waitFor();

    const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
    await nav.getByRole('link', { name: 'Meine Daten' }).waitFor();
    for (const hidden of ['Quellen', 'Athleten', 'Freigaben', 'Audit', 'Benutzer']) {
      expect(await nav.getByRole('link', { name: hidden, exact: true }).count()).toBe(0);
    }

    for (const path of ['/quellen', '/freigaben/neu', '/athleten', '/audit']) {
      await s.open(path, 'Kein Zugriff');
      await page.getByText('Für diese Seite fehlt Ihnen die Berechtigung.').waitFor();
    }

    // auch die API verweigert den Zugriff (403), nicht nur die Oberfläche
    s.allow(403, /^\/api\/v1\/(connectors|athletes)$/);
    const statuses = await page.evaluate(async () => {
      const get = async (p: string) => (await fetch(p, { headers: { accept: 'application/json' } })).status;
      return [await get('/api/v1/connectors'), await get('/api/v1/athletes')];
    });
    expect(statuses).toEqual([403, 403]);

    await page.getByRole('link', { name: 'Zur Übersicht' }).click();
    await page.getByRole('heading', { level: 1, name: /^Guten (Morgen|Tag|Abend), E2E coach$/ }).waitFor();
  });
});
