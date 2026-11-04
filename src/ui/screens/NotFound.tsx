import { Link } from 'react-router';
import { PageHeader } from '../components/PageHeader.tsx';
import { useI18n } from '../i18n/index.tsx';

export function NotFound() {
  const { t } = useI18n();
  return (
    <div className="page page-narrow">
      <PageHeader title={t('common.notFoundTitle')} description={t('common.notFound')} />
      <p>
        <Link to="/" className="btn btn-primary">
          {t('common.toOverview')}
        </Link>
      </p>
    </div>
  );
}
