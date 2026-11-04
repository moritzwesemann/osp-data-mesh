/**
 * Identität des Knotens: Ed25519-Schlüsselpaar (privater Schlüssel verschlüsselt in der Datenbank)
 * und geheimer Schlüssel für freigabebezogene Pseudonyme.
 */
import { randomBytes } from 'node:crypto';
import type { NodeCard } from '../../shared/contract/federation.ts';
import type { Config } from '../config.ts';
import { ed25519Sign, fingerprint, generateEd25519, hmacSha256, type SecretBox } from './crypto.ts';
import type { DbOrTx } from './db.ts';

const AAD_PRIVATE_KEY = 'node_identity.private_key';
const AAD_PSEUDONYM = 'node_identity.pseudonym_secret';

export class NodeIdentity {
  private constructor(
    readonly nodeId: string,
    readonly displayName: string,
    readonly baseUrl: string,
    readonly publicKey: string,
    private readonly privateKey: string,
    private readonly pseudonymSecret: Buffer,
  ) {}

  get fingerprint(): string {
    return fingerprint(this.publicKey);
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
      row.public_key,
      box.open(row.private_key_enc, AAD_PRIVATE_KEY),
      box.openBytes(row.pseudonym_secret_enc, AAD_PSEUDONYM),
    );
  }

  /** Verschlüsselt die Geheimnisse mit dem aktuellen Master-Key neu (Rotation). */
  static async reseal(db: DbOrTx, box: SecretBox): Promise<boolean> {
    const row = await db.selectFrom('node_identity').selectAll().where('id', '=', 1).executeTakeFirst();
    if (!row) return false;
    if (!box.needsReseal(row.private_key_enc) && !box.needsReseal(row.pseudonym_secret_enc)) return false;
    await db
      .updateTable('node_identity')
      .set({
        private_key_enc: box.seal(box.open(row.private_key_enc, AAD_PRIVATE_KEY), AAD_PRIVATE_KEY),
        pseudonym_secret_enc: box.seal(box.openBytes(row.pseudonym_secret_enc, AAD_PSEUDONYM), AAD_PSEUDONYM),
      })
      .where('id', '=', 1)
      .execute();
    return true;
  }

  sign(data: Uint8Array | string): string {
    return ed25519Sign(this.privateKey, data);
  }

  /**
   * Freigabebezogenes Pseudonym einer Person: HMAC(secret, releaseId:athleteId), 22 Zeichen base64url.
   * Unterschiedliche Freigaben → unterschiedliche Pseudonyme (Partner können Daten nicht verknüpfen).
   */
  pseudonym(releaseId: string, athleteId: string): string {
    return hmacSha256(this.pseudonymSecret, `${releaseId}:${athleteId}`).toString('base64url').slice(0, 22);
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
