import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { cx } from '../lib/util.ts';
import { ErrorMessage } from './ErrorMessage.tsx';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Modaler Dialog auf Basis von <dialog> (Fokusführung, Escape schließt).
 * Inhalt wird nur bei geöffnetem Dialog gerendert (Formularzustand beginnt jedes Mal neu).
 */
export function Dialog({ open, onClose, title, children, footer, size = 'md' }: DialogProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx('dialog', `dialog-${size}`)}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      {open && (
        <div className="dialog-inner">
          <div className="dialog-header">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="btn-icon" aria-label={t('common.close')} onClick={onClose}>
              ×
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmProps {
  open: boolean;
  title?: ReactNode;
  message: ReactNode;
  confirmLabel: string;
  /** rote Schaltfläche für zerstörende Aktionen */
  destructive?: boolean;
  busy?: boolean;
  error?: unknown;
  /** Starke Bestätigung: Wort muss eingetippt werden */
  requireWord?: string;
  /** zusätzliche Eingaben (z. B. Begründung) */
  children?: ReactNode;
  /** Bestätigen zusätzlich sperren (z. B. Begründung fehlt) */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Bestätigungsdialog für Widerrufen, Löschen, Sperren, Verwerfen. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  destructive,
  busy,
  error,
  requireWord,
  children,
  confirmDisabled,
  onConfirm,
  onCancel,
}: ConfirmProps) {
  const { t } = useI18n();
  const [typed, setTyped] = useState('');
  const inputId = useId();

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const blocked = busy || confirmDisabled || (requireWord !== undefined && typed.trim() !== requireWord);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title ?? t('common.confirmTitle')}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={destructive ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={blocked}
            onClick={onConfirm}
            aria-busy={busy || undefined}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack">
        <div>{message}</div>
        {children}
        {requireWord !== undefined && (
          <div className="field">
            <label className="field-label" htmlFor={inputId}>
              {t('common.typeToConfirm', { word: requireWord })}
            </label>
            <input
              id={inputId}
              className="input"
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        )}
        {error ? <ErrorMessage error={error} /> : null}
      </div>
    </Dialog>
  );
}
