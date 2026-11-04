/**
 * Regression (Sicherheitsbefund 1): Unauthentifizierte Anfragen an /federation/v1/* fluten das Audit-Log
 * nicht mehr, der Body wird erst nach der Absenderprüfung und höchstens bis 2 MB gelesen, Ablehnungen sind
 * je IP-Adresse und je behauptetem Absender begrenzt – ohne dass eine gefälschte Kennung einen echten
 * Partner aussperren kann.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  MAX_AUDITED_REJECTIONS,
  MAX_REJECTIONS_PER_IP,
  MAX_REJECTIONS_PER_NODE,
  REJECTION_WINDOW_MS,
} from '../../src/server/modules/federation/guard.ts';
import { MAX_REQUEST_BYTES, signRequest } from '../../src/server/modules/federation/protocol.ts';
import type { Peer } from '../../src/shared/contract/federation.ts';
import { adminOf, auditEntries, onboard, rawSend, TestClock } from '../helpers/federation.ts';
import { connEnv, TestMesh, type TestNode } from '../helpers/node.ts';

const mesh = new TestMesh();
// eine Uhr für beide Knoten: Zeitfenster vorstellen, ohne clock_skew auszulösen
const clock = new TestClock();
let a: TestNode;
let b: TestNode;
let bOnA: Peer;

interface Reply {
  status: number;
  json: { error?: { code: string; reason?: string } } | null;
  headers: Headers;
}

/** Rohe Anfrage an B mit frei wählbarer Absenderkennung, IP-Adresse (X-Forwarded-For) und Body */
async function post(o: {
  node?: string | null;
  ip?: string;
  type?: string;
  body?: BodyInit;
  signature?: string;
  headers?: Record<string, string>;
}): Promise<Reply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-mesh-signature': o.signature ?? 'AAAA',
    ...o.headers,
  };
  if (o.node !== null) headers['x-mesh-node'] = o.node ?? 'osp-ghost';
  if (o.ip) headers['x-forwarded-for'] = o.ip;
  const init = { method: 'POST', headers, body: o.body ?? '{}', duplex: 'half' } as RequestInit;
  const res = await b.app.request(`/federation/v1/${o.type ?? 'ping'}`, init, connEnv());
  const text = await res.text();
  let json: Reply['json'] = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, headers: res.headers };
}

/** Body, der erst beim Lesen erzeugt wird (ohne Content-Length); zählt die tatsächlich gelesenen Bytes */
function lazyBody(totalBytes: number, chunkBytes = 64 * 1024) {
  let pulled = 0;
  const chunk = new Uint8Array(chunkBytes).fill(0x20);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(ctrl) {
        if (pulled >= totalBytes) return ctrl.close();
        pulled += chunk.byteLength;
        ctrl.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled };
}

/** Gültig von A signierter Ping an B (für Anfragen mit eigener IP-Adresse) */
function signedPing(body: unknown = {}) {
  return signRequest(a.deps.identity, b.nodeId, 'ping', body, clock.now());
}

async function rejectedAudit() {
  return auditEntries(b, 'federation.request.rejected');
}

/** Neues Zeitfenster für Ratenbegrenzung und Audit-Zusammenfassung */
function nextWindow() {
  clock.advance(REJECTION_WINDOW_MS + 1000);
}

beforeAll(async () => {
  a = await mesh.add({ nodeId: 'osp-a', now: clock.now });
  b = await mesh.add({ nodeId: 'osp-b', now: clock.now, config: { MESH_TRUST_PROXY: 'true' } });
  ({ bOnA } = await onboard(a, b));
});
afterAll(async () => {
  await mesh.close();
});

describe('Föderation: Schutz vor Überflutung', () => {
  test('25 unauthentifizierte Anfragen (wechselnde Kennungen) → ein Audit-Eintrag; jede wird signiert abgelehnt', async () => {
    nextWindow();
    const before = (await rejectedAudit()).length;
    for (let i = 0; i < 25; i++) {
      const r = await post({ node: i % 5 === 0 ? null : `ghost-${i}`, ip: '10.9.0.1' });
      expect(r.status).toBe(401);
      expect(r.json?.error?.code).toBe('unknown_node');
      expect(r.headers.get('x-mesh-signature')).toBeTruthy();
    }
    const entries = (await rejectedAudit()).slice(before);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'denied', ip: '10.9.0.1' });
    expect(entries[0]!.details).toMatchObject({ code: 'unknown_node', type: 'ping' });

    // nächstes Zeitfenster: der nächste Eintrag dieser Quelle nennt die nur geloggten Ablehnungen
    nextWindow();
    expect((await post({ node: 'ghost-x', ip: '10.9.0.1' })).status).toBe(401);
    const next = (await rejectedAudit()).slice(before);
    expect(next).toHaveLength(2);
    expect(next[1]!.details).toMatchObject({ code: 'unknown_node', suppressed: 24 });
  });

  test('wechselnde IP-Adressen: höchstens MAX_AUDITED_REJECTIONS Audit-Einträge je Zeitfenster', async () => {
    nextWindow();
    const before = (await rejectedAudit()).length;
    for (let i = 0; i < MAX_AUDITED_REJECTIONS + 15; i++) {
      const r = await post({ node: `ghost-${i}`, ip: `10.8.${i}.1` });
      expect(r.status).toBe(401);
    }
    expect((await rejectedAudit()).length - before).toBe(MAX_AUDITED_REJECTIONS);
  });

  test('unbekannter Absender: der Body wird nicht gelesen (nur sein Anfang)', async () => {
    nextWindow();
    const body = lazyBody(10 * 1024 * 1024);
    const r = await post({ node: 'osp-ghost', ip: '10.7.0.1', body: body.stream });
    expect(r.status).toBe(401);
    expect(r.json?.error?.code).toBe('unknown_node');
    expect(body.pulled()).toBeLessThanOrEqual(64 * 1024);
  });

  test('zugelassener Partner: Anfragen höchstens 2 MB, auch ohne Content-Length', async () => {
    nextWindow();
    // gültig signiert, aber größer als erlaubt: früher bis 50 MB gelesen und angenommen
    const padded = signedPing({ pad: 'x'.repeat(MAX_REQUEST_BYTES + 1024) });
    const big = await post({ node: 'osp-a', ip: '10.7.0.2', body: padded.raw, signature: padded.signature });
    expect(big.status).toBe(400);
    expect(big.json?.error).toMatchObject({ code: 'bad_request', reason: 'payload_too_large' });

    // Body ohne Content-Length wird beim Lesen begrenzt, nicht vollständig gelesen
    const stream = lazyBody(20 * 1024 * 1024);
    const r = await post({ node: 'osp-a', ip: '10.7.0.2', body: stream.stream });
    expect(r.status).toBe(400);
    expect(stream.pulled()).toBeLessThanOrEqual(MAX_REQUEST_BYTES + 64 * 1024);

    // angekündigte Länge über der Grenze → 413, ohne den Body zu lesen
    const declared = lazyBody(MAX_REQUEST_BYTES + 1);
    const r413 = await post({
      node: 'osp-a',
      ip: '10.7.0.2',
      body: declared.stream,
      headers: { 'content-length': String(MAX_REQUEST_BYTES + 1) },
    });
    expect(r413.status).toBe(413);
    expect(r413.json?.error?.code).toBe('payload_too_large');
    expect(declared.pulled()).toBe(0);

    // normale Anfragen gehen weiter durch
    const ok = signedPing();
    const fine = await post({ node: 'osp-a', ip: '10.7.0.2', body: ok.raw, signature: ok.signature });
    expect(fine.status).toBe(200);
  });

  test('Ratenbegrenzung je IP-Adresse: danach 429 ohne Prüfung und ohne Lesen; andere Adressen frei; nach dem Zeitfenster wieder frei', async () => {
    nextWindow();
    const before = (await rejectedAudit()).length;
    for (let i = 0; i < MAX_REJECTIONS_PER_IP; i++) {
      expect((await post({ node: `ghost-${i}`, ip: '10.6.0.1' })).status).toBe(401);
    }
    const blocked = await post({ node: 'osp-ghost', ip: '10.6.0.1' });
    expect(blocked.status).toBe(429);
    expect(blocked.json?.error?.code).toBe('rate_limited');
    expect(blocked.headers.get('retry-after')).toBe(String(REJECTION_WINDOW_MS / 1000));
    expect(blocked.headers.get('x-mesh-signature')).toBeNull();

    // auch gültige Anfragen von dieser Adresse – der Body wird nicht gelesen
    const ping = signedPing();
    expect(
      (await post({ node: 'osp-a', ip: '10.6.0.1', body: ping.raw, signature: ping.signature })).status,
    ).toBe(429);
    const body = lazyBody(1024 * 1024);
    expect((await post({ node: 'osp-a', ip: '10.6.0.1', body: body.stream })).status).toBe(429);
    expect(body.pulled()).toBe(0);

    // andere Adresse unberührt
    const other = signedPing();
    expect(
      (await post({ node: 'osp-a', ip: '10.6.0.2', body: other.raw, signature: other.signature })).status,
    ).toBe(200);

    // Audit: erste Ablehnung und erste Sperre dieser Adresse, nicht jede Anfrage
    const entries = (await rejectedAudit()).slice(before).filter((e) => e.ip === '10.6.0.1');
    expect(entries.map((e) => e.details.code).sort()).toEqual(['rate_limited', 'unknown_node']);

    nextWindow();
    const later = signedPing();
    expect(
      (await post({ node: 'osp-a', ip: '10.6.0.1', body: later.raw, signature: later.signature })).status,
    ).toBe(200);
  });

  test('Ratenbegrenzung je behauptetem Absender: unbekannte Kennung gesperrt, zugelassener Partner nicht aussperrbar', async () => {
    nextWindow();
    for (let i = 0; i < MAX_REJECTIONS_PER_NODE; i++) {
      expect((await post({ node: 'osp-ghost', ip: `10.5.${i}.1` })).status).toBe(401);
    }
    // von einer neuen Adresse, aber mit derselben Kennung → 429
    expect((await post({ node: 'osp-ghost', ip: '10.5.250.1' })).status).toBe(429);
    // andere Kennung nicht betroffen
    expect((await post({ node: 'osp-other', ip: '10.5.250.2' })).status).toBe(401);

    // gefälschte Anfragen unter der Kennung des echten Partners A (falsche Signatur) aus vielen Adressen
    for (let i = 0; i < MAX_REJECTIONS_PER_NODE + 10; i++) {
      const r = await post({ node: 'osp-a', ip: `10.4.${i}.1`, body: signedPing().raw, signature: 'AAAA' });
      expect(r.status).toBe(401);
      expect(r.json?.error?.code).toBe('bad_signature');
    }
    // A selbst wird weiterhin bedient
    const ping = await a.request<{ ok: boolean; errorCode: string | null }>(
      'POST',
      `/api/v1/peers/${bOnA.id}/ping`,
      { as: await adminOf(a) },
    );
    expect(ping.json).toMatchObject({ ok: true, errorCode: null });
  });

  test('Client: 429 des Partners gilt als vorübergehend nicht erreichbar (peer_unreachable)', async () => {
    nextWindow();
    // Anfragen von A kommen im Test ohne IP-Adresse an (gemeinsamer Schlüssel "unknown")
    for (let i = 0; i < MAX_REJECTIONS_PER_IP; i++) {
      expect((await rawSend(b, { from: a, envelope: { to: 'osp-x' } })).json.error?.code).toBe(
        'wrong_recipient',
      );
    }
    const admin = await adminOf(a);
    const blocked = await a.request<{ ok: boolean; errorCode: string | null }>(
      'POST',
      `/api/v1/peers/${bOnA.id}/ping`,
      { as: admin },
    );
    expect(blocked.json).toMatchObject({ ok: false, errorCode: 'peer_unreachable' });
    nextWindow();
    const ok = await a.request<{ ok: boolean }>('POST', `/api/v1/peers/${bOnA.id}/ping`, { as: admin });
    expect(ok.json.ok).toBe(true);
  });
});
