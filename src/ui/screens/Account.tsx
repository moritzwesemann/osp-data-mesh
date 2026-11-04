import { type FormEvent, useState } from 'react';
import { ConfirmDialog, Dialog } from '../components/Dialog.tsx';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { FormField } from '../components/FormField.tsx';
import { CodeBlock, DateTime, DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { PasswordChangeForm } from '../components/PasswordChangeForm.tsx';
import { QueryView } from '../components/QueryState.tsx';
import { Badge, RoleBadge } from '../components/StatusBadge.tsx';
import { Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { useFieldErrors } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type Token = ApiOutput<'tokens.list'>['items'][number];

/** /konto – Profil, Sprache, Passwort, API-Tokens. */
export function Account() {
  const { t, lang, setLang } = useI18n();
  const s = useSession();
  const toast = useToast();

  return (
    <div className="page">
      <PageHeader title={t('account.title')} description={t('account.intro')} />
      <div className="grid-2">
        <Section title={t('account.profile')}>
          <DescriptionList
            items={[
              [t('account.displayName'), s.user.displayName],
              [t('account.email'), s.user.email],
              [
                t('account.roles'),
                <div key="roles" className="badges">
                  {s.roles.map((r) => (
                    <RoleBadge key={r} role={r} />
                  ))}
                </div>,
              ],
            ]}
          />
        </Section>
        <Section title={t('account.language')}>
          <fieldset className="fieldset">
            <legend className="sr-only">{t('account.language')}</legend>
            {(['de', 'en'] as const).map((l) => (
              <div className="checkbox-row" key={l}>
                <input
                  type="radio"
                  id={`lang-${l}`}
                  name="lang"
                  checked={lang === l}
                  onChange={() => setLang(l)}
                />
                <label htmlFor={`lang-${l}`} lang={l}>
                  {l === 'de' ? t('account.languageDe') : t('account.languageEn')}
                </label>
              </div>
            ))}
            <p className="field-hint">{t('account.languageHint')}</p>
          </fieldset>
        </Section>
      </div>
      <Section title={t('auth.changeTitle')}>
        <PasswordChangeForm onDone={() => toast.success(t('auth.passwordChanged'))} />
      </Section>
      <TokensSection />
    </div>
  );
}

function tokenState(tok: Token): 'active' | 'revoked' | 'expired' {
  if (tok.revokedAt) return 'revoked';
  if (tok.expiresAt && new Date(tok.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

function TokensSection() {
  const { t } = useI18n();
  const toast = useToast();
  const tokens = useApiQuery('tokens.list', {});
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Token | null>(null);

  const revoke = useApiMutation('tokens.revoke', {
    invalidate: ['tokens.list'],
    onSuccess: () => {
      setRevoking(null);
      toast.success(t('account.revoked'));
    },
  });

  return (
    <Section
      title={t('account.tokensTitle')}
      description={t('account.tokensIntro')}
      actions={
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          {t('account.createToken')}
        </button>
      }
    >
      <QueryView query={tokens}>
        {(data) => (
          <Table
            caption={t('account.tokensTitle')}
            rows={data.items}
            rowKey={(r) => r.id}
            empty={t('account.tokensEmpty')}
            columns={[
              { key: 'name', header: t('account.tokenName'), render: (r) => r.name },
              {
                key: 'prefix',
                header: t('account.prefix'),
                className: 'mono nowrap',
                render: (r) => `${r.prefix}…`,
              },
              {
                key: 'created',
                header: t('common.createdAt'),
                className: 'nowrap',
                render: (r) => <DateTime value={r.createdAt} />,
              },
              {
                key: 'expires',
                header: t('account.expires'),
                className: 'nowrap',
                render: (r) => (r.expiresAt ? <DateTime value={r.expiresAt} /> : t('account.never')),
              },
              {
                key: 'used',
                header: t('account.lastUsed'),
                className: 'nowrap',
                render: (r) => (r.lastUsedAt ? <DateTime value={r.lastUsedAt} /> : t('account.neverUsed')),
              },
              {
                key: 'state',
                header: t('common.status'),
                render: (r) => {
                  const st = tokenState(r);
                  if (st === 'revoked')
                    return <Badge tone="neutral">{t('account.tokenStatusRevoked')}</Badge>;
                  if (st === 'expired')
                    return <Badge tone="neutral">{t('account.tokenStatusExpired')}</Badge>;
                  return <Badge tone="success">{t('account.tokenStatusActive')}</Badge>;
                },
              },
              {
                key: 'actions',
                header: <span className="sr-only">{t('common.actions')}</span>,
                render: (r) =>
                  tokenState(r) === 'active' ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-outline"
                      onClick={() => {
                        revoke.reset();
                        setRevoking(r);
                      }}
                    >
                      {t('account.revoke')}
                    </button>
                  ) : null,
              },
            ]}
          />
        )}
      </QueryView>

      <CreateTokenDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(token) => {
          setCreating(false);
          setCreated(token);
          toast.success(t('account.tokenCreated'));
        }}
      />

      <Dialog open={created !== null} onClose={() => setCreated(null)} title={t('account.oneTimeTitle')}>
        <div className="alert alert-warning">
          <p>{t('account.oneTimeHint')}</p>
        </div>
        {created && <CodeBlock code={created} />}
        <p className="small muted">{t('account.usageHint')}</p>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        title={t('account.revokeTitle')}
        message={t('account.revokeConfirm', { name: revoking?.name ?? '' })}
        confirmLabel={t('account.revoke')}
        destructive
        busy={revoke.isPending}
        error={revoke.error}
        onCancel={() => setRevoking(null)}
        onConfirm={() => revoking && revoke.mutate({ params: { id: revoking.id } })}
      />
    </Section>
  );
}

function CreateTokenDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (token: string) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t('account.createToken')}>
      <CreateTokenForm onCancel={onClose} onCreated={onCreated} />
    </Dialog>
  );
}

function CreateTokenForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (token: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const create = useApiMutation('tokens.create', {
    invalidate: ['tokens.list'],
    onSuccess: (res) => onCreated(res.token),
  });
  const fe = useFieldErrors(create.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number.parseInt(days, 10);
    create.mutate({
      body: { name: name.trim(), expiresInDays: Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 90 },
    });
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <FormField label={t('account.tokenName')} hint={t('account.tokenNameHint')} required error={fe('name')}>
        {(a) => (
          <input
            {...a}
            className="input"
            maxLength={100}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </FormField>
      <FormField
        label={t('account.expiresInDays')}
        hint={t('account.expiresInDaysHint')}
        error={fe('expiresInDays')}
      >
        {(a) => (
          <input
            {...a}
            className="input"
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        )}
      </FormField>
      {create.error && <ErrorMessage error={create.error} showFields={false} />}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={create.isPending || !name.trim()}>
          {t('account.createToken')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
