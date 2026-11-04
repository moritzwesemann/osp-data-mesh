import { type ReactNode, useId } from 'react';
import { cx } from '../lib/util.ts';

export interface FieldA11y {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  required: boolean | undefined;
}

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** übersetzter Feldfehler */
  error?: string;
  required?: boolean;
  className?: string;
  /** Render-Funktion erhält id und ARIA-Attribute für das Eingabeelement */
  children: (a11y: FieldA11y) => ReactNode;
}

/**
 * Beschriftetes Eingabefeld mit Hinweis und Fehler.
 * Beispiel: <FormField label="Name" error={fe('name')}>{(a) => <input className="input" {...a} />}</FormField>
 */
export function FormField({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('field', error && 'field-invalid', className)}>
      <label className="field-label" htmlFor={id}>
        {label}
        {required && (
          <span className="field-required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined, required })}
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

interface CheckboxProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
  error?: string;
  className?: string;
}

export function Checkbox({ label, checked, onChange, hint, disabled, error, className }: CheckboxProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cx('checkbox-field', error && 'field-invalid', className)}>
      <div className="checkbox-row">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <label htmlFor={id}>{label}</label>
      </div>
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

export function Fieldset({
  legend,
  hint,
  error,
  children,
  className,
}: {
  legend: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cx('fieldset', error && 'field-invalid', className)}>
      <legend>{legend}</legend>
      {hint && <p className="field-hint">{hint}</p>}
      {children}
      {error && <p className="field-error">{error}</p>}
    </fieldset>
  );
}

/** Formular-Fußzeile mit Aktionen */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>;
}
