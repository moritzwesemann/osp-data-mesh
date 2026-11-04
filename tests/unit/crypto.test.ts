import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  ed25519Sign,
  ed25519Verify,
  fingerprint,
  generateEd25519,
  keyId,
  normalizeFingerprint,
  SecretBox,
} from '../../src/server/core/crypto.ts';
import { toCsv } from '../../src/server/core/formats.ts';
import { NodeIdentity } from '../../src/server/core/node-identity.ts';
import { createTestNode, type TestNode } from '../helpers/node.ts';

const key = () => randomBytes(32).toString('base64');

describe('SecretBox (AES-256-GCM)', () => {
  test('Roundtrip für Text und Bytes', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('geheim', 'zweck:1');
    expect(sealed.startsWith(`v1.${box.currentKeyId}.`)).toBe(true);
    expect(sealed).not.toContain('geheim');
    expect(box.open(sealed, 'zweck:1')).toBe('geheim');
    const bytes = randomBytes(64);
    expect(box.openBytes(box.seal(bytes, 'b'), 'b').equals(bytes)).toBe(true);
  });

  test('gleicher Klartext ergibt unterschiedliche Chiffrate (zufälliger IV)', () => {
    const box = new SecretBox(key());
    expect(box.seal('x', 'a')).not.toBe(box.seal('x', 'a'));
  });

  test('falsches AAD schlägt fehl', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('geheim', 'connector.secret:1');
    expect(() => box.open(sealed, 'connector.secret:2')).toThrow();
    expect(() => box.open(sealed)).toThrow();
  });

  test('manipuliertes Chiffrat schlägt fehl', () => {
    const box = new SecretBox(key());
    const sealed = box.seal('geheim', 'a');
    const [v, kid, payload] = sealed.split('.');
    const raw = Buffer.from(payload!, 'base64url');
    raw[14] = raw[14]! ^ 0x01;
    expect(() => box.open(`${v}.${kid}.${raw.toString('base64url')}`, 'a')).toThrow();
    expect(() => box.open('v1.deadbeef.AAAA', 'a')).toThrow(/unknown key id/);
    expect(() => box.open('kaputt', 'a')).toThrow(/invalid sealed value/);
  });

  test('anderer Schlüssel kann nicht öffnen', () => {
    const sealed = new SecretBox(key()).seal('geheim', 'a');
    expect(() => new SecretBox(key()).open(sealed, 'a')).toThrow();
  });

  test('Schlüssellänge wird geprüft', () => {
    expect(() => new SecretBox(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => new SecretBox(key(), randomBytes(8).toString('base64'))).toThrow(/32 bytes/);
  });

  test('Rotation: vorheriger Schlüssel entschlüsselt, needsReseal, Neuverschlüsselung mit neuem Schlüssel', () => {
    const oldKey = key();
    const newKey = key();
    const oldBox = new SecretBox(oldKey);
    const sealedOld = oldBox.seal('geheim', 'a');

    const rotating = new SecretBox(newKey, oldKey);
    expect(rotating.currentKeyId).toBe(keyId(Buffer.from(newKey, 'base64')));
    expect(rotating.needsReseal(sealedOld)).toBe(true);
    expect(rotating.open(sealedOld, 'a')).toBe('geheim');

    const resealed = rotating.seal(rotating.open(sealedOld, 'a'), 'a');
    expect(rotating.needsReseal(resealed)).toBe(false);
    // nach Abschluss der Rotation genügt der neue Schlüssel
    expect(new SecretBox(newKey).open(resealed, 'a')).toBe('geheim');
    expect(() => new SecretBox(newKey).open(sealedOld, 'a')).toThrow(/unknown key id/);
    expect(() => oldBox.open(resealed, 'a')).toThrow();
  });
});

describe('Ed25519', () => {
  const kp = generateEd25519();

  test('Schlüsselformat: 32 Byte Public Key, PKCS#8 privat', () => {
    expect(Buffer.from(kp.publicKey, 'base64').length).toBe(32);
    expect(Buffer.from(kp.privateKey, 'base64').length).toBeGreaterThan(32);
  });

  test('Signatur prüfen', () => {
    const sig = ed25519Sign(kp.privateKey, 'nachricht');
    expect(Buffer.from(sig, 'base64').length).toBe(64);
    expect(ed25519Verify(kp.publicKey, 'nachricht', sig)).toBe(true);
    expect(ed25519Verify(kp.publicKey, new TextEncoder().encode('nachricht'), sig)).toBe(true);
  });

  test('veränderte Nachricht, falscher Schlüssel, verfälschte Signatur schlagen fehl', () => {
    const sig = ed25519Sign(kp.privateKey, 'nachricht');
    expect(ed25519Verify(kp.publicKey, 'Nachricht', sig)).toBe(false);
    expect(ed25519Verify(generateEd25519().publicKey, 'nachricht', sig)).toBe(false);
    const raw = Buffer.from(sig, 'base64');
    raw[0] = raw[0]! ^ 0xff;
    expect(ed25519Verify(kp.publicKey, 'nachricht', raw.toString('base64'))).toBe(false);
    expect(ed25519Verify(kp.publicKey, 'nachricht', 'kein-base64!!')).toBe(false);
    expect(ed25519Verify(kp.publicKey, 'nachricht', sig.slice(0, 20))).toBe(false);
    expect(ed25519Verify('AAAA', 'nachricht', sig)).toBe(false);
  });
});

describe('Fingerprint', () => {
  test('Format: 10 Gruppen à 4 Hex-Zeichen, deterministisch', () => {
    const kp = generateEd25519();
    const fp = fingerprint(kp.publicKey);
    expect(fp).toMatch(/^([0-9A-F]{4} ){9}[0-9A-F]{4}$/);
    expect(fingerprint(kp.publicKey)).toBe(fp);
    expect(fingerprint(generateEd25519().publicKey)).not.toBe(fp);
  });

  test('normalizeFingerprint ignoriert Leerzeichen, Trenner und Groß-/Kleinschreibung', () => {
    const fp = fingerprint(generateEd25519().publicKey);
    const plain = fp.replace(/ /g, '');
    expect(normalizeFingerprint(fp)).toBe(plain);
    expect(normalizeFingerprint(fp.toLowerCase().replace(/ /g, '-'))).toBe(plain);
    expect(normalizeFingerprint(` ${fp.toLowerCase()}\n`)).toBe(plain);
  });
});

describe('NodeIdentity', () => {
  let node: TestNode;
  beforeAll(async () => {
    node = await createTestNode();
  });
  afterAll(async () => {
    await node?.close();
  });

  test('Pseudonym ist deterministisch und freigabespezifisch', () => {
    const id = node.deps.identity;
    const athlete = crypto.randomUUID();
    const r1 = crypto.randomUUID();
    const r2 = crypto.randomUUID();
    const p = id.pseudonym(r1, athlete);
    expect(p).toMatch(/^[0-9a-f]{32}$/);
    expect(id.pseudonym(r1, athlete)).toBe(p);
    expect(id.pseudonym(r2, athlete)).not.toBe(p);
    expect(id.pseudonym(r1, crypto.randomUUID())).not.toBe(p);
  });

  test('Pseudonym: 32 Hex-Zeichen (erste 16 Byte des HMAC), vom CSV-Schutz vor Formeln nie verändert', () => {
    const id = node.deps.identity;
    const release = crypto.randomUUID();
    const pseudonyms = Array.from({ length: 400 }, () => id.pseudonym(release, crypto.randomUUID()));
    // die frühere Form (base64url) begann bei rund 1/64 der Personen mit '-' und wurde im Export zu "'-…"
    const legacy = Array.from({ length: 2000 }, (_, i) => id.legacyPseudonym(release, `p${i}`));
    expect(legacy.some((x) => x.startsWith('-'))).toBe(true);
    for (const p of pseudonyms) {
      expect(p).toMatch(/^[0-9a-f]{32}$/);
      const csv = toCsv([{ key: 'subject', label: 'subject', type: 'string' }], [{ subject: p }]);
      expect(csv.replace(/^\uFEFF/, '').split('\r\n')[1]).toBe(p);
    }
    // gleiche HMAC-Basis: die frühere Form bleibt für Löschmitteilungen zu alten Lieferungen ableitbar
    const athlete = crypto.randomUUID();
    expect(id.legacyPseudonym(release, athlete)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(id.legacyPseudonym(release, athlete)).not.toBe(id.pseudonym(release, athlete));
  });

  test('Signaturen des Knotens sind mit dem Public Key der Knotenkarte prüfbar', () => {
    const card = node.deps.identity.card();
    expect(card.fingerprint).toBe(fingerprint(card.publicKey));
    const sig = node.deps.identity.sign('hallo');
    expect(ed25519Verify(card.publicKey, 'hallo', sig)).toBe(true);
  });

  test('Identität wird mit gleichem Master-Key identisch geladen (gleiche Pseudonyme)', async () => {
    const again = await NodeIdentity.ensure(node.deps.db, node.deps.box, node.deps.config);
    expect(again.publicKey).toBe(node.deps.identity.publicKey);
    expect(again.pseudonym('r', 'a')).toBe(node.deps.identity.pseudonym('r', 'a'));
  });

  test('Reseal mit neuem Master-Key: Identität bleibt gleich', async () => {
    const newKey = key();
    const rotating = new SecretBox(newKey, node.deps.config.MESH_MASTER_KEY);
    expect(await NodeIdentity.reseal(node.deps.db, rotating)).toBe(true);
    expect(await NodeIdentity.reseal(node.deps.db, rotating)).toBe(false);
    const reloaded = await NodeIdentity.ensure(node.deps.db, new SecretBox(newKey), node.deps.config);
    expect(reloaded.publicKey).toBe(node.deps.identity.publicKey);
    expect(reloaded.pseudonym('r', 'a')).toBe(node.deps.identity.pseudonym('r', 'a'));
  });
});
