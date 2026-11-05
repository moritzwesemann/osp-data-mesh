/**
 * Anmeldung und Abmeldung über die Oberfläche: falsches Passwort, Anmeldung, Weiterleitung zum
 * ursprünglichen Ziel, Abmeldung beendet die Sitzung.
 */
import { describe, expect } from 'bun:test';
import { env, uiTest } from './harness/ui.ts';

describe('Anmeldung', () => {
  uiTest('falsches Passwort → Meldung; Anmeldung → Übersicht; Abmelden beendet die Sitzung', async (t) => {
    const s = await t.session('nord');
    const { page } = s;
    // nicht angemeldet: auth.me 401; falsches Passwort: auth.login 401
    s.allow(401, /^\/api\/v1\/auth\/(me|login)$/);

    await page.goto('/');
    await page.waitForURL('**/anmelden');
    await page.getByRole('heading', { name: 'Anmelden' }).waitFor();

    await page.getByLabel('E-Mail').fill(s.node.users.analyst!);
    await page.getByLabel('Passwort').fill('falsches-Passwort-123');
    const failed = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/login'));
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    expect((await failed).status()).toBe(401);
    // einheitliche Meldung (verrät nicht, ob das Konto existiert)
    await page.getByRole('alert').getByText('E-Mail-Adresse oder Passwort ist falsch').waitFor();
    expect(page.url()).toEndWith('/anmelden');

    await page.getByLabel('Passwort').fill(env.password);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByRole('heading', { level: 1, name: /^Guten (Morgen|Tag|Abend), E2E analyst$/ }).waitFor();
    await page.getByText('Test-OSP Nord · Analyse').waitFor();
    expect(await page.getByRole('alert').count()).toBe(0);

    const cookie = (await s.context.cookies()).find((c) => c.name === 'osp_session');
    expect(cookie?.httpOnly).toBe(true);
    await page.getByRole('button', { name: 'Abmelden' }).click();
    await page.waitForURL('**/anmelden');
    await page.getByRole('heading', { name: 'Anmelden' }).waitFor();

    // Sitzung serverseitig beendet: das alte Cookie gilt nicht mehr …
    const replay = await fetch(`${s.node.url}/api/v1/auth/me`, {
      headers: { cookie: `osp_session=${cookie?.value}` },
    });
    expect(replay.status).toBe(401);
    // … und eine geschützte Seite führt zur Anmeldung mit Rücksprungziel
    await page.goto('/meine-daten');
    await page.waitForURL(/\/anmelden\?weiter=%2Fmeine-daten$/);
    await page.getByLabel('E-Mail').fill(s.node.users.analyst!);
    await page.getByLabel('Passwort').fill(env.password);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.waitForURL('**/meine-daten');
    await page.getByRole('heading', { level: 1, name: 'Meine Daten' }).waitFor();
  });
});
