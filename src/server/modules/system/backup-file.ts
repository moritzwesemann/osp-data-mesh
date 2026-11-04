/**
 * Dateiformat verschlüsselter Sicherungen (.mbk, "mesh backup").
 *
 *   Offset      Länge  Inhalt
 *   0           7      Magic "OSPMBK1" (ASCII)
 *   7           2      Länge N des Headers (uint16, big endian)
 *   9           N      Header als JSON (UTF-8): { keyId, nodeId, createdAt, schemaVersion, cipher }
 *   9+N         12     IV (zufällig je Datei)
 *   21+N        …      Chiffrat (pg_dump im Custom-Format, AES-256-GCM)
 *   Ende-16     16     GCM-Authentisierungs-Tag
 *
 * Als Additional Authenticated Data (AAD) dient alles vor dem Chiffrat (Magic, Header, IV): Knoten-ID,
 * Zeitpunkt und Schemaversion sind damit fälschungssicher an den Inhalt gebunden.
 * keyId = erste 8 Hex-Zeichen von SHA-256(Schlüssel); erkennt einen falschen Schlüssel vor dem Entschlüsseln.
 *
 * Verarbeitung: streamend (Ver- und Entschlüsselung in Blöcken), damit auch große Datenbanken nicht in den
 * Speicher geladen werden. Beim Entschlüsseln wird der Klartext in eine temporäre Datei (0600) geschrieben
 * und erst verwendet, nachdem das Tag am Ende geprüft wurde.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, open, stat } from 'node:fs/promises';
import { keyId } from '../../core/crypto.ts';

export const BACKUP_MAGIC = 'OSPMBK1';
export const BACKUP_FORMAT = 'osp-data-mesh/backup@1';
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_HEADER = 4096;

export interface BackupHeader {
  keyId: string;
  nodeId: string;
  createdAt: string;
  schemaVersion: string | null;
  cipher: 'aes-256-gcm';
}

export class BackupFileError extends Error {
  constructor(
    readonly code:
      | 'not_a_backup'
      | 'wrong_key'
      | 'decrypt_failed'
      | 'manifest_mismatch'
      | 'other_node'
      | 'schema_newer',
    message: string,
  ) {
    super(message);
    this.name = 'BackupFileError';
  }
}

export function decodeBackupKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('backup key must be 32 bytes (base64)');
  return key;
}

function buildPrefix(header: BackupHeader, iv: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  if (json.length > MAX_HEADER) throw new Error('backup header too large');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(json.length);
  return Buffer.concat([Buffer.from(BACKUP_MAGIC, 'ascii'), len, json, iv]);
}

async function writeAll(fh: FileHandle, buf: Uint8Array, hash: ReturnType<typeof createHash>) {
  if (buf.length === 0) return;
  hash.update(buf);
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

/**
 * Verschlüsselt einen Datenstrom in eine neue Datei (Modus 0600, darf noch nicht existieren).
 * Liefert SHA-256 und Größe der geschriebenen Datei.
 */
export async function encryptStreamToFile(
  source: AsyncIterable<Uint8Array>,
  keyB64: string,
  meta: Omit<BackupHeader, 'keyId' | 'cipher'>,
  path: string,
): Promise<{ sha256: string; sizeBytes: number; header: BackupHeader }> {
  const key = decodeBackupKey(keyB64);
  const header: BackupHeader = { keyId: keyId(key), cipher: 'aes-256-gcm', ...meta };
  const iv = randomBytes(IV_LEN);
  const prefix = buildPrefix(header, iv);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(prefix);
  const hash = createHash('sha256');
  const fh = await open(path, 'wx', 0o600);
  let size = 0;
  try {
    await writeAll(fh, prefix, hash);
    size += prefix.length;
    for await (const chunk of source) {
      const ct = cipher.update(chunk);
      await writeAll(fh, ct, hash);
      size += ct.length;
    }
    const last = Buffer.concat([cipher.final(), cipher.getAuthTag()]);
    await writeAll(fh, last, hash);
    size += last.length;
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { sha256: hash.digest('hex'), sizeBytes: size, header };
}

/** Liest und prüft den (noch nicht authentisierten) Kopf einer Sicherungsdatei. */
export async function readBackupHeader(
  path: string,
): Promise<{ header: BackupHeader; prefix: Buffer; sizeBytes: number }> {
  const { size } = await stat(path);
  const fh = await open(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(size, 9 + MAX_HEADER + IV_LEN));
    await fh.read(head, 0, head.length, 0);
    if (head.length < 9 || head.subarray(0, 7).toString('ascii') !== BACKUP_MAGIC) {
      throw new BackupFileError('not_a_backup', 'not an OSP-Data-Mesh backup file (magic mismatch)');
    }
    const len = head.readUInt16BE(7);
    if (len > MAX_HEADER || 9 + len + IV_LEN + TAG_LEN > size) {
      throw new BackupFileError('not_a_backup', 'backup file is truncated or has an invalid header');
    }
    let header: BackupHeader;
    try {
      header = JSON.parse(head.subarray(9, 9 + len).toString('utf8')) as BackupHeader;
    } catch {
      throw new BackupFileError('not_a_backup', 'backup header is not valid JSON');
    }
    if (
      header.cipher !== 'aes-256-gcm' ||
      typeof header.keyId !== 'string' ||
      typeof header.nodeId !== 'string'
    ) {
      throw new BackupFileError('not_a_backup', 'unsupported backup header');
    }
    return { header, prefix: Buffer.from(head.subarray(0, 9 + len + IV_LEN)), sizeBytes: size };
  } finally {
    await fh.close();
  }
}

/**
 * Entschlüsselt eine Sicherung in eine neue Datei (0600). Wirft BackupFileError bei falschem Schlüssel
 * oder manipulierter Datei; in diesem Fall ist der Inhalt von `outPath` unbrauchbar und muss gelöscht werden.
 */
export async function decryptBackupToFile(
  path: string,
  keyB64: string,
  outPath: string,
): Promise<BackupHeader> {
  const key = decodeBackupKey(keyB64);
  const { header, prefix, sizeBytes } = await readBackupHeader(path);
  if (header.keyId !== keyId(key)) {
    throw new BackupFileError(
      'wrong_key',
      `backup was encrypted with key ${header.keyId}, not ${keyId(key)}`,
    );
  }
  const tag = Buffer.alloc(TAG_LEN);
  const fh = await open(path, 'r');
  try {
    await fh.read(tag, 0, TAG_LEN, sizeBytes - TAG_LEN);
  } finally {
    await fh.close();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, prefix.subarray(prefix.length - IV_LEN));
  decipher.setAAD(prefix);
  decipher.setAuthTag(tag);
  const out = await open(outPath, 'wx', 0o600);
  const discard = createHash('sha256');
  try {
    const end = sizeBytes - TAG_LEN - 1;
    if (end >= prefix.length) {
      for await (const chunk of createReadStream(path, { start: prefix.length, end })) {
        await writeAll(out, decipher.update(chunk as Buffer), discard);
      }
    }
    let last: Buffer;
    try {
      last = decipher.final();
    } catch {
      throw new BackupFileError('decrypt_failed', 'backup file failed authentication (tampered or corrupt)');
    }
    await writeAll(out, last, discard);
  } finally {
    await out.close();
  }
  return header;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Begleitdatei (Manifest) zu einer Sicherung: <datei>.mbk.json */
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  fileName: string;
  nodeId: string;
  createdAt: string;
  schemaVersion: string | null;
  sha256: string;
  sizeBytes: number;
  keyId: string;
  cipher: 'aes-256-gcm';
}

export function manifestPath(backupPath: string): string {
  return `${backupPath}.json`;
}
