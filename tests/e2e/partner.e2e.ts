/**
 * Austausch zwischen zwei Knoten über die Oberfläche: osp-mitte findet das Angebot von osp-nord im
 * Katalog, ruft es ab (Kopie mit Herkunftsnachweis); osp-nord widerruft die Freigabe; die Kopie auf
 * osp-mitte wird über die signierte Widerrufsmitteilung gesperrt und geleert.
 */
import { describe, expect } from 'bun:test';
import type { Locator, Page } from 'playwright-core';
import { env, uiTest } from './harness/ui.ts';

const REASON = 'E2E: Kooperation beendet';

/** Seite neu laden, bis der Locator sichtbar ist (Zustandswechsel auf dem Server, z. B. Mitteilung) */
async function reloadUntil(page: Page, target: Locator, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await target.waitFor({ timeout: 1000 });
      return;
    } catch (err) {
      if (Date.now() > until) throw err;
    }
    await page.reload();
  }
}

describe('Partneraustausch', () => {
  uiTest(
    'Katalog zeigt das Angebot → Abrufen → Kopie mit Herkunft → Widerruf beim Datenhalter → Kopie widerrufen',
    async (t) => {
      const nordName = env.nodes.nord.name;

      // osp-mitte: Angebot im Katalog
      const mitte = await t.session('mitte');
      await mitte.signIn('steward');
      const mp = mitte.page;
      await mitte.open('/katalog', 'Katalog');
      await mp.getByRole('tab', { name: 'Bei Partnern' }).click();
      const offer = mp
        .getByRole('listitem')
        .filter({ has: mp.getByRole('heading', { name: env.seed.kaderProductName }) });
      await offer.getByText('Für uns freigegeben').waitFor();
      expect(await offer.textContent()).toContain(nordName);

      // Abrufen (Zweck aus der Freigabe)
      await offer.getByRole('button', { name: 'Abrufen' }).click();
      const dialog = mp.getByRole('dialog', { name: `Abrufen: ${env.seed.kaderProductName}` });
      await dialog.getByText('Trainingssteuerung').waitFor();
      await dialog.getByRole('button', { name: 'Jetzt abrufen' }).click();
      await mp.waitForURL(/\/empfangen\/[0-9a-f-]{36}$/);
      await mp.getByRole('heading', { level: 1, name: env.seed.kaderProductName }).waitFor();
      const receivedUrl = mp.url();

      // Kopie mit Herkunft: Absender, signierte Lieferung, Herkunftsnachweis mit Knotenkennung
      const main = mp.locator('#main');
      await main.getByText(`Von ${nordName}`).waitFor();
      await main
        .getByText('Vom Partner signiert geliefert – Herkunft und Unverändertheit sind nachweisbar.')
        .waitFor();
      const provenance = main.getByRole('group').filter({ hasText: 'Herkunftsnachweis' });
      await provenance.getByText('Herkunftsnachweis').click();
      await provenance.getByText(env.nodes.nord.id).first().waitFor();
      const data = mp.getByRole('table', { name: 'Daten' });
      expect((await data.getByRole('columnheader').allInnerTexts()).map((x) => x.trim())).toEqual([
        '#',
        'Pseudonym',
        'Sportart',
        'Kaderstatus',
        'Geburtsjahr',
      ]);
      await main.getByText(`${env.seed.nordAthletes} Zeilen`, { exact: true }).waitFor();
      // keine Namen in der Kopie (nicht freigegeben)
      expect(await data.textContent()).not.toContain('Wolf');

      // osp-nord: Freigabe widerrufen
      const nord = await t.session('nord');
      await nord.signIn('steward');
      const np = nord.page;
      await nord.open(`/freigaben/${env.seed.partnerReleaseId}`, env.seed.kaderProductName);
      await np.getByText(`Freigabe an ${env.nodes.mitte.name}`).waitFor();
      await np.getByRole('button', { name: 'Freigabe widerrufen' }).click();
      const revoke = np.getByRole('dialog', { name: 'Freigabe widerrufen' });
      await revoke.getByText('Der Partnerknoten erhält eine signierte Widerrufsmitteilung').waitFor();
      const confirm = revoke.getByRole('button', { name: 'Widerrufen' });
      expect(await confirm.isDisabled()).toBe(true);
      await revoke.getByRole('textbox', { name: 'Begründung' }).fill(REASON);
      await confirm.click();
      await revoke.waitFor({ state: 'detached' });
      await np.getByText(/^Diese Freigabe wurde am .* widerrufen\.$/).waitFor();
      await np.locator('#main').getByText('Widerrufen', { exact: true }).first().waitFor();

      // osp-mitte: Kopie widerrufen und geleert (Mitteilung über das Ausgangspostfach von osp-nord)
      await mp.goto(receivedUrl);
      await reloadUntil(mp, main.getByText('Diese Kopie ist nicht mehr aktiv.'));
      await main.getByText(`Begründung des Datenhalters: „${REASON}“`).waitFor();
      await main.getByText('0 Zeilen', { exact: true }).waitFor();
      await main.getByText('Keine Zeilen vorhanden.').waitFor();
      expect(await mp.getByRole('table', { name: 'Daten' }).count()).toBe(0);

      // Liste der empfangenen Daten: Status „Widerrufen“, 0 Zeilen
      await mp.goto('/katalog?wo=empfangen');
      const row = mp
        .getByRole('table', { name: 'Empfangene Daten' })
        .getByRole('row')
        .filter({ has: mp.getByRole('link', { name: env.seed.kaderProductName }) });
      await row.getByText('Widerrufen').waitFor();
      const cells = (await row.getByRole('cell').allInnerTexts()).map((x) => x.trim());
      // Spalten: Daten, Von, Zweck, Zeilen, Abgerufen
      expect(cells.slice(1, 4)).toEqual([nordName, 'Trainingssteuerung', '0']);
    },
  );
});
