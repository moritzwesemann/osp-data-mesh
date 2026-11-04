import { Link, useSearchParams } from 'react-router';
import { type Release, ReleaseStatus } from '../../shared/contract/index.ts';
import { DateTime } from '../components/Misc.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { PurposeList, RecipientLabel, validityText } from '../components/releases/ReleaseParts.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** /freigaben – Freigaben mit Status- und Produktfilter (releases.list). */
export function ReleaseList() {
  const i = useI18n();
  const { t } = i;
  const session = useSession();
  const [params, setParams] = useSearchParams();

  const statusParam = ReleaseStatus.safeParse(params.get('status'));
  const status = statusParam.success ? statusParam.data : undefined;
  const productParam = params.get('produkt') ?? '';
  const productId = UUID_RE.test(productParam) ? productParam : undefined;

  const releases = useApiQuery('releases.list', { query: { status, productId } }, { keepPrevious: true });
  const canProducts = session.can('products.list');
  const products = useApiQuery('products.list', {}, { enabled: canProducts });
  // Ohne Zugriff auf Datenprodukte (Revision): Produktauswahl aus allen Freigaben ableiten
  const allReleases = useApiQuery('releases.list', { query: {} }, { enabled: !canProducts });

  const productOptions: { id: string; name: string }[] = canProducts
    ? (products.data?.items ?? []).map((p) => ({ id: p.id, name: p.name }))
    : [...new Map((allReleases.data?.items ?? []).map((r) => [r.productId, r.productName])).entries()].map(
        ([id, name]) => ({ id, name }),
      );
  productOptions.sort((a, b) => a.name.localeCompare(b.name, i.locale));

  const setFilter = (key: 'status' | 'produkt', value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  };

  const canCreate = session.can('releases.create');
  const createHref = productId ? `/freigaben/neu?produkt=${productId}` : '/freigaben/neu';
  const filtered = Boolean(status || productId);

  const columns: Column<Release>[] = [
    {
      key: 'product',
      header: t('releases.colProduct'),
      render: (r) => <Link to={`/freigaben/${r.id}`}>{r.productName}</Link>,
    },
    {
      key: 'recipient',
      header: t('releases.colRecipient'),
      render: (r) => <RecipientLabel recipient={r.recipient} />,
    },
    {
      key: 'purposes',
      header: t('releases.colPurposes'),
      render: (r) => <PurposeList purposes={r.purposes} />,
    },
    {
      key: 'columns',
      header: t('releases.colColumns'),
      className: 'nowrap',
      render: (r) => t('releases.columnsCount', { count: r.columns.length }),
    },
    {
      key: 'validity',
      header: t('releases.colValidity'),
      render: (r) => <span className="small">{validityText(i, r.validFrom, r.validUntil)}</span>,
    },
    {
      key: 'consent',
      header: t('releases.colConsent'),
      className: 'nowrap',
      render: (r) => (r.requiresConsent ? t('releases.consentRequired') : t('releases.consentNotRequired')),
    },
    {
      key: 'status',
      header: t('releases.colStatus'),
      render: (r) => <StatusBadge group="releaseStatus" value={r.status} />,
    },
    {
      key: 'created',
      header: t('releases.colCreated'),
      className: 'nowrap',
      render: (r) => <DateTime value={r.createdAt} />,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('releases.title')}
        description={t('releases.intro')}
        actions={
          canCreate ? (
            <Link to={createHref} className="btn btn-primary">
              {t('releases.create')}
            </Link>
          ) : undefined
        }
      />
      {!canCreate && <p className="muted small">{t('releases.readOnlyHint')}</p>}

      <div className="toolbar">
        <div className="field">
          <label className="field-label" htmlFor="release-filter-status">
            {t('releases.filterStatus')}
          </label>
          <select
            id="release-filter-status"
            className="input"
            value={status ?? ''}
            onChange={(e) => setFilter('status', e.target.value)}
          >
            <option value="">{t('releases.allStatuses')}</option>
            {ReleaseStatus.options.map((s) => (
              <option key={s} value={s}>
                {t(`releaseStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-grow">
          <label className="field-label" htmlFor="release-filter-product">
            {t('releases.filterProduct')}
          </label>
          <select
            id="release-filter-product"
            className="input"
            value={productId ?? ''}
            onChange={(e) => setFilter('produkt', e.target.value)}
          >
            <option value="">{t('releases.allProducts')}</option>
            {productOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {productId && !productOptions.some((p) => p.id === productId) && (
              <option value={productId}>{productId}</option>
            )}
          </select>
        </div>
        {filtered && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setParams(new URLSearchParams(), { replace: true })}
          >
            {t('common.resetFilters')}
          </button>
        )}
      </div>

      <QueryView query={releases}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              message={filtered ? t('releases.emptyFiltered') : t('releases.empty')}
              action={
                canCreate && !filtered ? (
                  <Link to={createHref} className="btn btn-primary">
                    {t('releases.create')}
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <Table
              columns={columns}
              rows={data.items}
              rowKey={(r) => r.id}
              caption={t('releases.listCaption')}
            />
          )
        }
      </QueryView>
    </div>
  );
}
