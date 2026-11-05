/**
 * Föderationsprotokoll ohne Datenbank: Umschläge, Zeitfenster, Adressen, Backoff, Prüfung von Pull-Antworten
 * und die Antwortprüfung des Clients (mit simuliertem Partner).
 */
import { describe, expect, test } from 'bun:test';
import { ed25519Sign, ed25519Verify, generateEd25519 } from '../../src/server/core/crypto.ts';
import type { Deps } from '../../src/server/core/deps.ts';
import { PeerCallError, sendSigned } from '../../src/server/modules/federation/client.ts';
import { backoffMs } from '../../src/server/modules/federation/outbox.ts';
import {
  decodeUtf8,
  normalizeBaseUrl,
  signRequest,
  signResponse,
  withinSkew,
} from '../../src/server/modules/federation/protocol.ts';
import { checkPullPayload } from '../../src/server/modules/federation/received.ts';
import { RequestEnvelope, ResponseEnvelope } from '../../src/shared/contract/federation-wire.ts';

function identity(nodeId: string) {
  const kp = generateEd25519();
  const id = {
    nodeId,
    publicKey: kp.publicKey,
    sign: (d: string | Uint8Array) => ed25519Sign(kp.privateKey, d),
    // kein Schlüsselwechsel im Gang: immer der aktuelle Schlüssel (NodeIdentity.signerFor)
    signerFor: async () => id,
  };
  return id;
}

describe('Umschläge', () => {
  test('Anfrage: schemagültig, Signatur über die exakten Bytes', () => {
    const id = identity('osp-a');
    const now = new Date('2026-11-04T10:00:00Z');
    const req = signRequest(id, 'osp-b', 'pull', { releaseId: crypto.randomUUID(), purpose: 'x_y' }, now);
    expect(RequestEnvelope.parse(JSON.parse(req.raw))).toEqual(req.envelope);
    expect(req.envelope).toMatchObject({
      v: 1,
      type: 'pull',
      from: 'osp-a',
      to: 'osp-b',
      ts: now.toISOString(),
    });
    expect(ed25519Verify(id.publicKey, req.raw, req.signature)).toBe(true);
    expect(ed25519Verify(id.publicKey, `${req.raw} `, req.signature)).toBe(false);
    // jede Anfrage hat eine neue id (Nonce)
    expect(signRequest(id, 'osp-b', 'ping', {}, now).envelope.id).not.toBe(req.envelope.id);
  });

  test('Antwort: ok und Fehler, gebunden an die Anfrage', () => {
    const id = identity('osp-b');
    const now = new Date();
    const ok = signResponse(
      id,
      'osp-a',
      'f5b0c1b6-7e0c-4f57-9a43-0d3c9d0f8a11',
      { ok: true, body: { a: 1 } },
      now,
    );
    expect(ResponseEnvelope.parse(JSON.parse(ok.raw))).toMatchObject({ ok: true, body: { a: 1 } });
    const err = signResponse(id, 'osp-a', null, { ok: false, code: 'access_denied', reason: 'expired' }, now);
    expect(JSON.parse(err.raw)).toMatchObject({
      ok: false,
      inReplyTo: null,
      error: { code: 'access_denied', reason: 'expired' },
    });
    expect(ed25519Verify(id.publicKey, err.raw, err.signature)).toBe(true);
  });

  test('Zeitfenster ±5 Minuten', () => {
    const now = new Date('2026-11-04T10:00:00Z');
    expect(withinSkew('2026-11-04T10:05:00Z', now)).toBe(true);
    expect(withinSkew('2026-11-04T09:55:00Z', now)).toBe(true);
    expect(withinSkew('2026-11-04T10:05:00.001Z', now)).toBe(false);
    expect(withinSkew('2026-11-04T09:54:59Z', now)).toBe(false);
    expect(withinSkew('kein Datum', now)).toBe(false);
  });

  test('striktes UTF-8', () => {
    expect(decodeUtf8(new Uint8Array([0xc3, 0x28]))).toBeNull();
    expect(decodeUtf8(new TextEncoder().encode('Stützpunkt'))).toBe('Stützpunkt');
    // BOM bleibt erhalten (JSON.parse scheitert daran → bad_request)
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toBe('﻿{}');
  });
});

describe('Partneradressen', () => {
  test('nur https (http nur mit Freigabe), keine Zugangsdaten/Query, ohne Schrägstrich am Ende', () => {
    expect(normalizeBaseUrl('https://osp-b.example.de/', false)).toEqual({
      ok: true,
      url: 'https://osp-b.example.de',
    });
    expect(normalizeBaseUrl('https://example.de/mesh/', false)).toEqual({
      ok: true,
      url: 'https://example.de/mesh',
    });
    expect(normalizeBaseUrl('http://osp-b.example.de', false)).toEqual({ ok: false, code: 'https_required' });
    expect(normalizeBaseUrl('http://osp-b.example.de', true)).toEqual({
      ok: true,
      url: 'http://osp-b.example.de',
    });
    expect(normalizeBaseUrl('https://u:p@osp-b.example.de', false)).toEqual({
      ok: false,
      code: 'invalid_url',
    });
    expect(normalizeBaseUrl('https://osp-b.example.de/?x=1', false)).toEqual({
      ok: false,
      code: 'invalid_url',
    });
    expect(normalizeBaseUrl('ftp://osp-b.example.de', true)).toEqual({ ok: false, code: 'invalid_url' });
    expect(normalizeBaseUrl('kein url', true)).toEqual({ ok: false, code: 'invalid_url' });
  });
});

describe('Ausgangspostfach', () => {
  test('Backoff: 10 s · 2^Versuche, höchstens 1 h', () => {
    expect(backoffMs(0)).toBe(10_000);
    expect(backoffMs(1)).toBe(20_000);
    expect(backoffMs(5)).toBe(320_000);
    expect(backoffMs(9)).toBe(3_600_000);
    expect(backoffMs(19)).toBe(3_600_000);
  });
});

describe('Prüfung von Pull-Antworten', () => {
  const releaseId = '0b8e7a52-2f0c-4a53-9b1a-5d7c2a3e9f10';
  const base = () => ({
    release: {
      id: releaseId,
      productId: '1b8e7a52-2f0c-4a53-9b1a-5d7c2a3e9f10',
      productSlug: 'p',
      productName: 'P',
      productDescription: '',
      productVersion: 1,
      specialCategory: false,
      purpose: 'research',
      validUntil: null,
      dataFrom: null,
      dataUntil: null,
    },
    columns: [{ key: 'vo2max', label: 'VO2max', type: 'number' as const }],
    rows: [{ subject: 'AbCdEfGhIjKlMnOpQrStUv', values: { vo2max: 1 } }],
    generatedAt: new Date().toISOString(),
  });
  const req = { releaseId, purpose: 'research' };

  test('gültige Antwort', () => {
    expect(checkPullPayload(base(), req)).toBeNull();
  });

  test('falsche Freigabe, falscher Zweck', () => {
    expect(checkPullPayload(base(), { ...req, releaseId: crypto.randomUUID() })).toBe('release_mismatch');
    expect(checkPullPayload(base(), { ...req, purpose: 'reporting' })).toBe('purpose_mismatch');
  });

  test('Spaltenschlüssel: keine Duplikate, keine unsicheren Namen (XML/CSV/Prototype)', () => {
    for (const key of ['a b', 'x><script', '__proto__', '1abc', 'a'.repeat(65)]) {
      const p = base();
      p.columns.push({ key, label: 'x', type: 'number' });
      expect(checkPullPayload(p, req)).toBe('invalid_columns');
    }
    const dup = base();
    dup.columns.push({ key: 'vo2max', label: 'x', type: 'number' });
    expect(checkPullPayload(dup, req)).toBe('invalid_columns');
  });

  test('Zeilen nur mit angekündigten Spalten und adressierbarem Pseudonym', () => {
    const extra = base();
    extra.rows[0]!.values = { vo2max: 1, name: 'Muster' } as never;
    expect(checkPullPayload(extra, req)).toBe('unexpected_column');
    const shortSubject = base();
    shortSubject.rows[0]!.subject = 'abc';
    expect(checkPullPayload(shortSubject, req)).toBe('invalid_subject');
  });
});

describe('Client: Prüfung der Antwort', () => {
  const self = identity('osp-a');
  const peerId = identity('osp-b');
  const peer = { node_id: 'osp-b', base_url: 'https://osp-b.example.de', public_key: peerId.publicKey };

  function deps(respond: (req: Request) => Response | Promise<Response>, allowHttp = false) {
    const calls: Request[] = [];
    const bodies: string[] = [];
    const d = {
      identity: self,
      config: { MESH_FEDERATION_ALLOW_HTTP: allowHttp },
      now: () => new Date(),
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const r = new Request(String(input), init);
        calls.push(r);
        bodies.push(String(init?.body));
        return respond(r);
      },
    } as unknown as Deps;
    return { d, calls, bodies };
  }

  async function reply(
    req: Request,
    result: Parameters<typeof signResponse>[3],
    o: { signer?: ReturnType<typeof identity>; ts?: Date; status?: number } = {},
  ) {
    const env = JSON.parse(await req.text()) as { id: string };
    const signer = o.signer ?? peerId;
    const signed = signResponse(signer, 'osp-a', env.id, result, o.ts ?? new Date());
    return new Response(signed.raw, {
      status: o.status ?? (result.ok ? 200 : 403),
      headers: { 'x-mesh-node': 'osp-b', 'x-mesh-signature': signed.signature },
    });
  }

  async function code(p: Promise<unknown>): Promise<string> {
    try {
      await p;
      return 'ok';
    } catch (err) {
      expect(err).toBeInstanceOf(PeerCallError);
      const e = err as PeerCallError;
      return e.remoteCode ? `${e.code}:${e.remoteCode}:${e.reason}` : `${e.code}:${e.reason ?? ''}`;
    }
  }

  test('signierte Anfrage mit Kopfzeilen; gültige Antwort wird angenommen', async () => {
    const { d, calls, bodies } = deps((r) => reply(r, { ok: true, body: { ack: true } }));
    const r = await sendSigned(d, peer, 'ping', {});
    expect(r.body).toEqual({ ack: true });
    expect(calls[0]!.url).toBe('https://osp-b.example.de/federation/v1/ping');
    expect(calls[0]!.headers.get('x-mesh-node')).toBe('osp-a');
    expect(calls[0]!.redirect).toBe('error');
    const raw = bodies[0]!;
    expect(ed25519Verify(self.publicKey, raw, calls[0]!.headers.get('x-mesh-signature')!)).toBe(true);
    expect(r.requestId).toBe(JSON.parse(raw).id);
  });

  test('http-Adresse ohne Freigabe wird gar nicht erst kontaktiert', async () => {
    const { d, calls } = deps((r) => reply(r, { ok: true, body: {} }));
    expect(await code(sendSigned(d, { ...peer, base_url: 'http://osp-b.example.de' }, 'ping', {}))).toBe(
      'peer_unreachable:https_required',
    );
    expect(calls).toHaveLength(0);
  });

  test('Netzwerkfehler und Gateway-Fehler → peer_unreachable', async () => {
    expect(await code(sendSigned(deps(() => Promise.reject(new TypeError('x'))).d, peer, 'ping', {}))).toBe(
      'peer_unreachable:',
    );
    expect(
      await code(sendSigned(deps(() => new Response('bad gateway', { status: 502 })).d, peer, 'ping', {})),
    ).toBe('peer_unreachable:gateway_error');
  });

  test('fremder Schlüssel, unsigniert, alte Antwort, falsche Adressierung → signature_invalid', async () => {
    const other = identity('osp-x');
    expect(
      await code(
        sendSigned(deps((r) => reply(r, { ok: true, body: {} }, { signer: other })).d, peer, 'ping', {}),
      ),
    ).toBe('signature_invalid:bad_signature');
    expect(await code(sendSigned(deps(() => new Response('{}')).d, peer, 'ping', {}))).toBe(
      'signature_invalid:unsigned_response',
    );
    const stale = new Date(Date.now() - 10 * 60_000);
    expect(
      await code(
        sendSigned(deps((r) => reply(r, { ok: true, body: {} }, { ts: stale })).d, peer, 'ping', {}),
      ),
    ).toBe('signature_invalid:clock_skew');
    const wrongTo = deps(async (r) => {
      const env = JSON.parse(await r.text()) as { id: string };
      const s = signResponse(peerId, 'osp-z', env.id, { ok: true, body: {} }, new Date());
      return new Response(s.raw, { headers: { 'x-mesh-node': 'osp-b', 'x-mesh-signature': s.signature } });
    });
    expect(await code(sendSigned(wrongTo.d, peer, 'ping', {}))).toBe('signature_invalid:wrong_address');
    const wrongReply = deps(() => {
      const s = signResponse(peerId, 'osp-a', crypto.randomUUID(), { ok: true, body: {} }, new Date());
      return new Response(s.raw, { headers: { 'x-mesh-node': 'osp-b', 'x-mesh-signature': s.signature } });
    });
    expect(await code(sendSigned(wrongReply.d, peer, 'ping', {}))).toBe('signature_invalid:wrong_reply');
  });

  test('Ablehnung: bekannte Gründe werden übernommen, Freitext nicht', async () => {
    const known = deps((r) => reply(r, { ok: false, code: 'access_denied', reason: 'purpose_not_allowed' }));
    expect(await code(sendSigned(known.d, peer, 'pull', {}))).toBe(
      'peer_rejected:access_denied:purpose_not_allowed',
    );
    const free = deps((r) => reply(r, { ok: false, code: 'access_denied', reason: '<b>Bitte anrufen</b>' }));
    expect(await code(sendSigned(free.d, peer, 'pull', {}))).toBe(
      'peer_rejected:access_denied:access_denied',
    );
  });

  test('Antwort-Body wird gegen das Schema geprüft', async () => {
    const { NoticeResponse } = await import('../../src/shared/contract/federation-wire.ts');
    const { d } = deps((r) => reply(r, { ok: true, body: { ack: 'ja' } }));
    expect(await code(sendSigned(d, peer, 'notice', {}, { schema: NoticeResponse }))).toBe(
      'signature_invalid:bad_body',
    );
  });
});
