/**
 * Reine Funktionen zu Schlüsselwechsel (ADR 0013) und Prüfpunkten der Audit-Kette (ADR 0014):
 * Rotationsaussage mit zwei Signaturen, Prüfung von Partnersignaturen mit Übergangszeit, Aufbau der
 * Prüfpunkte und Vergleich mit der lokalen Kette.
 */
import { describe, expect, test } from 'bun:test';
import { ed25519Sign, ed25519Verify, fingerprint, generateEd25519 } from '../../src/server/core/crypto.ts';
import { keyWindows, type OwnKeyWindow } from '../../src/server/core/node-identity.ts';
import {
  ANCHOR_PROFILE_FORMAT,
  type AnchorProfile,
  ProfileError,
  parseAnchorProfile,
} from '../../src/server/modules/federation/anchor-profile.ts';
import {
  buildCheckpointStatement,
  checkpointSigner,
  compareCheckpoints,
  type EpochRecord,
  epochContext,
  originEpoch,
  parseCheckpointStatement,
} from '../../src/server/modules/federation/anchors.ts';
import {
  buildRotationStatement,
  checkRotationStatement,
  verifyPeerSignature,
} from '../../src/server/modules/federation/keys.ts';
import { KeyRotatedNotice, NoticeBody } from '../../src/shared/contract/federation-wire.ts';

const at = '2026-11-05T10:00:00.000Z';

function rotation(o: { sameKey?: boolean } = {}) {
  const old = generateEd25519();
  const next = o.sameKey ? old : generateEd25519();
  const statement = buildRotationStatement({
    nodeId: 'osp-a',
    oldPublicKey: old.publicKey,
    newPublicKey: next.publicKey,
    rotatedAt: at,
    graceUntil: '2026-11-12T10:00:00.000Z',
  });
  return {
    old,
    next,
    notice: {
      kind: 'key_rotated' as const,
      statement,
      signatureOld: ed25519Sign(old.privateKey, statement),
      signatureNew: ed25519Sign(next.privateKey, statement),
    },
  };
}

describe('Rotationsaussage', () => {
  test('gültig nur mit beiden Signaturen über die exakte Zeichenkette', () => {
    const { notice } = rotation();
    expect(KeyRotatedNotice.safeParse(notice).success).toBe(true);
    expect(NoticeBody.safeParse(notice).success).toBe(true);
    const ok = checkRotationStatement(notice);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.statement.nodeId).toBe('osp-a');

    // vertauschte Signaturen, fremde Signatur, veränderte Aussage
    expect(
      checkRotationStatement({
        ...notice,
        signatureOld: notice.signatureNew,
        signatureNew: notice.signatureOld,
      }),
    ).toEqual({ ok: false, reason: 'rotation_proof_invalid' });
    const stranger = generateEd25519();
    expect(
      checkRotationStatement({ ...notice, signatureNew: ed25519Sign(stranger.privateKey, notice.statement) }),
    ).toEqual({ ok: false, reason: 'rotation_proof_invalid' });
    const altered = notice.statement.replace('osp-a', 'osp-b');
    expect(checkRotationStatement({ ...notice, statement: altered })).toEqual({
      ok: false,
      reason: 'rotation_proof_invalid',
    });
    // gleiche Bytes, aber andere Formatierung (keine Kanonisierung): ungültig
    const reformatted = JSON.stringify(JSON.parse(notice.statement), null, 1);
    expect(checkRotationStatement({ ...notice, statement: reformatted }).ok).toBe(false);
  });

  test('gleicher alter und neuer Schlüssel bzw. ungültiger Aufbau werden abgelehnt', () => {
    expect(checkRotationStatement(rotation({ sameKey: true }).notice)).toEqual({
      ok: false,
      reason: 'same_key',
    });
    const { notice } = rotation();
    expect(checkRotationStatement({ ...notice, statement: '{"format":"x"}' })).toEqual({
      ok: false,
      reason: 'invalid_statement',
    });
    expect(checkRotationStatement({ ...notice, statement: 'kein json' })).toEqual({
      ok: false,
      reason: 'invalid_statement',
    });
    // Mitteilung mit unpassender Signaturlänge entspricht nicht dem Vertrag
    expect(KeyRotatedNotice.safeParse({ ...notice, signatureOld: 'AAAA' }).success).toBe(false);
  });
});

describe('Partnersignaturen mit Übergangszeit', () => {
  const cur = generateEd25519();
  const prev = generateEd25519();
  const now = new Date(at);
  const until = new Date(now.getTime() + 60_000);

  test('aktueller Schlüssel immer, bisheriger nur bis zum Ende der Übergangszeit', () => {
    const peer = {
      public_key: cur.publicKey,
      previous_public_key: prev.publicKey,
      previous_key_valid_until: until,
    };
    expect(verifyPeerSignature(peer, 'm', ed25519Sign(cur.privateKey, 'm'), now)).toBe('current');
    expect(verifyPeerSignature(peer, 'm', ed25519Sign(prev.privateKey, 'm'), now)).toBe('previous');
    expect(verifyPeerSignature(peer, 'm', ed25519Sign(prev.privateKey, 'm'), until)).toBe('previous');
    expect(
      verifyPeerSignature(peer, 'm', ed25519Sign(prev.privateKey, 'm'), new Date(until.getTime() + 1)),
    ).toBeNull();
    expect(verifyPeerSignature(peer, 'm', ed25519Sign(prev.privateKey, 'other'), now)).toBeNull();
  });

  test('ohne bisherigen Schlüssel bzw. ohne Ablaufzeit nur der aktuelle', () => {
    const sig = ed25519Sign(prev.privateKey, 'm');
    expect(verifyPeerSignature({ public_key: cur.publicKey }, 'm', sig, now)).toBeNull();
    expect(
      verifyPeerSignature(
        { public_key: cur.publicKey, previous_public_key: prev.publicKey, previous_key_valid_until: null },
        'm',
        sig,
        now,
      ),
    ).toBeNull();
  });
});

describe('Prüfpunkte der Audit-Kette', () => {
  test('Aussage: exakt signierbar, nur gültiger Aufbau wird gelesen', () => {
    const kp = generateEd25519();
    const statement = buildCheckpointStatement({ nodeId: 'osp-a', seq: 7, hash: 'f'.repeat(64), at });
    expect(parseCheckpointStatement(statement)).toEqual({
      format: 'osp-data-mesh/audit-checkpoint@1',
      nodeId: 'osp-a',
      seq: 7,
      hash: 'f'.repeat(64),
      at,
    });
    expect(ed25519Verify(kp.publicKey, statement, ed25519Sign(kp.privateKey, statement))).toBe(true);
    for (const bad of [
      buildCheckpointStatement({ nodeId: 'osp-a', seq: 0, hash: 'f'.repeat(64), at }),
      buildCheckpointStatement({ nodeId: 'osp-a', seq: 1, hash: 'F'.repeat(64), at }),
      buildCheckpointStatement({ nodeId: 'osp-a', seq: 1, hash: 'f'.repeat(63), at }),
      '{"format":"osp-data-mesh/key-rotation@1"}',
      'null',
    ]) {
      expect(parseCheckpointStatement(bad)).toBeNull();
    }
  });

  test('Vergleich: fehlende (abgeschnitten) und abweichende (umgeschrieben) Einträge', () => {
    const local = new Map([
      [1, 'h1'],
      [2, 'h2'],
      [3, 'h3'],
    ]);
    expect(compareCheckpoints(local, [{ seq: 3, hash: 'h3' }]).problems).toEqual([]);
    expect(
      compareCheckpoints(local, [
        { seq: 5, hash: 'h5' },
        { seq: 2, hash: 'xx' },
        { seq: 3, hash: 'h3' },
      ]).problems,
    ).toEqual([
      { seq: 2, kind: 'hash_mismatch' },
      { seq: 5, kind: 'missing' },
    ]);
  });
});

describe('Epochen der Kette (Wiederherstellung)', () => {
  const E1 = '11111111-1111-4111-8111-111111111111';
  const E2 = '22222222-2222-4222-8222-222222222222';
  const E3 = '33333333-3333-4333-8333-333333333333';
  const E4 = '44444444-4444-4444-8444-444444444444';
  const rec = (epoch: string, previousEpoch: string | null, restoredSeq: number | null): EpochRecord => ({
    epoch,
    n: null,
    startedAt: null,
    reason: previousEpoch || restoredSeq !== null ? 'restore' : 'initial',
    previousEpoch,
    restoredSeq,
  });
  // E1 → (Wiederherstellung bis 100) E2 → (bis 130) E3; außerdem E4: Wiederherstellung von E1 bis 50
  const epochs = new Map(
    [rec(E1, null, null), rec(E2, E1, 100), rec(E3, E2, 130), rec(E4, E1, 50)].map((e) => [e.epoch, e]),
  );

  test('Ursprung eines Eintrags folgt den übernommenen Laufnummern rückwärts', () => {
    expect(originEpoch(epochs, E3, 10)).toBe(E1);
    expect(originEpoch(epochs, E3, 120)).toBe(E2);
    expect(originEpoch(epochs, E3, 131)).toBe(E3);
    expect(originEpoch(epochs, E4, 80)).toBe(E4);
    expect(originEpoch(epochs, 'unbekannt', 1)).toBeNull();
    // Zyklus im (manipulierten) Verlauf
    const cyclic = new Map([
      [E1, rec(E1, E2, 10)],
      [E2, rec(E2, E1, 10)],
    ]);
    expect(originEpoch(cyclic, E1, 5)).toBeNull();
  });

  test('Vergleich: passend bis zur übernommenen Laufnummer, dahinter verloren; unbekannte Epoche; ohne Epoche = erste', () => {
    const local = new Map([
      [10, 'h10'],
      [120, 'h120'],
      [140, 'h140'],
    ]);
    const ctx = epochContext(epochs, E3);
    expect(ctx.root).toBe(E1);
    const { problems, matched } = compareCheckpoints(
      local,
      [
        { seq: 10, hash: 'h10', epoch: E1 },
        { seq: 10, hash: 'h10' }, // ohne Epoche → erste Epoche
        { seq: 120, hash: 'alt', epoch: E1 }, // E1 nach 100: verloren
        { seq: 120, hash: 'h120', epoch: E2 },
        { seq: 140, hash: 'h140', epoch: E3 },
        { seq: 60, hash: 'x', epoch: E4 }, // Zweig E4: verloren
        { seq: 5, hash: 'x', epoch: '55555555-5555-4555-8555-555555555555' },
        { seq: 11, hash: 'falsch', epoch: E1 }, // passt nicht zu Laufnummer 11 (fehlt lokal) → Manipulation
      ],
      ctx,
    );
    expect(matched).toBe(4);
    expect(problems).toEqual([
      { seq: 5, kind: 'unknown_epoch', epoch: '55555555-5555-4555-8555-555555555555' },
      { seq: 11, kind: 'missing', epoch: E1 },
      { seq: 60, kind: 'lost_by_restore', epoch: E4 },
      { seq: 120, kind: 'lost_by_restore', epoch: E1 },
    ]);
    // aktuelle Epoche: ohne Angabe der Epoche im Befund
    expect(compareCheckpoints(local, [{ seq: 140, hash: 'x', epoch: E3 }], ctx).problems).toEqual([
      { seq: 140, kind: 'hash_mismatch' },
    ]);
  });

  test('Abweichung mit kompromittiertem Schlüssel: nicht beweiskräftig', () => {
    const local = new Map([[3, 'h3']]);
    expect(
      compareCheckpoints(local, [
        { seq: 3, hash: 'x', compromisedKey: true },
        { seq: 9, hash: 'x', compromisedKey: true },
        { seq: 3, hash: 'h3', compromisedKey: true },
      ]),
    ).toEqual({
      problems: [
        { seq: 3, kind: 'inconclusive' },
        { seq: 9, kind: 'inconclusive' },
      ],
      matched: 1,
      latestMatched: { seq: 3, hash: 'h3', compromisedKey: true },
    });
  });
});

describe('Gültigkeitszeiträume eigener Schlüssel', () => {
  const t = (h: number) => new Date(Date.UTC(2026, 0, 1, h));
  const k0 = generateEd25519();
  const k1 = generateEd25519();
  const k2 = generateEd25519();
  const k3 = generateEd25519();

  test('planmäßig: bis Ende der Übergangszeit; Kompromittierung: bis zum Wechsel, auch der abgebrochene Übergang', () => {
    const windows = keyWindows({ public_key: k3.publicKey, key_created_at: t(30) }, [
      {
        mode: 'routine',
        old_public_key: k0.publicKey,
        new_public_key: k1.publicKey,
        rotated_at: t(1),
        grace_until: t(5),
        finished_at: t(5),
      },
      {
        mode: 'routine',
        old_public_key: k1.publicKey,
        new_public_key: k2.publicKey,
        rotated_at: t(10),
        grace_until: t(20),
        finished_at: t(12),
      },
      {
        mode: 'compromised',
        old_public_key: k2.publicKey,
        new_public_key: k3.publicKey,
        rotated_at: t(12),
        grace_until: t(12),
        finished_at: t(12),
      },
    ]);
    expect(windows).toEqual([
      { publicKey: k0.publicKey, validFrom: null, validUntil: t(5), retired: 'routine' },
      // Übergang durch die Kompromittierung bei t(12) abgebrochen
      { publicKey: k1.publicKey, validFrom: t(1), validUntil: t(12), retired: 'compromised' },
      { publicKey: k2.publicKey, validFrom: t(10), validUntil: t(12), retired: 'compromised' },
      { publicKey: k3.publicKey, validFrom: t(12), validUntil: null, retired: null },
    ]);
    expect(keyWindows({ public_key: k0.publicKey, key_created_at: t(0) }, [])).toEqual([
      { publicKey: k0.publicKey, validFrom: null, validUntil: null, retired: null },
    ]);
  });

  test('Prüfpunkt-Signatur nur im Zeitraum des Schlüssels', () => {
    const keys: OwnKeyWindow[] = [
      { publicKey: k0.publicKey, validFrom: null, validUntil: t(5), retired: 'routine' },
      { publicKey: k1.publicKey, validFrom: t(1), validUntil: null, retired: null },
    ];
    const sign = (kp: typeof k0, at: Date) => {
      const st = buildCheckpointStatement({
        nodeId: 'osp-a',
        seq: 1,
        hash: 'f'.repeat(64),
        at: at.toISOString(),
      });
      return checkpointSigner(keys, st, ed25519Sign(kp.privateKey, st), at.toISOString());
    };
    expect(sign(k0, t(3))).toEqual({ key: keys[0]! });
    expect(sign(k0, t(6))).toEqual({ invalid: 'outside_window' });
    expect(sign(k1, t(0))).toEqual({ invalid: 'outside_window' });
    expect(sign(k1, t(9))).toEqual({ key: keys[1]! });
    expect(sign(k2, t(3))).toEqual({ invalid: 'signature' });
  });
});

describe('Anker-Profil: Aufbau und innere Stimmigkeit', () => {
  const partner = generateEd25519();
  const own = generateEd25519();
  const valid: AnchorProfile = {
    format: ANCHOR_PROFILE_FORMAT,
    nodeId: 'osp-a',
    createdAt: at,
    minPartners: 1,
    keys: [
      {
        publicKey: own.publicKey,
        fingerprint: fingerprint(own.publicKey),
        validFrom: null,
        validUntil: null,
        retired: null,
      },
    ],
    epochs: [
      {
        epoch: '11111111-1111-4111-8111-111111111111',
        n: 1,
        startedAt: at,
        reason: 'initial',
        previousEpoch: null,
        restoredSeq: null,
      },
    ],
    partners: [
      {
        nodeId: 'osp-b',
        displayName: 'B',
        baseUrl: 'https://b.example',
        publicKey: partner.publicKey,
        fingerprint: fingerprint(partner.publicKey),
      },
    ],
  };
  const reason = (raw: unknown) => {
    try {
      parseAnchorProfile(raw);
      return 'ok';
    } catch (err) {
      return err instanceof ProfileError ? err.message : 'other';
    }
  };

  test('gültig; verfälschter Fingerprint, doppelter oder eigener Knoten, zu hohe Mindestzahl, fremdes Format abgelehnt', () => {
    expect(reason(valid)).toBe('ok');
    expect(
      reason({ ...valid, partners: [{ ...valid.partners[0]!, fingerprint: fingerprint(own.publicKey) }] }),
    ).toBe('fingerprint_mismatch');
    expect(reason({ ...valid, keys: [{ ...valid.keys[0]!, fingerprint: '00' }] })).toBe(
      'fingerprint_mismatch',
    );
    expect(reason({ ...valid, partners: [valid.partners[0]!, valid.partners[0]!] })).toBe(
      'duplicate_partner',
    );
    expect(reason({ ...valid, partners: [{ ...valid.partners[0]!, nodeId: 'osp-a' }] })).toBe(
      'own_node_as_partner',
    );
    expect(reason({ ...valid, minPartners: 2 })).toBe('min_partners_out_of_range');
    expect(reason({ ...valid, format: 'osp-data-mesh/audit-anchor-profile@0' })).toBe('invalid_profile');
    expect(reason({ ...valid, partners: [] })).toBe('invalid_profile');
  });
});
