import { type FormEvent, useId, useState } from 'react';
import { ConsentInput, DATA_CATEGORIES, type DataCategory } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import type { ApiError } from '../../lib/api.ts';
import { clientValidate, useFieldErrors } from '../../lib/errors.ts';
import { usePurposes } from '../../lib/purposes.ts';
import { useApiMutation } from '../../lib/query.ts';
import { todayBerlin } from '../../lib/util.ts';
import { Dialog } from '../Dialog.tsx';
import { ErrorMessage } from '../ErrorMessage.tsx';
import { FormField } from '../FormField.tsx';
import { useToast } from '../Toast.tsx';

/** Dialog „Einwilligung dokumentieren“ (consents.create). */
export function ConsentDialog({
  athleteId,
  open,
  onClose,
}: {
  athleteId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const create = useApiMutation('consents.create', {
    invalidate: ['athletes.get'],
  });
  const close = () => {
    create.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('athletes.consents.dialogTitle')}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={create.isPending}>
            {t('common.cancel')}
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <ConsentForm formId={formId} athleteId={athleteId} mutation={create} onDone={close} />
    </Dialog>
  );
}

type CreateMutation = ReturnType<typeof useApiMutation<'consents.create'>>;

function ConsentForm({
  formId,
  athleteId,
  mutation,
  onDone,
}: {
  formId: string;
  athleteId: string;
  mutation: CreateMutation;
  onDone: () => void;
}) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const purposes = usePurposes();
  const [purpose, setPurpose] = useState('');
  const [category, setCategory] = useState<DataCategory | '*'>('*');
  const [validFrom, setValidFrom] = useState(todayBerlin());
  const [validUntil, setValidUntil] = useState('');
  const [evidenceNote, setEvidenceNote] = useState('');
  const [clientError, setClientError] = useState<ApiError | null>(null);
  const fe = useFieldErrors(clientError, mutation.error);

  const active = (purposes.data?.items ?? []).filter((p) => p.active);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = clientValidate(ConsentInput, {
      purpose,
      dataCategory: category,
      validFrom,
      validUntil: validUntil || null,
      evidenceNote: evidenceNote.trim(),
    });
    if (!checked.ok) {
      setClientError(checked.error);
      return;
    }
    setClientError(null);
    mutation.mutate(
      { params: { id: athleteId }, body: checked.data },
      {
        onSuccess: () => {
          toast.success(t('athletes.consents.created'));
          onDone();
        },
      },
    );
  };

  return (
    <form id={formId} className="stack" onSubmit={submit} noValidate>
      <p className="muted">{t('athletes.consents.intro')}</p>
      <FormField label={t('athletes.consents.purpose')} required error={fe('purpose')}>
        {(a) => (
          <select {...a} className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="">{purposes.isPending ? t('common.loading') : t('common.select')}</option>
            <option value="*">{t('common.allPurposes')}</option>
            {active.map((p) => (
              <option key={p.code} value={p.code}>
                {lang === 'de' ? p.labelDe : p.labelEn}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {purposes.isError && <ErrorMessage error={purposes.error} onRetry={() => void purposes.refetch()} />}
      <FormField
        label={t('athletes.consents.category')}
        hint={t('athletes.consents.categoryHint')}
        error={fe('dataCategory')}
      >
        {(a) => (
          <select
            {...a}
            className="input"
            value={category}
            onChange={(e) => setCategory(e.target.value as DataCategory | '*')}
          >
            <option value="*">{t('common.allCategories')}</option>
            {DATA_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`categories.${c}`)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <div className="form-grid">
        <FormField label={t('athletes.consents.validFrom')} required error={fe('validFrom')}>
          {(a) => (
            <input
              {...a}
              className="input"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label={t('athletes.consents.validUntil')}
          hint={t('athletes.consents.validUntilHint')}
          error={fe('validUntil')}
        >
          {(a) => (
            <input
              {...a}
              className="input"
              type="date"
              min={validFrom || undefined}
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
            />
          )}
        </FormField>
      </div>
      <FormField
        label={t('athletes.consents.evidenceNote')}
        hint={t('athletes.consents.evidenceHint')}
        error={fe('evidenceNote')}
      >
        {(a) => (
          <textarea
            {...a}
            className="input"
            maxLength={1000}
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
          />
        )}
      </FormField>
      {(clientError ?? mutation.error) && (
        <ErrorMessage error={clientError ?? mutation.error} showFields={false} />
      )}
    </form>
  );
}
