import { useId, useState } from 'react';
import { useI18n } from '../../i18n/index.tsx';
import { useApiMutation } from '../../lib/query.ts';
import { Dialog } from '../Dialog.tsx';
import { ErrorMessage } from '../ErrorMessage.tsx';
import { Checkbox, FormField } from '../FormField.tsx';
import { useToast } from '../Toast.tsx';

type Mode = 'routine' | 'compromised';

/**
 * Knotenschlüssel wechseln (node.rotateKey). Zwei ausdrücklich getrennte Fälle (ADR 0013):
 *  - planmäßig: Partner werden mit einer Mitteilung benachrichtigt, die alter und neuer Schlüssel signieren;
 *  - Verdacht auf Kompromittierung: eine Mitteilung mit dem alten Schlüssel wäre nicht vertrauenswürdig –
 *    keine Benachrichtigung, Partner sperren und gleichen den neuen Fingerprint telefonisch ab.
 */
export function RotateKeyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const ids = useId();
  const [mode, setMode] = useState<Mode>('routine');
  const [graceDays, setGraceDays] = useState('7');
  const [confirmed, setConfirmed] = useState(false);
  const rotate = useApiMutation('node.rotateKey', {
    invalidate: ['node.card', 'node.keyStatus', 'system.status', 'outbox.list'],
    onSuccess: (s) => {
      toast.success(t('partners.rotated', { fingerprint: s.fingerprint }));
      close();
    },
  });

  const close = () => {
    setMode('routine');
    setGraceDays('7');
    setConfirmed(false);
    rotate.reset();
    onClose();
  };

  const days = Number(graceDays);
  const daysValid = Number.isInteger(days) && days >= 1 && days <= 30;
  const choose = (m: Mode) => {
    setMode(m);
    setConfirmed(false);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('partners.rotateTitle')}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={rotate.isPending}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={mode === 'compromised' ? 'btn btn-danger' : 'btn btn-primary'}
            disabled={!confirmed || (mode === 'routine' && !daysValid) || rotate.isPending}
            onClick={() =>
              rotate.mutate({
                body: { mode, confirm: true, ...(mode === 'routine' ? { graceDays: days } : {}) },
              })
            }
          >
            {rotate.isPending
              ? t('partners.rotating')
              : mode === 'compromised'
                ? t('partners.rotateSubmitCompromised')
                : t('partners.rotateSubmit')}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>{t('partners.rotateIntro')}</p>
        <fieldset className="stack-sm">
          <legend className="field-label">{t('partners.rotateMode')}</legend>
          <div className="checkbox-row">
            <input
              id={`${ids}-routine`}
              type="radio"
              name={`${ids}-mode`}
              checked={mode === 'routine'}
              onChange={() => choose('routine')}
            />
            <label htmlFor={`${ids}-routine`}>{t('partners.rotateRoutine')}</label>
          </div>
          <p className="field-hint">{t('partners.rotateRoutineHint')}</p>
          <div className="checkbox-row">
            <input
              id={`${ids}-compromised`}
              type="radio"
              name={`${ids}-mode`}
              checked={mode === 'compromised'}
              onChange={() => choose('compromised')}
            />
            <label htmlFor={`${ids}-compromised`}>{t('partners.rotateCompromised')}</label>
          </div>
          <p className="field-hint">{t('partners.rotateCompromisedHint')}</p>
        </fieldset>

        {mode === 'routine' ? (
          <>
            <FormField
              label={t('partners.graceDays')}
              hint={t('partners.graceDaysHint')}
              error={daysValid ? undefined : t('partners.graceDaysInvalid')}
            >
              {(a) => (
                <input
                  {...a}
                  className="input input-sm"
                  type="number"
                  min={1}
                  max={30}
                  value={graceDays}
                  onChange={(e) => setGraceDays(e.target.value)}
                />
              )}
            </FormField>
            <div className="alert alert-info">
              <p>{t('partners.rotateRoutineInfo')}</p>
            </div>
            <Checkbox
              label={t('partners.rotateConfirmRoutine')}
              checked={confirmed}
              onChange={setConfirmed}
            />
          </>
        ) : (
          <>
            <div className="alert alert-warning" role="note">
              <p className="alert-title">{t('partners.compromisedTitle')}</p>
              <ol className="stack-sm">
                <li>{t('partners.compromisedStep1')}</li>
                <li>{t('partners.compromisedStep2')}</li>
                <li>{t('partners.compromisedStep3')}</li>
                <li>{t('partners.compromisedStep4')}</li>
              </ol>
            </div>
            <Checkbox
              label={t('partners.rotateConfirmCompromised')}
              checked={confirmed}
              onChange={setConfirmed}
            />
          </>
        )}
        {rotate.error && <ErrorMessage error={rotate.error} />}
      </div>
    </Dialog>
  );
}
