import { Link } from 'react-router';
import { PageHeader } from '../components/PageHeader.tsx';
import { dataWindowText, validityText } from '../components/products/grantText.ts';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { Badge, CategoryBadge, SpecialCategoryBadge } from '../components/StatusBadge.tsx';
import { useI18n } from '../i18n/index.tsx';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiQuery } from '../lib/query.ts';

/** /meine-daten – für die eigenen Rollen freigegebene Datenprodukte (access.list). */
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
                  <div className="badges">
                    <CategoryBadge category={g.product.category} />
                    <SpecialCategoryBadge show={g.product.specialCategory} />
                    <Badge tone="accent">{t(`recipientRoles.${g.recipientRole}`)}</Badge>
                  </div>
                  {g.product.description && <p className="muted">{g.product.description}</p>}
                  <dl className="dl">
                    <div className="dl-row">
                      <dt>{t('common.purposes')}</dt>
                      <dd>{g.purposes.map(purposeLabel).join(', ')}</dd>
                    </div>
                    <div className="dl-row">
                      <dt>{t('common.columns')}</dt>
                      <dd>{t('myData.columnsCount', { count: g.columns.length })}</dd>
                    </div>
                    <div className="dl-row">
                      <dt>{t('myData.validity')}</dt>
                      <dd>{validityText(i, g)}</dd>
                    </div>
                    <div className="dl-row">
                      <dt>{t('myData.dataWindow')}</dt>
                      <dd>{dataWindowText(i, g)}</dd>
                    </div>
                  </dl>
                  {g.requiresConsent && <p className="small muted">{t('myData.consentRequired')}</p>}
                </Link>
              ))}
            </div>
          )
        }
      </QueryView>
    </div>
  );
}
