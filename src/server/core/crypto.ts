/**
 * Kryptografische Grundbausteine (nur node:crypto, keine eigenen Primitive):
 *  - SecretBox: AES-256-GCM für gespeicherte Geheimnisse, Schlüssel-ID im Chiffrat (Rotation)
 *  - Ed25519: Knotenidentität und Signaturen im Föderationsprotokoll
 *  - Hashes, HMAC, Zufallstoken
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: Uint8Array, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function keyId(key: Uint8Array): string {
  return sha256Hex(key).slice(0, 8);
}

/** AES-256-GCM-Verschlüsselung mit aktuellem Master-Key; Entschlüsselung auch mit vorherigem Key (Rotation). */
export class SecretBox {
  private readonly current: Buffer;
  private readonly keys = new Map<string, Buffer>();
  readonly currentKeyId: string;

  constructor(currentKeyB64: string, previousKeyB64?: string) {
    this.current = Buffer.from(currentKeyB64, 'base64');
    if (this.current.length !== 32) throw new Error('master key must be 32 bytes');
    this.currentKeyId = keyId(this.current);
    this.keys.set(this.currentKeyId, this.current);
    if (previousKeyB64) {
      const prev = Buffer.from(previousKeyB64, 'base64');
      if (prev.length !== 32) throw new Error('previous master key must be 32 bytes');
      this.keys.set(keyId(prev), prev);
    }
  }

  /** Format: v1.<keyId>.<base64url(iv[12] | ciphertext | tag[16])> */
  seal(plaintext: string | Uint8Array, aad = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.current, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([
      cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext) : plaintext),
      cipher.final(),
    ]);
    return `v1.${this.currentKeyId}.${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url')}`;
  }

  openBytes(sealed: string, aad = ''): Buffer {
    const [v, kid, payload] = sealed.split('.');
    if (v !== 'v1' || !kid || !payload) throw new Error('invalid sealed value');
    const key = this.keys.get(kid);
    if (!key) throw new Error('unknown key id (master key rotated without MESH_MASTER_KEY_PREVIOUS?)');
    const raw = Buffer.from(payload, 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  open(sealed: string, aad = ''): string {
    return this.openBytes(sealed, aad).toString('utf8');
  }

  /** true, wenn der Wert mit einem anderen als dem aktuellen Key verschlüsselt ist */
  needsReseal(sealed: string): boolean {
    return sealed.split('.')[1] !== this.currentKeyId;
  }
}

// ---------------------------------------------------------------------------------------------
// Ed25519
// ---------------------------------------------------------------------------------------------

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface Ed25519KeyPair {
  /** roher Public Key (32 Byte), base64 */
  publicKey: string;
  /** PKCS#8 DER, base64 */
  privateKey: string;
}

export function generateEd25519(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKey: Buffer.from(spki.subarray(spki.length - 32)).toString('base64'),
    privateKey: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('base64'),
  };
}

export function ed25519Sign(privateKeyB64: string, data: Uint8Array | string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return edSign(null, typeof data === 'string' ? Buffer.from(data) : data, key).toString('base64');
}

export function ed25519Verify(
  publicKeyB64: string,
  data: Uint8Array | string,
  signatureB64: string,
): boolean {
  try {
    const raw = Buffer.from(publicKeyB64, 'base64');
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    const sig = Buffer.from(signatureB64, 'base64');
    if (sig.length !== 64) return false;
    return edVerify(null, typeof data === 'string' ? Buffer.from(data) : data, key, sig);
  } catch {
    return false;
  }
}

/** Fingerprint zum Abgleich außerhalb des Systems: SHA-256 des Public Keys, 160 Bit, 4er-Gruppen. */
export function fingerprint(publicKeyB64: string): string {
  const hex = sha256Hex(Buffer.from(publicKeyB64, 'base64')).slice(0, 40).toUpperCase();
  return hex.match(/.{4}/g)!.join(' ');
}

export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
}
