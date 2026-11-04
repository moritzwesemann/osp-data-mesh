import { type FormEvent, useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { ApiError } from '../lib/api.ts';
import { reasonText, useFieldErrors } from '../lib/errors.ts';
import { useApiMutation } from '../lib/query.ts';
import { ErrorMessage } from './ErrorMessage.tsx';
import { FormActions, FormField } from './FormField.tsx';

/** Eigenes Passwort ändern (auth.changePassword); genutzt beim erzwungenen Wechsel und im Konto. */
export function PasswordChangeForm({ onDone }: { onDone: () => void }) {
  const i = useI18n();
  const { t } = i;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const change = useApiMutation('auth.changePassword', {
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setRepeat('');
      onDone();
    },
  });
  const fe = useFieldErrors(change.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 12) return setLocalError(t('auth.passwordTooShort'));
    if (next !== repeat) return setLocalError(t('auth.passwordMismatch'));
    setLocalError(null);
    change.mutate({ body: { currentPassword: current, newPassword: next } });
  };

  const serverError = change.error;
  const wrongCurrent =
    serverError instanceof ApiError &&
    (serverError.code === 'invalid_credentials' || serverError.reason === 'wrong_password');
  // Passwortregel verletzt: Grund (too_short, equals_email, equals_current) direkt am neuen Passwort
  const weakReason =
    serverError instanceof ApiError && serverError.code === 'password_too_weak'
      ? (reasonText(i, serverError.reason) ?? t('errors.password_too_weak'))
      : undefined;

  return (
    <form className="form" onSubmit={submit} noValidate>
      <FormField
        label={t('auth.currentPassword')}
        required
        error={fe('currentPassword') ?? (wrongCurrent ? t('reasons.wrong_password') : undefined)}
      >
        {(a) => (
          <input
            {...a}
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label={t('auth.newPassword')}
        required
        hint={t('auth.passwordHint')}
        error={fe('newPassword') ?? weakReason}
      >
        {(a) => (
          <input
            {...a}
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        )}
      </FormField>
      <FormField label={t('auth.repeatPassword')} required error={localError ?? undefined}>
        {(a) => (
          <input
            {...a}
            className="input"
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        )}
      </FormField>
      {serverError && !wrongCurrent && !weakReason && <ErrorMessage error={serverError} showFields={false} />}
      <FormActions>
        <button type="submit" className="btn btn-primary" disabled={change.isPending || !current || !next}>
          {change.isPending ? t('common.saving') : t('auth.savePassword')}
        </button>
      </FormActions>
    </form>
  );
}
