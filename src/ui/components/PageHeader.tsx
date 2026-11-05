import { type ReactNode, useEffect, useId } from 'react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/index.tsx';
import { cx } from '../lib/util.ts';
import { useDisclosure } from './Misc.tsx';

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

/**
 * Abschnitt als Karte mit Überschrift (h2) und optionalen Aktionen.
 * collapsible: zuklappbar (Standard zu, defaultOpen öffnet); Aktionen stehen dann im aufgeklappten Teil.
 */
export function Section({
  title,
  actions,
  description,
  children,
  id,
  collapsible = false,
  defaultOpen = false,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  id?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  if (collapsible && title) {
    return (
      <CollapsibleSection
        title={title}
        actions={actions}
        description={description}
        id={id}
        defaultOpen={defaultOpen}
      >
        {children}
      </CollapsibleSection>
    );
  }
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

/**
 * Zuklappbarer Abschnitt nach dem Muster „Überschrift mit Schaltfläche“ (h2 > button[aria-expanded]): Die
 * Überschrift bleibt für Screenreader eine Überschrift. Der Inhalt bleibt im DOM (hidden), damit Feldfehler darin
 * den Abschnitt automatisch öffnen können (useDisclosure).
 */
function CollapsibleSection({
  title,
  actions,
  description,
  children,
  id,
  defaultOpen,
}: {
  title: ReactNode;
  actions?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  id?: string;
  defaultOpen: boolean;
}) {
  const d = useDisclosure<HTMLElement>(defaultOpen);
  const bodyId = useId();
  return (
    <section ref={d.ref} className={cx('card card-collapsible', d.open && 'is-open')} id={id}>
      <h2 className="card-title">
        <button
          type="button"
          className="card-toggle"
          aria-expanded={d.open}
          aria-controls={bodyId}
          onClick={() => d.setOpen(!d.open)}
        >
          {title}
        </button>
      </h2>
      <div id={bodyId} className="card-collapsible-body" hidden={!d.open}>
        {description && <p className="card-description">{description}</p>}
        {actions && <div className="card-actions">{actions}</div>}
        {children}
      </div>
    </section>
  );
}
