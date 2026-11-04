import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useDocumentTitle } from '../components/PageHeader.tsx';
import { PasswordChangeForm } from '../components/PasswordChangeForm.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import { type Me, useReloadSession, useSignOut } from '../lib/session.tsx';

/** Erzwungener Passwortwechsel (mustChangePassword) vor jeder weiteren Nutzung. */
export function ForcePasswordChange({ me }: { me: Me }) {
  const { t } = useI18n();
  useDocumentTitle(t('auth.forcedTitle'));
  const toast = useToast();
  const reload = useReloadSession();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  return (
    <div className="center-page">
      <main className="auth-card">
        <div className="auth-brand">
          <img src="/icon.svg" alt="" width={40} height={40} />
          <div>
            <div className="auth-brand-name">{t('common.appName')}</div>
            <div className="auth-brand-node">{me.node.displayName}</div>
          </div>
        </div>
        <div className="stack-sm">
          <h1>{t('auth.forcedTitle')}</h1>
          <p className="muted">{t('auth.forcedIntro')}</p>
          <p className="small muted">{me.user.email}</p>
        </div>
        <PasswordChangeForm
          onDone={() => {
            toast.success(t('auth.passwordChanged'));
            void reload();
          }}
        />
        <button
          type="button"
          className="btn-link small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await signOut();
            navigate('/anmelden', { replace: true });
          }}
        >
          {t('auth.signOutInstead')}
        </button>
      </main>
    </div>
  );
}
