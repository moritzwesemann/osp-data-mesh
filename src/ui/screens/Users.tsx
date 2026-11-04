import { type FormEvent, useState } from 'react';
import { ROLES, type Role } from '../../shared/contract/index.ts';
import { ConfirmDialog, Dialog } from '../components/Dialog.tsx';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { Checkbox, Fieldset, FormActions, FormField } from '../components/FormField.tsx';
import { DateTime } from '../components/Misc.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { QueryView } from '../components/QueryState.tsx';
import { Badge, RoleBadge, StatusBadge } from '../components/StatusBadge.tsx';
import { Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { type Lang, useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { useFieldErrors } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type User = ApiOutput<'users.list'>['items'][number];

function isLocked(u: User): boolean {
  return u.lockedUntil !== null && new Date(u.lockedUntil).getTime() > Date.now();
}

/** /benutzer – Benutzer anlegen, Rollen ändern, aktivieren/deaktivieren, entsperren, Passwort zurücksetzen. */
export function Users() {
  const { t, fmt } = useI18n();
  const s = useSession();
  const toast = useToast();
  const list = useApiQuery('users.list', {});
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [deactivating, setDeactivating] = useState<User | null>(null);

  const update = useApiMutation('users.update', { invalidate: ['users.list'] });

  const setActive = (u: User, active: boolean) =>
    update.mutate(
      { params: { id: u.id }, body: { active } },
      {
        onSuccess: () => {
          setDeactivating(null);
          toast.success(active ? t('users.activated') : t('users.deactivated'));
        },
      },
    );

  const unlock = (u: User) =>
    update.mutate(
      { params: { id: u.id }, body: { unlock: true } },
      { onSuccess: () => toast.success(t('users.unlocked')) },
    );

  return (
    <div className="page">
      <PageHeader
        title={t('users.title')}
        description={t('users.intro')}
        actions={
          s.can('users.create') && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              {t('users.create')}
            </button>
          )
        }
      />
      {update.error && !deactivating && <ErrorMessage error={update.error} />}
      <QueryView query={list}>
        {(data) => (
          <Table
            caption={t('users.title')}
            rows={data.items}
            rowKey={(u) => u.id}
            empty={t('users.empty')}
            columns={[
              {
                key: 'name',
                header: t('users.name'),
                render: (u) => (
                  <span className="stack-sm">
                    <span>
                      {u.displayName}
                      {u.id === s.user.id && <span className="muted"> ({t('users.you')})</span>}
                    </span>
                    <span className="small muted break">{u.email}</span>
                  </span>
                ),
              },
              {
                key: 'roles',
                header: t('users.roles'),
                render: (u) => (
                  <div className="badges">
                    {u.roles.map((r) => (
                      <RoleBadge key={r} role={r} />
                    ))}
                  </div>
                ),
              },
              {
                key: 'status',
                header: t('users.status'),
                render: (u) => (
                  <div className="badges">
                    <StatusBadge group="activeState" value={u.active ? 'active' : 'inactive'} />
                    {isLocked(u) && (
                      <Badge
                        tone="warning"
                        title={t('users.lockedUntil', { time: fmt.dateTime(u.lockedUntil) })}
                      >
                        {t('activeState.locked')}
                      </Badge>
                    )}
                    {u.mustChangePassword && <Badge tone="info">{t('users.mustChange')}</Badge>}
                  </div>
                ),
              },
              {
                key: 'login',
                header: t('users.lastLogin'),
                className: 'nowrap',
                render: (u) => (u.lastLoginAt ? <DateTime value={u.lastLoginAt} /> : t('users.never')),
              },
              {
                key: 'actions',
                header: <span className="sr-only">{t('common.actions')}</span>,
                render: (u) => (
                  <div className="row">
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(u)}>
                      {t('users.edit')}
                    </button>
                    {s.can('users.resetPassword') && (
                      <button type="button" className="btn btn-sm" onClick={() => setResetting(u)}>
                        {t('users.resetPassword')}
                      </button>
                    )}
                    {isLocked(u) && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={update.isPending}
                        onClick={() => unlock(u)}
                      >
                        {t('users.unlock')}
                      </button>
                    )}
                    {u.active ? (
                      u.id !== s.user.id && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger-outline"
                          onClick={() => {
                            update.reset();
                            setDeactivating(u);
                          }}
                        >
                          {t('users.deactivate')}
                        </button>
                      )
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={update.isPending}
                        onClick={() => setActive(u, true)}
                      >
                        {t('users.activate')}
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </QueryView>

      <Dialog open={creating} onClose={() => setCreating(false)} title={t('users.create')} size="lg">
        <UserForm
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            toast.success(t('users.created'));
          }}
        />
      </Dialog>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={t('users.editTitle')} size="lg">
        {editing && (
          <UserForm
            user={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              toast.success(t('users.saved'));
            }}
          />
        )}
      </Dialog>

      <Dialog open={resetting !== null} onClose={() => setResetting(null)} title={t('users.resetTitle')}>
        {resetting && (
          <ResetPasswordForm
            user={resetting}
            onCancel={() => setResetting(null)}
            onDone={() => {
              setResetting(null);
              toast.success(t('users.resetDone'));
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deactivating !== null}
        title={t('users.deactivateTitle')}
        message={t('users.deactivateConfirm', { name: deactivating?.displayName ?? '' })}
        confirmLabel={t('users.deactivate')}
        destructive
        busy={update.isPending}
        error={update.error}
        onCancel={() => setDeactivating(null)}
        onConfirm={() => deactivating && setActive(deactivating, false)}
      />
    </div>
  );
}

function RolePicker({
  value,
  onChange,
  error,
}: {
  value: readonly Role[];
  onChange: (roles: Role[]) => void;
  error?: string;
}) {
  const { t } = useI18n();
  return (
    <Fieldset legend={t('users.roles')} hint={t('users.rolesHint')} error={error}>
      <div className="stack">
        {ROLES.map((r) => (
          <Checkbox
            key={r}
            label={t(`roles.${r}`)}
            hint={t(`roleDescriptions.${r}`)}
            checked={value.includes(r)}
            onChange={(on) => onChange(on ? [...value, r] : value.filter((x) => x !== r))}
          />
        ))}
      </div>
    </Fieldset>
  );
}

function UserForm({ user, onCancel, onSaved }: { user?: User; onCancel: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState(user?.email ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [roles, setRoles] = useState<Role[]>(user ? [...user.roles] : []);
  const [locale, setLocale] = useState<Lang>(user?.locale ?? 'de');
  const [password, setPassword] = useState('');
  const create = useApiMutation('users.create', { invalidate: ['users.list'], onSuccess: onSaved });
  const update = useApiMutation('users.update', { invalidate: ['users.list'], onSuccess: onSaved });
  const error = user ? update.error : create.error;
  const busy = create.isPending || update.isPending;
  const fe = useFieldErrors(error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (user) {
      update.mutate({ params: { id: user.id }, body: { displayName: displayName.trim(), roles, locale } });
    } else {
      create.mutate({
        body: { email: email.trim(), displayName: displayName.trim(), roles, password, locale },
      });
    }
  };

  return (
    <form className="form form-wide" onSubmit={submit} noValidate>
      <div className="form-grid">
        <FormField label={t('users.name')} required error={fe('displayName')}>
          {(a) => (
            <input
              {...a}
              className="input"
              maxLength={200}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}
        </FormField>
        <FormField label={t('users.email')} required={!user} error={fe('email')}>
          {(a) => (
            <input
              {...a}
              className="input"
              type="email"
              autoComplete="off"
              disabled={Boolean(user)}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </FormField>
        {!user && (
          <FormField
            label={t('users.initialPassword')}
            required
            hint={t('users.initialPasswordHint')}
            error={fe('password')}
          >
            {(a) => (
              <input
                {...a}
                className="input"
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </FormField>
        )}
        <FormField label={t('users.language')} error={fe('locale')}>
          {(a) => (
            <select
              {...a}
              className="input"
              value={locale}
              onChange={(e) => setLocale(e.target.value as Lang)}
            >
              <option value="de">{t('account.languageDe')}</option>
              <option value="en">{t('account.languageEn')}</option>
            </select>
          )}
        </FormField>
        <div className="span-2">
          <RolePicker value={roles} onChange={setRoles} error={fe('roles')} />
        </div>
      </div>
      {error && <ErrorMessage error={error} showFields={false} />}
      <FormActions>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            busy ||
            roles.length === 0 ||
            !displayName.trim() ||
            (!user && (!email.trim() || password.length < 12))
          }
        >
          {busy ? t('common.saving') : user ? t('common.save') : t('users.create')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </FormActions>
    </form>
  );
}

function ResetPasswordForm({
  user,
  onCancel,
  onDone,
}: {
  user: User;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const reset = useApiMutation('users.resetPassword', { invalidate: ['users.list'], onSuccess: onDone });
  const fe = useFieldErrors(reset.error);
  return (
    <form
      className="form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        reset.mutate({ params: { id: user.id }, body: { password } });
      }}
    >
      <p>
        <strong>{user.displayName}</strong> <span className="muted">({user.email})</span>
      </p>
      <p className="field-hint">{t('users.resetHint')}</p>
      <FormField label={t('users.newPassword')} required hint={t('auth.passwordHint')} error={fe('password')}>
        {(a) => (
          <input
            {...a}
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}
      </FormField>
      {reset.error && <ErrorMessage error={reset.error} showFields={false} />}
      <FormActions>
        <button type="submit" className="btn btn-primary" disabled={reset.isPending || password.length < 12}>
          {t('users.resetPassword')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </FormActions>
    </form>
  );
}
