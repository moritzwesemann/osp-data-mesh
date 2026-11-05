import { type FormEvent, useState } from 'react';
import type { Connector } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import { useApiMutation } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';
import { ConfirmDialog } from '../Dialog.tsx';
import { ErrorMessage } from '../ErrorMessage.tsx';
import { FormActions, FormField } from '../FormField.tsx';
import { Section } from '../PageHeader.tsx';
import { useToast } from '../Toast.tsx';

/** true, wenn die Quelle ein Zugangsgeheimnis benötigt (HTTP-API mit Bearer, eigener Kopfzeile oder OAuth2). */
export function needsSecret(c: Pick<Connector, 'config'>): boolean {
  return c.config.type === 'http_api' && c.config.auth.type !== 'none';
}

/** Zugangsgeheimnis setzen oder entfernen (connectors.setSecret); wird nie angezeigt. Zugeklappt, solange eines hinterlegt ist. */
export function SecretSection({ connector }: { connector: Connector }) {
  const { t } = useI18n();
  const toast = useToast();
  const session = useSession();
  const [secret, setSecret] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const save = useApiMutation('connectors.setSecret', {
    invalidate: ['connectors.get', 'connectors.list'],
    onSuccess: (_d, input) => {
      setSecret('');
      setConfirmRemove(false);
      toast.success(input.body.secret === null ? t('connectors.secretRemoved') : t('connectors.secretSaved'));
    },
  });

  if (!needsSecret(connector) || !session.can('connectors.setSecret')) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!secret) return;
    save.mutate({ params: { id: connector.id }, body: { secret } });
  };

  return (
    <Section
      title={t('connectors.sectionSecret')}
      description={connector.hasSecret ? t('connectors.secretStored') : t('connectors.secretMissing')}
      collapsible
      defaultOpen={!connector.hasSecret}
    >
      <form className="form" onSubmit={submit} noValidate>
        <FormField
          label={
            connector.config.type === 'http_api' && connector.config.auth.type === 'oauth2_client_credentials'
              ? t('connectors.secretOauth')
              : t('connectors.secret')
          }
          hint={t('connectors.secretHint')}
        >
          {(a) => (
            <input
              {...a}
              className="input"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
        </FormField>
        {save.error && !confirmRemove && <ErrorMessage error={save.error} />}
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={!secret || save.isPending}>
            {connector.hasSecret ? t('connectors.replaceSecret') : t('connectors.setSecret')}
          </button>
          {connector.hasSecret && (
            <button
              type="button"
              className="btn btn-danger-outline"
              disabled={save.isPending}
              onClick={() => {
                save.reset();
                setConfirmRemove(true);
              }}
            >
              {t('connectors.removeSecret')}
            </button>
          )}
        </FormActions>
      </form>
      <ConfirmDialog
        open={confirmRemove}
        title={t('connectors.removeSecret')}
        message={t('connectors.removeSecretConfirm')}
        confirmLabel={t('common.remove')}
        destructive
        busy={save.isPending}
        error={save.error}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => save.mutate({ params: { id: connector.id }, body: { secret: null } })}
      />
    </Section>
  );
}
