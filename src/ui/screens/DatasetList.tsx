import { Link } from 'react-router';
import type { Dataset } from '../../shared/contract/index.ts';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { ShareabilityBadge, SpecialCategoryBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

/** /datensaetze – Strukturen mit Kategorie und Bestand; Art. 9 und „Nur intern“ als Hinweis am Namen. */
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
      render: (d) => (
        <span className="row">
          <Link to={`/datensaetze/${d.id}`}>{d.name}</Link>
          <SpecialCategoryBadge show={d.specialCategory} />
          {d.shareability === 'internal' && <ShareabilityBadge value={d.shareability} />}
        </span>
      ),
    },
    { key: 'category', header: t('datasets.category'), render: (d) => t(`categories.${d.category}`) },
    { key: 'fields', header: t('datasets.fieldsCount'), className: 'num', render: (d) => d.fields.length },
    {
      key: 'records',
      header: t('datasets.recordCount'),
      className: 'num',
      render: (d) => fmt.number(d.recordCount),
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
