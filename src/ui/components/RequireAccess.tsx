import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { RouteId } from '../../shared/contract/index.ts';
import { useI18n } from '../i18n/index.tsx';
import { useSession } from '../lib/session.tsx';
import { PageHeader } from './PageHeader.tsx';

/** Zeigt den Inhalt nur, wenn mindestens eine der Routen für die Rollen erlaubt ist. */
export function RequireAccess({ routes, children }: { routes: readonly RouteId[]; children: ReactNode }) {
  const session = useSession();
  const { t } = useI18n();
  if (routes.length > 0 && !session.canAny(routes)) {
    return (
      <div className="page">
        <PageHeader title={t('common.noAccessTitle')} />
        <div className="alert alert-info">
          <p>{t('common.noAccess')}</p>
          <p>
            <Link to="/">{t('common.toOverview')}</Link>
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
