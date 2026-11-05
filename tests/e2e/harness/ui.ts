/**
 * Browser-Hilfen der E2E-Tests: je Test ein eigenes Chromium (bun test teilt Module zwischen den Dateien,
 * daher kein gemeinsamer Browser), je Sitzung ein eigener Browser-Kontext (eigene Cookies), Überwachung auf Konsolenfehler, Skriptfehler und fehlgeschlagene API-Aufrufe (nur ausdrücklich
 * erwartete Fehlerstatus sind erlaubt) und Bildschirmfotos bei Fehlschlag (.local/e2e/artefakte/).
 *
 * Selektoren über Rollen, Beschriftungen und sichtbare Texte der deutschen Oberfläche; gewartet wird auf
 * Zustände (waitFor, waitForURL, waitForResponse), nie mit festen Pausen.
 */
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Locator, type Page } from 'playwright-core';
import { type E2eEnv, loadEnv, type NodeEnv, type NodeKey, type UserKey } from './env.ts';

export const env: E2eEnv = loadEnv();

export const DESKTOP = { width: 1280, height: 860 };
export const MOBILE = { width: 390, height: 844 };

/** Erwarteter Fehlerstatus einer API-Antwort (z. B. 401 bei falschem Passwort) */
interface Allowed {
  status: number;
  path: RegExp;
}

export interface Session {
  page: Page;
  context: BrowserContext;
  node: NodeEnv;
  /** Fehlerstatus für passende API-Pfade erlauben (für den Rest des Tests) */
  allow(status: number, path: RegExp): void;
  /** Über das Anmeldeformular anmelden und auf die Startseite warten */
  signIn(user: UserKey): Promise<void>;
  /** Seite aufrufen und auf den Seitentitel (h1) warten */
  open(path: string, heading?: string | RegExp): Promise<void>;
}

export interface UiTest {
  /** Neuer Browser-Kontext gegen einen Knoten */
  session(node: NodeKey, opts?: { viewport?: { width: number; height: number } }): Promise<Session>;
}

/** Anmerkungen aus der Überwachung (Konsole, Skriptfehler, API) */
type Problem = string;

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Ein Oberflächentest: legt Kontexte an, überwacht sie und prüft am Ende, dass keine unerwarteten
 * Fehler aufgetreten sind. Bei Fehlschlag: Bildschirmfoto + Seitentext je Kontext.
 */
export function uiTest(name: string, body: (t: UiTest) => Promise<void>, timeoutMs = 60_000): void {
  test(
    name,
    async () => {
      const b = await chromium.launch({ headless: true, args: ['--lang=de-DE'] });
      const sessions: { label: string; s: Session }[] = [];
      const problems: Problem[] = [];

      const t: UiTest = {
        async session(nodeKey, opts = {}) {
          const node = env.nodes[nodeKey];
          const context = await b.newContext({
            baseURL: node.url,
            viewport: opts.viewport ?? DESKTOP,
            locale: 'de-DE',
            timezoneId: 'Europe/Berlin',
            acceptDownloads: true,
          });
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          page.setDefaultNavigationTimeout(15_000);
          const allowed: Allowed[] = [];
          const label = `${node.id}#${sessions.length + 1}`;
          const where = () => `${label} ${new URL(page.url() || node.url).pathname}`;

          page.on('console', (m) => {
            if (m.type() !== 'error') return;
            // "Failed to load resource" begleitet jede 4xx/5xx-Antwort – geprüft über das response-Ereignis
            if (/Failed to load resource/.test(m.text())) return;
            problems.push(`${where()}: console.error ${m.text().slice(0, 300)}`);
          });
          page.on('pageerror', (e) => problems.push(`${where()}: Skriptfehler ${String(e).slice(0, 300)}`));
          page.on('response', (r) => {
            if (r.status() < 400) return;
            const path = new URL(r.url()).pathname;
            if (allowed.some((a) => a.status === r.status() && a.path.test(path))) return;
            problems.push(`${where()}: ${r.request().method()} ${path} → HTTP ${r.status()}`);
          });
          page.on('requestfailed', (r) => {
            const reason = r.failure()?.errorText ?? '';
            // abgebrochene Anfragen (Seitenwechsel, Downloads) sind kein Fehler
            if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason)) return;
            problems.push(`${where()}: Anfrage fehlgeschlagen ${r.url()} ${reason}`);
          });

          const s: Session = {
            page,
            context,
            node,
            allow(status, path) {
              allowed.push({ status, path });
            },
            async signIn(user) {
              const email = node.users[user];
              if (!email) throw new Error(`${node.id}: keine Person ${user}`);
              // nicht angemeldet: auth.me antwortet 401 (erwartet)
              s.allow(401, /^\/api\/v1\/auth\/me$/);
              await page.goto('/anmelden');
              await page.getByLabel('E-Mail').fill(email);
              await page.getByLabel('Passwort').fill(env.password);
              await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
              await waitForHeading(page);
              // Rahmen geladen (Abmelden steht auf schmalen Bildschirmen im Klappmenü)
              await page
                .getByRole('navigation', { name: 'Hauptnavigation', includeHidden: true })
                .waitFor({ state: 'attached' });
            },
            async open(path, heading) {
              await page.goto(path);
              await waitForHeading(page, heading);
            },
          };
          sessions.push({ label, s });
          return s;
        },
      };

      try {
        await body(t);
        expect(problems, 'unerwartete Konsolen-/API-Fehler').toEqual([]);
      } catch (err) {
        for (const { label, s } of sessions) {
          const base = join(env.artifactsDir, `${slug(name)}--${slug(label)}`);
          try {
            await s.page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 5000 });
            // biome-ignore lint/performance/useDomNodeTextContent: gerenderter Text (wie sichtbar) fürs Fehlerbild
            const text = await s.page.locator('body').innerText({ timeout: 2000 });
            writeFileSync(`${base}.txt`, `${s.page.url()}\n\n${text}`);
          } catch {
            // Seite schon geschlossen
          }
        }
        if (problems.length)
          writeFileSync(join(env.artifactsDir, `${slug(name)}--probleme.txt`), problems.join('\n'));
        throw err;
      } finally {
        await b.close().catch(() => {});
      }
    },
    timeoutMs,
  );
}

/** Wartet, bis der Locator einen Text enthält (ohne feste Pause) */
export async function waitForText(locator: Locator, text: string | RegExp, timeout = 10_000): Promise<void> {
  await locator.filter({ hasText: text }).first().waitFor({ timeout });
}

/**
 * Wartet, bis die Seite fertig geladen ist: Seitentitel sichtbar und keine Ladeanzeige mehr
 * (alle Lade-Platzhalter der Oberfläche tragen aria-busy="true").
 */
export async function settled(page: Page): Promise<void> {
  await waitForHeading(page);
  await page.waitForFunction(() => !document.querySelector('#main [aria-busy="true"]'));
}

/**
 * Wartet auf einen Seitentitel (h1 im Inhalt), optional mit Text. Über waitForFunction (Prüfung je
 * Bildaufbau): locator.waitFor fragt mit wachsenden Abständen ab (bis 500 ms) und verschenkt nach jedem
 * Seitenwechsel Zeit, weil React das Einblenden nachgeladener Seiten um ~300 ms verzögert.
 */
export async function waitForHeading(page: Page, text?: string | RegExp): Promise<void> {
  const pattern: { re: string; flags: string } | null =
    text === undefined
      ? null
      : typeof text === 'string'
        ? { re: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: '' }
        : { re: text.source, flags: text.flags };
  await page.waitForFunction((p) => {
    const titles = [...document.querySelectorAll('#main h1')].map((h) => h.textContent ?? '');
    if (!p) return titles.length > 0;
    return titles.some((t) => new RegExp(p.re, p.flags).test(t));
  }, pattern);
}

/** Horizontaler Überlauf der Seite in Pixeln (0 = passt in die Breite) */
export async function pageOverflowX(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
