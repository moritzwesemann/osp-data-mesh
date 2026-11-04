import { Link } from 'react-router';
import type { Dataset } from '../../shared/contract/index.ts';
import { DateTime } from '../components/Misc.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { CategoryBadge, ShareabilityBadge, SpecialCategoryBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

/** /datensaetze – Strukturen mit Kategorie, Art.-9-Kennzeichen, Teilbarkeit und Bestand. */
export function DatasetList() {
  const { t, fmt } = useI18n();
  const session = useSession();
  const list = useApiQuery('datasets.list', {});

  const createButton = session.can('datasets.create') ? (
    <Link to="/datensaetze/neu" className="btn btn-primary">
      {t('datasets.create')}
    </Link>
  ) : null;

  const columns: Column<Dataset>[] = [
    {
      key: 'name',
      header: t('datasets.name'),
      render: (d) => <Link to={`/datensaetze/${d.id}`}>{d.name}</Link>,
    },
    { key: 'slug', header: t('datasets.slug'), className: 'mono', render: (d) => d.slug },
    {
      key: 'category',
      header: t('datasets.category'),
      render: (d) => (
        <div className="badges">
          <CategoryBadge category={d.category} />
          <SpecialCategoryBadge show={d.specialCategory} />
        </div>
      ),
    },
    {
      key: 'share',
      header: t('datasets.shareability'),
      render: (d) => <ShareabilityBadge value={d.shareability} />,
    },
    { key: 'version', header: t('datasets.version'), className: 'num', render: (d) => d.version },
    { key: 'fields', header: t('datasets.fieldsCount'), className: 'num', render: (d) => d.fields.length },
    {
      key: 'records',
      header: t('datasets.recordCount'),
      className: 'num',
      render: (d) => fmt.number(d.recordCount),
    },
    {
      key: 'updated',
      header: t('datasets.updatedAt'),
      className: 'nowrap',
      render: (d) => <DateTime value={d.updatedAt} />,
    },
  ];

  return (
    <div className="page">
      <PageHeader title={t('datasets.title')} description={t('datasets.intro')} actions={createButton} />
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState message={t('datasets.empty')} action={createButton} />
          ) : (
            <Table
              columns={columns}
              rows={data.items}
              rowKey={(d) => d.id}
              caption={t('datasets.listCaption')}
            />
          )
        }
      </QueryView>
    </div>
  );
}
