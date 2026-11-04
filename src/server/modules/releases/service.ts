/**
 * Freigaben: Erteilen (mit Prüfung), Widerrufen, Anzeigen, Vorschau.
 * Freigaben sind unveränderlich; Änderung = neue Freigabe erteilen und alte widerrufen.
 */
import type { RecipientRole } from '../../../shared/contract/common.ts';
import type {
  ExchangeLogEntry,
  Release,
  ReleaseInput,
  releaseRoutes,
} from '../../../shared/contract/releases.ts';
import type { RouteBody, RouteResponse } from '../../../shared/contract/route.ts';
import { type Actor, SYSTEM_ACTOR } from '../../core/audit.ts';
import { type DbOrTx, iso, isoReq, type Tx } from '../../core/db.ts';
import type { Deps } from '../../core/deps.ts';
import { AppError, conflict, notFound } from '../../core/errors.ts';
import type { DomainEvents } from '../../core/events.ts';
import { assertDeliveryLock } from '../../core/locks.ts';
import { writeTx } from '../../core/tx.ts';
import { type LoadedProduct, loadProductRows, normalizeConditions, productMeta } from '../products/rows.ts';
import {
  applyRelease,
  conditionValueFits,
  decide,
  type ReleaseDraft,
  type ReleaseIssue,
  type ReleaseRule,
  type Requester,
  validateRelease,
} from './engine.ts';
import { loadConsentFacts, type ReleaseRow, statusOf } from './rules.ts';

export interface RequestMeta {
  actor: Actor;
  userId: string | null;
  ip: string | null;
  requestId: string | null;
}

type RevokedPayload = DomainEvents['release.revoked'];
type PreviewBody = RouteBody<(typeof releaseRoutes)['releases.preview']>;
type PreviewResponse = RouteResponse<(typeof releaseRoutes)['releases.preview']>;

// ---------------------------------------------------------------------------------------------
// Abbildung auf den Vertrag
// ---------------------------------------------------------------------------------------------

export async function toReleaseApi(db: DbOrTx, rows: readonly ReleaseRow[], at: Date): Promise<Release[]> {
  if (rows.length === 0) return [];
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  const peerIds = [...new Set(rows.map((r) => r.recipient_peer_id).filter((x): x is string => !!x))];
  const products = new Map(
    (
      await db
        .selectFrom('data_product')
        .select(['id', 'slug', 'name', 'version'])
        .where('id', 'in', productIds)
        .execute()
    ).map((p) => [p.id, p]),
  );
  const peers = new Map(
    peerIds.length
      ? (
          await db
            .selectFrom('peer')
            .select(['id', 'node_id', 'display_name'])
            .where('id', 'in', peerIds)
            .execute()
        ).map((p) => [p.id, p])
      : [],
  );
  return rows.map((r) => {
    const product = products.get(r.product_id);
    const currentVersion = product?.version ?? r.product_version;
    const peer = r.recipient_peer_id ? peers.get(r.recipient_peer_id) : undefined;
    const recipient: Release['recipient'] =
      r.recipient_type === 'peer'
        ? {
            type: 'peer',
            peerId: r.recipient_peer_id ?? '',
            peerNodeId: peer?.node_id ?? '',
            peerName: peer?.display_name ?? '',
          }
        : { type: 'role', role: r.recipient_role as RecipientRole };
    return {
      id: r.id,
      productId: r.product_id,
      productName: product?.name ?? '',
      productSlug: product?.slug ?? '',
      productVersion: r.product_version,
      currentProductVersion: currentVersion,
      recipient,
      purposes: r.purposes,
      columns: r.columns,
      rowFilter: (Array.isArray(r.row_filter) ? r.row_filter : []) as Release['rowFilter'],
      dataFrom: r.data_from,
      dataUntil: r.data_until,
      validFrom: isoReq(r.valid_from),
      validUntil: iso(r.valid_until),
      requiresConsent: r.requires_consent,
      legalBasis: r.legal_basis,
      note: r.note,
      status: statusOf(r, currentVersion, at),
      createdAt: isoReq(r.created_at),
      revokedAt: iso(r.revoked_at),
      revocationReason: r.revocation_reason,
    };
  });
}

export async function listReleases(
  deps: Deps,
  q: { productId?: string; status?: Release['status'] },
): Promise<Release[]> {
  let query = deps.db.selectFrom('data_release').selectAll().orderBy('created_at', 'desc');
  if (q.productId) query = query.where('product_id', '=', q.productId);
  const items = await toReleaseApi(deps.db, await query.execute(), deps.now());
  return q.status ? items.filter((r) => r.status === q.status) : items;
}

export async function getRelease(
  deps: Deps,
  id: string,
): Promise<Release & { exchanges: ExchangeLogEntry[] }> {
  const row = await deps.db.selectFrom('data_release').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound();
  const [release] = await toReleaseApi(deps.db, [row], deps.now());
  const exchanges = await deps.db
    .selectFrom('exchange_log')
    .selectAll()
    .where('release_id', '=', id)
    .orderBy('at', 'desc')
    .limit(50)
    .execute();
  return {
    ...release!,
    exchanges: exchanges.map((e) => ({
      id: e.id,
      direction: e.direction,
      peerNodeId: e.peer_node_id,
      releaseId: e.release_id,
      remoteReleaseId: e.remote_release_id,
      productRef: e.product_ref,
      purpose: e.purpose,
      outcome: e.outcome,
      denyReason: e.deny_reason,
      rowCount: e.row_count,
      columns: e.columns,
      payloadSha256: e.payload_sha256,
      at: isoReq(e.at),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Prüfung
// ---------------------------------------------------------------------------------------------

async function activePurposes(db: DbOrTx): Promise<string[]> {
  const rows = await db.selectFrom('purpose').select('code').where('active', '=', true).execute();
  return rows.map((r) => r.code);
}

/** Übersetzt Prüfergebnisse der Engine in Feldfehler (Pfad → Code). */
export function issueFields(
  issues: readonly ReleaseIssue[],
  draft: ReleaseDraft,
  product: LoadedProduct,
  prefix: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const set = (path: string, code: string) => {
    fields[`${prefix}${path}`] ??= code;
  };
  const types = new Map(product.columns.map((c) => [c.key, c.type]));
  for (const issue of issues) {
    switch (issue.code) {
      case 'unknown_column':
        draft.columns.forEach((c, i) => {
          if (c === issue.column) set(`columns.${i}`, issue.code);
        });
        break;
      case 'unknown_filter_column':
        draft.rowFilter.forEach((c, i) => {
          if (c.column === issue.column) set(`rowFilter.${i}.column`, issue.code);
        });
        break;
      case 'invalid_filter_value':
        draft.rowFilter.forEach((c, i) => {
          const type = types.get(c.column);
          if (c.column === issue.column && type && !conditionValueFits(c, type))
            set(`rowFilter.${i}.value`, issue.code);
        });
        break;
      case 'unknown_purpose':
        draft.purposes.forEach((p, i) => {
          if (p === issue.purpose) set(`purposes.${i}`, issue.code);
        });
        break;
      case 'special_category_requires_consent':
        set('requiresConsent', issue.code);
        break;
      case 'not_shareable':
        set('recipient', issue.code);
        break;
      case 'product_inactive':
        set('productId', issue.code);
        break;
      case 'bi_requires_single_purpose':
        set('purposes', issue.code);
        break;
      case 'invalid_time_window':
        set('validUntil', issue.code);
        break;
      case 'invalid_data_window':
        set('dataUntil', issue.code);
        break;
    }
  }
  if (Object.keys(fields).length === 0) fields[`${prefix}_`] = 'invalid';
  return fields;
}

function columnTypes(product: LoadedProduct) {
  return new Map(product.columns.map((c) => [c.key, c.type]));
}

function toDraft(input: ReleaseInput, now: Date): ReleaseDraft {
  return {
    recipient: input.recipient,
    purposes: input.purposes,
    columns: input.columns,
    rowFilter: input.rowFilter,
    dataFrom: input.dataFrom,
    dataUntil: input.dataUntil,
    validFrom: input.validFrom ? new Date(input.validFrom) : now,
    validUntil: input.validUntil ? new Date(input.validUntil) : null,
    requiresConsent: input.requiresConsent,
  };
}

function createdPayload(r: ReleaseRow): DomainEvents['release.created'] {
  return {
    releaseId: r.id,
    productId: r.product_id,
    recipientType: r.recipient_type,
    recipientRole: r.recipient_role,
    recipientPeerId: r.recipient_peer_id,
  };
}

// ---------------------------------------------------------------------------------------------
// Erteilen
// ---------------------------------------------------------------------------------------------

export async function createRelease(deps: Deps, input: ReleaseInput, meta: RequestMeta): Promise<Release> {
  const knownPurposes = await activePurposes(deps.db);
  const now = deps.now();
  const draft = toDraft(input, now);
  const row = await writeTx(deps, async (trx) => {
    // Produktzeile sperren: serialisiert mit Produktänderungen und weiteren BI-Freigaben
    const locked = await trx
      .selectFrom('data_product')
      .select('id')
      .where('id', '=', input.productId)
      .forUpdate()
      .executeTakeFirst();
    const product = locked ? await productMeta(trx, input.productId) : null;
    if (!product) throw new AppError('release_invalid', { fields: { 'body.productId': 'not_found' } });

    if (input.recipient.type === 'peer') {
      const peer = await trx
        .selectFrom('peer')
        .select(['id', 'status'])
        .where('id', '=', input.recipient.peerId)
        .executeTakeFirst();
      if (!peer) throw new AppError('release_invalid', { fields: { 'body.recipient.peerId': 'not_found' } });
      if (peer.status !== 'trusted') throw new AppError('peer_untrusted');
    }

    const issues = validateRelease(draft, product, knownPurposes);
    if (issues.length) {
      throw new AppError('release_invalid', { fields: issueFields(issues, draft, product, 'body.') });
    }

    const rowFilter = normalizeConditions(input.rowFilter, columnTypes(product));

    if (input.recipient.type === 'role' && input.recipient.role === 'bi') {
      const others = await trx
        .selectFrom('data_release')
        .selectAll()
        .where('product_id', '=', product.id)
        .where('recipient_type', '=', 'role')
        .where('recipient_role', '=', 'bi')
        .where('revoked_at', 'is', null)
        .execute();
      const blocking = others.some((o) => {
        const s = statusOf(o, product.version, now);
        return s === 'active' || s === 'scheduled';
      });
      if (blocking) throw conflict('bi_release_exists');
    }

    const inserted = await trx
      .insertInto('data_release')
      .values({
        product_id: product.id,
        product_version: product.version,
        recipient_type: input.recipient.type,
        recipient_role: input.recipient.type === 'role' ? input.recipient.role : null,
        recipient_peer_id: input.recipient.type === 'peer' ? input.recipient.peerId : null,
        purposes: input.purposes,
        columns: input.columns,
        row_filter: JSON.stringify(rowFilter),
        data_from: input.dataFrom,
        data_until: input.dataUntil,
        valid_from: draft.validFrom,
        valid_until: draft.validUntil,
        requires_consent: input.requiresConsent,
        legal_basis: input.legalBasis,
        note: input.note,
        created_by: meta.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await deps.audit.record(
      {
        actor: meta.actor,
        action: 'release.create',
        objectType: 'release',
        objectId: inserted.id,
        details: {
          productId: product.id,
          productVersion: product.version,
          recipient:
            input.recipient.type === 'role'
              ? { type: 'role', role: input.recipient.role }
              : { type: 'peer', peerId: input.recipient.peerId },
          purposes: input.purposes,
          columns: input.columns,
          rowFilterCount: rowFilter.length,
          dataFrom: input.dataFrom,
          dataUntil: input.dataUntil,
          validFrom: draft.validFrom.toISOString(),
          validUntil: draft.validUntil ? draft.validUntil.toISOString() : null,
          requiresConsent: input.requiresConsent,
          specialCategory: product.specialCategory,
        },
        ip: meta.ip,
        requestId: meta.requestId,
      },
      trx,
    );
    await deps.events.inTx(trx, 'release.created', createdPayload(inserted));
    return inserted;
  });
  await deps.events.after('release.created', createdPayload(row));
  const [api] = await toReleaseApi(deps.db, [row], deps.now());
  return api!;
}

// ---------------------------------------------------------------------------------------------
// Widerrufen
// ---------------------------------------------------------------------------------------------

/**
 * Widerruft eine (gesperrte) Freigabe innerhalb der Transaktion: setzt Widerrufsangaben, löst
 * 'release.revoked' in der Transaktion aus (Föderation: Widerrufsmitteilung, BI: View entfernen) und
 * schreibt den Audit-Eintrag. Das Ereignis nach dem Commit löst der Aufrufer aus.
 */
export async function revokeInTx(
  deps: Deps,
  trx: Tx,
  row: ReleaseRow,
  opts: { meta: RequestMeta; reason: string; cause: 'manual' | 'product_retired' | 'dataset_reclassified' },
): Promise<RevokedPayload> {
  const at = deps.now();
  const currentVersion =
    (
      await trx
        .selectFrom('data_product')
        .select('version')
        .where('id', '=', row.product_id)
        .executeTakeFirst()
    )?.version ?? row.product_version;
  const previousStatus = statusOf(row, currentVersion, at);
  await trx
    .updateTable('data_release')
    .set({ revoked_at: at, revoked_by: opts.meta.userId, revocation_reason: opts.reason })
    .where('id', '=', row.id)
    .execute();
  const payload: RevokedPayload = {
    releaseId: row.id,
    productId: row.product_id,
    recipientType: row.recipient_type,
    recipientRole: row.recipient_role,
    recipientPeerId: row.recipient_peer_id,
    reason: opts.reason,
  };
  await deps.events.inTx(trx, 'release.revoked', payload);
  await deps.audit.record(
    {
      actor: opts.meta.actor,
      action: 'release.revoke',
      objectType: 'release',
      objectId: row.id,
      details: {
        productId: row.product_id,
        recipientType: row.recipient_type,
        recipientRole: row.recipient_role,
        recipientPeerId: row.recipient_peer_id,
        previousStatus,
        cause: opts.cause,
      },
      ip: opts.meta.ip,
      requestId: opts.meta.requestId,
    },
    trx,
  );
  return payload;
}

export async function revokeRelease(
  deps: Deps,
  id: string,
  reason: string,
  meta: RequestMeta,
): Promise<Release> {
  const payload = await writeTx(deps, async (trx) => {
    const row = await trx
      .selectFrom('data_release')
      .selectAll()
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.revoked_at) throw conflict('already_revoked');
    return revokeInTx(deps, trx, row, { meta, reason, cause: 'manual' });
  });
  await deps.events.after('release.revoked', payload);
  const row = await deps.db
    .selectFrom('data_release')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  const [api] = await toReleaseApi(deps.db, [row], deps.now());
  return api!;
}

/**
 * Stilllegung eines Produkts: alle nicht widerrufenen Freigaben werden in der Transaktion der
 * Stilllegung widerrufen. Hochstufung des Datensatzes (revokePeerReleases, siehe products): alle nicht
 * widerrufenen Partnerfreigaben werden widerrufen; Partner erhalten release_revoked und löschen ihre Kopien.
 * Die Ereignisse nach dem Commit werden nach 'product.changed' (after) ausgelöst.
 */
export function registerRetirementHandler(deps: Deps): void {
  const pending = new Map<string, RevokedPayload[]>();
  deps.events.onTx('product.changed', async (p, trx) => {
    if (!p.retired && !p.revokePeerReleases) return;
    // Die auslösende Transaktion (Stilllegung, Neueinstufung) hat die Liefersperre als Erstes genommen
    // (core/locks.ts): laufende Lieferungen sind abgeschlossen, spätere sehen den Widerruf.
    assertDeliveryLock(trx, 'exclusive');
    let query = trx
      .selectFrom('data_release')
      .selectAll()
      .where('product_id', '=', p.productId)
      .where('revoked_at', 'is', null);
    if (!p.retired) query = query.where('recipient_type', '=', 'peer');
    const rows = await query.orderBy('created_at').forUpdate().execute();
    const reason = p.retired ? 'product_retired' : (p.revokePeerReleases ?? 'dataset_reclassified');
    const payloads: RevokedPayload[] = [];
    for (const r of rows) {
      payloads.push(
        await revokeInTx(deps, trx, r, {
          meta: { actor: SYSTEM_ACTOR, userId: null, ip: null, requestId: null },
          reason,
          cause: reason,
        }),
      );
    }
    pending.set(p.productId, payloads);
  });
  deps.events.onAfter('product.changed', async (p) => {
    if (!p.retired && !p.revokePeerReleases) return;
    const payloads = pending.get(p.productId) ?? [];
    pending.delete(p.productId);
    for (const payload of payloads) await deps.events.after('release.revoked', payload);
  });
}

// ---------------------------------------------------------------------------------------------
// Vorschau
// ---------------------------------------------------------------------------------------------

const EMPTY_STATS = { total: 0, returned: 0, excludedByFilter: 0, excludedByTime: 0, excludedByConsent: 0 };

export async function previewRelease(
  deps: Deps,
  body: PreviewBody,
  meta: RequestMeta,
): Promise<PreviewResponse> {
  const input = body.release;
  const product = await productMeta(deps.db, input.productId);
  if (!product) throw new AppError('release_invalid', { fields: { 'body.release.productId': 'not_found' } });
  if (input.recipient.type === 'peer') {
    const peerId = input.recipient.peerId;
    const peer = await deps.db.selectFrom('peer').select('id').where('id', '=', peerId).executeTakeFirst();
    if (!peer)
      throw new AppError('release_invalid', { fields: { 'body.release.recipient.peerId': 'not_found' } });
  }
  const now = deps.now();
  const draft = toDraft(input, now);
  const issues = validateRelease(draft, product, await activePurposes(deps.db));
  if (issues.length) {
    throw new AppError('release_invalid', { fields: issueFields(issues, draft, product, 'body.release.') });
  }
  const rule: ReleaseRule = {
    ...draft,
    rowFilter: normalizeConditions(draft.rowFilter, columnTypes(product)),
    id: 'preview',
    productId: product.id,
    productVersion: product.version,
    revokedAt: null,
  };
  const requester: Requester =
    input.recipient.type === 'peer'
      ? { type: 'peer', peerId: input.recipient.peerId, peerStatus: 'trusted' }
      : input.recipient.role === 'bi'
        ? { type: 'bi' }
        : { type: 'user', userId: meta.userId ?? 'preview', roles: [input.recipient.role] };
  // Geplante Freigaben werden zum Beginn ihrer Gültigkeit betrachtet
  const at = draft.validFrom.getTime() > now.getTime() ? draft.validFrom : now;
  const decision = decide({ release: rule, product, requester, purpose: body.purpose, at });

  let result: PreviewResponse;
  if (!decision.allowed) {
    result = {
      decision: { allowed: false, reason: decision.reason },
      columns: [],
      rows: [],
      stats: EMPTY_STATS,
    };
  } else {
    const timeZone = deps.config.MESH_TIMEZONE;
    const rows = await loadProductRows(deps.db, product, { timeZone });
    const consents =
      rule.requiresConsent || product.specialCategory
        ? await loadConsentFacts(
            deps.db,
            rows.map((r) => r.athleteId).filter((x): x is string => !!x),
            body.purpose,
            product.category,
          )
        : [];
    const applied = applyRelease({
      release: rule,
      product,
      columns: decision.columns,
      rows,
      consents,
      purpose: body.purpose,
      at,
      timeZone,
    });
    result = {
      decision: { allowed: true, reason: null },
      columns: decision.columns,
      rows: applied.rows.slice(0, 20).map((r) => r.values),
      stats: applied.stats,
    };
  }
  await deps.audit.record({
    actor: meta.actor,
    action: 'release.preview',
    objectType: 'product',
    objectId: product.id,
    details: {
      productId: product.id,
      productVersion: product.version,
      recipientType: input.recipient.type,
      recipientRole: input.recipient.type === 'role' ? input.recipient.role : null,
      recipientPeerId: input.recipient.type === 'peer' ? input.recipient.peerId : null,
      purpose: body.purpose,
      allowed: result.decision.allowed,
      reason: result.decision.reason,
      rowCount: result.rows.length,
    },
    ip: meta.ip,
    requestId: meta.requestId,
  });
  return result;
}
