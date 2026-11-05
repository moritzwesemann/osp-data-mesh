/**
 * Statische Prüfung der Container-Konfiguration (deploy/): Netztrennung, veröffentlichte Ports, Proxy-Vertrauen,
 * TLS-Weiterleitung und Abbild. Die Laufzeitprüfung derselben Eigenschaften macht deploy/verify-deployment.sh
 * gegen eine laufende Installation (docs/installation.md, B5); dieser Test hält die Konfiguration dazwischen fest.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const DEPLOY = join(import.meta.dir, '../../deploy');

interface Service {
  ports?: string[];
  networks?: string[] | Record<string, { ipv4_address?: string } | null>;
  environment?: Record<string, string>;
  profiles?: string[];
}
interface Compose {
  services: Record<string, Service>;
  networks: Record<
    string,
    { internal?: boolean; driver_opts?: Record<string, string>; ipam?: { config: Record<string, string>[] } }
  >;
}

async function compose(file: string): Promise<Compose> {
  return Bun.YAML.parse(await Bun.file(join(DEPLOY, file)).text()) as Compose;
}

/** Compose-Platzhalter auflösen: ${VAR:-standard}, ${VAR:?meldung}, ${VAR} (ohne Verschachtelung) */
function interpolate(value: string, env: Record<string, string> = {}): string {
  return value.replace(
    /\$\{([A-Z_]+)(?::([-?])([^}]*))?\}/g,
    (_, name: string, op?: string, arg?: string) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      if (op === '-') return arg ?? '';
      if (op === '?') throw new Error(`${name} fehlt`);
      return '';
    },
  );
}

function networksOf(s: Service): string[] {
  if (!s.networks) return [];
  return Array.isArray(s.networks) ? s.networks : Object.keys(s.networks);
}

describe('docker-compose.yml', () => {
  test('nur Caddy veröffentlicht Ports; Knoten, Datenbank, Superset nicht', async () => {
    const c = await compose('docker-compose.yml');
    const publishing = Object.entries(c.services)
      .filter(([, s]) => (s.ports ?? []).length > 0)
      .map(([name]) => name);
    expect(publishing).toEqual(['caddy']);
  });

  test('Caddy: Port außen = Port im Container (sonst falsche HTTP→HTTPS-Weiterleitung), Standard 80/443', async () => {
    const caddy = (await compose('docker-compose.yml')).services.caddy!;
    const envs: Record<string, string>[] = [
      {},
      { CADDY_HTTPS_PORT: '8443', CADDY_HTTP_PORT: '8081', CADDY_BIND: '127.0.0.1' },
    ];
    for (const env of envs) {
      const mappings = caddy.ports!.map((p) => interpolate(p, env).replace('/udp', '').split(':'));
      for (const [, host, container] of mappings) expect(host).toBe(container!);
      const expected = 'CADDY_HTTPS_PORT' in env ? ['8081', '8443'] : ['443', '80'];
      expect([...new Set(mappings.map((m) => m[2]))].sort()).toEqual(expected);
      if ('CADDY_BIND' in env) expect(mappings.every((m) => m[0] === '127.0.0.1')).toBe(true);
    }
    expect(caddy.environment!.CADDY_HTTPS_PORT).toContain('CADDY_HTTPS_PORT');
    expect(caddy.environment!.CADDY_HTTP_PORT).toContain('CADDY_HTTP_PORT');
  });

  test('Datenbank nur im internen Netz backend ohne Adresse des Docker-Hosts', async () => {
    const c = await compose('docker-compose.yml');
    expect(networksOf(c.services.db!)).toEqual(['backend']);
    const backend = c.networks.backend!;
    expect(backend.internal).toBe(true);
    expect(backend.driver_opts?.['com.docker.network.bridge.inhibit_ipv4']).toBe('true');
    // frontend (mit Zugang nach außen) ist nicht intern; dort liegen nur Caddy, Knoten und Superset
    expect(c.networks.frontend!.internal).toBeUndefined();
    const onFrontend = Object.entries(c.services)
      .filter(([, s]) => networksOf(s).includes('frontend'))
      .map(([name]) => name)
      .sort();
    expect(onFrontend).toEqual(['caddy', 'node', 'superset']);
  });

  test('X-Forwarded-For nur von Caddys fester Adresse; Adresse liegt im Subnetz, aber außerhalb des dynamischen Bereichs', async () => {
    const c = await compose('docker-compose.yml');
    const caddyNet = (c.services.caddy!.networks as Record<string, { ipv4_address: string }>).frontend!;
    const node = c.services.node!.environment!;
    const [ipam] = c.networks.frontend!.ipam!.config;
    const envs: Record<string, string>[] = [{}, { FRONTEND_NET_PREFIX: '172.31.253' }];
    for (const env of envs) {
      const caddyIp = interpolate(caddyNet.ipv4_address, env);
      expect(interpolate(node.MESH_TRUSTED_PROXIES!, env)).toBe(caddyIp);
      expect(interpolate(node.MESH_TRUST_PROXY!, env)).toBe('true');
      const prefix = env.FRONTEND_NET_PREFIX ?? '172.31.252';
      expect(caddyIp).toBe(`${prefix}.10`);
      expect(interpolate(ipam!.subnet!, env)).toBe(`${prefix}.0/24`);
      // dynamische Vergabe nur .128–.255: .10 kann kein anderer Container erhalten
      expect(interpolate(ipam!.ip_range!, env)).toBe(`${prefix}.128/25`);
    }
  });

  test('Knoten: Föderation nur über HTTPS, sichere Cookies; ohne Owner-Passwort', async () => {
    const node = (await compose('docker-compose.yml')).services.node!.environment!;
    expect(node.MESH_FEDERATION_ALLOW_HTTP).toBe('false');
    expect(node.MESH_COOKIE_SECURE).toBe('true');
    expect(Object.keys(node).some((k) => k.includes('OWNER'))).toBe(false);
    expect(node.MESH_DB_URL).toContain('mesh_app:');
  });
});

describe('docker-compose.bi-db.yml', () => {
  test('BI-Port nur auf BI_DB_BIND (Pflicht), Port konfigurierbar; bi_access ohne NAT nach außen', async () => {
    const c = await compose('docker-compose.bi-db.yml');
    const [port] = c.services.db!.ports!;
    expect(() => interpolate(port!)).toThrow('BI_DB_BIND fehlt');
    expect(interpolate(port!, { BI_DB_BIND: '10.0.5.10' })).toBe('10.0.5.10:5432:5432');
    expect(interpolate(port!, { BI_DB_BIND: '127.0.0.1', BI_DB_PORT: '55441' })).toBe('127.0.0.1:55441:5432');
    expect(c.networks.bi_access!.driver_opts?.['com.docker.network.bridge.enable_ip_masquerade']).toBe(
      'false',
    );
  });

  test('pg_hba.bi.conf: von außen nur mesh_bi mit TLS, alle anderen ausdrücklich abgelehnt', async () => {
    const rules = (await Bun.file(join(DEPLOY, 'postgres/pg_hba.bi.conf')).text())
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/));
    // Subnetz von bi_access: dort kommen Verbindungen über den veröffentlichten Port an (Gateway-Adresse)
    const biSubnet = (await compose('docker-compose.bi-db.yml')).networks.bi_access!.ipam!.config[0]!.subnet!;
    expect(biSubnet).toBe('172.31.250.0/24');
    // erste passende Zeile entscheidet (wie PostgreSQL)
    const decide = (type: 'host' | 'hostssl', user: string, addr: string) =>
      rules.find(
        (r) =>
          (r[0] === type || (r[0] === 'host' && type === 'hostssl')) &&
          (r[1] === 'all' || r[1] === 'mesh') &&
          (r[2] === 'all' || r[2] === user) &&
          r[3] === addr,
      )?.[4];
    for (const addr of [biSubnet, '0.0.0.0/0', '::/0']) {
      expect(decide('hostssl', 'mesh_bi', addr)).toBe('scram-sha-256');
      expect(decide('host', 'mesh_bi', addr)).toBe('reject');
      for (const user of ['mesh_app', 'mesh_owner', 'postgres'])
        expect(decide('hostssl', user, addr)).toBe('reject');
    }
  });
});

describe('Caddyfile', () => {
  test('HTTPS-Port steht in den Site-Adressen (Weiterleitung mit Port), HTTP-Port global, keine Trust-Installation', async () => {
    const text = (await Bun.file(join(DEPLOY, 'Caddyfile')).text())
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(text).toMatch(/^\{\$CADDY_DOMAIN:localhost\}:\{\$CADDY_HTTPS_PORT:443\} \{$/m);
    expect(text).toMatch(/^\{\$MESH_BI_DOMAIN:bi\.localhost\}:\{\$CADDY_HTTPS_PORT:443\} \{$/m);
    expect(text).toMatch(/^\{\n\thttp_port \{\$CADDY_HTTP_PORT:80\}\n\tskip_install_trust\n\}$/m);
    // https_port würde Caddy in der Weiterleitung weglassen
    expect(text).not.toContain('https_port');
  });
});

describe('Dockerfile', () => {
  test('läuft unprivilegiert, mit Healthcheck, ohne VOLUME (keine verwaisten anonymen Volumes)', async () => {
    const lines = (await Bun.file(join(DEPLOY, 'Dockerfile')).text())
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'));
    const instructions = lines.map((l) => l.trim().split(/\s+/)[0]);
    expect(instructions).not.toContain('VOLUME');
    expect(lines.filter((l) => l.startsWith('USER '))).toEqual(['USER 1000:1000']);
    expect(instructions).toContain('HEALTHCHECK');
    expect(lines.some((l) => /^ARG BUN_VERSION=\d+\.\d+\.\d+$/.test(l))).toBe(true);
  });
});
