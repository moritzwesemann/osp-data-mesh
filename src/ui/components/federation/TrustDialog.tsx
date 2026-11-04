import { useState } from 'react';
import type { Peer } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import { useFieldErrors } from '../../lib/errors.ts';
import { useApiMutation } from '../../lib/query.ts';
import { Dialog } from '../Dialog.tsx';
import { ErrorMessage } from '../ErrorMessage.tsx';
import { Checkbox, FormField } from '../FormField.tsx';
import { useToast } from '../Toast.tsx';
import { normalizeFingerprint } from './fingerprint.ts';

/**
 * Vertrauen bestätigen (peers.trust): Der telefonisch abgeglichene Fingerprint muss eingegeben werden.
 * Gesendet wird die Eingabe; der Server prüft die Übereinstimmung.
 */
export function TrustDialog({ peer, onClose }: { peer: Peer | null; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [checked, setChecked] = useState(false);
  const trust = useApiMutation('peers.trust', {
    invalidate: ['peers.list'],
    onSuccess: (p) => {
      toast.success(t('partners.trusted', { name: p.displayName }));
      close();
    },
  });
  const fe = useFieldErrors(trust.error);

  const close = () => {
    setTyped('');
    setChecked(false);
    trust.reset();
    onClose();
  };

  const entered = typed.trim();
  const matches = peer ? normalizeFingerprint(entered) === normalizeFingerprint(peer.fingerprint) : false;
  const hint = entered === '' ? undefined : matches ? t('partners.fingerprintMatches') : undefined;
  const mismatch = entered !== '' && !matches ? t('partners.fingerprintDiffers') : undefined;

  return (
    <Dialog
      open={peer !== null}
      onClose={close}
      title={peer ? t('partners.trustTitle', { name: peer.displayName }) : t('partners.trust')}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={trust.isPending}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!peer || entered.length < 16 || !checked || trust.isPending}
            onClick={() => peer && trust.mutate({ params: { id: peer.id }, body: { fingerprint: entered } })}
          >
            {trust.isPending ? t('common.saving') : t('partners.trustSubmit')}
          </button>
        </>
      }
    >
      {peer && (
        <>
          <p>{t('partners.trustIntro')}</p>
          <div className="stack-sm">
            <span className="field-label">{t('partners.storedFingerprint')}</span>
            <p className="fingerprint">{peer.fingerprint}</p>
            <p className="small muted">
              {peer.displayName} · <span className="mono">{peer.nodeId}</span> ·{' '}
              <span className="break">{peer.baseUrl}</span>
            </p>
          </div>
          <FormField
            label={t('partners.confirmedFingerprint')}
            required
            hint={hint}
            error={fe('fingerprint') ?? mismatch}
          >
            {(a) => (
              <input
                {...a}
                className="input mono"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            )}
          </FormField>
          <Checkbox label={t('partners.phoneChecked')} checked={checked} onChange={setChecked} />
          {trust.error && <ErrorMessage error={trust.error} showFields={false} />}
        </>
      )}
    </Dialog>
  );
}
