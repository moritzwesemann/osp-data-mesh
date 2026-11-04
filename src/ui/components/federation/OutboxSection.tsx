import { useI18n } from '../../i18n/index.tsx';
import type { ApiOutput } from '../../lib/api.ts';
import { codeText, describeError } from '../../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';
import { DateTime } from '../Misc.tsx';
import { Section } from '../PageHeader.tsx';
import { QueryView } from '../QueryState.tsx';
import { StatusBadge } from '../StatusBadge.tsx';
import { type Column, Table } from '../Table.tsx';
import { useToast } from '../Toast.tsx';

type OutboxMessage = ApiOutput<'outbox.list'>['items'][number];

/** Ausgangspostfach (outbox.list) mit sofortiger Zustellung (outbox.flush). */
export function OutboxSection() {
  const i = useI18n();
  const { t, tx } = i;
  const session = useSession();
  const toast = useToast();
  const outbox = useApiQuery('outbox.list', {});
  const flush = useApiMutation('outbox.flush', {
    invalidate: ['outbox.list', 'peers.list'],
    onSuccess: (r) => toast.success(t('partners.flushed', { delivered: r.delivered, failed: r.failed })),
  });

  const columns: Column<OutboxMessage>[] = [
    {
      key: 'type',
      header: t('partners.messageType'),
      render: (m) => tx(`partners.messageTypes.${m.type}`) ?? <span className="mono">{m.type}</span>,
    },
    { key: 'peer', header: t('partners.peer'), render: (m) => <span className="mono">{m.peerNodeId}</span> },
    {
      key: 'status',
      header: t('common.status'),
      render: (m) => <StatusBadge group="outboxStatus" value={m.status} />,
    },
    { key: 'attempts', header: t('partners.attempts'), className: 'num', render: (m) => m.attempts },
    {
      key: 'next',
      header: t('partners.nextAttempt'),
      className: 'nowrap',
      render: (m) => (m.status === 'delivered' ? t('common.empty') : <DateTime value={m.nextAttemptAt} />),
    },
    {
      key: 'error',
      header: t('partners.lastError'),
      render: (m) => (m.lastError ? codeText(i, m.lastError) : t('common.empty')),
    },
    {
      key: 'created',
      header: t('common.createdAt'),
      className: 'nowrap',
      render: (m) => <DateTime value={m.createdAt} />,
    },
    {
      key: 'delivered',
      header: t('partners.deliveredAt'),
      className: 'nowrap',
      render: (m) => <DateTime value={m.deliveredAt} />,
    },
  ];

  return (
    <Section
      title={t('partners.outboxTitle')}
      description={t('partners.outboxIntro')}
      actions={
        session.can('outbox.flush') ? (
          <button
            type="button"
            className="btn"
            disabled={flush.isPending}
            onClick={() => flush.mutate({}, { onError: (e) => toast.error(describeError(i, e).message) })}
          >
            {flush.isPending ? t('partners.flushing') : t('partners.flush')}
          </button>
        ) : undefined
      }
    >
      <QueryView query={outbox}>
        {(data) => (
          <Table
            columns={columns}
            rows={data.items}
            rowKey={(m) => m.id}
            caption={t('partners.outboxTitle')}
            empty={t('partners.outboxEmpty')}
          />
        )}
      </QueryView>
    </Section>
  );
}
