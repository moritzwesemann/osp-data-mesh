import { useI18n } from '../../i18n/index.tsx';
import type { ApiOutput } from '../../lib/api.ts';
import { codeText, describeError } from '../../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';
import { DateTime, MetaLine } from '../Misc.tsx';
import { Section } from '../PageHeader.tsx';
import { QueryView } from '../QueryState.tsx';
import { Badge, StatusBadge } from '../StatusBadge.tsx';
import { type Column, Table } from '../Table.tsx';
import { useToast } from '../Toast.tsx';

type OutboxMessage = ApiOutput<'outbox.list'>['items'][number];

/**
 * Ausgangspostfach (outbox.list) mit sofortiger Zustellung (outbox.flush).
 * Zugeklappt, solange alles zugestellt ist; offen, sobald Mitteilungen ausstehen oder fehlschlagen.
 */
export function OutboxSection({ peerNames }: { peerNames?: ReadonlyMap<string, string> }) {
  const i = useI18n();
  const { t, tx, fmt } = i;
  const session = useSession();
  const toast = useToast();
  const outbox = useApiQuery('outbox.list', {});
  const flush = useApiMutation('outbox.flush', {
    invalidate: ['outbox.list', 'peers.list'],
    onSuccess: (r) => toast.success(t('partners.flushed', { delivered: r.delivered, failed: r.failed })),
  });

  const items = outbox.data?.items ?? [];
  const pending = items.filter((m) => m.status === 'pending').length;
  const failed = items.filter((m) => m.status === 'failed').length;

  const columns: Column<OutboxMessage>[] = [
    {
      key: 'type',
      header: t('partners.messageType'),
      render: (m) => tx(`partners.messageTypes.${m.type}`) ?? <span className="mono">{m.type}</span>,
    },
    {
      key: 'peer',
      header: t('partners.peer'),
      render: (m) => peerNames?.get(m.peerNodeId) ?? <span className="mono">{m.peerNodeId}</span>,
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (m) => (
        <div className="stack-sm">
          <span>
            <StatusBadge group="outboxStatus" value={m.status} />
          </span>
          <MetaLine
            className="small"
            items={[
              m.status === 'delivered'
                ? m.deliveredAt && fmt.dateTime(m.deliveredAt)
                : t('partners.nextAttemptAt', { time: fmt.dateTime(m.nextAttemptAt) }),
              t('partners.attemptsCount', { count: m.attempts }),
            ]}
          />
          {m.lastError && <span className="small text-danger">{codeText(i, m.lastError)}</span>}
        </div>
      ),
    },
    {
      key: 'created',
      header: t('common.createdAt'),
      className: 'nowrap',
      render: (m) => <DateTime value={m.createdAt} />,
    },
  ];

  return (
    <Section
      collapsible
      defaultOpen={pending + failed > 0}
      title={
        <span className="row">
          {t('partners.outboxTitle')}
          {failed > 0 && <Badge tone="danger">{t('partners.outboxFailedCount', { count: failed })}</Badge>}
          {pending > 0 && (
            <Badge tone="warning">{t('partners.outboxPendingCount', { count: pending })}</Badge>
          )}
        </span>
      }
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
