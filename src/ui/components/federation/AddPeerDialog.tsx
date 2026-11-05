import { type ChangeEvent, useState } from 'react';
import { NodeCard } from '../../../shared/contract/index.ts';
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

/** Partner aus Knotenkarte aufnehmen (peers.add): Datei hochladen oder (aufklappbar) als Text einfügen. */
export function AddPeerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [text, setText] = useState('');
  const add = useApiMutation('peers.add', {
    invalidate: ['peers.list'],
    onSuccess: (peer) => {
      toast.success(t('partners.added', { name: peer.displayName }));
      close();
    },
  });

  const close = () => {
    setText('');
    add.reset();
    onClose();
  };

  const card = parseCard(text);
  const invalid = text.trim() !== '' && !card;

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('partners.addTitle')}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={add.isPending}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!card || add.isPending}
            onClick={() => card && add.mutate({ body: { card } })}
          >
            {add.isPending ? t('common.saving') : t('partners.addSubmit')}
          </button>
        </>
      }
    >
      <p>{t('partners.addIntro')}</p>
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
      {card && (
        <div className="stack-sm">
          <h3>{t('partners.cardSummary')}</h3>
          <DescriptionList
            items={[
              [t('partners.displayName'), card.displayName],
              [
                t('partners.nodeId'),
                <span key="node" className="mono">
                  {card.nodeId}
                </span>,
              ],
              [
                t('partners.baseUrl'),
                <span key="url" className="break">
                  {card.baseUrl}
                </span>,
              ],
              [
                t('common.fingerprint'),
                <span key="fp" className="mono break">
                  {card.fingerprint}
                </span>,
              ],
            ]}
          />
          <p className="field-hint">{t('partners.cardSummaryHint')}</p>
        </div>
      )}
      {add.error && <ErrorMessage error={add.error} />}
    </Dialog>
  );
}
