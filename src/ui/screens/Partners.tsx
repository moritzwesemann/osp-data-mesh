import { type ReactNode, useState } from 'react';
import type { Peer } from '../../shared/contract/index.ts';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { AddPeerDialog } from '../components/federation/AddPeerDialog.tsx';
import { EditPeerDialog } from '../components/federation/EditPeerDialog.tsx';
import { NodeCardPanel } from '../components/federation/NodeCardPanel.tsx';
import { OutboxSection } from '../components/federation/OutboxSection.tsx';
import { ReplaceKeyDialog } from '../components/federation/ReplaceKeyDialog.tsx';
import { TrustDialog } from '../components/federation/TrustDialog.tsx';
import { DateTime, DescriptionList, Details } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { QueryView } from '../components/QueryState.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import { codeText, describeError } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

/**
 * /partner – Partnerliste mit der jeweils nächsten Aktion (Vertrauen bestätigen bzw. Verbindung prüfen);
 * Kennung, Adresse, Fingerprint, Bearbeiten und Sperren in den Zeilendetails. Darunter eigene Knotenkarte
 * und Ausgangspostfach (zugeklappt, solange nichts aussteht).
 */
export function Partners() {
  const i = useI18n();
  const { t, fmt } = i;
  const session = useSession();
  const toast = useToast();
  const peers = useApiQuery('peers.list', {});
  const [adding, setAdding] = useState(false);
  const [trusting, setTrusting] = useState<Peer | null>(null);
  const [editing, setEditing] = useState<Peer | null>(null);
  const [suspending, setSuspending] = useState<Peer | null>(null);
  const [replacing, setReplacing] = useState<Peer | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

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

  const canPing = (p: Peer) => session.can('peers.ping') && p.status !== 'suspended';
  const canTrust = (p: Peer) => session.can('peers.trust') && p.status === 'pending';
  const canSuspend = (p: Peer) => session.can('peers.suspend') && p.status !== 'suspended';
  /** Weitere Aktionen in den Zeilendetails (Verbindung prüfen, falls nicht schon Hauptaktion; Bearbeiten; Sperren) */
  const moreActions = (p: Peer) =>
    (canTrust(p) && canPing(p)) ||
    session.can('peers.update') ||
    canSuspend(p) ||
    session.can('peers.replaceKey');

  const pingButton = (p: Peer) => {
    const pinging = ping.isPending && ping.variables?.params.id === p.id;
    return (
      <button type="button" className="btn btn-sm" disabled={pinging} onClick={() => runPing(p)}>
        {pinging ? t('partners.pinging') : t('partners.ping')}
      </button>
    );
  };

  /** Nächste sinnvolle Aktion: ausstehend → Vertrauen bestätigen, sonst Verbindung prüfen. */
  const nextAction = (p: Peer) => {
    if (canTrust(p))
      return (
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setTrusting(p)}>
          {t('partners.trust')}
        </button>
      );
    if (canPing(p)) return pingButton(p);
    return null;
  };

  const columns: Column<Peer>[] = [
    {
      key: 'name',
      header: t('partners.displayName'),
      render: (p) => <strong>{p.displayName}</strong>,
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (p) => <StatusBadge group="peerStatus" value={p.status} />,
    },
    {
      key: 'seen',
      header: t('partners.lastSeen'),
      render: (p) => (
        <span className="stack-sm">
          <span className="nowrap">
            {p.lastSeenAt ? <DateTime value={p.lastSeenAt} /> : t('partners.neverSeen')}
          </span>
          {p.lastError && <span className="small text-danger">{codeText(i, p.lastError)}</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('common.actions')}</span>,
      render: (p) => (
        <div className="row">
          {nextAction(p)}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-expanded={openId === p.id}
            onClick={() => setOpenId(openId === p.id ? null : p.id)}
          >
            {openId === p.id ? t('common.hideDetails') : t('common.details')}
          </button>
        </div>
      ),
    },
  ];

  const peerDetails = (p: Peer) => (
    <div className="stack">
      <DescriptionList
        items={[
          [
            t('partners.nodeId'),
            <span key="node" className="mono">
              {p.nodeId}
            </span>,
          ],
          [
            t('partners.baseUrl'),
            <span key="url" className="break">
              {p.baseUrl}
            </span>,
          ],
          [
            t('common.fingerprint'),
            <span key="fp" className="mono break">
              {p.fingerprint}
            </span>,
          ],
          ...(p.keyRotatedAt
            ? [
                [t('partners.keyRotatedAt'), <DateTime key="rot" value={p.keyRotatedAt} />] satisfies [
                  ReactNode,
                  ReactNode,
                ],
              ]
            : []),
          ...(p.previousFingerprint
            ? [
                [
                  t('partners.previousFingerprint'),
                  <span key="prev" className="stack-sm">
                    <span className="mono break">{p.previousFingerprint}</span>
                    {p.previousKeyValidUntil && (
                      <span className="small muted">
                        {t('partners.previousValidUntil', { date: fmt.dateTime(p.previousKeyValidUntil) })}
                      </span>
                    )}
                  </span>,
                ] satisfies [ReactNode, ReactNode],
              ]
            : []),
        ]}
      />
      {moreActions(p) && (
        <div className="row">
          {canTrust(p) && canPing(p) && pingButton(p)}
          {session.can('peers.update') && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing(p)}>
              {t('common.edit')}
            </button>
          )}
          {session.can('peers.replaceKey') && (
            <button type="button" className="btn btn-sm" onClick={() => setReplacing(p)}>
              {t('partners.replaceKey')}
            </button>
          )}
          {canSuspend(p) && (
            <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setSuspending(p)}>
              {t('partners.suspend')}
            </button>
          )}
        </div>
      )}
    </div>
  );

  const peerNames = new Map((peers.data?.items ?? []).map((p) => [p.nodeId, p.displayName]));

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

      <Section title={t('partners.peersTitle')}>
        <QueryView query={peers}>
          {(data) => (
            <Table
              columns={columns}
              rows={data.items}
              rowKey={(p) => p.id}
              caption={t('partners.peersTitle')}
              empty={t('partners.peersEmpty')}
              expanded={(p) => (openId === p.id ? peerDetails(p) : null)}
            />
          )}
        </QueryView>
        <Details summary={t('partners.onboardingTitle')} defaultOpen={peers.data?.items.length === 0}>
          <ol className="stack-sm">
            <li>{t('partners.step1')}</li>
            <li>{t('partners.step2')}</li>
            <li>{t('partners.step3')}</li>
            <li>{t('partners.step4')}</li>
          </ol>
          <p className="muted small">{t('partners.suspendNote')}</p>
          <p className="muted small">{t('partners.keyChangeNote')}</p>
        </Details>
      </Section>

      {session.can('node.card') && <NodeCardPanel />}

      {session.can('outbox.list') && <OutboxSection peerNames={peerNames} />}

      <AddPeerDialog open={adding} onClose={() => setAdding(false)} />
      <TrustDialog peer={trusting} onClose={() => setTrusting(null)} />
      <EditPeerDialog peer={editing} onClose={() => setEditing(null)} />
      <ReplaceKeyDialog
        peer={replacing}
        onClose={() => setReplacing(null)}
        onReplaced={(p) => setTrusting(p)}
      />
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
