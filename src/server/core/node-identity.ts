/**
 * Identität des Knotens: Ed25519-Schlüsselpaar (privater Schlüssel verschlüsselt in der Datenbank)
 * und geheimer Schlüssel für freigabebezogene Pseudonyme.
 *
 * Schlüsselwechsel (ADR 0013): Nach einem planmäßigen Wechsel signiert der Knoten bis zum Ende der
 * Übergangszeit für jeden Partner, der die Rotationsmitteilung noch nicht bestätigt hat, weiter mit dem
 * bisherigen Schlüssel (signerFor), für alle anderen mit dem neuen. Ein Wechsel aus einem anderen Prozess
 * (CLI) wird mit refresh() übernommen.
 */
import { randomBytes } from 'node:crypto';
import type { NodeCard } from '../../shared/contract/federation.ts';
import type { Config } from '../config.ts';
import { ed25519Sign, fingerprint, generateEd25519, hmacSha256, type SecretBox } from './crypto.ts';
import { type DbOrTx, pgCode } from './db.ts';

const AAD_PRIVATE_KEY = 'node_identity.private_key';
const AAD_PSEUDONYM = 'node_identity.pseudonym_secret';

/** AAD des bisherigen privaten Schlüssels während der Übergangszeit eines Wechsels */
export function rotationKeyAad(rotationId: string): string {
  return `node_key_rotation.old_private_key:${rotationId}`;
}

/** Signiert Nachrichten im Namen des Knotens (aktueller oder – im Übergang – bisheriger Schlüssel) */
export interface Signer {
  readonly nodeId: string;
  readonly publicKey: string;
  sign(data: Uint8Array | string): string;
}

interface KeyPair {
  publicKey: string;
  privateKey: string;
}

/** Laufender Schlüsselwechsel: bisheriger Schlüssel für Partner ohne Bestätigung, bis graceUntil */
interface Transition {
  rotationId: string;
  old: KeyPair;
  graceUntil: Date;
}

export class NodeIdentity implements Signer {
  private key: KeyPair;
  private transition: Transition | null;
  private keyCreated: Date;

  private constructor(
    readonly nodeId: string,
    readonly displayName: string,
    readonly baseUrl: string,
    key: KeyPair,
    keyCreatedAt: Date,
    transition: Transition | null,
    private readonly pseudonymSecret: Buffer,
  ) {
    this.key = key;
    this.keyCreated = keyCreatedAt;
    this.transition = transition;
  }

  get publicKey(): string {
    return this.key.publicKey;
  }

  get fingerprint(): string {
    return fingerprint(this.key.publicKey);
  }

  get keyCreatedAt(): Date {
    return this.keyCreated;
  }

  /** Lädt die Identität oder legt sie beim ersten Start an. node_id ist danach unveränderlich. */
  static async ensure(
    db: DbOrTx,
    box: SecretBox,
    cfg: Pick<Config, 'MESH_NODE_ID' | 'MESH_NODE_NAME' | 'MESH_PUBLIC_URL'>,
  ) {
    let row = await db.selectFrom('node_identity').selectAll().where('id', '=', 1).executeTakeFirst();
    if (!row) {
      const kp = generateEd25519();
      await db
        .insertInto('node_identity')
        .values({
          id: 1,
          node_id: cfg.MESH_NODE_ID,
          display_name: cfg.MESH_NODE_NAME,
          base_url: cfg.MESH_PUBLIC_URL.replace(/\/$/, ''),
          public_key: kp.publicKey,
          private_key_enc: box.seal(kp.privateKey, AAD_PRIVATE_KEY),
          pseudonym_secret_enc: box.seal(randomBytes(32), AAD_PSEUDONYM),
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      row = await db.selectFrom('node_identity').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    }
    if (row.node_id !== cfg.MESH_NODE_ID) {
      throw new Error(
        `MESH_NODE_ID (${cfg.MESH_NODE_ID}) does not match the node identity stored in the database (${row.node_id})`,
      );
    }
    const baseUrl = cfg.MESH_PUBLIC_URL.replace(/\/$/, '');
    if (row.display_name !== cfg.MESH_NODE_NAME || row.base_url !== baseUrl) {
      await db
        .updateTable('node_identity')
        .set({ display_name: cfg.MESH_NODE_NAME, base_url: baseUrl })
        .where('id', '=', 1)
        .execute();
    }
    return new NodeIdentity(
      row.node_id,
      cfg.MESH_NODE_NAME,
      baseUrl,
      { publicKey: row.public_key, privateKey: box.open(row.private_key_enc, AAD_PRIVATE_KEY) },
      row.key_created_at,
      await loadTransition(db, box),
      box.openBytes(row.pseudonym_secret_enc, AAD_PSEUDONYM),
    );
  }

  /** Schlüssel und laufenden Wechsel neu aus der Datenbank lesen (nach einem Wechsel). */
  async reload(db: DbOrTx, box: SecretBox): Promise<void> {
    const row = await db
      .selectFrom('node_identity')
      .select(['public_key', 'private_key_enc', 'key_created_at'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    const transition = await loadTransition(db, box);
    this.key = { publicKey: row.public_key, privateKey: box.open(row.private_key_enc, AAD_PRIVATE_KEY) };
    this.keyCreated = row.key_created_at;
    this.transition = transition;
  }

  /**
   * Übernimmt einen Schlüsselwechsel aus einem anderen Prozess (CLI) bzw. das Ende einer Übergangszeit.
   * Günstig: liest nur den öffentlichen Schlüssel und die id des laufenden Wechsels. true = neu geladen.
   */
  async refresh(db: DbOrTx, box: SecretBox): Promise<boolean> {
    const row = await db
      .selectFrom('node_identity')
      .select('public_key')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    const running = await db
      .selectFrom('node_key_rotation')
      .select('id')
      .where('finished_at', 'is', null)
      .executeTakeFirst();
    if (
      row.public_key === this.key.publicKey &&
      (running?.id ?? null) === (this.transition?.rotationId ?? null)
    ) {
      return false;
    }
    await this.reload(db, box);
    return true;
  }

  /** Bisheriger öffentlicher Schlüssel während eines laufenden Wechsels */
  get previousPublicKey(): string | null {
    return this.transition?.old.publicKey ?? null;
  }

  /** id des laufenden Wechsels (Übergangszeit), sonst null */
  get transitionRotationId(): string | null {
    return this.transition?.rotationId ?? null;
  }

  /**
   * Signierer für Nachrichten an bzw. Antworten für einen Partner: während eines laufenden Wechsels der
   * bisherige Schlüssel, solange dieser Partner die Rotationsmitteilung nicht bestätigt hat (er kennt nur
   * den bisherigen Schlüssel), sonst der aktuelle. Nach dem Ende der Übergangszeit immer der aktuelle.
   */
  async signerFor(db: DbOrTx, peerNodeId: string, now: Date): Promise<Signer> {
    const t = this.transition;
    if (!t || now.getTime() >= t.graceUntil.getTime()) return this;
    const open = await db
      .selectFrom('node_key_rotation_peer as rp')
      .innerJoin('peer as p', 'p.id', 'rp.peer_id')
      .select('rp.peer_id')
      .where('rp.rotation_id', '=', t.rotationId)
      .where('p.node_id', '=', peerNodeId)
      .where('rp.confirmed_at', 'is', null)
      .executeTakeFirst();
    return open ? keySigner(this.nodeId, t.old) : this;
  }

  /**
   * Signierer mit dem bisherigen Schlüssel eines laufenden Wechsels (für die Rotationsmitteilung selbst,
   * die Kontinuität beweisen muss). null, wenn der Wechsel beendet ist (Schlüssel gelöscht).
   */
  static async rotationSigner(
    db: DbOrTx,
    box: SecretBox,
    nodeId: string,
    rotationId: string,
  ): Promise<Signer | null> {
    const r = await db
      .selectFrom('node_key_rotation')
      .select(['old_public_key', 'old_private_key_enc', 'finished_at'])
      .where('id', '=', rotationId)
      .executeTakeFirst();
    if (!r?.old_private_key_enc || r.finished_at) return null;
    return keySigner(nodeId, {
      publicKey: r.old_public_key,
      privateKey: box.open(r.old_private_key_enc, rotationKeyAad(rotationId)),
    });
  }

  /**
   * Alle öffentlichen Schlüssel, die dieser Knoten je hatte, mit Gültigkeitszeitraum für die Prüfung eigener,
   * früher signierter Prüfpunkte (ADR 0013/0014): ab dem Wechsel, der ihn eingeführt hat (der erste Schlüssel:
   * ohne Beginn), bis zum Ende der Übergangszeit des Wechsels, der ihn ablöste – bei einem Wechsel wegen
   * Kompromittierung bis zu dessen Zeitpunkt. `retired` = Art dieses ablösenden Wechsels; ein bisheriger
   * Schlüssel eines planmäßigen Wechsels, der durch einen Wechsel wegen Kompromittierung abgebrochen wurde,
   * gilt ebenfalls als kompromittiert (er lag verschlüsselt in derselben Datenbank).
   */
  static async keyHistory(db: DbOrTx): Promise<OwnKeyWindow[]> {
    const current = await db
      .selectFrom('node_identity')
      .select(['public_key', 'key_created_at'])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    const rotations = await db
      .selectFrom('node_key_rotation')
      .select(['mode', 'old_public_key', 'new_public_key', 'rotated_at', 'grace_until', 'finished_at'])
      .orderBy('rotated_at')
      .execute();
    return keyWindows(current, rotations);
  }

  /** Verschlüsselt die Geheimnisse mit dem aktuellen Master-Key neu (Rotation des Master-Keys). */
  static async reseal(db: DbOrTx, box: SecretBox): Promise<boolean> {
    const row = await db.selectFrom('node_identity').selectAll().where('id', '=', 1).executeTakeFirst();
    if (!row) return false;
    let changed = false;
    if (box.needsReseal(row.private_key_enc) || box.needsReseal(row.pseudonym_secret_enc)) {
      await db
        .updateTable('node_identity')
        .set({
          private_key_enc: box.seal(box.open(row.private_key_enc, AAD_PRIVATE_KEY), AAD_PRIVATE_KEY),
          pseudonym_secret_enc: box.seal(
            box.openBytes(row.pseudonym_secret_enc, AAD_PSEUDONYM),
            AAD_PSEUDONYM,
          ),
        })
        .where('id', '=', 1)
        .execute();
      changed = true;
    }
    // bisheriger Schlüssel eines laufenden Knotenschlüssel-Wechsels
    const rotations = await db
      .selectFrom('node_key_rotation')
      .select(['id', 'old_private_key_enc'])
      .where('old_private_key_enc', 'is not', null)
      .execute();
    for (const r of rotations) {
      if (!r.old_private_key_enc || !box.needsReseal(r.old_private_key_enc)) continue;
      const aad = rotationKeyAad(r.id);
      await db
        .updateTable('node_key_rotation')
        .set({ old_private_key_enc: box.seal(box.open(r.old_private_key_enc, aad), aad) })
        .where('id', '=', r.id)
        .execute();
      changed = true;
    }
    return changed;
  }

  /** Signatur mit dem aktuellen Schlüssel */
  sign(data: Uint8Array | string): string {
    return ed25519Sign(this.key.privateKey, data);
  }

  /**
   * Freigabebezogenes Pseudonym einer Person: die ersten 16 Byte von HMAC-SHA256(secret, releaseId:athleteId)
   * als 32 Hex-Zeichen (Kleinbuchstaben), deterministisch. Unterschiedliche Freigaben → unterschiedliche
   * Pseudonyme (Partner können Daten nicht verknüpfen). Nur [0-9a-f]: der Schutz vor Formel-Injection in
   * CSV-Exporten (core/formats.ts) verändert es nie (base64url konnte mit '-' beginnen).
   */
  pseudonym(releaseId: string, athleteId: string): string {
    return this.pseudonymMac(releaseId, athleteId).subarray(0, 16).toString('hex');
  }

  /**
   * Frühere Form des Pseudonyms (22 Zeichen base64url). Nur noch, um Löschmitteilungen für Lieferungen
   * zuzuordnen, die vor der Umstellung protokolliert wurden (federation/outbox.ts).
   */
  legacyPseudonym(releaseId: string, athleteId: string): string {
    return this.pseudonymMac(releaseId, athleteId).toString('base64url').slice(0, 22);
  }

  private pseudonymMac(releaseId: string, athleteId: string): Buffer {
    return hmacSha256(this.pseudonymSecret, `${releaseId}:${athleteId}`);
  }

  card(): NodeCard {
    return {
      format: 'osp-data-mesh/node-card@1',
      nodeId: this.nodeId,
      displayName: this.displayName,
      baseUrl: this.baseUrl,
      publicKey: this.publicKey,
      fingerprint: this.fingerprint,
    };
  }
}

function keySigner(nodeId: string, key: KeyPair): Signer {
  return {
    nodeId,
    publicKey: key.publicKey,
    sign: (data) => ed25519Sign(key.privateKey, data),
  };
}

/** Laufender Wechsel; vor Migration 0600 (Tabelle fehlt, Knoten noch nicht migriert) keiner */
async function loadTransition(db: DbOrTx, box: SecretBox): Promise<Transition | null> {
  let r:
    | { id: string; old_public_key: string; old_private_key_enc: string | null; grace_until: Date }
    | undefined;
  try {
    r = await db
      .selectFrom('node_key_rotation')
      .select(['id', 'old_public_key', 'old_private_key_enc', 'grace_until'])
      .where('finished_at', 'is', null)
      .executeTakeFirst();
  } catch (err) {
    if (pgCode(err) === '42P01') return null;
    throw err;
  }
  if (!r?.old_private_key_enc) return null;
  return {
    rotationId: r.id,
    old: { publicKey: r.old_public_key, privateKey: box.open(r.old_private_key_enc, rotationKeyAad(r.id)) },
    graceUntil: r.grace_until,
  };
}

/** Öffentlicher Schlüssel des Knotens mit Gültigkeitszeitraum für eigene Prüfpunkte */
export interface OwnKeyWindow {
  publicKey: string;
  /** null = seit Anlage des Knotens */
  validFrom: Date | null;
  /** null = aktueller Schlüssel */
  validUntil: Date | null;
  retired: 'routine' | 'compromised' | null;
}

interface RotationRow {
  mode: 'routine' | 'compromised';
  old_public_key: string;
  new_public_key: string;
  rotated_at: Date;
  grace_until: Date;
  finished_at: Date | null;
}

/** Gültigkeitszeiträume aus dem Verlauf der Schlüsselwechsel (nach rotated_at sortiert) */
export function keyWindows(
  current: { public_key: string; key_created_at: Date },
  rotations: readonly RotationRow[],
): OwnKeyWindow[] {
  const out = new Map<string, OwnKeyWindow>();
  const put = (k: OwnKeyWindow) => {
    const seen = out.get(k.publicKey);
    // derselbe Schlüssel mehrfach (sollte nicht vorkommen): engster Zeitraum, Kompromittierung gewinnt
    if (!seen) out.set(k.publicKey, k);
    else if (k.retired === 'compromised') seen.retired = 'compromised';
  };
  let from: Date | null = null;
  rotations.forEach((r, i) => {
    const next = rotations[i + 1];
    const compromisedLater =
      next?.mode === 'compromised' && next.rotated_at.getTime() <= r.grace_until.getTime();
    let until: Date;
    if (r.mode === 'compromised') until = r.rotated_at;
    else {
      // vorzeitig beendet (Wechsel wegen Kompromittierung während der Übergangszeit)
      const end = r.finished_at && r.finished_at < r.grace_until ? r.finished_at : r.grace_until;
      until = end;
    }
    put({
      publicKey: r.old_public_key,
      validFrom: from,
      validUntil: until,
      retired: r.mode === 'compromised' || compromisedLater ? 'compromised' : 'routine',
    });
    from = r.rotated_at;
  });
  const last = rotations.at(-1);
  if (last && last.new_public_key !== current.public_key) {
    // Verlauf passt nicht zum aktuellen Schlüssel: letzter neuer Schlüssel ohne bekanntes Ende
    put({ publicKey: last.new_public_key, validFrom: from, validUntil: null, retired: null });
    from = current.key_created_at;
  }
  put({ publicKey: current.public_key, validFrom: from, validUntil: null, retired: null });
  return [...out.values()];
}
