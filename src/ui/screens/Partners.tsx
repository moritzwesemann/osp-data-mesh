import { useState } from 'react';
import type { Peer } from '../../shared/contract/index.ts';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { AddPeerDialog } from '../components/federation/AddPeerDialog.tsx';
import { EditPeerDialog } from '../components/federation/EditPeerDialog.tsx';
import { shortHash } from '../components/federation/fingerprint.ts';
import { NodeCardPanel } from '../components/federation/NodeCardPanel.tsx';
import { OutboxSection } from '../components/federation/OutboxSection.tsx';
import { TrustDialog } from '../components/federation/TrustDialog.tsx';
import { DateTime } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { QueryView } from '../components/QueryState.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import { codeText, describeError } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

/** /partner – Knotenkarte, Partnerknoten (Aufnahme, Vertrauen, Sperre, Prüfung), Ausgangspostfach. */
export function Partners() {
  const i = useI18n();
  const { t } = i;
  const session = useSession();
  const toast = useToast();
  const peers = useApiQuery('peers.list', {});
  const [adding, setAdding] = useState(false);
  const [trusting, setTrusting] = useState<Peer | null>(null);
  const [editing, setEditing] = useState<Peer | null>(null);
  const [suspending, setSuspending] = useState<Peer | null>(null);

  const ping = useApiMutation('peers.ping', { invalidate: ['peers.list'] });
  const suspend = useApiMutation('peers.suspend', {
    invalidate: ['peers.list'],
    onSuccess: (p) => {
      toast.success(t('partners.suspended', { name: p.displayName }));
      setSuspending(null);
    },
  });

  const runPing = (peer: Peer) =>
    ping.mutate(
      { params: { id: peer.id } },
      {
        onSuccess: (r) => {
          if (r.ok) {
            toast.success(
              r.latencyMs === null
                ? t('partners.pingOkNoLatency', { name: peer.displayName })
                : t('partners.pingOk', { name: peer.displayName, ms: Math.round(r.latencyMs) }),
            );
          } else {
            toast.error(
              t('partners.pingFailed', { name: peer.displayName, reason: codeText(i, r.errorCode) }),
            );
          }
        },
        onError: (e) =>
          toast.error(
            t('partners.pingFailed', { name: peer.displayName, reason: describeError(i, e).message }),
          ),
      },
    );

  const columns: Column<Peer>[] = [
    {
      key: 'name',
      header: t('partners.displayName'),
      render: (p) => <strong>{p.displayName}</strong>,
    },
    { key: 'node', header: t('partners.nodeId'), render: (p) => <span className="mono">{p.nodeId}</span> },
    { key: 'url', header: t('partners.baseUrl'), render: (p) => <span className="break">{p.baseUrl}</span> },
    {
      key: 'status',
      header: t('common.status'),
      render: (p) => <StatusBadge group="peerStatus" value={p.status} />,
    },
    {
      key: 'fp',
      header: t('common.fingerprint'),
      className: 'nowrap',
      render: (p) => (
        <span className="mono" title={p.fingerprint}>
          {shortHash(p.fingerprint)}
        </span>
      ),
    },
    {
      key: 'seen',
      header: t('partners.lastSeen'),
      className: 'nowrap',
      render: (p) => (p.lastSeenAt ? <DateTime value={p.lastSeenAt} /> : t('partners.neverSeen')),
    },
    {
      key: 'error',
      header: t('partners.lastError'),
      render: (p) =>
        p.lastError ? <span className="text-danger">{codeText(i, p.lastError)}</span> : t('common.empty'),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('common.actions')}</span>,
      render: (p) => {
        const pinging = ping.isPending && ping.variables?.params.id === p.id;
        return (
          <div className="row">
            {session.can('peers.ping') && p.status !== 'suspended' && (
              <button type="button" className="btn btn-sm" disabled={pinging} onClick={() => runPing(p)}>
                {pinging ? t('partners.pinging') : t('partners.ping')}
              </button>
            )}
            {session.can('peers.trust') && p.status === 'pending' && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setTrusting(p)}>
                {t('partners.trust')}
              </button>
            )}
            {session.can('peers.update') && (
              <button type="button" className="btn btn-sm" onClick={() => setEditing(p)}>
                {t('common.edit')}
              </button>
            )}
            {session.can('peers.suspend') && p.status !== 'suspended' && (
              <button
                type="button"
                className="btn btn-sm btn-danger-outline"
                onClick={() => setSuspending(p)}
              >
                {t('partners.suspend')}
              </button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('partners.title')}
        description={t('partners.intro')}
        actions={
          session.can('peers.add') ? (
            <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
              {t('partners.addPeer')}
            </button>
          ) : undefined
        }
      />

      <Section title={t('partners.onboardingTitle')}>
        <ol className="stack-sm">
          <li>{t('partners.step1')}</li>
          <li>{t('partners.step2')}</li>
          <li>{t('partners.step3')}</li>
          <li>{t('partners.step4')}</li>
        </ol>
        <p className="muted small">{t('partners.suspendNote')}</p>
      </Section>

      {session.can('node.card') && <NodeCardPanel />}

      <Section title={t('partners.peersTitle')}>
        <QueryView query={peers}>
          {(data) => (
            <Table
              columns={columns}
              rows={data.items}
              rowKey={(p) => p.id}
              caption={t('partners.peersTitle')}
              empty={t('partners.peersEmpty')}
            />
          )}
        </QueryView>
      </Section>

      {session.can('outbox.list') && <OutboxSection />}

      <AddPeerDialog open={adding} onClose={() => setAdding(false)} />
      <TrustDialog peer={trusting} onClose={() => setTrusting(null)} />
      <EditPeerDialog peer={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={suspending !== null}
        title={t('partners.suspendTitle')}
        message={suspending ? t('partners.suspendConfirm', { name: suspending.displayName }) : ''}
        confirmLabel={t('partners.suspend')}
        destructive
        busy={suspend.isPending}
        error={suspend.error}
        onConfirm={() => suspending && suspend.mutate({ params: { id: suspending.id } })}
        onCancel={() => {
          suspend.reset();
          setSuspending(null);
        }}
      />
    </div>
  );
}
