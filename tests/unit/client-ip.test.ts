/**
 * Client-Adresse: X-Forwarded-For nur von vertrauenswürdigen Proxys, rechteste nicht vertrauenswürdige
 * Adresse der Kette (core/client-ip.ts).
 */
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/server/config.ts';
import { clientIp, normalizeIp, TrustedProxies } from '../../src/server/core/client-ip.ts';

const local = new TrustedProxies(['127.0.0.1', '::1']);
const ip = (peer: string | null, xff: string | undefined, trusted = local, trustProxy = true) =>
  clientIp({ trustProxy, trusted, peer, forwardedFor: xff });

describe('normalizeIp', () => {
  test('IPv4, IPv6, IPv4-gemappt, Klammern und Ports; Ungültiges → null', () => {
    expect(normalizeIp('10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeIp(' ::FFFF:10.0.0.1 ')).toBe('10.0.0.1');
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('10.0.0.1:8080')).toBe('10.0.0.1');
    expect(normalizeIp('unknown')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(null)).toBeNull();
  });
});

describe('clientIp', () => {
  test('ohne MESH_TRUST_PROXY: immer die TCP-Gegenstelle', () => {
    expect(ip('127.0.0.1', '203.0.113.7', local, false)).toBe('127.0.0.1');
  });

  test('Gegenstelle kein vertrauenswürdiger Proxy: X-Forwarded-For wird ignoriert', () => {
    expect(ip('172.31.252.20', '198.51.100.1')).toBe('172.31.252.20');
    expect(ip('::ffff:172.31.252.20', '198.51.100.1')).toBe('172.31.252.20');
  });

  test('vertrauenswürdiger Proxy: rechteste nicht vertrauenswürdige Adresse, nicht die linkeste', () => {
    expect(ip('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(ip('::ffff:127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    // links vom Proxy kann der Client beliebiges eintragen
    expect(ip('127.0.0.1', '198.51.100.99, 203.0.113.7')).toBe('203.0.113.7');
    // Kette über mehrere vertrauenswürdige Proxys
    expect(ip('127.0.0.1', '198.51.100.99, 203.0.113.7, ::1, 127.0.0.1')).toBe('203.0.113.7');
  });

  test('ohne Header, leerer Header, ungültige Einträge, nur Proxys', () => {
    expect(ip('127.0.0.1', undefined)).toBe('127.0.0.1');
    expect(ip('127.0.0.1', ' , ')).toBe('127.0.0.1');
    expect(ip('127.0.0.1', 'garbage')).toBe('127.0.0.1');
    expect(ip('127.0.0.1', '203.0.113.7, garbage, ::1')).toBe('::1');
    expect(ip('127.0.0.1', '::1, 127.0.0.1')).toBe('::1');
    expect(ip(null, '203.0.113.7')).toBeNull();
  });

  test('Netze in CIDR-Schreibweise, IPv6', () => {
    const net = new TrustedProxies(['172.31.252.0/24', 'fd00::/8']);
    expect(ip('172.31.252.10', '203.0.113.7', net)).toBe('203.0.113.7');
    expect(ip('172.31.253.10', '203.0.113.7', net)).toBe('172.31.253.10');
    expect(ip('fd12::5', '2001:db8::7', net)).toBe('2001:db8::7');
  });
});

describe('MESH_TRUSTED_PROXIES', () => {
  const env = {
    MESH_NODE_ID: 'osp-x',
    MESH_NODE_NAME: 'X',
    MESH_PUBLIC_URL: 'https://x.example',
    MESH_DB_URL: 'postgres://x',
    MESH_MASTER_KEY: Buffer.alloc(32).toString('base64'),
  };
  test('Standard 127.0.0.1 und ::1; Liste mit Leerzeichen; ungültige Einträge werden abgewiesen', () => {
    expect(loadConfig(env).MESH_TRUSTED_PROXIES).toEqual(['127.0.0.1', '::1']);
    expect(
      loadConfig({ ...env, MESH_TRUSTED_PROXIES: ' 172.31.252.10 , 10.0.0.0/8 ' }).MESH_TRUSTED_PROXIES,
    ).toEqual(['172.31.252.10', '10.0.0.0/8']);
    expect(() => loadConfig({ ...env, MESH_TRUSTED_PROXIES: 'caddy' })).toThrow(/MESH_TRUSTED_PROXIES/);
    expect(() => loadConfig({ ...env, MESH_TRUSTED_PROXIES: '10.0.0.0/33' })).toThrow(/MESH_TRUSTED_PROXIES/);
  });
});
