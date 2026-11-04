import { type ReactNode, useEffect } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/index.tsx';

interface Props {
  title: ReactNode;
  /** Text für den Browser-Tab, falls title kein Text ist */
  docTitle?: string;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  /** Badges o. Ä. neben dem Titel */
  meta?: ReactNode;
}

export function useDocumentTitle(title: string | undefined) {
  const { t } = useI18n();
  useEffect(() => {
    const app = t('common.appName');
    document.title = title ? `${title} – ${app}` : app;
  }, [title, t]);
}

/** Seitenkopf: Rücklink, Titel (h1), Beschreibung, Aktionen. */
export function PageHeader({ title, docTitle, description, actions, back, meta }: Props) {
  useDocumentTitle(docTitle ?? (typeof title === 'string' ? title : undefined));
  return (
    <header className="page-header">
      {back && (
        <Link className="back-link" to={back.to}>
          <span aria-hidden="true">← </span>
          {back.label}
        </Link>
      )}
      <div className="page-header-row">
        <div className="page-header-text">
          <h1>{title}</h1>
          {meta && <div className="page-meta">{meta}</div>}
          {description && <p className="page-description">{description}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </header>
  );
}

/** Abschnitt als Karte mit Überschrift (h2) und optionalen Aktionen. */
export function Section({
  title,
  actions,
  description,
  children,
  id,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="card" id={id}>
      {(title || actions) && (
        <div className="card-header">
          {title && <h2 className="card-title">{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {description && <p className="card-description">{description}</p>}
      {children}
    </section>
  );
}
