import { Link } from 'react-router';
import type { Product } from '../../shared/contract/index.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { ShareabilityBadge, SpecialCategoryBadge, StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

/** /produkte – Datenprodukte (products.list); Stillgelegt, Art. 9 und „Nur intern“ als Hinweis am Namen. */
export function ProductList() {
  const { t, fmt } = useI18n();
  const session = useSession();
  const canCreate = session.can('products.create');
  const q = useApiQuery('products.list', {});

  const createLink = (
    <Link to="/produkte/neu" className="btn btn-primary">
      {t('products.create')}
    </Link>
  );

  const columns: Column<Product>[] = [
    {
      key: 'name',
      header: t('common.name'),
      render: (p) => (
        <span className="row">
          <Link to={`/produkte/${p.id}`}>{p.name}</Link>
          {p.status !== 'active' && <StatusBadge group="productStatus" value={p.status} />}
          <SpecialCategoryBadge show={p.specialCategory} />
          {p.shareability === 'internal' && <ShareabilityBadge value={p.shareability} />}
        </span>
      ),
    },
    {
      key: 'source',
      header: t('products.colSource'),
      render: (p) =>
        p.sourceType === 'athletes' ? t('products.sourceAthletes') : (p.datasetName ?? t('common.empty')),
    },
    { key: 'category', header: t('common.category'), render: (p) => t(`categories.${p.category}`) },
    {
      key: 'columns',
      header: t('products.colColumns'),
      className: 'num',
      render: (p) => fmt.number(p.columns.length),
    },
    {
      key: 'releases',
      header: t('products.colReleases'),
      className: 'num',
      render: (p) => fmt.number(p.activeReleaseCount),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('products.listTitle')}
        description={t('products.listIntro')}
        actions={canCreate ? createLink : undefined}
      />
      <QueryView query={q}>
        {(data) => (
          <Table
            columns={columns}
            rows={data.items}
            rowKey={(p) => p.id}
            caption={t('products.caption')}
            empty={
              <EmptyState
                message={canCreate ? t('products.empty') : t('products.emptyNoRights')}
                action={canCreate ? createLink : undefined}
              />
            }
          />
        )}
      </QueryView>
    </div>
  );
}
