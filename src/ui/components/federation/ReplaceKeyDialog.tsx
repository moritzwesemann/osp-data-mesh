import { type ChangeEvent, useState } from 'react';
import { NodeCard, type Peer } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import { useApiMutation } from '../../lib/query.ts';
import { Dialog } from '../Dialog.tsx';
import { ErrorMessage } from '../ErrorMessage.tsx';
import { FormField } from '../FormField.tsx';
import { DescriptionList, Details } from '../Misc.tsx';
import { useToast } from '../Toast.tsx';

function parseCard(text: string): NodeCard | null {
  if (!text.trim()) return null;
  try {
    const r = NodeCard.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * Neuen Schlüssel eines Partners eintragen (peers.replaceKey): wenn der Partner die Rotationsmitteilung
 * verpasst oder seinen Schlüssel wegen Kompromittierung ohne Mitteilung gewechselt hat. Danach ist der
 * Partner „ausstehend“, bis der neue Fingerprint telefonisch abgeglichen und das Vertrauen bestätigt ist.
 */
export function ReplaceKeyDialog({
  peer,
  onClose,
  onReplaced,
}: {
  peer: Peer | null;
  onClose: () => void;
  /** danach Vertrauen bestätigen (Fingerprint-Abgleich) */
  onReplaced: (peer: Peer) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [text, setText] = useState('');
  const replace = useApiMutation('peers.replaceKey', {
    invalidate: ['peers.list'],
    onSuccess: (p) => {
      toast.success(t('partners.keyReplaced', { name: p.displayName }));
      close();
      onReplaced(p);
    },
  });

  const close = () => {
    setText('');
    replace.reset();
    onClose();
  };

  const card = parseCard(text);
  const invalid = text.trim() !== '' && !card;
  const otherNode = card && peer && card.nodeId !== peer.nodeId;

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
  };

  return (
    <Dialog
      open={peer !== null}
      onClose={close}
      title={peer ? t('partners.replaceKeyTitle', { name: peer.displayName }) : t('partners.replaceKey')}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={replace.isPending}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!peer || !card || Boolean(otherNode) || replace.isPending}
            onClick={() => peer && card && replace.mutate({ params: { id: peer.id }, body: { card } })}
          >
            {replace.isPending ? t('common.saving') : t('partners.replaceKeySubmit')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>{t('partners.replaceKeyIntro')}</p>
        <div className="alert alert-warning" role="note">
          <p>{t('partners.replaceKeyWarning')}</p>
        </div>
        <FormField label={t('partners.cardFile')}>
          {(a) => (
            <input {...a} className="input" type="file" accept=".json,application/json" onChange={onFile} />
          )}
        </FormField>
        <Details summary={t('partners.cardPaste')} defaultOpen={invalid}>
          <FormField label={t('partners.cardJson')} error={invalid ? t('partners.cardInvalid') : undefined}>
            {(a) => (
              <textarea
                {...a}
                className="input mono"
                rows={8}
                spellCheck={false}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </FormField>
        </Details>
        {peer && card && (
          <DescriptionList
            items={[
              [
                t('partners.replaceKeyCurrent'),
                <span key="cur" className="mono break">
                  {peer.fingerprint}
                </span>,
              ],
              [
                t('partners.replaceKeyNew'),
                <span key="new" className="mono break">
                  {card.fingerprint}
                </span>,
              ],
            ]}
          />
        )}
        {otherNode && (
          <p className="field-error" role="alert">
            {t('partners.replaceKeyOtherNode', { nodeId: card.nodeId })}
          </p>
        )}
        {replace.error && <ErrorMessage error={replace.error} />}
      </div>
    </Dialog>
  );
}
