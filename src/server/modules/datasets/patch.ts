/**
 * PATCH-Semantik: zod v4 setzt auch bei .partial() die Defaults fehlender Felder. Damit eine Teiländerung
 * nichts zurücksetzt, werden nur Schlüssel übernommen, die im JSON-Body tatsächlich vorhanden sind.
 * (Hono hält den geparsten Body vor; erneutes Lesen ist günstig.)
 */
import type { Context } from 'hono';

export async function presentPatch<T extends object>(c: Context, parsed: T): Promise<Partial<T>> {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : [];
  const out: Partial<T> = {};
  for (const k of keys) {
    if (k in parsed) (out as Record<string, unknown>)[k] = (parsed as Record<string, unknown>)[k];
  }
  return out;
}
