import { type FormEvent, useId, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { type Athlete, AthleteInput, SQUAD_STATUSES, type SquadStatus } from '../../shared/contract/index.ts';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { FormActions, FormField } from '../components/FormField.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { QueryView } from '../components/QueryState.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiError } from '../lib/api.ts';
import { clientValidate, useFieldErrors } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { emptyToNull } from '../lib/util.ts';

const SEXES = ['f', 'm', 'd'] as const;
type SexValue = (typeof SEXES)[number];

interface FormState {
  lastName: string;
  firstName: string;
  dateOfBirth: string;
  sport: string;
  squadStatus: SquadStatus | '';
  sex: SexValue | '';
  club: string;
  discipline: string;
}

const EMPTY: FormState = {
  lastName: '',
  firstName: '',
  dateOfBirth: '',
  sport: '',
  squadStatus: '',
  sex: '',
  club: '',
  discipline: '',
};

function fromAthlete(a: Athlete): FormState {
  return {
    lastName: a.lastName,
    firstName: a.firstName,
    dateOfBirth: a.dateOfBirth,
    sport: a.sport,
    squadStatus: a.squadStatus,
    sex: a.sex ?? '',
    club: a.club ?? '',
    discipline: a.discipline ?? '',
  };
}

/** /athleten/neu und /athleten/:id/bearbeiten – Stammdaten anlegen oder ändern. */
export function AthleteForm() {
  const { id } = useParams();
  const athlete = useApiQuery('athletes.get', { params: { id: id ?? '' } }, { enabled: Boolean(id) });

  if (!id) return <AthleteFormBody initial={EMPTY} />;
  return (
    <div className="page page-narrow">
      <QueryView query={athlete}>
        {(a) => <AthleteFormBody id={id} initial={fromAthlete(a)} title={`${a.firstName} ${a.lastName}`} />}
      </QueryView>
    </div>
  );
}

function AthleteFormBody({ id, initial, title }: { id?: string; initial: FormState; title?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const datalistId = useId();
  const [form, setForm] = useState<FormState>(initial);
  const [clientError, setClientError] = useState<ApiError | null>(null);
  const sports = useApiQuery('athletes.sports', {}, { staleTime: 60_000 });
  const invalidate = ['athletes.list', 'athletes.get', 'athletes.sports'] as const;

  const create = useApiMutation('athletes.create', {
    invalidate,
    onSuccess: (a) => {
      toast.success(t('athletes.created'));
      navigate(`/athleten/${a.id}`);
    },
  });
  const update = useApiMutation('athletes.update', {
    invalidate,
    onSuccess: (a) => {
      toast.success(t('athletes.saved'));
      navigate(`/athleten/${a.id}`);
    },
  });
  const mutation = id ? update : create;
  const fe = useFieldErrors(clientError, mutation.error);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = {
      lastName: form.lastName,
      firstName: form.firstName,
      dateOfBirth: form.dateOfBirth,
      sport: form.sport,
      squadStatus: form.squadStatus,
      sex: form.sex === '' ? null : form.sex,
      club: emptyToNull(form.club),
      discipline: emptyToNull(form.discipline),
    };
    const checked = clientValidate(AthleteInput, body);
    if (!checked.ok) {
      setClientError(checked.error);
      return;
    }
    setClientError(null);
    if (id) update.mutate({ params: { id }, body: checked.data });
    else create.mutate({ body: checked.data });
  };

  const back = id
    ? { to: `/athleten/${id}`, label: t('athletes.backToDetail') }
    : { to: '/athleten', label: t('athletes.backToList') };

  const content = (
    <>
      <PageHeader
        title={id ? t('athletes.editTitle') : t('athletes.createTitle')}
        description={title}
        back={back}
      />
      <form className="form card" onSubmit={submit} noValidate>
        <div className="form-grid">
          <FormField label={t('athletes.lastName')} required error={fe('lastName')}>
            {(a) => (
              <input
                {...a}
                className="input"
                autoComplete="off"
                value={form.lastName}
                onChange={(e) => set('lastName', e.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('athletes.firstName')} required error={fe('firstName')}>
            {(a) => (
              <input
                {...a}
                className="input"
                autoComplete="off"
                value={form.firstName}
                onChange={(e) => set('firstName', e.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('athletes.dateOfBirth')} required error={fe('dateOfBirth')}>
            {(a) => (
              <input
                {...a}
                className="input"
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => set('dateOfBirth', e.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('athletes.sex')} error={fe('sex')}>
            {(a) => (
              <select
                {...a}
                className="input"
                value={form.sex}
                onChange={(e) => set('sex', e.target.value as SexValue | '')}
              >
                <option value="">{t('athletes.sexNone')}</option>
                {SEXES.map((s) => (
                  <option key={s} value={s}>
                    {t(`sex.${s}`)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('athletes.sport')} required hint={t('athletes.sportHint')} error={fe('sport')}>
            {(a) => (
              <>
                <input
                  {...a}
                  className="input"
                  list={datalistId}
                  autoComplete="off"
                  value={form.sport}
                  onChange={(e) => set('sport', e.target.value)}
                />
                <datalist id={datalistId}>
                  {(sports.data?.items ?? []).map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </>
            )}
          </FormField>
          <FormField label={t('athletes.squad')} required error={fe('squadStatus')}>
            {(a) => (
              <select
                {...a}
                className="input"
                value={form.squadStatus}
                onChange={(e) => set('squadStatus', e.target.value as SquadStatus | '')}
              >
                <option value="">{t('common.select')}</option>
                {SQUAD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`squad.${s}`)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('athletes.club')} error={fe('club')}>
            {(a) => (
              <input
                {...a}
                className="input"
                autoComplete="off"
                value={form.club}
                onChange={(e) => set('club', e.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('athletes.discipline')} error={fe('discipline')}>
            {(a) => (
              <input
                {...a}
                className="input"
                autoComplete="off"
                value={form.discipline}
                onChange={(e) => set('discipline', e.target.value)}
              />
            )}
          </FormField>
        </div>
        {(clientError ?? mutation.error) && (
          <ErrorMessage error={clientError ?? mutation.error} showFields={false} />
        )}
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? t('common.saving') : id ? t('common.save') : t('common.create')}
          </button>
          <button type="button" className="btn" onClick={() => navigate(back.to)}>
            {t('common.cancel')}
          </button>
        </FormActions>
      </form>
    </>
  );

  return id ? content : <div className="page page-narrow">{content}</div>;
}
