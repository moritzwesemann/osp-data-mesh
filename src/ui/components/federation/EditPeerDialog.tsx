import { type FormEvent, useState } from 'react';
import type { Peer } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import { useFieldErrors } from '../../lib/errors.ts';
import { useApiMutation } from '../../lib/query.ts';
import { Dialog } from '../Dialog.tsx';
import { ErrorMessage } from '../ErrorMessage.tsx';
import { FormField } from '../FormField.tsx';
import { useToast } from '../Toast.tsx';

/** Anzeigename oder Adresse eines Partners ändern (peers.update). */
export function EditPeerDialog({ peer, onClose }: { peer: Peer | null; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={peer !== null} onClose={onClose} title={t('partners.editTitle')}>
      {peer && <EditPeerForm key={peer.id} peer={peer} onClose={onClose} />}
    </Dialog>
  );
}

function EditPeerForm({ peer, onClose }: { peer: Peer; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [displayName, setDisplayName] = useState(peer.displayName);
  const [baseUrl, setBaseUrl] = useState(peer.baseUrl);
  const update = useApiMutation('peers.update', {
    invalidate: ['peers.list'],
    onSuccess: () => {
      toast.success(t('partners.updated'));
      onClose();
    },
  });
  const fe = useFieldErrors(update.error);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: { displayName?: string; baseUrl?: string } = {};
    if (displayName.trim() !== peer.displayName) body.displayName = displayName.trim();
    if (baseUrl.trim() !== peer.baseUrl) body.baseUrl = baseUrl.trim();
    if (Object.keys(body).length === 0) return onClose();
    update.mutate({ params: { id: peer.id }, body });
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <FormField label={t('partners.displayName')} required error={fe('displayName')}>
        {(a) => (
          <input
            {...a}
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        )}
      </FormField>
      <FormField label={t('partners.baseUrl')} required error={fe('baseUrl')}>
        {(a) => (
          <input
            {...a}
            className="input"
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        )}
      </FormField>
      {update.error && <ErrorMessage error={update.error} showFields={false} />}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={update.isPending || !displayName.trim()}>
          {update.isPending ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={update.isPending}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
