import { type FormEvent, useState } from 'react';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { FormField } from '../components/FormField.tsx';
import { useDocumentTitle } from '../components/PageHeader.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useFieldErrors } from '../lib/errors.ts';
import { useApiMutation } from '../lib/query.ts';
import { useReloadSession } from '../lib/session.tsx';

/** /anmelden – Anmeldung mit E-Mail und Passwort (auth.login). */
export function SignIn() {
  const { t } = useI18n();
  useDocumentTitle(t('auth.signInTitle'));
  const reload = useReloadSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useApiMutation('auth.login', { onSuccess: () => void reload() });
  const fe = useFieldErrors(login.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ body: { email: email.trim(), password } });
  };

  return (
    <div className="center-page">
      <main className="auth-card">
        <div className="auth-brand">
          <img src="/icon.svg" alt="" width={40} height={40} />
          <div>
            <div className="auth-brand-name">{t('common.appName')}</div>
          </div>
        </div>
        <div className="stack-sm">
          <h1>{t('auth.signInTitle')}</h1>
          <p className="muted">{t('auth.signInIntro')}</p>
        </div>
        <form className="form" onSubmit={submit} noValidate>
          <FormField label={t('auth.email')} required error={fe('email')}>
            {(a) => (
              <input
                {...a}
                className="input"
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('auth.password')} required error={fe('password')}>
            {(a) => (
              <input
                {...a}
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </FormField>
          {login.error && <ErrorMessage error={login.error} showFields={false} />}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={login.isPending || !email.trim() || !password}
          >
            {login.isPending ? t('auth.submitting') : t('auth.submit')}
          </button>
        </form>
      </main>
    </div>
  );
}
