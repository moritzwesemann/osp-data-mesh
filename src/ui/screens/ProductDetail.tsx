import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { Product } from '../../shared/contract/index.ts';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { DateTime, DescriptionList, Details } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { conditionText, sourceText } from '../components/products/sources.ts';
import { QueryView } from '../components/QueryState.tsx';
import { ResultTable } from '../components/ResultTable.tsx';
import { ShareabilityBadge, SpecialCategoryBadge, StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useRememberVisit } from '../lib/recent.ts';
import { useSession } from '../lib/session.tsx';

type ProductColumn = Product['columns'][number];

/** /produkte/:id – Datenprodukt: Überblick, Spalten mit Basisfilter, Vorschau; Kennungen aufklappbar. */
export function ProductDetail() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const q = useApiQuery('products.get', { params: { id } });
  useRememberVisit('product', id, q.isSuccess);
  return (
    <div className="page">
      {!q.data && (
        <PageHeader
          title={t('products.listTitle')}
          back={{ to: '/produkte', label: t('products.backToList') }}
        />
      )}
      <QueryView query={q}>{(p) => <ProductView product={p} />}</QueryView>
    </div>
  );
}

function ProductView({ product: p }: { product: Product }) {
  const i = useI18n();
  const { t } = i;
  const session = useSession();
  const toast = useToast();
  const [retireOpen, setRetireOpen] = useState(false);
  const [previewOn, setPreviewOn] = useState(false);
  const active = p.status === 'active';

  const retire = useApiMutation('products.retire', {
    invalidate: ['products.list', 'products.get', 'releases.list', 'access.list', 'catalog.local'],
    onSuccess: () => {
      setRetireOpen(false);
      toast.success(t('products.retired'));
    },
  });

  const preview = useApiQuery(
    'products.preview',
    { params: { id: p.id }, query: { limit: 50 } },
    { enabled: previewOn, staleTime: 0 },
  );

  // Auf einen Blick: Bezeichnung, Typ, Einheit; Spaltenschlüssel und Feldpfade aufklappbar
  const columns: Column<ProductColumn>[] = [
    { key: 'label', header: t('products.columnLabel'), render: (c) => c.label },
    { key: 'type', header: t('common.type'), render: (c) => t(`fieldTypes.${c.type}`) },
    { key: 'unit', header: t('common.unit'), render: (c) => c.unit ?? t('common.empty') },
  ];
  const techColumns: Column<ProductColumn>[] = [
    { key: 'key', header: t('products.columnKey'), className: 'mono', render: (c) => c.key },
    { key: 'field', header: t('products.columnField'), render: (c) => sourceText(i, c.source, c.label) },
    { key: 'source', header: t('products.columnPath'), className: 'mono', render: (c) => c.source },
  ];

  const actions = (
    <>
      {active && session.can('releases.create') && (
        <Link to={`/freigaben/neu?produkt=${p.id}`} className="btn btn-primary">
          {t('products.release')}
        </Link>
      )}
      {active && session.can('products.update') && (
        <Link to={`/produkte/${p.id}/bearbeiten`} className="btn">
          {t('products.edit')}
        </Link>
      )}
      {active && session.can('products.retire') && (
        <button type="button" className="btn btn-danger-outline" onClick={() => setRetireOpen(true)}>
          {t('products.retire')}
        </button>
      )}
    </>
  );

  const source =
    p.sourceType === 'athletes' ? (
      t('products.sourceAthletes')
    ) : p.datasetId && session.can('datasets.get') ? (
      <Link to={`/datensaetze/${p.datasetId}`}>{p.datasetName ?? p.datasetId}</Link>
    ) : (
      (p.datasetName ?? t('common.empty'))
    );
  const releaseCount = t('products.activeReleasesN', { count: p.activeReleaseCount });

  return (
    <>
      <PageHeader
        title={p.name}
        back={{ to: '/produkte', label: t('products.backToList') }}
        description={p.description || undefined}
        actions={actions}
        meta={
          !active || p.specialCategory || p.shareability === 'internal' ? (
            <>
              {!active && <StatusBadge group="productStatus" value={p.status} />}
              <SpecialCategoryBadge show={p.specialCategory} />
              {p.shareability === 'internal' && <ShareabilityBadge value={p.shareability} />}
            </>
          ) : undefined
        }
      />

      {!active && (
        <div className="alert alert-info">
          <p>{t('products.retiredNotice')}</p>
        </div>
      )}

      <Section>
        <DescriptionList
          items={[
            [t('products.colSource'), source],
            [t('common.category'), t(`categories.${p.category}`)],
            [
              t('nav.releases'),
              session.can('releases.list') ? (
                <Link key="rel" to={`/freigaben?produkt=${p.id}`}>
                  {releaseCount}
                </Link>
              ) : (
                releaseCount
              ),
            ],
          ]}
        />
        {p.specialCategory && <p className="field-hint">{t('products.specialHint')}</p>}
      </Section>

      <Section title={t('products.columnsTable')}>
        <Table
          columns={columns}
          rows={p.columns}
          rowKey={(c) => c.key}
          caption={t('products.columnsTable')}
        />
        {p.filters.length === 0 ? (
          <p className="small muted">{t('products.filtersNone')}</p>
        ) : (
          <div className="stack-sm">
            <h3>{t('products.filtersTitle')}</h3>
            <p className="small muted">{t('products.filtersIntro')}</p>
            <ul>
              {p.filters.map((c) => {
                const text = conditionText(i, c, p.columns);
                return <li key={`${c.column}-${c.op}-${JSON.stringify(c.value ?? null)}`}>{text}</li>;
              })}
            </ul>
          </div>
        )}
      </Section>

      <Section
        title={t('products.previewTitle')}
        description={t('products.previewIntro')}
        actions={
          previewOn ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={preview.isFetching}
              onClick={() => void preview.refetch()}
            >
              {t('products.refreshPreview')}
            </button>
          ) : undefined
        }
      >
        {previewOn ? (
          <QueryView query={preview}>
            {(data) => (
              <div className="stack">
                <p className="small muted">
                  {t('products.previewStats', { returned: data.stats.returned, total: data.stats.total })}
                </p>
                <ResultTable
                  columns={data.columns}
                  rows={data.rows}
                  caption={t('products.previewTitle')}
                  numbered
                />
              </div>
            )}
          </QueryView>
        ) : (
          <p>
            <button type="button" className="btn" onClick={() => setPreviewOn(true)}>
              {t('products.loadPreview')}
            </button>
          </p>
        )}
      </Section>

      <Details>
        <DescriptionList
          items={[
            [
              t('products.slug'),
              <span key="slug" className="mono">
                {p.slug}
              </span>,
            ],
            [t('common.version'), p.version],
            [t('common.shareability'), t(`shareability.${p.shareability}`)],
            [t('common.createdAt'), <DateTime key="c" value={p.createdAt} />],
            [t('common.updatedAt'), <DateTime key="u" value={p.updatedAt} />],
          ]}
        />
        <Table
          columns={techColumns}
          rows={p.columns}
          rowKey={(c) => c.key}
          caption={t('products.columnsTechnical')}
        />
      </Details>

      <ConfirmDialog
        open={retireOpen}
        title={t('products.retireTitle')}
        message={<p>{t('products.retireConfirm', { name: p.name })}</p>}
        confirmLabel={t('products.retire')}
        destructive
        busy={retire.isPending}
        error={retire.error}
        onConfirm={() => retire.mutate({ params: { id: p.id } })}
        onCancel={() => {
          setRetireOpen(false);
          retire.reset();
        }}
      />
    </>
  );
}
