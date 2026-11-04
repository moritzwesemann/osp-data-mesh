/**
 * Client-Adresse einer Anfrage (Audit, Ratenbegrenzungen je IP-Adresse).
 *
 * X-Forwarded-For wird nur ausgewertet, wenn MESH_TRUST_PROXY=true ist UND die TCP-Gegenstelle ein
 * vertrauenswürdiger Proxy ist (MESH_TRUSTED_PROXIES). Sonst könnte jeder, der den Knoten direkt erreicht
 * (z. B. ein kompromittierter Dienst im selben Docker-Netz), eine beliebige Adresse vorgeben: fremde
 * Partner in die Ratenbegrenzung treiben, die Anmeldebegrenzung umgehen, Audit-Adressen fälschen.
 * Aus der Kette gilt die rechteste Adresse, die kein vertrauenswürdiger Proxy ist (links davon kann der
 * Client beliebiges eintragen).
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';

/** Adresse ohne Klammern/Port, IPv4-gemappte IPv6-Adressen als IPv4; null, wenn keine gültige IP */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) s = mapped[1]!;
  if (isIPv4(s)) return s;
  if (isIPv6(s)) return s.toLowerCase();
  return null;
}

export class TrustedProxies {
  private readonly list = new BlockList();

  /** entries: IP-Adressen (IPv4/IPv6) oder Netze in CIDR-Schreibweise; wirft bei ungültigen Einträgen */
  constructor(readonly entries: readonly string[]) {
    for (const entry of entries) {
      const [addr, prefix, extra] = entry.split('/');
      const ip = normalizeIp(addr);
      if (!ip || extra !== undefined) throw new Error(`invalid proxy address: ${entry}`);
      const type = isIPv4(ip) ? 'ipv4' : 'ipv6';
      if (prefix === undefined) {
        this.list.addAddress(ip, type);
        continue;
      }
      const bits = Number(prefix);
      if (!/^\d{1,3}$/.test(prefix) || bits > (type === 'ipv4' ? 32 : 128)) {
        throw new Error(`invalid proxy network: ${entry}`);
      }
      this.list.addSubnet(ip, bits, type);
    }
  }

  contains(address: string): boolean {
    const ip = normalizeIp(address);
    if (!ip) return false;
    return this.list.check(ip, isIPv4(ip) ? 'ipv4' : 'ipv6');
  }
}

/** Prüft MESH_TRUSTED_PROXIES (für die Konfiguration) */
export function proxyListIssue(entries: readonly string[]): string | null {
  try {
    new TrustedProxies(entries);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Client-Adresse aus TCP-Gegenstelle und X-Forwarded-For. Die Kette wird von rechts gelesen: jede Adresse,
 * die ein vertrauenswürdiger Proxy ist, wird übersprungen; die erste andere ist der Client. Ein ungültiger
 * Eintrag beendet die Suche (zuletzt geprüfter vertrauenswürdiger Proxy); sind alle vertrauenswürdig, gilt
 * die linkeste Adresse.
 */
export function clientIp(opts: {
  trustProxy: boolean;
  trusted: TrustedProxies;
  peer: string | null | undefined;
  forwardedFor: string | null | undefined;
}): string | null {
  const peer = normalizeIp(opts.peer);
  if (!opts.trustProxy || !peer || !opts.forwardedFor || !opts.trusted.contains(peer)) return peer;
  const hops = opts.forwardedFor
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  let client = peer;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]);
    if (!hop) return client;
    client = hop;
    if (!opts.trusted.contains(hop)) return hop;
  }
  return client;
}
