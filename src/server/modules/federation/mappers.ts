/** Abbildung Datenbankzeilen (snake_case) → API-Objekte (camelCase) des Föderationsmoduls. */
import type { z } from 'zod';
import type { ColumnDef } from '../../../shared/contract/common.ts';
import type { OutboxMessage, Peer, ReceivedProduct } from '../../../shared/contract/federation.ts';
import type { ExchangeLogEntry } from '../../../shared/contract/releases.ts';
import { fingerprint } from '../../core/crypto.ts';
import { iso, isoReq } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';

type PeerStatus = Peer['status'];
type ReceivedStatus = ReceivedProduct['status'];

export function toPeer(r: Row<'peer'>): Peer {
  return {
    id: r.id,
    nodeId: r.node_id,
    displayName: r.display_name,
    baseUrl: r.base_url,
    publicKey: r.public_key,
    fingerprint: r.fingerprint,
    status: r.status as PeerStatus,
    createdAt: isoReq(r.created_at),
    trustedAt: iso(r.trusted_at),
    lastSeenAt: iso(r.last_seen_at),
    lastError: r.last_error,
    previousFingerprint: r.previous_public_key ? fingerprint(r.previous_public_key) : null,
    previousKeyValidUntil: iso(r.previous_key_valid_until),
    keyRotatedAt: iso(r.key_rotated_at),
  };
}

export type ReceivedWithPeer = Row<'received_product'> & {
  peer_node_id: string;
  peer_display_name: string;
};

export function toReceived(r: ReceivedWithPeer): ReceivedProduct {
  return {
    id: r.id,
    peer: { id: r.peer_id, nodeId: r.peer_node_id, displayName: r.peer_display_name },
    remoteReleaseId: r.remote_release_id,
    remoteProductId: r.remote_product_id,
    remoteProductSlug: r.remote_product_slug,
    title: r.title,
    description: r.description,
    purpose: r.purpose,
    columns: r.columns as ColumnDef[],
    productVersion: r.product_version,
    specialCategory: r.special_category,
    releaseValidUntil: iso(r.release_valid_until),
    status: r.status as ReceivedStatus,
    rowCount: r.row_count,
    payloadSha256: r.payload_sha256,
    lastPulledAt: iso(r.last_pulled_at),
    statusChangedAt: iso(r.status_changed_at),
    statusReason: r.status_reason,
    createdAt: isoReq(r.created_at),
  };
}

export function toExchangeLogEntry(r: Row<'exchange_log'>): ExchangeLogEntry {
  return {
    id: r.id,
    direction: r.direction,
    peerNodeId: r.peer_node_id,
    releaseId: r.release_id,
    remoteReleaseId: r.remote_release_id,
    productRef: r.product_ref,
    purpose: r.purpose,
    outcome: r.outcome,
    denyReason: r.deny_reason,
    rowCount: r.row_count,
    columns: r.columns,
    payloadSha256: r.payload_sha256,
    at: isoReq(r.at),
  };
}

export function toOutboxMessage(
  r: Row<'outbox_message'> & { peer_node_id: string },
): z.infer<typeof OutboxMessage> {
  return {
    id: r.id,
    peerNodeId: r.peer_node_id,
    type: r.type,
    kind: noticeKind(r.body),
    status: r.status as 'pending' | 'delivered' | 'failed',
    attempts: r.attempts,
    nextAttemptAt: isoReq(r.next_attempt_at),
    lastError: r.last_error,
    createdAt: isoReq(r.created_at),
    deliveredAt: iso(r.delivered_at),
  };
}

/** Art einer Mitteilung (body.kind), sonst null */
function noticeKind(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const kind = (body as { kind?: unknown }).kind;
  return typeof kind === 'string' && /^[a-z_]{1,40}$/.test(kind) ? kind : null;
}
