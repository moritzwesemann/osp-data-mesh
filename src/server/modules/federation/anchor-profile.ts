/**
 * Anker-Profil für die unabhängige Prüfung der Audit-Kette (ADR 0014, Nachtrag; docs/betrieb.md).
 *
 * Partnerliste, Schlüssel und Adressen der Partner sowie die früheren eigenen Schlüssel liegen in derselben
 * Datenbank wie das Audit-Log. Wer sie verändern kann (mesh_owner, teils schon mesh_app), könnte Partner
 * sperren (Ergebnis „nicht verankert“ statt „Manipulation“) oder eine Partneradresse auf einen eigenen
 * Dienst und dessen Schlüssel umstellen und sich einen eigenen „früheren Knotenschlüssel“ eintragen – die
 * Prüfung meldete dann „ok“ unter dem Namen eines echten Partners.
 *
 * Das Profil hält diese Angaben außerhalb der Datenbank fest: eine Administratorin exportiert es
 * (`audit-anchor-profile --out`), vergleicht die angezeigten Fingerprints mit den Unterlagen der
 * Vertrauensaufnahme und verwahrt es offline neben dem Sicherungsschlüssel (Prüfsumme notieren).
 * `verify-audit --with-partners --profile <datei>` nimmt Partner, Adressen, Partnerschlüssel, eigene
 * Schlüssel (mit Gültigkeitszeitraum) und den bekannten Epochenverlauf dann ausschließlich aus dem Profil.
 *
 * Neu exportieren mit `--previous <altes-profil>` (Nachtrag 2): Das alte Profil ist die vertrauenswürdige
 * Grundlage, die Datenbank nur ein Vorschlag. Mindestzahl der Partner bleibt die des alten Profils (außer
 * ausdrücklich mit --min-partners). Jede Abweichung wird angezeigt (planAnchorProfile) und muss je Kategorie
 * ausdrücklich angenommen werden: Partner entfernt/hinzugekommen/Schlüssel oder Adresse geändert
 * (--accept-partner-changes), eigene Schlüssel neu oder Gültigkeitszeitraum/Art der Ablösung geändert
 * (--accept-key-changes), Epochen neu oder geändert (--accept-epochs) – sonst bricht der Export ab. Ohne
 * Annahme gelten bei Widerspruch die Angaben des alten Profils; was nur das alte Profil kennt (eigene
 * Schlüssel, Epochen, die eine Wiederherstellung aus der Datenbank entfernt hat), bleibt erhalten.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { IsoDateTime, Uuid } from '../../../shared/contract/common.ts';
import { PublicKeyB64 } from '../../../shared/contract/federation-wire.ts';
import { fingerprint, normalizeFingerprint, sha256Hex } from '../../core/crypto.ts';
import { type DbOrTx, iso } from '../../core/db.ts';
import { NodeIdentity, type OwnKeyWindow } from '../../core/node-identity.ts';
import { epochFromRow } from './anchors.ts';

export const ANCHOR_PROFILE_FORMAT = 'osp-data-mesh/audit-anchor-profile@1' as const;

const ProfileKey = z.object({
  publicKey: PublicKeyB64,
  fingerprint: z.string(),
  validFrom: IsoDateTime.nullable(),
  validUntil: IsoDateTime.nullable(),
  /** Art des Wechsels, mit dem der Schlüssel abgelöst wurde; null = beim Export aktuell */
  retired: z.enum(['routine', 'compromised']).nullable(),
});

const ProfileEpoch = z.object({
  epoch: Uuid,
  n: z.number().int().min(1).nullable(),
  startedAt: IsoDateTime.nullable(),
  reason: z.enum(['initial', 'restore']),
  previousEpoch: Uuid.nullable(),
  restoredSeq: z.number().int().min(0).nullable(),
  /**
   * Nur bei Wiederherstellungen (Nachtrag 2; fehlen in älteren Profilen): Prüfsumme und Zeitpunkt der
   * Sicherung, Epoche, Laufnummer und Hash des Kopfes unmittelbar vor der Wiederherstellung (null = unbekannt)
   */
  backupSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional(),
  backupCreatedAt: IsoDateTime.nullable().optional(),
  preRestoreEpoch: Uuid.nullable().optional(),
  preRestoreSeq: z.number().int().min(0).nullable().optional(),
  preRestoreHash: z.string().max(200).nullable().optional(),
});

const ProfilePartner = z.object({
  nodeId: z.string().min(1).max(100),
  displayName: z.string().max(200),
  baseUrl: z.string().min(1).max(500),
  publicKey: PublicKeyB64,
  fingerprint: z.string(),
});

export const AnchorProfile = z.object({
  format: z.literal(ANCHOR_PROFILE_FORMAT),
  nodeId: z.string().min(1).max(100),
  createdAt: IsoDateTime,
  /** so viele Partner aus dem Profil müssen die Kette bestätigen */
  minPartners: z.number().int().min(1),
  keys: z.array(ProfileKey).min(1).max(1000),
  epochs: z.array(ProfileEpoch).min(1).max(10_000),
  partners: z.array(ProfilePartner).min(1).max(1000),
});
export type AnchorProfile = z.infer<typeof AnchorProfile>;
export type ProfileEpoch = z.infer<typeof ProfileEpoch>;

export interface LoadedProfile {
  profile: AnchorProfile;
  /** SHA-256 der Datei (mit dem bei der Ablage notierten Wert vergleichen) */
  sha256: string;
}

export class ProfileError extends Error {}

function keyFromWindow(k: OwnKeyWindow) {
  return {
    publicKey: k.publicKey,
    fingerprint: fingerprint(k.publicKey),
    validFrom: iso(k.validFrom),
    validUntil: iso(k.validUntil),
    retired: k.retired,
  };
}

export type ProfileKey = z.infer<typeof ProfileKey>;
export type ProfilePartner = z.infer<typeof ProfilePartner>;
export type ChangeCategory = 'partners' | 'keys' | 'epochs';

/** Abweichungen der Datenbank vom alten Profil (nur mit `previous`) */
export interface ProfileDiff {
  minPartners: { previous: number; next: number };
  partners: {
    added: ProfilePartner[];
    /** im alten Profil, in der Datenbank nicht (mehr) vertrauenswürdig; dbStatus null = fehlt ganz */
    removed: (ProfilePartner & { dbStatus: string | null })[];
    changed: {
      nodeId: string;
      fields: ('publicKey' | 'baseUrl')[];
      previous: ProfilePartner;
      current: ProfilePartner;
    }[];
    /** nur der Anzeigename anders (ohne Annahme übernommen) */
    renamed: { nodeId: string; from: string; to: string }[];
  };
  keys: {
    added: ProfileKey[];
    changed: { previous: ProfileKey; current: ProfileKey }[];
    /** nur im alten Profil (bleiben) */
    kept: ProfileKey[];
  };
  epochs: {
    added: ProfileEpoch[];
    changed: { previous: ProfileEpoch; current: ProfileEpoch }[];
    /** nur im alten Profil (bleiben) */
    kept: ProfileEpoch[];
  };
}

export interface ProfilePlan {
  profile: AnchorProfile;
  diff: ProfileDiff | null;
  /** Kategorien mit Abweichungen, die nicht ausdrücklich angenommen wurden (dann nicht exportieren) */
  unaccepted: ChangeCategory[];
}

/** Abweichungen nicht angenommen: Export abgebrochen */
export class ProfileChangesError extends Error {
  constructor(readonly plan: ProfilePlan) {
    super('previous_changes_not_accepted');
  }
}

function epochOf(r: Parameters<typeof epochFromRow>[0]): ProfileEpoch {
  const e = epochFromRow(r);
  return {
    epoch: e.epoch,
    n: e.n,
    startedAt: e.startedAt,
    reason: e.reason,
    previousEpoch: e.previousEpoch,
    restoredSeq: e.restoredSeq,
    backupSha256: e.backupSha256 ?? null,
    backupCreatedAt: e.backupCreatedAt ?? null,
    preRestoreEpoch: e.preRestoreEpoch ?? null,
    preRestoreSeq: e.preRestoreSeq ?? null,
    preRestoreHash: e.preRestoreHash ?? null,
  };
}

const sameKey = (a: ProfileKey, b: ProfileKey) =>
  a.retired === b.retired &&
  (a.validFrom ? Date.parse(a.validFrom) : null) === (b.validFrom ? Date.parse(b.validFrom) : null) &&
  (a.validUntil ? Date.parse(a.validUntil) : null) === (b.validUntil ? Date.parse(b.validUntil) : null);

/**
 * Gleiche Angaben zu einer Epoche. Fehlen Angaben zur Wiederherstellung im alten Profil (ältere Profile),
 * gilt das bei einer Wiederherstellung als Abweichung (ausdrücklich annehmen); die erste Epoche hat keine.
 */
const sameEpoch = (a: ProfileEpoch, b: ProfileEpoch) => {
  const t = (v: string | null | undefined) => (v ? Date.parse(v) : v);
  const n = <T>(e: ProfileEpoch, v: T | undefined) => (v === undefined && e.reason === 'initial' ? null : v);
  return (
    a.n === b.n &&
    t(a.startedAt) === t(b.startedAt) &&
    a.reason === b.reason &&
    a.previousEpoch === b.previousEpoch &&
    a.restoredSeq === b.restoredSeq &&
    n(a, a.backupSha256) === n(b, b.backupSha256) &&
    t(n(a, a.backupCreatedAt)) === t(n(b, b.backupCreatedAt)) &&
    n(a, a.preRestoreEpoch) === n(b, b.preRestoreEpoch) &&
    n(a, a.preRestoreSeq) === n(b, b.preRestoreSeq) &&
    n(a, a.preRestoreHash) === n(b, b.preRestoreHash)
  );
};

/**
 * Plant das Profil aus dem heutigen Stand der Datenbank (vertrauenswürdige Partner, eigener
 * Schlüsselverlauf, Epochenverlauf). Mit `previous` (altes Profil): Abweichungen je Kategorie; nur
 * angenommene (`accept`) werden übernommen, sonst gilt das alte Profil und die Kategorie steht in
 * `unaccepted`. Mindestzahl: `minPartners`, sonst die des alten Profils, sonst 1.
 */
export async function planAnchorProfile(
  db: DbOrTx,
  opts: {
    nodeId: string;
    now: Date;
    minPartners?: number;
    previous?: AnchorProfile;
    accept?: Partial<Record<ChangeCategory, boolean>>;
  },
): Promise<ProfilePlan> {
  const prev = opts.previous;
  if (prev && prev.nodeId !== opts.nodeId) throw new ProfileError('previous_other_node');
  const accept = opts.accept ?? {};
  const rows = await db
    .selectFrom('peer')
    .select(['node_id', 'display_name', 'base_url', 'public_key', 'status'])
    .orderBy('node_id')
    .execute();
  const dbPartners: ProfilePartner[] = rows
    .filter((p) => p.status === 'trusted')
    .map((p) => ({
      nodeId: p.node_id,
      displayName: p.display_name,
      baseUrl: p.base_url,
      publicKey: p.public_key,
      fingerprint: fingerprint(p.public_key),
    }));
  const dbKeys = (await NodeIdentity.keyHistory(db)).map(keyFromWindow);
  const dbEpochs = (await db.selectFrom('audit_chain_epoch').selectAll().orderBy('n').execute()).map(epochOf);

  let partners = dbPartners;
  let keys = dbKeys;
  let epochs = dbEpochs;
  let diff: ProfileDiff | null = null;
  const unaccepted: ChangeCategory[] = [];
  if (prev) {
    // Partner
    const byNode = new Map(dbPartners.map((p) => [p.nodeId, p]));
    const prevNodes = new Set(prev.partners.map((p) => p.nodeId));
    const pd: ProfileDiff['partners'] = { added: [], removed: [], changed: [], renamed: [] };
    const kept: ProfilePartner[] = [];
    for (const p of prev.partners) {
      const cur = byNode.get(p.nodeId);
      if (!cur) {
        pd.removed.push({ ...p, dbStatus: rows.find((r) => r.node_id === p.nodeId)?.status ?? null });
        if (!accept.partners) kept.push(p);
        continue;
      }
      const fields: ('publicKey' | 'baseUrl')[] = [];
      if (cur.publicKey !== p.publicKey) fields.push('publicKey');
      if (cur.baseUrl !== p.baseUrl) fields.push('baseUrl');
      if (fields.length > 0) pd.changed.push({ nodeId: p.nodeId, fields, previous: p, current: cur });
      else if (cur.displayName !== p.displayName) {
        pd.renamed.push({ nodeId: p.nodeId, from: p.displayName, to: cur.displayName });
      }
      kept.push(fields.length > 0 && !accept.partners ? p : cur);
    }
    for (const p of dbPartners) {
      if (prevNodes.has(p.nodeId)) continue;
      pd.added.push(p);
      if (accept.partners) kept.push(p);
    }
    partners = kept.sort((x, y) => (x.nodeId < y.nodeId ? -1 : x.nodeId > y.nodeId ? 1 : 0));
    if ((pd.added.length || pd.removed.length || pd.changed.length) && !accept.partners) {
      unaccepted.push('partners');
    }

    // eigene Schlüssel
    const dbKeyMap = new Map(dbKeys.map((k) => [k.publicKey, k]));
    const kd: ProfileDiff['keys'] = { added: [], changed: [], kept: [] };
    const outKeys: ProfileKey[] = [];
    for (const k of prev.keys) {
      const cur = dbKeyMap.get(k.publicKey);
      if (!cur) {
        kd.kept.push(k);
        outKeys.push(k);
      } else if (!sameKey(k, cur)) {
        kd.changed.push({ previous: k, current: cur });
        outKeys.push(accept.keys ? cur : k);
      } else outKeys.push(k);
    }
    const prevKeys = new Set(prev.keys.map((k) => k.publicKey));
    for (const k of dbKeys) {
      if (prevKeys.has(k.publicKey)) continue;
      kd.added.push(k);
      if (accept.keys) outKeys.push(k);
    }
    keys = outKeys;
    if ((kd.added.length || kd.changed.length) && !accept.keys) unaccepted.push('keys');

    // Epochen
    const dbEpochMap = new Map(dbEpochs.map((e) => [e.epoch, e]));
    const ed: ProfileDiff['epochs'] = { added: [], changed: [], kept: [] };
    const outEpochs: ProfileEpoch[] = [];
    for (const e of prev.epochs) {
      const cur = dbEpochMap.get(e.epoch);
      if (!cur) {
        ed.kept.push(e);
        outEpochs.push(e);
      } else if (!sameEpoch(e, cur)) {
        ed.changed.push({ previous: e, current: cur });
        outEpochs.push(accept.epochs ? cur : e);
      } else outEpochs.push(e);
    }
    const prevEpochs = new Set(prev.epochs.map((e) => e.epoch));
    for (const e of dbEpochs) {
      if (prevEpochs.has(e.epoch)) continue;
      ed.added.push(e);
      if (accept.epochs) outEpochs.push(e);
    }
    epochs = outEpochs;
    if ((ed.added.length || ed.changed.length) && !accept.epochs) unaccepted.push('epochs');

    diff = {
      minPartners: { previous: prev.minPartners, next: opts.minPartners ?? prev.minPartners },
      partners: pd,
      keys: kd,
      epochs: ed,
    };
  }

  if (partners.length === 0) throw new ProfileError('no_trusted_partners');
  const minPartners = opts.minPartners ?? prev?.minPartners ?? 1;
  if (!Number.isInteger(minPartners) || minPartners < 1 || minPartners > partners.length) {
    throw new ProfileError('min_partners_out_of_range');
  }
  return {
    profile: {
      format: ANCHOR_PROFILE_FORMAT,
      nodeId: opts.nodeId,
      createdAt: opts.now.toISOString(),
      minPartners,
      keys,
      epochs,
      partners,
    },
    diff,
    unaccepted,
  };
}

/**
 * Erstellt das Profil (planAnchorProfile); mit `previous` nur, wenn alle Abweichungen ausdrücklich
 * angenommen sind (sonst ProfileChangesError mit dem Plan).
 */
export async function buildAnchorProfile(
  db: DbOrTx,
  opts: Parameters<typeof planAnchorProfile>[1],
): Promise<AnchorProfile> {
  const plan = await planAnchorProfile(db, opts);
  if (plan.unaccepted.length > 0) throw new ProfileChangesError(plan);
  return plan.profile;
}

/** Prüft Aufbau und innere Stimmigkeit (Fingerprints passen zu den Schlüsseln, Mindestzahl erreichbar) */
export function parseAnchorProfile(raw: unknown): AnchorProfile {
  const r = AnchorProfile.safeParse(raw);
  if (!r.success) throw new ProfileError('invalid_profile');
  const p = r.data;
  for (const k of [...p.keys, ...p.partners]) {
    if (normalizeFingerprint(fingerprint(k.publicKey)) !== normalizeFingerprint(k.fingerprint)) {
      throw new ProfileError('fingerprint_mismatch');
    }
  }
  if (new Set(p.partners.map((x) => x.nodeId)).size !== p.partners.length) {
    throw new ProfileError('duplicate_partner');
  }
  if (p.partners.some((x) => x.nodeId === p.nodeId)) throw new ProfileError('own_node_as_partner');
  if (p.minPartners > p.partners.length) throw new ProfileError('min_partners_out_of_range');
  return p;
}

export function loadAnchorProfile(file: string): LoadedProfile {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new ProfileError('profile_not_readable');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ProfileError('invalid_profile');
  }
  return { profile: parseAnchorProfile(raw), sha256: sha256Hex(bytes) };
}

/** Schlüsselzeiträume des Profils in der Form des Schlüsselverlaufs */
export function profileKeyWindows(p: AnchorProfile): OwnKeyWindow[] {
  return p.keys.map((k) => ({
    publicKey: k.publicKey,
    validFrom: k.validFrom ? new Date(k.validFrom) : null,
    validUntil: k.validUntil ? new Date(k.validUntil) : null,
    retired: k.retired,
  }));
}
