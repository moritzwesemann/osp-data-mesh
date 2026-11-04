/**
 * Föderation: Vertrauensaufnahme und Sicherheitsprüfungen des Protokolls (Signaturen, Replay, Uhrzeit,
 * Adressierung, Vertrauensstatus, Antwortprüfung durch den Client).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Peer } from '../../src/shared/contract/federation.ts';
import {
  addPeer,
  adminOf,
  auditEntries,
  cardOf,
  peerRow,
  rawSend,
  TestClock,
  trustPeer,
} from '../helpers/federation.ts';
import { TestMesh, type TestNode } from '../helpers/node.ts';

const mesh = new TestMesh();
const clockA = new TestClock();
const clockB = new TestClock();
let a: TestNode;
let b: TestNode;
let bOnA: Peer;
let aOnB: Peer;

type PingResult = { ok: boolean; latencyMs: number | null; errorCode: string | null };

async function ping(from: TestNode, peer: Peer): Promise<PingResult> {
  const r = await from.request<PingResult>('POST', `/api/v1/peers/${peer.id}/ping`, {
    as: await adminOf(from),
  });
  expect(r.status).toBe(200);
  return r.json;
}

async function rejections(node: TestNode, code: string): Promise<number> {
  return (await auditEntries(node, 'federation.request.rejected')).filter((e) => e.details.code === code)
    .length;
}

beforeAll(async () => {
  a = await mesh.add({ nodeId: 'osp-a', displayName: 'OSP A', now: clockA.now });
  b = await mesh.add({ nodeId: 'osp-b', displayName: 'OSP B', now: clockB.now });
});
afterAll(async () => {
  await mesh.close();
});

describe('Föderation: Vertrauensaufnahme', () => {
  test('Knotenkarte enthält Schlüssel und Fingerprint', async () => {
    const card = await cardOf(a);
    expect(card.format).toBe('osp-data-mesh/node-card@1');
    expect(card.nodeId).toBe('osp-a');
    expect(card.publicKey).toBe(a.deps.identity.publicKey);
    expect(card.fingerprint).toBe(a.deps.identity.fingerprint);
  });

  test('Rollen: nur Admin nimmt Partner auf und bestätigt Vertrauen', async () => {
    const analyst = await a.user(['analyst']);
    const steward = await a.user(['data_steward']);
    const card = await cardOf(b);
    expect((await a.request('POST', '/api/v1/peers', { as: analyst, body: { card } })).status).toBe(403);
    expect((await a.request('POST', '/api/v1/peers', { as: steward, body: { card } })).status).toBe(403);
    expect((await a.request('GET', '/api/v1/peers', { as: analyst })).status).toBe(403);
    expect((await a.request('GET', '/api/v1/node/card', { as: analyst })).status).toBe(403);
    expect((await a.request('GET', '/api/v1/peers', { as: null })).status).toBe(401);
  });

  test('Karte mit manipuliertem Fingerprint wird abgewiesen und auditiert', async () => {
    const card = await cardOf(b);
    const manipulated = { ...card, fingerprint: card.fingerprint.replace(/^..../, '0000') };
    const r = await a.request<{ error: { code: string; fields: Record<string, string> } }>(
      'POST',
      '/api/v1/peers',
      { as: await adminOf(a), body: { card: manipulated } },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.fields['card.fingerprint']).toBe('mismatch');
    // fremder Schlüssel unter dem Fingerprint der echten Karte
    const swapped = { ...card, publicKey: a.deps.identity.publicKey };
    const r2 = await a.request<{ error: { fields: Record<string, string> } }>('POST', '/api/v1/peers', {
      as: await adminOf(a),
      body: { card: swapped },
    });
    expect(r2.status).toBe(400);
    const denied = (await auditEntries(a, 'peer.add')).filter((e) => e.outcome === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });

  test('eigene Karte wird abgewiesen', async () => {
    const r = await a.request<{ error: { fields: Record<string, string> } }>('POST', '/api/v1/peers', {
      as: await adminOf(a),
      body: { card: await cardOf(a) },
    });
    expect(r.status).toBe(400);
    expect(r.json.error.fields['card.nodeId']).toBe('own_node');
  });

  test('Aufnahme → pending; Austausch erst nach beidseitigem Vertrauen', async () => {
    bOnA = await addPeer(a, b);
    expect(bOnA.status).toBe('pending');
    expect(bOnA.trustedAt).toBeNull();
    // doppelte Aufnahme
    const dup = await a.request('POST', '/api/v1/peers', {
      as: await adminOf(a),
      body: { card: await cardOf(b) },
    });
    expect(dup.status).toBe(409);

    // B kennt A noch nicht → unknown_node (signierte Ablehnung, für A lesbar)
    expect((await ping(a, bOnA)).errorCode).toBe('unknown_node');

    aOnB = await addPeer(b, a);
    // B hat A aufgenommen, aber noch nicht bestätigt → untrusted
    expect((await ping(a, bOnA)).errorCode).toBe('untrusted');
    expect(await rejections(b, 'untrusted')).toBeGreaterThanOrEqual(1);
  });

  test('falscher Fingerprint beim Bestätigen wird abgewiesen und auditiert', async () => {
    const r = await b.request<{ error: { code: string; fields: Record<string, string> } }>(
      'POST',
      `/api/v1/peers/${aOnB.id}/trust`,
      { as: await adminOf(b), body: { fingerprint: b.deps.identity.fingerprint } },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation_failed');
    expect(r.json.error.fields.fingerprint).toBe('mismatch');
    expect((await peerRow(b, a)).status).toBe('pending');
    const denied = (await auditEntries(b, 'peer.trust')).filter((e) => e.outcome === 'denied');
    expect(denied.length).toBe(1);
    // Datenverantwortliche dürfen nicht bestätigen
    const steward = await b.user(['data_steward']);
    const r2 = await b.request('POST', `/api/v1/peers/${aOnB.id}/trust`, {
      as: steward,
      body: { fingerprint: aOnB.fingerprint },
    });
    expect(r2.status).toBe(403);
  });

  test('Bestätigung mit abgeglichenem Fingerprint (Format egal) → trusted; signierter Ping in beide Richtungen', async () => {
    // Fingerprint wie am Telefon diktiert: klein, ohne Leerzeichen
    const spoken = a.deps.identity.fingerprint.replace(/ /g, '').toLowerCase();
    const r = await b.request<Peer>('POST', `/api/v1/peers/${aOnB.id}/trust`, {
      as: await adminOf(b),
      body: { fingerprint: spoken },
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('trusted');
    expect(r.json.trustedAt).not.toBeNull();
    // A vertraut B noch nicht: A lehnt Anfragen von B ab, B kann A aber schon anpingen? Nein: A kennt B nur pending
    expect((await ping(b, aOnB)).errorCode).toBe('untrusted');
    bOnA = await trustPeer(a, bOnA);

    const ab = await ping(a, bOnA);
    expect(ab).toMatchObject({ ok: true, errorCode: null });
    expect(ab.latencyMs).toBeGreaterThanOrEqual(0);
    const ba = await ping(b, aOnB);
    expect(ba.ok).toBe(true);
    expect((await peerRow(a, b)).last_seen_at).not.toBeNull();
    expect((await peerRow(a, b)).last_error).toBeNull();
    expect(await auditEntries(a, 'peer.trust')).toHaveLength(1);
    expect(await auditEntries(a, 'peer.add')).toContainEqual(expect.objectContaining({ outcome: 'success' }));
  });
});

describe('Föderation: Prüfungen beim Empfänger', () => {
  test('gültige rohe Anfrage: signierte Antwort mit inReplyTo', async () => {
    const r = await rawSend(b, { from: a, type: 'ping', envelope: { id: crypto.randomUUID() } });
    expect(r.status).toBe(200);
    expect(r.signedByTarget).toBe(true);
    expect(r.json.ok).toBe(true);
    expect(r.json.from).toBe('osp-b');
    expect(r.json.to).toBe('osp-a');
    expect(r.json.inReplyTo).toBe(JSON.parse(r.raw).id);
    expect(r.json.body).toMatchObject({ nodeId: 'osp-b', displayName: 'OSP B' });
  });

  test('unbekannter Knoten → unknown_node (signiert; Audit zusammengefasst je Quelle und Code)', async () => {
    // erste Ablehnung dieser Quelle: Ping von A, bevor B den Knoten A kannte
    expect(await rejections(b, 'unknown_node')).toBe(1);
    const r = await rawSend(b, { from: a, headerNode: 'osp-ghost', envelope: { from: 'osp-ghost' } });
    expect(r.status).toBe(401);
    expect(r.json.error?.code).toBe('unknown_node');
    expect(r.signedByTarget).toBe(true);
    // Body wird nicht gelesen, nur sein Anfang: die Ablehnung bleibt für den Absender zuordenbar
    expect(r.json.inReplyTo).toBe(JSON.parse(r.raw).id);
    const noHeader = await rawSend(b, { from: a, headerNode: null });
    expect(noHeader.json.error?.code).toBe('unknown_node');
    // weitere Ablehnungen derselben Quelle im Zeitfenster stehen nur im Betriebslog
    expect(await rejections(b, 'unknown_node')).toBe(1);
    const entry = (await auditEntries(b, 'federation.request.rejected')).find(
      (e) => e.details.code === 'unknown_node',
    );
    expect(entry).toMatchObject({ actor_type: 'peer', actor_id: 'osp-a', outcome: 'denied' });
  });

  test('manipulierter Body (nach dem Signieren geändert) → bad_signature', async () => {
    const r = await rawSend(b, {
      from: a,
      type: 'catalog',
      body: { q: 'kraft' },
      tamper: (raw) => raw.replace('kraft', 'alles'),
    });
    expect(r.status).toBe(401);
    expect(r.json.error?.code).toBe('bad_signature');
    expect(r.signedByTarget).toBe(true);
    // Signatur eines anderen Schlüssels
    const r2 = await rawSend(b, { from: b, headerNode: 'osp-a', envelope: { from: 'osp-a' } });
    expect(r2.json.error?.code).toBe('bad_signature');
    // zusammengefasst: nur die erste Ablehnung je Quelle und Code im Zeitfenster wird auditiert
    expect(await rejections(b, 'bad_signature')).toBe(1);
  });

  test('ungültiger Aufbau → bad_request', async () => {
    // from ≠ X-Mesh-Node
    expect((await rawSend(b, { from: a, envelope: { from: 'osp-c' } })).json.error?.code).toBe('bad_request');
    // type ≠ Pfad
    expect((await rawSend(b, { from: a, type: 'ping', pathType: 'catalog' })).json.error?.code).toBe(
      'bad_request',
    );
    // unbekannter Typ
    const unknownType = await rawSend(b, { from: a, type: 'export' });
    expect(unknownType.status).toBe(400);
    expect(unknownType.json.error?.code).toBe('bad_request');
    // falsche Protokollversion
    expect((await rawSend(b, { from: a, envelope: { v: 2 } })).json.error?.code).toBe('bad_request');
    // kein JSON
    const notJson = await rawSend(b, {
      from: a,
      replay: { raw: 'hallo', signature: a.deps.identity.sign('hallo') },
    });
    expect(notJson.json.error?.code).toBe('bad_request');
    expect(notJson.json.inReplyTo).toBeNull();
    // ungültiger Nachrichteninhalt
    const badBody = await rawSend(b, {
      from: a,
      type: 'pull',
      body: { releaseId: 'x', purpose: 'training_steering' },
    });
    expect(badBody.status).toBe(400);
    expect(badBody.json.error?.code).toBe('bad_request');
  });

  test('falscher Empfänger → wrong_recipient', async () => {
    const r = await rawSend(b, { from: a, envelope: { to: 'osp-c' } });
    expect(r.status).toBe(401);
    expect(r.json.error?.code).toBe('wrong_recipient');
  });

  test('Uhrzeitabweichung > 5 Minuten → clock_skew', async () => {
    const old = new Date(clockA.now().getTime() - 6 * 60_000).toISOString();
    const r = await rawSend(b, { from: a, envelope: { ts: old } });
    expect(r.json.error?.code).toBe('clock_skew');
    // 4 Minuten sind zulässig
    const ok = await rawSend(b, {
      from: a,
      envelope: { ts: new Date(Date.now() + 4 * 60_000).toISOString() },
    });
    expect(ok.json.ok).toBe(true);

    // Uhr von B geht 10 Minuten vor: Ping von A wird abgelehnt, Ablehnung bleibt für A lesbar
    clockB.advance(10 * 60_000);
    try {
      expect((await ping(a, bOnA)).errorCode).toBe('clock_skew');
    } finally {
      clockB.reset();
    }
    expect(await rejections(b, 'clock_skew')).toBeGreaterThanOrEqual(2);
  });

  test('wiederholte Nachricht → replay', async () => {
    const first = await rawSend(b, { from: a, type: 'ping' });
    expect(first.json.ok).toBe(true);
    const again = await rawSend(b, { from: a, replay: { raw: first.raw, signature: first.signature } });
    expect(again.status).toBe(401);
    expect(again.json.error?.code).toBe('replay');
    expect(again.json.inReplyTo).toBe(JSON.parse(first.raw).id);
    expect(await rejections(b, 'replay')).toBe(1);
  });

  test('gesperrter Partner → untrusted; erneute Bestätigung hebt Sperre auf', async () => {
    const r = await b.request<Peer>('POST', `/api/v1/peers/${aOnB.id}/suspend`, { as: await adminOf(b) });
    expect(r.json.status).toBe('suspended');
    const raw = await rawSend(b, { from: a });
    expect(raw.status).toBe(401);
    expect(raw.json.error?.code).toBe('untrusted');
    expect((await ping(a, bOnA)).errorCode).toBe('untrusted');
    // B pingt gesperrten Partner gar nicht erst an
    expect((await ping(b, aOnB)).errorCode).toBe('peer_untrusted');
    await trustPeer(b, aOnB);
    expect((await ping(a, bOnA)).ok).toBe(true);
  });

  test('peers.update: Anzeigename und Adresse; Adresse wird normalisiert', async () => {
    const r = await a.request<Peer>('PATCH', `/api/v1/peers/${bOnA.id}`, {
      as: await adminOf(a),
      body: { displayName: 'Olympiastützpunkt B', baseUrl: 'http://osp-b.mesh.test/' },
    });
    expect(r.status).toBe(200);
    expect(r.json.displayName).toBe('Olympiastützpunkt B');
    expect(r.json.baseUrl).toBe('http://osp-b.mesh.test');
    const bad = await a.request<{ error: { fields: Record<string, string> } }>(
      'PATCH',
      `/api/v1/peers/${bOnA.id}`,
      {
        as: await adminOf(a),
        body: { baseUrl: 'http://user:pw@osp-b.mesh.test' },
      },
    );
    expect(bad.status).toBe(400);
  });
});

describe('Föderation: Prüfung der Antworten durch den Client', () => {
  async function withFetch(
    node: TestNode,
    wrap: (res: Response) => Promise<Response>,
    fn: () => Promise<void>,
  ) {
    const original = node.deps.fetch;
    node.deps.fetch = async (input, init) => wrap(await original(input, init));
    try {
      await fn();
    } finally {
      node.deps.fetch = original;
    }
  }

  test('manipulierte Antwort → signature_invalid', async () => {
    await withFetch(
      a,
      async (res) => {
        const text = (await res.text()).replace('OSP B', 'OSP X');
        return new Response(text, { status: res.status, headers: res.headers });
      },
      async () => {
        expect((await ping(a, bOnA)).errorCode).toBe('signature_invalid');
      },
    );
    expect((await peerRow(a, b)).last_error).toBe('signature_invalid');
  });

  test('unsignierte Antwort, fremder Absender, wiedereingespielte Antwort → signature_invalid', async () => {
    await withFetch(
      a,
      async (res) => {
        const headers = new Headers(res.headers);
        headers.delete('x-mesh-signature');
        return new Response(await res.text(), { status: res.status, headers });
      },
      async () => {
        expect((await ping(a, bOnA)).errorCode).toBe('signature_invalid');
      },
    );
    await withFetch(
      a,
      async (res) => {
        const headers = new Headers(res.headers);
        headers.set('x-mesh-node', 'osp-c');
        return new Response(await res.text(), { status: res.status, headers });
      },
      async () => {
        expect((await ping(a, bOnA)).errorCode).toBe('signature_invalid');
      },
    );
    // gültig signierte, aber alte Antwort (zu einer anderen Anfrage)
    let captured: { text: string; headers: Headers; status: number } | null = null;
    await withFetch(
      a,
      async (res) => {
        if (!captured) {
          captured = { text: await res.text(), headers: new Headers(res.headers), status: res.status };
          return new Response(captured.text, { status: captured.status, headers: captured.headers });
        }
        await res.text();
        return new Response(captured.text, { status: captured.status, headers: captured.headers });
      },
      async () => {
        expect((await ping(a, bOnA)).ok).toBe(true);
        expect((await ping(a, bOnA)).errorCode).toBe('signature_invalid');
      },
    );
  });

  test('nicht erreichbarer Partner → peer_unreachable', async () => {
    mesh.nodes.delete('osp-b');
    try {
      expect((await ping(a, bOnA)).errorCode).toBe('peer_unreachable');
    } finally {
      mesh.nodes.set('osp-b', b);
    }
    expect((await ping(a, bOnA)).ok).toBe(true);
  });

  test('Partnerliste zeigt Status, letzten Kontakt und letzten Fehler', async () => {
    const r = await a.request<{ items: Peer[] }>('GET', '/api/v1/peers', { as: await adminOf(a) });
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    expect(r.json.items[0]).toMatchObject({ nodeId: 'osp-b', status: 'trusted', lastError: null });
    expect(r.json.items[0]!.lastSeenAt).not.toBeNull();
  });
});
