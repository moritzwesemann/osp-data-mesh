import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import type { RouteId } from '../../shared/contract/index.ts';
import { Dialog } from '../components/Dialog.tsx';
import { DateTime, Tabs } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { Badge, CategoryBadge, ShareabilityBadge, SpecialCategoryBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type Entry = ApiOutput<'catalog.local'>['items'][number];
type Kind = Entry['kind'];
type KindTab = Kind | 'all';

const KIND_LINKS: Record<Kind, { path: string; route: RouteId }> = {
  source: { path: '/quellen/', route: 'connectors.get' },
  dataset: { path: '/datensaetze/', route: 'datasets.get' },
  product: { path: '/produkte/', route: 'products.get' },
};

/** /katalog – lokaler Metadatenkatalog mit Arten, Suche und Detailansicht. */
export function Catalog() {
  const { t } = useI18n();
  const session = useSession();
  const [kind, setKind] = useState<KindTab>('all');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Entry | null>(null);

  const catalog = useApiQuery(
    'catalog.local',
    { query: { q: q || undefined, kind: kind === 'all' ? undefined : kind } },
    { keepPrevious: true },
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQ(input.trim());
  };

  const columns: Column<Entry>[] = [
    {
      key: 'name',
      header: t('common.name'),
      render: (e) => (
        <button type="button" className="btn-link" onClick={() => setSelected(e)}>
          {e.name}
        </button>
      ),
    },
    {
      key: 'kind',
      header: t('catalog.kind'),
      render: (e) => <Badge tone="accent">{t(`catalogKind.${e.kind}`)}</Badge>,
    },
    { key: 'category', header: t('common.category'), render: (e) => <CategoryBadge category={e.category} /> },
    { key: 'version', header: t('common.version'), className: 'num', render: (e) => e.version },
    {
      key: 'share',
      header: t('common.shareability'),
      render: (e) => (
        <div className="badges">
          <ShareabilityBadge value={e.shareability} />
          <SpecialCategoryBadge show={e.specialCategory} />
        </div>
      ),
    },
    {
      key: 'updated',
      header: t('common.updatedAt'),
      className: 'nowrap',
      render: (e) => <DateTime value={e.updatedAt} />,
    },
  ];

  const tabs: { id: KindTab; label: string }[] = [
    { id: 'all', label: t('catalog.all') },
    { id: 'source', label: t('catalogKind.source') },
    { id: 'dataset', label: t('catalogKind.dataset') },
    { id: 'product', label: t('catalogKind.product') },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('catalog.title')}
        description={t('catalog.intro')}
        actions={
          session.can('discovery.search') ? (
            <Link to="/katalog/partner" className="btn">
              {t('catalog.partnerSearch')}
            </Link>
          ) : undefined
        }
      />
      <Section>
        <Tabs tabs={tabs} active={kind} onChange={setKind} label={t('catalog.kindLabel')} />
        <form className="toolbar" onSubmit={submit}>
          <div className="field field-grow">
            <label className="field-label" htmlFor="catalog-q">
              {t('catalog.searchLabel')}
            </label>
            <input
              id="catalog-q"
              className="input"
              type="search"
              value={input}
              placeholder={t('common.searchPlaceholder')}
              onChange={(e) => {
                setInput(e.target.value);
                if (e.target.value === '') setQ('');
              }}
            />
          </div>
          <button type="submit" className="btn">
            {t('common.search')}
          </button>
        </form>
        <QueryView query={catalog}>
          {(data) => (
            <Table
              columns={columns}
              rows={data.items}
              rowKey={(e) => `${e.kind}:${e.id}`}
              caption={t('catalog.title')}
              empty={q || kind !== 'all' ? t('catalog.empty') : t('catalog.emptyAll')}
            />
          )}
        </QueryView>
      </Section>
      <EntryDialog entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function EntryDialog({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const { t } = useI18n();
  const session = useSession();

  const link = (kind: Kind, id: string, name: string) => {
    const target = KIND_LINKS[kind];
    return session.can(target.route) ? (
      <Link to={`${target.path}${id}`} onClick={onClose}>
        {name}
      </Link>
    ) : (
      <span>{name}</span>
    );
  };

  return (
    <Dialog open={entry !== null} onClose={onClose} title={entry?.name ?? ''} size="lg">
      {entry && (
        <div className="stack">
          <div className="badges">
            <Badge tone="accent">{t(`catalogKind.${entry.kind}`)}</Badge>
            <CategoryBadge category={entry.category} />
            <Badge>{t('common.versionN', { version: entry.version })}</Badge>
            <ShareabilityBadge value={entry.shareability} />
            <SpecialCategoryBadge show={entry.specialCategory} />
          </div>
          <p className="small muted">
            {t('catalog.slug')}: <span className="mono">{entry.slug}</span> · {t('common.updatedAt')}:{' '}
            <DateTime value={entry.updatedAt} />
          </p>
          <p>{entry.description || <span className="muted">{t('catalog.noDescription')}</span>}</p>
          {session.can(KIND_LINKS[entry.kind].route) && (
            <p>
              <Link to={`${KIND_LINKS[entry.kind].path}${entry.id}`} onClick={onClose}>
                {t('catalog.openEntry')}
              </Link>
            </p>
          )}

          <h3>{t('catalog.fields')}</h3>
          <Table
            columns={[
              { key: 'key', header: t('catalog.key'), render: (f) => <span className="mono">{f.key}</span> },
              { key: 'label', header: t('catalog.label'), render: (f) => f.label },
              { key: 'type', header: t('common.type'), render: (f) => t(`fieldTypes.${f.type}`) },
              { key: 'unit', header: t('common.unit'), render: (f) => f.unit ?? t('common.empty') },
            ]}
            rows={entry.fields}
            rowKey={(f) => f.key}
            caption={t('catalog.fields')}
            empty={t('catalog.fieldsEmpty')}
          />

          {entry.kind === 'source' && (
            <>
              <h3>{t('catalog.mappings')}</h3>
              <Table
                columns={[
                  {
                    key: 'source',
                    header: t('catalog.mappingSource'),
                    render: (m) => <span className="mono">{m.source}</span>,
                  },
                  {
                    key: 'target',
                    header: t('catalog.mappingTarget'),
                    render: (m) => <span className="mono">{m.target}</span>,
                  },
                ]}
                rows={entry.mappings}
                rowKey={(m) => `${m.source}→${m.target}`}
                caption={t('catalog.mappings')}
                empty={t('common.none')}
              />
            </>
          )}

          <h3>{t('catalog.related')}</h3>
          {entry.related.length === 0 ? (
            <EmptyState message={t('catalog.relatedEmpty')} />
          ) : (
            <ul className="list-plain list-divided">
              {entry.related.map((r) => (
                <li key={`${r.kind}:${r.id}`} className="row">
                  <Badge tone="accent">{t(`catalogKind.${r.kind}`)}</Badge>
                  {link(r.kind, r.id, r.name)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
