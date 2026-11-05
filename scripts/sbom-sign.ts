/**
 * Signatur der SBOM nach CycloneDX: eingebettete Signatur im JSON Signature Format (JSF 0.82,
 * https://cyberphone.github.io/doc/security/jsf.html) über die kanonische Form nach RFC 8785 (JCS).
 *
 * Kompatibel mit `cdx-sign`/`cdx-verify` aus @cyclonedx/cdxgen (gegenseitig geprüft, siehe
 * docs/sicherheit.md). Unterstützte Schlüssel: Ed25519 (Standard), ECDSA P-256/P-384 (ES256/ES384),
 * RSA (RS256). Signiert wird nur die Wurzel der SBOM (keine Einzelsignaturen je Komponente).
 *
 * Schlüssel: Der private Schlüssel liegt nie im Repository (z. B. in der Passwortverwaltung bzw. im
 * Geheimnisspeicher der Release-Umgebung); der öffentliche Schlüssel wird veröffentlicht
 * (sbom/sbom.config.json → signing.publicKey). Prüfen mit pinnendem Schlüssel beweist Herkunft und
 * Unversehrtheit; ohne ihn nur die Unversehrtheit gegenüber dem eingebetteten Schlüssel.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';

export type JsfAlgorithm = 'Ed25519' | 'ES256' | 'ES384' | 'RS256';

export interface JsfSignature {
  algorithm: JsfAlgorithm;
  keyId?: string;
  publicKey?: Record<string, unknown>;
  value: string;
}

interface AlgSpec {
  hash: string | null;
  keyType: string;
  curve?: string;
  /** Gruppenordnung (ECDSA), für die eindeutige Low-S-Form */
  order?: bigint;
}

const ALGS: Record<JsfAlgorithm, AlgSpec> = {
  Ed25519: { hash: null, keyType: 'ed25519' },
  ES256: {
    hash: 'sha256',
    keyType: 'ec',
    curve: 'prime256v1',
    order: 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n,
  },
  ES384: {
    hash: 'sha384',
    keyType: 'ec',
    curve: 'secp384r1',
    order:
      0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973n,
  },
  RS256: { hash: 'sha256', keyType: 'rsa' },
};

/** RFC 8785 (JCS): Schlüssel nach UTF-16-Codeeinheiten sortiert, Zahlen und Zeichenketten wie JSON.stringify. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('JCS: nicht endliche Zahl');
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
  const members: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined || typeof v === 'function') continue;
    members.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
  }
  return `{${members.join(',')}}`;
}

function algorithmFor(key: KeyObject): JsfAlgorithm {
  const t = key.asymmetricKeyType;
  if (t === 'ed25519') return 'Ed25519';
  if (t === 'rsa') return 'RS256';
  if (t === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve === 'prime256v1') return 'ES256';
    if (curve === 'secp384r1') return 'ES384';
  }
  throw new Error(
    `Schlüsseltyp nicht unterstützt (${t}${t === 'ec' ? ` ${key.asymmetricKeyDetails?.namedCurve}` : ''}); erlaubt: Ed25519, EC P-256/P-384, RSA`,
  );
}

function assertKeyMatches(key: KeyObject, alg: JsfAlgorithm) {
  const spec = ALGS[alg];
  if (!spec) throw new Error(`Algorithmus nicht unterstützt: ${String(alg)}`);
  if (key.asymmetricKeyType !== spec.keyType)
    throw new Error(`Schlüssel (${key.asymmetricKeyType}) passt nicht zum Algorithmus ${alg}`);
  if (spec.curve && key.asymmetricKeyDetails?.namedCurve !== spec.curve)
    throw new Error(`Kurve des Schlüssels passt nicht zum Algorithmus ${alg}`);
}

function toLowS(sig: Buffer, order: bigint): Buffer {
  const size = sig.length / 2;
  const s = BigInt(`0x${sig.subarray(size).toString('hex')}`);
  if (s <= order >> 1n) return sig;
  const low = Buffer.from((order - s).toString(16).padStart(size * 2, '0'), 'hex');
  return Buffer.concat([sig.subarray(0, size), low]);
}

function options(key: KeyObject, spec: AlgSpec) {
  return spec.keyType === 'ec' ? { key, dsaEncoding: 'ieee-p1363' as const } : key;
}

/** Fingerabdruck eines öffentlichen Schlüssels: SHA-256 über SPKI (DER), hexadezimal. */
export function publicKeyFingerprint(key: KeyObject): string {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return createHash('sha256')
    .update(pub.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function sameKey(a: KeyObject, b: KeyObject): boolean {
  return (
    a.asymmetricKeyType === b.asymmetricKeyType &&
    a.asymmetricKeyDetails?.namedCurve === b.asymmetricKeyDetails?.namedCurve &&
    a.equals(b)
  );
}

/** Die von der Signatur abgedeckten Bytes: das ganze Dokument mit `signature` ohne `value` (JSF). */
function signedBytes(doc: Record<string, unknown>, sigWithoutValue: Record<string, unknown>): Buffer {
  const { signature: _ignored, ...content } = doc;
  return Buffer.from(canonicalize({ ...content, signature: sigWithoutValue }), 'utf8');
}

/** Signiert die SBOM (ersetzt eine vorhandene Signatur). Gibt ein neues Objekt zurück. */
export function signBom<T extends Record<string, unknown>>(
  bom: T,
  privateKeyPem: string | Buffer,
): T & { signature: JsfSignature } {
  const key = createPrivateKey(privateKeyPem);
  const alg = algorithmFor(key);
  const spec = ALGS[alg];
  const pub = createPublicKey(key);
  const template: Record<string, unknown> = {
    algorithm: alg,
    keyId: `sha256:${publicKeyFingerprint(pub)}`,
    publicKey: pub.export({ format: 'jwk' }),
  };
  const data = signedBytes(bom, template);
  let raw: Buffer = sign(spec.hash, data, options(key, spec));
  if (spec.order) raw = toLowS(raw, spec.order);
  return { ...bom, signature: { ...template, value: raw.toString('base64url') } as unknown as JsfSignature };
}

export interface VerifyResult {
  ok: boolean;
  /** true: geprüft mit einem vorgegebenen (vertrauenswürdigen) Schlüssel; false: nur mit dem eingebetteten */
  pinned: boolean;
  algorithm?: string;
  keyFingerprint?: string;
  reason?: string;
}

/**
 * Prüft die eingebettete JSF-Signatur. Mit `trustedPublicKeyPem` muss die Signatur mit genau diesem
 * Schlüssel erstellt worden sein (Herkunft); ohne nur mit dem eingebetteten Schlüssel (Unversehrtheit).
 */
export function verifyBom(bom: Record<string, unknown>, trustedPublicKeyPem?: string | Buffer): VerifyResult {
  const pinned = trustedPublicKeyPem !== undefined;
  const sig = bom.signature as Record<string, unknown> | undefined;
  if (!sig || typeof sig !== 'object' || Array.isArray(sig))
    return { ok: false, pinned, reason: 'keine Signatur vorhanden' };
  if ('signers' in sig || 'chain' in sig)
    return { ok: false, pinned, reason: 'Mehrfachsignaturen (signers/chain) werden nicht unterstützt' };
  if ('excludes' in sig) return { ok: false, pinned, reason: 'JSF excludes wird nicht unterstützt' };
  const alg = sig.algorithm as JsfAlgorithm;
  const spec = ALGS[alg];
  if (!spec) return { ok: false, pinned, reason: `Algorithmus nicht unterstützt: ${String(sig.algorithm)}` };
  if (typeof sig.value !== 'string' || !sig.value)
    return { ok: false, pinned, algorithm: alg, reason: 'Signaturwert fehlt' };
  const raw = Buffer.from(sig.value, 'base64url');
  if (raw.toString('base64url') !== sig.value)
    return { ok: false, pinned, algorithm: alg, reason: 'Signaturwert ist kein kanonisches base64url' };
  try {
    let embedded: KeyObject | undefined;
    if (sig.publicKey !== undefined)
      embedded = createPublicKey({ key: sig.publicKey as never, format: 'jwk' });
    let key: KeyObject;
    if (pinned) {
      key = createPublicKey(trustedPublicKeyPem);
      if (embedded && !sameKey(embedded, key))
        return {
          ok: false,
          pinned,
          algorithm: alg,
          keyFingerprint: publicKeyFingerprint(embedded),
          reason: 'eingebetteter Schlüssel ist nicht der vertrauenswürdige Schlüssel',
        };
    } else if (embedded) key = embedded;
    else
      return { ok: false, pinned, algorithm: alg, reason: 'kein Schlüssel eingebettet und keiner angegeben' };
    assertKeyMatches(key, alg);
    const { value: _v, ...withoutValue } = sig;
    const ok = verify(spec.hash, signedBytes(bom, withoutValue), options(key, spec), raw);
    return {
      ok,
      pinned,
      algorithm: alg,
      keyFingerprint: publicKeyFingerprint(key),
      ...(ok ? {} : { reason: 'Signatur ungültig: Inhalt verändert oder anderer Schlüssel' }),
    };
  } catch (err) {
    return { ok: false, pinned, algorithm: alg, reason: (err as Error).message };
  }
}

/** Erzeugt ein Ed25519-Schlüsselpaar (PEM: PKCS#8 bzw. SPKI). */
export function generateSigningKeyPair(): {
  privateKeyPem: string;
  publicKeyPem: string;
  fingerprint: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: publicKeyFingerprint(publicKey),
  };
}
