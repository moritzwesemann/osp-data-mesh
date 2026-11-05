/**
 * Befehle der Betriebs-CLI (siehe main.ts).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { buildDeps } from '../app.ts';
import { loadConfig } from '../config.ts';
import type { Actor } from '../core/audit.ts';
import { AuditWriter } from '../core/audit.ts';
import { randomToken, SecretBox, sha256Hex } from '../core/crypto.ts';
import { createDb, type Db, pgCode } from '../core/db.ts';
import { migrate } from '../core/migrate.ts';
import { NodeIdentity } from '../core/node-identity.ts';
import { tryAcquireNodeLock } from '../core/node-lock.ts';
import { recomputeAuditChain } from '../modules/audit/chain.ts';
import { passwordPolicyViolation } from '../modules/auth/policy.ts';
import { hashPassword } from '../modules/auth/sessions.ts';
import {
  type AnchorProfile,
  type LoadedProfile,
  loadAnchorProfile,
  type ProfileDiff,
  type ProfileEpoch,
  ProfileError,
  type ProfilePlan,
  planAnchorProfile,
} from '../modules/federation/anchor-profile.ts';
import {
  type AnchorFinding,
  type AnchorVerification,
  checkCheckpointExport,
  createCheckpoint,
  latestCheckpointExport,
  STALE_INTERVALS,
  verifyAnchors,
} from '../modules/federation/anchors.ts';
import { DEFAULT_GRACE_DAYS, MAX_GRACE_DAYS, rotateNodeKey } from '../modules/federation/keys.ts';
import { BackupManager } from '../modules/system/backup.ts';
import { BackupFileError } from '../modules/system/backup-file.ts';
import { resolvePsql, sanitizeToolOutput, splitDbUrl, toolEnv } from '../modules/system/pg-tools.ts';
import { restoreBackup, runningNodeConnections } from '../modules/system/restore.ts';

export class UsageError extends Error {}

export type Command = (args: string[]) => Promise<number>;

const CLI_ACTOR: Actor = { type: 'system', id: null, label: 'cli' };

/** Aufruf der CLI in Ausgaben (nativ; Docker: docker compose run --rm cli …) */
const MESH_CLI = 'bun --env-file=.env run cli';

/** Dokumentierter Aufruf der Migrationen (Server- und Owner-Umgebung, docs/installation.md) */
export const MIGRATE_COMMAND = 'bun --env-file=.env --env-file=.env.owner run cli migrate';
/** Entsprechender Schritt unter Docker Compose (im Verzeichnis deploy/; der Dienst migrate läuft auch bei jedem „up“) */
export const MIGRATE_COMMAND_DOCKER = 'docker compose run --rm migrate';

/** Nächster Schritt passend zur Installationsart (Container-Abbild setzt MESH_DEPLOYMENT=docker) */
export function migrateHint(env: Record<string, string | undefined> = process.env): string {
  return env.MESH_DEPLOYMENT === 'docker' ? MIGRATE_COMMAND_DOCKER : MIGRATE_COMMAND;
}
const ROOT = resolve(import.meta.dir, '../../..');

interface Parsed {
  flags: Record<string, string | true>;
  positionals: string[];
}

export function parseArgs(args: string[], booleans: readonly string[] = []): Parsed {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) flags[key] = a.slice(eq + 1);
    else if (booleans.includes(key)) flags[key] = true;
    else {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--'))
        throw new UsageError(`--${key} braucht einen Wert / needs a value`);
      flags[key] = v;
      i++;
    }
  }
  return { flags, positionals };
}

function flag(p: Parsed, name: string, required: true): string;
function flag(p: Parsed, name: string, required?: false): string | undefined;
function flag(p: Parsed, name: string, required = false): string | undefined {
  const v = p.flags[name];
  if (v === true) throw new UsageError(`--${name} braucht einen Wert / needs a value`);
  if (v === undefined && required) throw new UsageError(`--${name} fehlt / is required`);
  return v;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt / environment variable ${name} is not set`);
  return v;
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

async function withDb<T>(url: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const db = createDb(url, 2);
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

/** Exit-Codes von verify-audit --with-partners bzw. --checkpoint */
export const VERIFY_EXIT = { ok: 0, manipulated: 1, unanchored: 3, needs_review: 4 } as const;

function readProfile(file: string): LoadedProfile {
  try {
    return loadAnchorProfile(resolve(file));
  } catch (err) {
    if (err instanceof ProfileError) {
      throw new Error(`Anker-Profil unbrauchbar / anchoring profile unusable (${err.message}): ${file}`);
    }
    throw err;
  }
}

const BREAK_TEXT: Record<string, string> = {
  seq_gap: 'Laufnummer fehlt oder außer der Reihe / sequence gap',
  prev_hash_mismatch: 'Verweis auf den Vorgänger falsch / previous hash wrong',
  hash_mismatch: 'Inhalt passt nicht zum Hash, Eintrag geändert / content does not match its hash',
  unsequenced: 'Einträge ohne Laufnummer / entries without sequence number',
  not_a_table: 'audit_log ist keine gewöhnliche Tabelle oder hat Zeilensicherheit / not a plain table',
  column_changed:
    'Aufbau von audit_log verändert (Spaltentyp, NOT NULL oder Spalte fehlt) / audit_log columns altered',
  invalid_value: 'actor_type oder outcome mit unzulässigem Wert / actor_type or outcome not allowed',
  digest_version:
    'unbekannte oder zurückgesetzte Version der Hash-Eingabe / unknown or downgraded digest version',
};

function chainLine(local: {
  ok: boolean;
  checked: number;
  firstBrokenSeq: number | null;
  breakKind: string | null;
}) {
  return local.ok
    ? `Audit-Kette (im Programm neu berechnet) ok / chain (recomputed) ok: ${local.checked} Einträge / entries`
    : `Audit-Kette GEBROCHEN bei seq ${local.firstBrokenSeq} (${BREAK_TEXT[local.breakKind ?? ''] ?? local.breakKind}) / chain BROKEN`;
}

function findingText(f: AnchorFinding): string {
  const n = f.nodeId ?? '?';
  switch (f.code) {
    case 'insufficient_partners':
      return `nur ${f.count} von mindestens ${f.seq} Partnern bestätigen die Kette / only ${f.count} of ${f.seq} required partners confirm`;
    case 'partner_missing':
      return `Partner ${n} aus dem Profil hat nicht bestätigt (${f.detail}); ohne Begründung (--excuse … --reason …) nicht bestanden / profile partner did not confirm`;
    case 'partner_excused':
      return `Partner ${n} entschuldigt / excused: ${f.detail ?? ''}`;
    case 'partner_not_trusted_in_database':
      return `Partner ${n} ist in der Datenbank nicht vertrauenswürdig (${f.detail}) – Partnerliste verändert? Klären / not trusted in the database: clarify`;
    case 'partner_differs_from_database':
      return `Partner ${n}: ${f.detail} in der Datenbank weicht vom Profil ab – Manipulation oder Schlüsselwechsel/Umzug des Partners; klären, dann Profil neu exportieren / differs from the profile`;
    case 'epoch_not_in_profile':
      return `Epoche ${f.epoch}${f.seq !== undefined ? ` (Wiederherstellung, übernommen bis seq ${f.seq}${f.detail ? `, ${f.detail}` : ''})` : ''} steht nicht im Profil – mit dem Protokoll der Wiederherstellung abgleichen; ohne Wiederherstellung: Manipulation / epoch not documented in the profile`;
    case 'epoch_conflict':
      return `Epoche ${f.epoch}: Datenbank und Profil widersprechen sich / database and profile disagree`;
    case 'restore_epoch':
      return `Wiederherstellung / restore: Epoche ${f.epoch} seit ${f.detail ?? '?'}, übernommen bis seq ${f.seq ?? '?'}`;
    case 'lost_by_restore':
      if (f.severity === 'fail') {
        return `${f.count} Prüfpunkt(e) bei ${n} wären durch eine im Profil NICHT dokumentierte Wiederherstellung verloren – gilt als Abschneiden. Echte Wiederherstellung: mit ihrem Protokoll (Prüfsumme der Sicherung, Kopf davor) abgleichen und das Profil mit --previous … --accept-epochs neu exportieren / lost by a restore the profile does not document: treated as truncation`;
      }
      return `${f.count} Prüfpunkt(e) bei ${n} durch Wiederherstellung verloren (frühere Epoche, nach der übernommenen Laufnummer)${f.severity === 'info' ? ', im Profil dokumentiert' : ''} / lost by restore`;
    case 'unknown_epoch':
      return `${f.count} Prüfpunkt(e) bei ${n} mit unbekannter Epoche – Profil mit --previous ergänzen oder klären / unknown epoch`;
    case 'inconclusive':
      return `${f.count} Abweichung(en) bei ${n}, signiert mit einem als kompromittiert abgelösten Schlüssel – kein Beweis, klären / signed by a compromised key: not conclusive`;
    case 'anchor_stale':
      return `Jüngster von Partnern bestätigter Prüfpunkt (seq ${f.seq ?? '?'}, ${f.detail ?? '?'}) ist älter als das ${STALE_INTERVALS}-fache Intervall; ${f.count ?? 0} Einträge danach sind nicht verankert und könnten unbemerkt geändert oder gelöscht sein. Planer und Zustellung prüfen (Knoten lief lange nicht? audit-checkpoint), dann erneut prüfen / newest confirmed checkpoint is stale`;
    case 'legacy_digest_ambiguous':
      return `${f.count} alte Einträge (Hash-Version 1) enthalten „|“ in einem Feld: dort ist eine Verschiebung zwischen benachbarten Feldern nicht erkennbar (Restrisiko, ADR 0006) / legacy entries with ambiguous field boundaries`;
  }
}

function anchoringLine(a: AnchorVerification['anchoring']): string {
  const last =
    a.lastAnchoredSeq === null
      ? 'kein bestätigter Prüfpunkt / no confirmed checkpoint'
      : `bis seq ${a.lastAnchoredSeq} (${a.lastAnchoredAt ?? '?'})`;
  return `Verankert / anchored: ${last}; ${a.unanchoredEntries} Einträge danach noch nicht verankert / entries not yet anchored${a.staleAfterHours === null ? ' (kein Planer / no schedule)' : ''}`;
}

function keyLine(k: AnchorProfile['keys'][number]): string {
  return `Fingerprint ${k.fingerprint}: ${k.validFrom ?? 'Anfang / start'} … ${k.validUntil ?? 'heute / now'}${k.retired ? ` (${k.retired === 'compromised' ? 'kompromittiert / compromised' : 'planmäßig abgelöst / rotated'})` : ''}`;
}

function epochLine(e: ProfileEpoch): string {
  if (e.reason === 'initial') {
    return `${e.epoch}: erste / initial${e.startedAt ? `, seit / since ${e.startedAt}` : ''}`;
  }
  const backup =
    e.backupSha256 === undefined
      ? 'Sicherung nicht festgehalten / backup not recorded'
      : `Sicherung / backup SHA-256 ${e.backupSha256 ?? '?'} vom / of ${e.backupCreatedAt ?? '?'}`;
  const head =
    e.preRestoreSeq === undefined || e.preRestoreSeq === null
      ? 'Kopf davor unbekannt / head before unknown'
      : `Kopf davor / head before: Epoche ${e.preRestoreEpoch ?? '?'} seq ${e.preRestoreSeq} hash ${e.preRestoreHash ?? '?'}`;
  return `${e.epoch}: Wiederherstellung / restore${e.startedAt ? ` am / on ${e.startedAt}` : ''}, übernommen bis / restored up to seq ${e.restoredSeq}; ${backup}; ${head}`;
}

/** Abweichungen vom alten Profil, je Kategorie mit Hinweis, ob angenommen */
function profileDiffLines(d: ProfileDiff, accept: Record<'partners' | 'keys' | 'epochs', boolean>): string[] {
  const lines: string[] = [];
  const state = (c: 'partners' | 'keys' | 'epochs') =>
    accept[c] ? 'angenommen / accepted' : 'NICHT angenommen / NOT accepted';
  if (d.minPartners.previous !== d.minPartners.next) {
    lines.push(`Mindestzahl / minimum: ${d.minPartners.previous} → ${d.minPartners.next} (--min-partners)`);
  } else lines.push(`Mindestzahl bleibt / minimum kept: ${d.minPartners.next}`);
  const pd = d.partners;
  if (pd.added.length || pd.removed.length || pd.changed.length) {
    lines.push(`Partner geändert / partner changes (${state('partners')}):`);
    for (const x of pd.removed)
      lines.push(
        `  - entfernt / removed: ${x.nodeId} (in der Datenbank / in the database: ${x.dbStatus ?? 'fehlt / missing'}), Fingerprint ${x.fingerprint}`,
      );
    for (const x of pd.added)
      lines.push(`  + neu / added: ${x.nodeId} (${x.displayName}) ${x.baseUrl} Fingerprint ${x.fingerprint}`);
    for (const x of pd.changed) {
      const parts = x.fields.map((f) =>
        f === 'publicKey'
          ? `Fingerprint ${x.previous.fingerprint} → ${x.current.fingerprint}`
          : `Adresse / address ${x.previous.baseUrl} → ${x.current.baseUrl}`,
      );
      lines.push(`  ~ geändert / changed: ${x.nodeId}: ${parts.join(', ')}`);
    }
  }
  for (const x of pd.renamed) lines.push(`Anzeigename / display name ${x.nodeId}: ${x.from} → ${x.to}`);
  const kd = d.keys;
  if (kd.added.length || kd.changed.length) {
    lines.push(`Eigene Schlüssel geändert / own key changes (${state('keys')}):`);
    for (const k of kd.added) lines.push(`  + neu / added: ${keyLine(k)}`);
    for (const k of kd.changed) {
      lines.push(`  ~ geändert / changed: ${keyLine(k.current)}`);
      lines.push(`      bisher / previously: ${keyLine(k.previous)}`);
    }
  }
  for (const k of kd.kept)
    lines.push(`Schlüssel nur im alten Profil, bleibt / kept from previous: ${k.fingerprint}`);
  const ed = d.epochs;
  if (ed.added.length || ed.changed.length) {
    lines.push(`Epochen geändert / epoch changes (${state('epochs')}):`);
    for (const e of ed.added) lines.push(`  + neu / added: ${epochLine(e)}`);
    for (const e of ed.changed) {
      lines.push(`  ~ geändert / changed: ${epochLine(e.current)}`);
      lines.push(`      bisher / previously: ${epochLine(e.previous)}`);
    }
  }
  for (const e of ed.kept) lines.push(`Epoche nur im alten Profil, bleibt / kept from previous: ${e.epoch}`);
  return lines;
}

/** Zusammenfassung der Abweichungen für das Audit-Log (Fingerprints, keine Schlüssel) */
function diffSummary(d: ProfileDiff) {
  return {
    minPartners: d.minPartners,
    partnersAdded: d.partners.added.map((x) => x.nodeId),
    partnersRemoved: d.partners.removed.map((x) => x.nodeId),
    partnersChanged: d.partners.changed.map((x) => ({ nodeId: x.nodeId, fields: x.fields })),
    keysAdded: d.keys.added.map((k) => k.fingerprint),
    keysChanged: d.keys.changed.map((k) => k.current.fingerprint),
    epochsAdded: d.epochs.added.map((e) => e.epoch),
    epochsChanged: d.epochs.changed.map((e) => e.current.epoch),
  };
}

const PROBLEM_TEXT: Record<string, string> = {
  missing: 'fehlt, Kette abgeschnitten / missing, truncated',
  hash_mismatch: 'Hash abweichend, umgeschrieben / hash differs, rewritten',
  beyond_pre_restore:
    'hinter dem vor der Wiederherstellung festgehaltenen Kopf / beyond the head recorded before the restore',
  lost_by_restore: 'durch nicht dokumentierte Wiederherstellung verloren / lost by an undocumented restore',
};

function partnerLine(p: AnchorVerification['partners'][number]): string {
  const problem = p.firstProblem
    ? ` – erste Abweichung / first mismatch: seq ${p.firstProblem.seq} (${PROBLEM_TEXT[p.firstProblem.kind] ?? p.firstProblem.kind}), ${p.problems} insgesamt / total`
    : '';
  const code = p.errorCode ? ` (${p.errorCode})` : '';
  const extra = [
    p.lostByRestore ? `${p.lostByRestore} verloren durch Wiederherstellung / lost by restore` : '',
    p.inconclusive ? `${p.inconclusive} nicht beweiskräftig / inconclusive` : '',
    p.unknownEpoch ? `${p.unknownEpoch} unbekannte Epoche / unknown epoch` : '',
    p.invalidSignatures
      ? `${p.invalidSignatures} ungültig signiert oder unbekannter Schlüssel / invalid signature or unknown key`
      : '',
    p.excused ? 'entschuldigt / excused' : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `  ${p.nodeId} [Fingerprint ${p.fingerprint}]: ${p.status}${code}, ${p.checkpoints} Prüfpunkte / checkpoints, ${p.matched} bestätigt / confirmed, letzter / latest seq ${p.latestSeq ?? '–'}${problem}${extra ? `; ${extra}` : ''}`;
}

/**
 * Prüfung mit den bei Partnern verwahrten Prüfpunkten. Mit --profile unabhängig von der Datenbank (Partner,
 * Adressen, Schlüssel nur aus dem Profil). Exit 0 ok, 1 Manipulation, 3 nicht ausreichend verankert,
 * 4 Klärung nötig.
 */
async function verifyWithPartners(p: Parsed): Promise<number> {
  const profileFile = flag(p, 'profile');
  const excuseRaw = flag(p, 'excuse');
  const reason = flag(p, 'reason')?.trim();
  const profile = profileFile ? readProfile(profileFile) : undefined;
  if (excuseRaw && !profile) throw new UsageError('--excuse nur mit --profile / --excuse requires --profile');
  if (excuseRaw && (!reason || reason.length < 3)) {
    throw new UsageError('--excuse braucht eine Begründung mit --reason "…" / --excuse requires --reason');
  }
  const excused = excuseRaw
    ? excuseRaw
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
  for (const id of excused) {
    if (!profile?.profile.partners.some((x) => x.nodeId === id)) {
      throw new UsageError(`--excuse: ${id} steht nicht im Profil / is not a partner in the profile`);
    }
  }
  const config = loadConfig();
  if (profile && profile.profile.nodeId !== config.MESH_NODE_ID) {
    throw new Error(
      `Profil gehört zu Knoten ${profile.profile.nodeId}, dieser ist ${config.MESH_NODE_ID} / profile belongs to another node`,
    );
  }
  const deps = await buildDeps({ config });
  try {
    const r = await verifyAnchors(
      deps,
      { actor: CLI_ACTOR },
      { profile, excuse: excused.length ? { nodeIds: excused, reason: reason ?? '' } : undefined },
    );
    if (profile) {
      out(
        `Quelle der Partner / source of partners: Anker-Profil / anchoring profile ${resolve(profileFile ?? '')}` +
          ` (erstellt / created ${profile.profile.createdAt}, mindestens / at least ${profile.profile.minPartners} Partner)`,
      );
      out(
        `  SHA-256 des Profils / of the profile: ${profile.sha256} – mit dem bei der Ablage notierten Wert vergleichen / compare with the recorded value`,
      );
    } else {
      out(
        'Quelle der Partner / source of partners: Datenbank – NICHT UNABHÄNGIG: Partnerliste, Adressen, ' +
          'Partnerschlüssel und frühere eigene Schlüssel stammen aus der geprüften Datenbank. Unabhängige ' +
          'Prüfung mit --profile <datei> (audit-anchor-profile) / partners and keys come from the database ' +
          'being checked: NOT independent of it; use --profile for an independent check',
      );
    }
    out(`${chainLine(r.local)}, Kopf / head seq ${r.local.headSeq ?? '–'}`);
    out(anchoringLine(r.anchoring));
    out(`Epoche / epoch: ${r.epoch.current}`);
    for (const partner of r.partners) out(partnerLine(partner));
    if (r.partners.length === 0) out('  keine Partner / no partners');
    if (r.findings.length > 0) {
      out('Hinweise / findings:');
      const mark = { fail: '!!', review: '! ', info: '  ' } as const;
      for (const f of r.findings) out(`  ${mark[f.severity]} ${findingText(f)}`);
    }
    const verdict = {
      ok: `VERANKERT UND INTAKT / anchored and intact (${r.anchoredPartners} Partner)`,
      manipulated: 'MANIPULATION ERKANNT (abgeschnitten, umgeschrieben oder gebrochen) / TAMPERING DETECTED',
      unanchored: `NICHT VERANKERT: ${r.anchoredPartners} von mindestens ${r.requiredPartners} Partnern bestätigen die Kette / NOT ANCHORED`,
      needs_review:
        'KLÄRUNG NÖTIG: Hinweise oben erklären und dokumentieren / NEEDS REVIEW: explain the findings above',
    }[r.result];
    out(`Ergebnis / result: ${verdict}${r.independent ? '' : ' (nicht unabhängig / not independent)'}`);
    return VERIFY_EXIT[r.result];
  } finally {
    await deps.db.destroy();
  }
}

/** Prüfung gegen einen exportierten Prüfpunkt (Verankerung außerhalb des Netzes) */
async function verifyAgainstExport(file: string, profileFile?: string): Promise<number> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
  } catch {
    throw new Error(`Datei nicht lesbar oder kein JSON / file not readable or not JSON: ${file}`);
  }
  const profile = profileFile ? readProfile(profileFile) : undefined;
  const nodeId = env('MESH_NODE_ID');
  const url = process.env.MESH_DB_URL ?? env('MESH_DB_OWNER_URL');
  const check = await withDb(url, (db) => checkCheckpointExport(db, nodeId, raw, { profile }));
  const fp = (raw as { fingerprint?: unknown })?.fingerprint;
  out(
    `Signatur / signature: ${check.signatureValid ? 'gültig / valid' : 'UNGÜLTIG / INVALID'}${typeof fp === 'string' ? ` (Fingerprint ${fp})` : ''}`,
  );
  out(
    `Schlüssel dieses Knotens zum Zeitpunkt / key of this node at that time${profile ? ' (laut Profil / per profile)' : ''}: ${check.keyKnown ? 'ja / yes' : 'NEIN / NO'}${check.keyCompromised ? ' – als kompromittiert abgelöst / retired as compromised' : ''}`,
  );
  out(`Knoten / node: ${check.nodeMatches ? 'passt / matches' : 'FALSCH / WRONG'}`);
  const localText: Record<string, string> = {
    match: 'vorhanden, Hash gleich / present, same hash',
    missing: 'FEHLT (abgeschnitten) / MISSING (truncated)',
    hash_mismatch: 'HASH ABWEICHEND (umgeschrieben) / HASH DIFFERS (rewritten)',
    lost_by_restore:
      'durch eine Wiederherstellung verloren (frühere Epoche) – klären / lost by a restore (earlier epoch): review',
    unknown_epoch: 'Epoche unbekannt – klären / unknown epoch: review',
    inconclusive:
      'abweichend, aber Schlüssel kompromittiert – kein Beweis / differs, but key compromised: not conclusive',
  };
  out(
    `Prüfpunkt seq ${check.seq ?? '?'}${check.epoch ? ` (Epoche ${check.epoch})` : ''} in der lokalen Kette / in local chain: ${check.local ? (localText[check.local] ?? check.local) : '?'}`,
  );
  out(chainLine(check.chain));
  out(
    'Den Fingerprint mit dem außerhalb des Systems notierten Wert vergleichen / compare the fingerprint with the value recorded outside the system.',
  );
  if (check.ok) return VERIFY_EXIT.ok;
  const review =
    check.local === 'lost_by_restore' || check.local === 'unknown_epoch' || check.local === 'inconclusive';
  return review && check.chain.ok && check.signatureValid && check.keyKnown && check.nodeMatches
    ? VERIFY_EXIT.needs_review
    : VERIFY_EXIT.manipulated;
}

/**
 * Datenbanken anderer Knoten im Cluster: Eigentümer mesh_owner, nicht die Zieldatenbank. Leer, wenn es
 * die Rolle noch nicht gibt.
 */
export async function otherNodeDatabases(superuserUrl: string, dbName: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: superuserUrl, application_name: 'osp-data-mesh-cli' });
  await client.connect();
  try {
    const r = await client.query<{ datname: string }>(
      `select d.datname from pg_database d join pg_roles r on r.oid = d.datdba
        where r.rolname = 'mesh_owner' and d.datname <> $1 order by d.datname`,
      [dbName],
    );
    return r.rows.map((row) => row.datname);
  } finally {
    await client.end();
  }
}

/** Bereits vorhandene Rollen mesh_owner/mesh_app/mesh_bi im Cluster */
async function existingMeshRoles(superuserUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: superuserUrl, application_name: 'osp-data-mesh-cli' });
  await client.connect();
  try {
    const r = await client.query<{ rolname: string }>(
      `select rolname from pg_roles where rolname in ('mesh_owner', 'mesh_app', 'mesh_bi') order by rolname`,
    );
    return r.rows.map((row) => row.rolname);
  } finally {
    await client.end();
  }
}

/** Wert für psql "\set name '…'" (einfache Anführungszeichen, Backslash-Escapes) */
function psqlQuote(v: string): string {
  if (/[\r\n\0]/.test(v)) throw new Error('value must not contain line breaks');
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

export const commands: Record<string, Command> = {
  async migrate() {
    const url = env('MESH_DB_OWNER_URL');
    const r = await migrate(url, { log: (m) => out(m) });
    out(`angewandt / applied: ${r.applied.length ? r.applied.join(', ') : '–'}`);
    out(`bereits vorhanden / skipped: ${r.skipped.length}`);
    return 0;
  },

  async 'db-bootstrap'(args) {
    const p = parseArgs(args, ['force', 'rotate-passwords']);
    const rotate = p.flags['rotate-passwords'] === true;
    // Superuser-URL bevorzugt aus der Umgebung (Passwort nicht auf der Kommandozeile bzw. in der Ausgabe von bun run)
    const superuserUrl = flag(p, 'superuser-url') ?? process.env.MESH_DB_SUPERUSER_URL;
    if (!superuserUrl) {
      throw new UsageError(
        'MESH_DB_SUPERUSER_URL oder --superuser-url fehlt / MESH_DB_SUPERUSER_URL or --superuser-url is required',
      );
    }
    const dbName = flag(p, 'db') ?? 'mesh';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(dbName))
      throw new UsageError('--db: nur a-z, 0-9, _ / only a-z, 0-9, _');
    const missing = ['MESH_DB_OWNER_PASSWORD', 'MESH_DB_APP_PASSWORD', 'MESH_DB_BI_PASSWORD'].filter(
      (k) => !process.env[k],
    );
    if (missing.length)
      throw new Error(`Umgebungsvariablen fehlen / missing environment: ${missing.join(', ')}`);
    // Die Rollen gelten clusterweit: ein zweiter Knoten im selben Cluster überschriebe ihre Passwörter und
    // teilte sie mit dem ersten. Erneuter Aufruf für dieselbe Datenbank bleibt möglich (idempotent).
    const others = await otherNodeDatabases(superuserUrl, dbName);
    if (others.length > 0 && p.flags.force !== true) {
      throw new Error(
        `Der Cluster enthält bereits Datenbanken von mesh_owner (${others.join(', ')}). Ein PostgreSQL-Cluster je Knoten: ` +
          'die Rollen mesh_owner, mesh_app und mesh_bi gelten clusterweit, ihre Passwörter würden überschrieben. ' +
          'Eigenen Cluster verwenden oder bewusst mit --force fortfahren / ' +
          `the cluster already contains databases owned by mesh_owner (${others.join(', ')}): ` +
          'one PostgreSQL cluster per node (roles are cluster-wide); use a separate cluster or --force',
      );
    }
    const existingRoles = await existingMeshRoles(superuserUrl);
    // Passwörter über stdin (nicht als Argumente, sonst in der Prozessliste sichtbar)
    const script = [
      `\\set db_name ${psqlQuote(dbName)}`,
      `\\set owner_password ${psqlQuote(env('MESH_DB_OWNER_PASSWORD'))}`,
      `\\set app_password ${psqlQuote(env('MESH_DB_APP_PASSWORD'))}`,
      `\\set bi_password ${psqlQuote(env('MESH_DB_BI_PASSWORD'))}`,
      `\\set rotate_passwords ${rotate ? 'true' : 'false'}`,
      `\\i ${psqlQuote(resolve(ROOT, 'deploy/postgres/bootstrap.sql'))}`,
      '',
    ].join('\n');
    const { url, env: pgEnv } = splitDbUrl(superuserUrl);
    const proc = Bun.spawn(
      [resolvePsql(), '-q', '-X', '-v', 'ON_ERROR_STOP=1', `--dbname=${url}`, '-f', '-'],
      {
        stdin: Buffer.from(script),
        stdout: 'pipe',
        stderr: 'pipe',
        env: toolEnv(pgEnv),
      },
    );
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`psql failed (exit ${code}): ${sanitizeToolOutput(stderr)}`);
    out(`Datenbank "${dbName}" und Rollen mesh_owner, mesh_app, mesh_bi eingerichtet / bootstrapped.`);
    if (existingRoles.length > 0 && !rotate) {
      out(
        `Hinweis: Rollen existierten bereits (${existingRoles.join(', ')}); ihre Passwörter wurden NICHT geändert ` +
          '(ändern mit --rotate-passwords) / roles already existed; passwords were NOT changed (use --rotate-passwords)',
      );
    }
    out(`Weiter / next: ${migrateHint()}`);
    return 0;
  },

  async 'gen-key'() {
    out(randomBytes(32).toString('base64'));
    return 0;
  },

  async 'create-admin'(args) {
    const p = parseArgs(args);
    const emailRaw = flag(p, 'email', true);
    const name = flag(p, 'name', true).trim();
    const email = z.email().max(254).safeParse(emailRaw.trim().toLowerCase());
    if (!email.success)
      throw new UsageError('--email ist keine gültige E-Mail-Adresse / is not a valid email');
    if (!name || name.length > 200) throw new UsageError('--name: 1–200 Zeichen / characters');
    const dbUrl = env('MESH_DB_URL');
    const provided = process.env.MESH_ADMIN_PASSWORD;
    const password = provided ?? randomToken(18);
    if (provided) {
      const violation = passwordPolicyViolation(provided, { email: email.data });
      if (violation)
        throw new Error(`MESH_ADMIN_PASSWORD erfüllt die Passwortregeln nicht / too weak (${violation})`);
    }
    const hash = await hashPassword(password);
    const id = await withDb(dbUrl, async (db) => {
      try {
        return await db.transaction().execute(async (trx) => {
          const row = await trx
            .insertInto('app_user')
            .values({
              email: email.data,
              display_name: name,
              password_hash: hash,
              roles: ['admin'],
              must_change_password: !provided,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await new AuditWriter(trx).record({
            actor: CLI_ACTOR,
            action: 'user.create',
            objectType: 'user',
            objectId: row.id,
            details: { roles: ['admin'], via: 'cli' },
          });
          return row.id;
        });
      } catch (err) {
        if (pgCode(err) === '23505')
          throw new Error(`E-Mail existiert bereits / email already exists: ${email.data}`);
        throw err;
      }
    });
    out(`Administrator angelegt / admin created: ${email.data} (${id})`);
    if (!provided) {
      out(`Initialpasswort (nur jetzt sichtbar) / initial password (shown once): ${password}`);
      out('Das Passwort muss bei der ersten Anmeldung geändert werden / must be changed at first login.');
    }
    return 0;
  },

  async backup() {
    const config = loadConfig();
    const deps = await buildDeps({ config });
    try {
      const run = await new BackupManager(deps).runBackup('cli', null);
      out(`Sicherung erstellt / backup created: ${resolve(config.MESH_BACKUP_DIR, run.fileName ?? '')}`);
      out(`  Größe / size: ${run.sizeBytes} bytes, sha256: ${run.sha256}`);
      return 0;
    } catch (err) {
      const reason = (err as { reason?: string }).reason;
      throw new Error(`Sicherung fehlgeschlagen / backup failed${reason ? ` (${reason})` : ''}`);
    } finally {
      await deps.db.destroy();
    }
  },

  async restore(args) {
    const p = parseArgs(args, ['yes', 'allow-other-node', 'force']);
    const file = flag(p, 'file', true);
    if (p.flags.yes !== true) {
      throw new UsageError(
        'restore überschreibt die Datenbank; Knoten stoppen und mit --yes bestätigen / overwrites the database; stop the node and confirm with --yes',
      );
    }
    const ownerUrl = env('MESH_DB_OWNER_URL');
    const backupKey = env('MESH_BACKUP_KEY');
    const nodeId = env('MESH_NODE_ID');
    // Knotensperre: hält ein laufender Server sie, wird nicht wiederhergestellt; während der Wiederherstellung
    // hält die CLI sie selbst, sodass auch kein Server starten kann.
    const nodeLock = await tryAcquireNodeLock(ownerUrl, 'osp-data-mesh-restore');
    if (!nodeLock && p.flags.force !== true) {
      throw new Error(
        'Der Knoten läuft noch (Knotensperre gehalten) oder eine andere Wiederherstellung läuft. Knoten stoppen und ' +
          'erneut aufrufen; --force übergeht diese Prüfung / the node is still running (node lock held) or another ' +
          'restore is in progress: stop it first, or use --force',
      );
    }
    const running = await runningNodeConnections(ownerUrl);
    if (running > 0 && p.flags.force !== true) {
      await nodeLock?.release();
      throw new Error(
        `Der Knoten läuft noch (${running} Verbindung(en) des Servers zu dieser Datenbank). Knoten stoppen und ` +
          'erneut aufrufen; --force übergeht diese Prüfung / ' +
          `the node is still running (${running} server connection(s) to this database): stop it first, or use --force`,
      );
    }
    try {
      const r = await restoreBackup({
        file: resolve(file),
        ownerUrl,
        backupKey,
        expectedNodeId: nodeId,
        allowOtherNode: p.flags['allow-other-node'] === true,
        log: (m) => out(`  ${m}`),
      });
      out(`Wiederhergestellt / restored: ${r.fileName}`);
      out(
        `  Knoten / node: ${r.nodeId}, erstellt / created: ${r.createdAt}, Schema: ${r.schemaVersion ?? '?'}`,
      );
      out(`  Manifest geprüft / verified: ${r.manifestVerified ? 'ja/yes' : 'nein/no (keine Begleitdatei)'}`);
      out(`  Sitzungen beendet / sessions ended: ${r.sessionsEnded}`);
      out(
        `  Audit-Kette (im Programm neu berechnet) / audit chain (recomputed): ${r.audit.ok ? 'ok' : `GEBROCHEN bei / BROKEN at seq ${r.audit.firstBrokenSeq}${r.audit.breakKind ? ` (${BREAK_TEXT[r.audit.breakKind] ?? r.audit.breakKind})` : ''}`} (${r.audit.checked} geprüft / checked)` +
          `; audit_verify() der Datenbank / of the database: ${r.audit.database.ok ? 'ok' : `seq ${r.audit.database.firstBrokenSeq}`}`,
      );
      out(`  Sicherung / backup SHA-256: ${r.sha256}, erstellt / created ${r.createdAt}`);
      out(
        `  Kopf vor der Wiederherstellung / head before the restore: ${r.preRestore ? `Epoche ${r.preRestore.epoch ?? '?'} seq ${r.preRestore.seq} hash ${r.preRestore.hash}` : 'keiner / none (leere Datenbank / empty database)'}`,
      );
      if (r.epoch) {
        out(
          `  Neue Epoche der Audit-Kette / new audit chain epoch: ${r.epoch.epoch} (übernommen bis / restored up to seq ${r.epoch.restoredSeq}, vorige / previous ${r.epoch.previousEpoch ?? '–'})`,
        );
        out(
          '  Diese Angaben ins Protokoll der Wiederherstellung übernehmen; beim Neuexport des Anker-Profils ' +
            '(--accept-epochs) werden sie damit abgeglichen / record these values; they are compared when ' +
            're-exporting the anchoring profile',
        );
        out(
          '  Prüfpunkte bei Partnern nach seq ' +
            `${r.epoch.restoredSeq} sind damit verloren (verify-audit meldet „Klärung nötig“, mit dem alten Profil ` +
            '„Manipulation“, bis die Wiederherstellung im Profil dokumentiert ist). Wiederherstellung dokumentieren und ' +
            `das Anker-Profil neu exportieren: ${MESH_CLI} audit-anchor-profile --out <datei> --previous <altes-profil> ` +
            '--accept-epochs / document the restore and re-export the anchoring profile',
        );
      }
      out(
        `Weiter / next: ${migrateHint()}, Knoten starten / start node, BI-Views neu aufbauen / refresh BI views.`,
      );
      return r.audit.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof BackupFileError) throw new Error(`${err.code}: ${err.message}`);
      throw err;
    } finally {
      await nodeLock?.release();
    }
  },

  async 'verify-audit'(args) {
    const p = parseArgs(args, ['with-partners']);
    const file = flag(p, 'checkpoint');
    if (p.flags['with-partners'] === true) return verifyWithPartners(p);
    if (flag(p, 'excuse') || flag(p, 'reason')) {
      throw new UsageError('--excuse/--reason nur mit --with-partners / only with --with-partners');
    }
    if (file) return verifyAgainstExport(file, flag(p, 'profile'));
    if (flag(p, 'profile')) {
      throw new UsageError(
        '--profile nur mit --with-partners oder --checkpoint / only with --with-partners or --checkpoint',
      );
    }
    const url = process.env.MESH_DB_URL ?? env('MESH_DB_OWNER_URL');
    // im Programm neu berechnet (nicht audit_verify() der Datenbank, die deren Eigentümer ersetzen kann)
    const r = await withDb(url, (db) => recomputeAuditChain(db));
    if (r.ok)
      out(
        `Audit-Kette ok / audit chain ok (${r.checked} Einträge / entries, im Programm neu berechnet / recomputed)`,
      );
    else
      out(
        `Audit-Kette GEBROCHEN bei seq ${r.firstBrokenSeq} (${BREAK_TEXT[r.breakKind ?? ''] ?? r.breakKind}) / audit chain BROKEN (${r.checked} ok davor / before)`,
      );
    if (r.ok) {
      out(
        'Hinweis: prüft nur die innere Konsistenz; Abschneiden/Umschreiben durch den Datenbank-Eigentümer erkennt ' +
          '--with-partners / note: checks internal consistency only; use --with-partners to detect truncation/rewriting',
      );
    }
    return r.ok ? 0 : 1;
  },

  async 'audit-checkpoint'(args) {
    const p = parseArgs(args);
    const file = flag(p, 'out');
    const config = loadConfig();
    const deps = await buildDeps({ config });
    try {
      const r = await createCheckpoint(deps, 'cli', { actor: CLI_ACTOR });
      out(
        `${r.created ? 'Prüfpunkt erstellt / checkpoint created' : 'Prüfpunkt bestand bereits / checkpoint already existed'}: ` +
          `seq ${r.checkpoint.seq}, hash ${r.checkpoint.hash}, Epoche / epoch ${r.checkpoint.epoch}`,
      );
      if (r.created) {
        out(
          `  an ${r.checkpoint.peers} Partner im Ausgangspostfach (Zustellung durch den laufenden Knoten) / ` +
            `queued for ${r.checkpoint.peers} partner(s), delivered by the running node`,
        );
      }
      const exp = await latestCheckpointExport(deps);
      const json = `${JSON.stringify(exp, null, 2)}\n`;
      if (file) {
        writeFileSync(resolve(file), json, { mode: 0o644 });
        out(`  exportiert / exported: ${resolve(file)} (Fingerprint ${exp.fingerprint})`);
      } else out(json.trimEnd());
      return 0;
    } finally {
      await deps.db.destroy();
    }
  },

  async 'audit-anchor-profile'(args) {
    const p = parseArgs(args, ['accept-partner-changes', 'accept-key-changes', 'accept-epochs']);
    const file = flag(p, 'out', true);
    const minRaw = flag(p, 'min-partners');
    const minPartners = minRaw === undefined ? undefined : Number(minRaw);
    if (minPartners !== undefined && (!Number.isInteger(minPartners) || minPartners < 1)) {
      throw new UsageError('--min-partners: ganze Zahl ≥ 1 / integer ≥ 1');
    }
    const previousFile = flag(p, 'previous');
    const accept = {
      partners: p.flags['accept-partner-changes'] === true,
      keys: p.flags['accept-key-changes'] === true,
      epochs: p.flags['accept-epochs'] === true,
    };
    if (!previousFile && (accept.partners || accept.keys || accept.epochs)) {
      throw new UsageError('--accept-… nur mit --previous / --accept-… requires --previous');
    }
    const previous = previousFile ? readProfile(previousFile) : undefined;
    const config = loadConfig();
    const deps = await buildDeps({ config });
    try {
      let plan: ProfilePlan;
      try {
        plan = await planAnchorProfile(deps.db, {
          nodeId: deps.identity.nodeId,
          now: deps.now(),
          minPartners,
          previous: previous?.profile,
          accept,
        });
      } catch (err) {
        if (err instanceof ProfileError) {
          const text: Record<string, string> = {
            no_trusted_partners: 'keine vertrauenswürdigen Partner / no trusted partners',
            min_partners_out_of_range:
              'Mindestzahl der Partner (--min-partners bzw. aus dem alten Profil) größer als die Zahl der Partner; ' +
              'ausdrücklich mit --min-partners festlegen / minimum exceeds the number of partners: set --min-partners',
            previous_other_node: '--previous gehört zu einem anderen Knoten / belongs to another node',
          };
          throw new UsageError(text[err.message] ?? err.message);
        }
        throw err;
      }
      const { profile, diff } = plan;
      if (diff && previous) {
        out(
          `Vergleich mit dem alten Profil / compared with the previous profile: ${resolve(previousFile ?? '')} ` +
            `(erstellt / created ${previous.profile.createdAt}, SHA-256 ${previous.sha256})`,
        );
        for (const line of profileDiffLines(diff, accept)) out(`  ${line}`);
      }
      if (plan.unaccepted.length > 0) {
        const flagOf = {
          partners: '--accept-partner-changes',
          keys: '--accept-key-changes',
          epochs: '--accept-epochs',
        } as const;
        out(
          'NICHT EXPORTIERT: Abweichungen vom alten Profil sind nicht angenommen. Jede Abweichung mit den ' +
            'Unterlagen abgleichen (Vertrauensaufnahme, Protokoll des Schlüsselwechsels bzw. der Wiederherstellung) ' +
            `und dann ausdrücklich annehmen: ${plan.unaccepted.map((c) => flagOf[c]).join(' ')} / NOT EXPORTED: ` +
            'changes not accepted; verify each against your records, then accept explicitly',
        );
        await deps.audit.record({
          actor: CLI_ACTOR,
          action: 'audit.anchor_profile.export',
          outcome: 'denied',
          objectType: 'audit_log',
          details: {
            reason: 'previous_changes_not_accepted',
            unaccepted: plan.unaccepted,
            previousSha256: previous?.sha256 ?? null,
            ...(diff ? { changes: diffSummary(diff) } : {}),
          },
        });
        return VERIFY_EXIT.needs_review;
      }
      const json = `${JSON.stringify(profile, null, 2)}\n`;
      writeFileSync(resolve(file), json, { mode: 0o644 });
      const digest = sha256Hex(Buffer.from(json, 'utf8'));
      await deps.audit.record({
        actor: CLI_ACTOR,
        action: 'audit.anchor_profile.export',
        objectType: 'audit_log',
        details: {
          sha256: digest,
          minPartners: profile.minPartners,
          partners: profile.partners.map((x) => ({ nodeId: x.nodeId, fingerprint: x.fingerprint })),
          keys: profile.keys.length,
          epochs: profile.epochs.length,
          ...(previous
            ? {
                previousCreatedAt: previous.profile.createdAt,
                previousSha256: previous.sha256,
                accepted: (Object.keys(accept) as (keyof typeof accept)[]).filter((k) => accept[k]),
                ...(diff ? { changes: diffSummary(diff) } : {}),
              }
            : {}),
        },
      });
      out(`Anker-Profil exportiert / anchoring profile exported: ${resolve(file)}`);
      out(`  SHA-256: ${digest}`);
      out(
        `  Knoten / node: ${profile.nodeId}, mindestens / at least ${profile.minPartners} Partner müssen bestätigen / must confirm`,
      );
      out(
        '  Partner (Fingerprints mit den Unterlagen der Vertrauensaufnahme vergleichen / compare with the onboarding records):',
      );
      for (const x of profile.partners)
        out(`    ${x.nodeId} (${x.displayName}) ${x.baseUrl}  Fingerprint ${x.fingerprint}`);
      out('  Eigene Schlüssel / own keys:');
      for (const k of profile.keys) out(`    ${keyLine(k)}`);
      out('  Epochen der Audit-Kette / audit chain epochs:');
      for (const e of profile.epochs) out(`    ${epochLine(e)}`);
      out(
        'Jede Wiederherstellung in dieser Liste mit ihrem Protokoll abgleichen (Prüfsumme der Sicherung, Kopf ' +
          'davor). Profil offline neben dem Sicherungsschlüssel verwahren und die Prüfsumme notieren; nach ' +
          'Schlüsselwechseln, Änderungen der Partner und Wiederherstellungen neu exportieren (--previous ' +
          '<altes-profil>) / store offline next to the backup key, record the checksum; re-export after key ' +
          'rotations, partner changes and restores.',
      );
      return 0;
    } finally {
      await deps.db.destroy();
    }
  },

  async 'rotate-node-key'(args) {
    const p = parseArgs(args, ['routine', 'compromised', 'yes']);
    const routine = p.flags.routine === true;
    const compromised = p.flags.compromised === true;
    if (routine === compromised) {
      throw new UsageError(
        'genau eine Art angeben: --routine (planmäßig, Partner werden signiert benachrichtigt) oder --compromised ' +
          '(Verdacht auf Kompromittierung: keine Benachrichtigung, Partner gleichen den neuen Fingerprint telefonisch ' +
          'ab) / specify exactly one of --routine or --compromised',
      );
    }
    if (compromised && p.flags.yes !== true) {
      throw new UsageError(
        '--compromised verwirft den bisherigen Schlüssel sofort; alle Partner müssen die neue Knotenkarte aufnehmen ' +
          'und den Fingerprint telefonisch abgleichen. Mit --yes bestätigen / discards the old key immediately; ' +
          'confirm with --yes',
      );
    }
    const graceRaw = flag(p, 'grace-days');
    const graceDays = graceRaw === undefined ? DEFAULT_GRACE_DAYS : Number(graceRaw);
    if (!Number.isInteger(graceDays) || graceDays < 1 || graceDays > MAX_GRACE_DAYS) {
      throw new UsageError(`--grace-days: 1–${MAX_GRACE_DAYS}`);
    }
    const config = loadConfig();
    const deps = await buildDeps({ config });
    try {
      const r = await rotateNodeKey(deps, {
        mode: compromised ? 'compromised' : 'routine',
        graceDays,
        actor: CLI_ACTOR,
      });
      out(`Knotenschlüssel gewechselt / node key rotated (${r.mode})`);
      out(`  bisheriger Fingerprint / old fingerprint: ${r.oldFingerprint}`);
      out(`  neuer Fingerprint / new fingerprint:      ${r.newFingerprint}`);
      if (r.mode === 'routine') {
        out(
          `  ${r.peersNotified} Partner benachrichtigt (Ausgangspostfach, Zustellung durch den laufenden Knoten) / ` +
            `${r.peersNotified} partner(s) notified via the outbox`,
        );
        out(`  Übergangszeit bis / grace period until: ${r.graceUntil.toISOString()}`);
        out(
          'Partner ohne Bestätigung bis dahin müssen die neue Knotenkarte aufnehmen (Partner › Neuen Schlüssel eintragen) ' +
            'und den Fingerprint telefonisch abgleichen / partners that have not confirmed by then must re-trust manually.',
        );
      } else {
        out(
          'Keine Benachrichtigung: alle Partner müssen den Knoten sperren, die neue Knotenkarte aufnehmen und den neuen ' +
            'Fingerprint telefonisch abgleichen (docs/betrieb.md) / no notice sent: every partner must re-onboard this node.',
        );
      }
      out(`Neue Knotenkarte / new node card: ${MESH_CLI} node-card`);
      return 0;
    } finally {
      await deps.db.destroy();
    }
  },

  async 'rotate-master-key'() {
    const next = env('MESH_MASTER_KEY');
    const previous = env('MESH_MASTER_KEY_PREVIOUS');
    const url = process.env.MESH_DB_URL ?? env('MESH_DB_OWNER_URL');
    const box = new SecretBox(next, previous);
    const r = await withDb(url, (db) =>
      db.transaction().execute(async (trx) => {
        const identity = await NodeIdentity.reseal(trx, box);
        const rows = await trx
          .selectFrom('connector')
          .select(['id', 'secret_enc'])
          .where('secret_enc', 'is not', null)
          .forUpdate()
          .execute();
        let connectors = 0;
        for (const row of rows) {
          if (!row.secret_enc || !box.needsReseal(row.secret_enc)) continue;
          const aad = `connector.secret:${row.id}`;
          await trx
            .updateTable('connector')
            .set({ secret_enc: box.seal(box.openBytes(row.secret_enc, aad), aad) })
            .where('id', '=', row.id)
            .execute();
          connectors++;
        }
        await new AuditWriter(trx).record({
          actor: CLI_ACTOR,
          action: 'system.master_key_rotated',
          objectType: 'master_key',
          objectId: box.currentKeyId,
          details: {
            identityResealed: identity,
            connectorsResealed: connectors,
            connectorsTotal: rows.length,
          },
        });
        return { identity, connectors, total: rows.length };
      }),
    );
    out(`Master-Key rotiert / rotated (neue Schlüssel-ID / new key id ${box.currentKeyId})`);
    out(
      `  Knotenidentität / node identity: ${r.identity ? 'neu verschlüsselt / resealed' : 'bereits aktuell / up to date'}`,
    );
    out(
      `  Connector-Geheimnisse / connector secrets: ${r.connectors} von / of ${r.total} neu verschlüsselt / resealed`,
    );
    out('MESH_MASTER_KEY_PREVIOUS kann jetzt entfernt werden / can now be removed.');
    return 0;
  },

  async 'node-card'() {
    const config = loadConfig();
    const deps = await buildDeps({ config });
    try {
      out(JSON.stringify(deps.identity.card(), null, 2));
      return 0;
    } finally {
      await deps.db.destroy();
    }
  },
};
