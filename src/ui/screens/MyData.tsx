import { Link } from 'react-router';
import { MetaLine } from '../components/Misc.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { validityShort } from '../components/products/grantText.ts';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { SpecialCategoryBadge } from '../components/StatusBadge.tsx';
import { useI18n } from '../i18n/index.tsx';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiQuery } from '../lib/query.ts';

/**
 * /meine-daten – für die eigenen Rollen freigegebene Datenprodukte (access.list).
 * Karten zeigen nur das Wesentliche; Kategorie, Rolle und Datenzeitraum stehen in der Detailansicht.
 */
export function MyData() {
  const i = useI18n();
  const { t } = i;
  const purposeLabel = usePurposeLabel();
  const q = useApiQuery('access.list', {});

  return (
    <div className="page">
      <PageHeader title={t('myData.title')} description={t('myData.intro')} />
      <QueryView query={q}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState message={t('myData.empty')} />
          ) : (
            <div className="card-grid">
              {data.items.map((g) => (
                <Link key={g.releaseId} to={`/meine-daten/${g.releaseId}`} className="card link-card">
                  <h2 className="card-title">{g.product.name}</h2>
                  {g.product.specialCategory && (
                    <div className="badges">
                      <SpecialCategoryBadge />
                    </div>
                  )}
                  {g.product.description && <p className="muted clamp-2">{g.product.description}</p>}
                  <p className="small">
                    {t('myData.purposesLine', {
                      count: g.purposes.length,
                      list: g.purposes.map(purposeLabel).join(', '),
                    })}
                  </p>
                  <MetaLine
                    items={[
                      t('myData.columnsCount', { count: g.columns.length }),
                      validityShort(i, g),
                      g.requiresConsent && t('myData.consentShort'),
                    ]}
                  />
                </Link>
              ))}
            </div>
          )
        }
      </QueryView>
    </div>
  );
}
