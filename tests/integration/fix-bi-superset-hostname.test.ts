/**
 * Regression: Superset lief unter dem Hostnamen des Knotens auf Port 8443. Cookies sind nicht an Ports
 * gebunden (RFC 6265, Abschnitt 8.5): Der Browser schickte das host-only Sitzungs-Cookie des Knotens
 * (osp_session) damit auch an Superset. Superset muss unter einem eigenen Hostnamen laufen.
 * (Statische Prüfung von deploy/Caddyfile und deploy/docker-compose.yml.)
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const DEPLOY = join(import.meta.dir, '../../deploy');

interface Site {
  address: string;
  body: string;
}

/** Site-Blöcke der obersten Ebene (ohne Snippets wie "(common) {") */
function caddySites(text: string): Site[] {
  const sites: Site[] = [];
  let depth = 0;
  let current: Site | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    if (depth === 0 && line.endsWith('{')) {
      const address = line.slice(0, -1).trim();
      current = address.startsWith('(') ? null : { address, body: '' };
      if (current) sites.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    // Platzhalter {$VAR:default} öffnen und schließen in derselben Zeile
    if (depth === 0) current = null;
  }
  return sites;
}

/** Ersetzt {$VAR:default} wie Caddy (Standardwert nur, wenn die Variable fehlt) */
function substitute(address: string, env: Record<string, string>): string {
  return address.replace(
    /\{\$([A-Z_]+)(?::([^}]*))?\}/g,
    (_, name: string, def?: string) => env[name] ?? def ?? '',
  );
}

function hostOf(address: string): { host: string; port: string | null } {
  const m = /^(?:https?:\/\/)?([^:/]+)(?::(\d+))?$/.exec(address.trim());
  if (!m) throw new Error(`unexpected site address ${address}`);
  return { host: m[1]!, port: m[2] ?? null };
}

describe('Superset unter eigenem Hostnamen', () => {
  test('Caddyfile: Superset-Site hat einen anderen Hostnamen als der Knoten (nicht nur einen anderen Port)', async () => {
    const sites = caddySites(await Bun.file(join(DEPLOY, 'Caddyfile')).text());
    const node = sites.filter((s) => /reverse_proxy\s+node:4401/.test(s.body));
    const superset = sites.filter((s) => /reverse_proxy\s+superset:8088/.test(s.body));
    expect(node).toHaveLength(1);
    expect(superset).toHaveLength(1);
    // Werte wie in docker-compose.yml (Standard MESH_BI_DOMAIN = bi.<CADDY_DOMAIN>) und ohne Umgebung
    for (const env of [
      { CADDY_DOMAIN: 'mesh.osp.example.de', MESH_BI_DOMAIN: 'bi.mesh.osp.example.de' },
      {} as Record<string, string>,
    ]) {
      const n = hostOf(substitute(node[0]!.address, env));
      const s = hostOf(substitute(superset[0]!.address, env));
      expect(s.host).not.toBe(n.host);
      expect(s.port).toBeNull();
    }
    expect(superset[0]!.address).toContain('{$MESH_BI_DOMAIN');
    expect(superset[0]!.address).not.toContain('CADDY_DOMAIN');
  });

  test('docker-compose: MESH_BI_DOMAIN mit Standard bi.<CADDY_DOMAIN>, kein Port 8443', async () => {
    const compose = Bun.YAML.parse(await Bun.file(join(DEPLOY, 'docker-compose.yml')).text()) as {
      services: { caddy: { environment: Record<string, string>; ports: string[] } };
    };
    const caddy = compose.services.caddy;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose-Platzhalter, kein JS-Template
    expect(caddy.environment.MESH_BI_DOMAIN).toBe('${MESH_BI_DOMAIN:-bi.${CADDY_DOMAIN}}');
    const published = caddy.ports.map((p) => p.split(':').at(-1)!.replace('/udp', ''));
    expect([...new Set(published)].sort()).toEqual(['443', '80']);
  });
});
