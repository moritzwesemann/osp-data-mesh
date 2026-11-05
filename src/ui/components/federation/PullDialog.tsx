import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../../i18n/index.tsx';
import { usePurposeLabel } from '../../lib/purposes.ts';
import { useApiMutation } from '../../lib/query.ts';
import { Dialog } from '../Dialog.tsx';
import { ErrorMessage } from '../ErrorMessage.tsx';
import { FormField } from '../FormField.tsx';
import { useToast } from '../Toast.tsx';

export interface PullTarget {
  peerId: string;
  releaseId: string;
  purposes: readonly string[];
  productName: string;
}

/** Freigegebenes Produkt bei einem Partner abrufen (received.pull) mit Zweckwahl. */
export function PullDialog({ target, onClose }: { target: PullTarget | null; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={target ? t('catalog.pullTitle', { name: target.productName }) : t('catalog.pull')}
    >
      {target && <PullForm key={target.releaseId} target={target} onClose={onClose} />}
    </Dialog>
  );
}

function PullForm({ target, onClose }: { target: PullTarget; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const purposeLabel = usePurposeLabel();
  const [purpose, setPurpose] = useState(target.purposes.length === 1 ? (target.purposes[0] ?? '') : '');
  const pull = useApiMutation('received.pull', {
    invalidate: ['received.list', 'received.get', 'received.rows'],
    onSuccess: (r) => {
      toast.success(t('catalog.pulled', { count: r.rowCount }));
      onClose();
      navigate(`/empfangen/${r.id}`);
    },
  });

  return (
    <div className="stack">
      <p className="muted">{t('catalog.pullIntro')}</p>
      {target.purposes.length === 1 ? (
        // Nur ein freigegebener Zweck: vorausgewählt, keine Auswahl nötig
        <p>
          <strong>{t('common.purpose')}:</strong> {purposeLabel(purpose)}
        </p>
      ) : (
        <FormField label={t('common.purpose')} required>
          {(a) => (
            <select {...a} className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              <option value="">{t('common.select')}</option>
              {target.purposes.map((p) => (
                <option key={p} value={p}>
                  {purposeLabel(p)}
                </option>
              ))}
            </select>
          )}
        </FormField>
      )}
      {pull.error && <ErrorMessage error={pull.error} />}
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!purpose || pull.isPending}
          onClick={() =>
            pull.mutate({ body: { peerId: target.peerId, releaseId: target.releaseId, purpose } })
          }
        >
          {pull.isPending ? t('catalog.pulling') : t('catalog.pullSubmit')}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={pull.isPending}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
