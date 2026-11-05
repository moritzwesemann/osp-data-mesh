/**
 * Revision (osp-nord): Audit-Log einsehen und die Integrität der Hash-Kette prüfen.
 */
import { describe, expect } from 'bun:test';
import { uiTest } from './harness/ui.ts';

describe('Revision', () => {
  uiTest('Audit-Log → „Integrität prüfen“ meldet eine intakte Hash-Kette', async (t) => {
    const s = await t.session('nord');
    const { page } = s;
    await s.signIn('auditor');

    await s.open('/audit', 'Audit');
    await page.getByRole('tab', { name: 'Audit-Log', selected: true }).waitFor();
    const log = page.getByRole('table', { name: 'Audit-Log' });
    // die eigene Anmeldung ist protokolliert
    await log
      .getByRole('row')
      .filter({ hasText: s.node.users.auditor! })
      .filter({ hasText: 'auth.login' })
      .first()
      .waitFor();

    const verify = page.waitForResponse((r) => r.url().includes('/api/v1/audit/verify'));
    await page.getByRole('button', { name: 'Integrität prüfen' }).click();
    expect((await verify).status()).toBe(200);
    const status = page.getByRole('status').filter({ hasText: 'Hash-Kette intakt' });
    await status.waitFor();
    const checked = Number(/(\d+) Einträge geprüft/.exec((await status.textContent()) ?? '')?.[1] ?? 0);
    expect(checked).toBeGreaterThan(10);

    // Austauschprotokoll ist für die Revision einsehbar
    await page.getByRole('tab', { name: 'Austauschprotokoll' }).click();
    await page.getByRole('tab', { name: 'Austauschprotokoll', selected: true }).waitFor();
  });
});
