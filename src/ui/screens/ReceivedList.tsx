import { Link } from 'react-router';
import { DateTime } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { SpecialCategoryBadge, StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type Received = ApiOutput<'received.list'>['items'][number];

/** /empfangen – von Partnern abgerufene Datenprodukte. */
export function ReceivedList() {
  const { t, fmt } = useI18n();
  const session = useSession();
  const purposeLabel = usePurposeLabel();
  const list = useApiQuery('received.list', {});

  const columns: Column<Received>[] = [
    {
      key: 'title',
      header: t('received.product'),
      render: (r) => (
        <div className="stack-sm">
          <Link to={`/empfangen/${r.id}`}>{r.title}</Link>
          {r.specialCategory && (
            <span>
              <SpecialCategoryBadge />
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'source',
      header: t('received.source'),
      render: (r) => (
        <div className="stack-sm">
          <span>{r.peer.displayName}</span>
          <span className="mono small muted">{r.peer.nodeId}</span>
        </div>
      ),
    },
    { key: 'purpose', header: t('common.purpose'), render: (r) => purposeLabel(r.purpose) },
    { key: 'rows', header: t('received.rowCount'), className: 'num', render: (r) => fmt.number(r.rowCount) },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge group="receivedStatus" value={r.status} />,
    },
    {
      key: 'pulled',
      header: t('received.lastPulled'),
      className: 'nowrap',
      render: (r) => <DateTime value={r.lastPulledAt} />,
    },
    {
      key: 'valid',
      header: t('received.validUntil'),
      className: 'nowrap',
      render: (r) =>
        r.releaseValidUntil ? <DateTime value={r.releaseValidUntil} /> : t('received.unlimited'),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('received.title')}
        description={t('received.intro')}
        actions={
          session.can('discovery.search') ? (
            <Link to="/katalog/partner" className="btn">
              {t('received.searchPartners')}
            </Link>
          ) : undefined
        }
      />
      <Section>
        <QueryView query={list}>
          {(data) => (
            <Table
              columns={columns}
              rows={data.items}
              rowKey={(r) => r.id}
              caption={t('received.title')}
              empty={
                <EmptyState
                  message={t('received.empty')}
                  action={
                    session.can('discovery.search') ? (
                      <Link to="/katalog/partner" className="btn btn-primary">
                        {t('received.searchPartners')}
                      </Link>
                    ) : undefined
                  }
                />
              }
            />
          )}
        </QueryView>
      </Section>
    </div>
  );
}
