import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  DATA_CATEGORIES,
  type DataCategory,
  type Dataset,
  DatasetInput,
  type Shareability,
} from '../../shared/contract/index.ts';
import {
  draftToField,
  type FieldDraft,
  FieldEditor,
  fieldToDraft,
  newFieldDraft,
} from '../components/datasets/FieldEditor.tsx';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { Checkbox, Fieldset, FormActions, FormField } from '../components/FormField.tsx';
import { Details, useOpenWhen } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { QueryView } from '../components/QueryState.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiError } from '../lib/api.ts';
import { clientValidate, useFieldErrors } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';

const SHAREABILITY: readonly Shareability[] = ['on_request', 'internal'];
const UpdateSchema = DatasetInput.omit({ slug: true }).partial();
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

interface FormState {
  slug: string;
  name: string;
  description: string;
  category: DataCategory | '';
  specialCategory: boolean;
  shareability: Shareability;
  ownerContact: string;
  fields: FieldDraft[];
  keyFields: string[];
  observedAtField: string;
}

function emptyForm(): FormState {
  return {
    slug: '',
    name: '',
    description: '',
    category: '',
    specialCategory: false,
    shareability: 'on_request',
    ownerContact: '',
    fields: [newFieldDraft()],
    keyFields: [],
    observedAtField: '',
  };
}

function fromDataset(d: Dataset): FormState {
  return {
    slug: d.slug,
    name: d.name,
    description: d.description,
    category: d.category,
    specialCategory: d.specialCategory,
    shareability: d.shareability,
    ownerContact: d.ownerContact,
    fields: d.fields.map(fieldToDraft),
    keyFields: d.keyFields,
    observedAtField: d.observedAtField ?? '',
  };
}

/** /datensaetze/neu und /datensaetze/:id/bearbeiten – Struktur mit Feldern und Regeln. */
export function DatasetForm() {
  const { id } = useParams();
  const dataset = useApiQuery('datasets.get', { params: { id: id ?? '' } }, { enabled: Boolean(id) });
  if (!id) {
    return (
      <div className="page">
        <DatasetFormBody initial={emptyForm()} />
      </div>
    );
  }
  return (
    <div className="page">
      <QueryView query={dataset}>
        {(d) => <DatasetFormBody id={id} initial={fromDataset(d)} subtitle={d.name} />}
      </QueryView>
    </div>
  );
}

function DatasetFormBody({ id, initial, subtitle }: { id?: string; initial: FormState; subtitle?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(initial);
  const [clientError, setClientError] = useState<ApiError | null>(null);
  const invalidate = ['datasets.list', 'datasets.get', 'catalog.local'] as const;

  const create = useApiMutation('datasets.create', {
    invalidate,
    onSuccess: (d) => {
      toast.success(t('datasets.created'));
      navigate(`/datensaetze/${d.id}`);
    },
  });
  const update = useApiMutation('datasets.update', {
    invalidate,
    onSuccess: (d) => {
      toast.success(t('datasets.saved'));
      navigate(`/datensaetze/${d.id}`);
    },
  });
  const mutation = id ? update : create;
  const fe = useFieldErrors(clientError, mutation.error);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const health = form.category === 'health';
  // Einstufung geändert: Produkte erhalten eine neue Version (Freigaben veralten); strengere Einstufung
  // (besondere Kategorie neu oder geändert, „Nur intern“ neu) widerruft zusätzlich alle Partnerfreigaben
  const special = health || form.specialCategory;
  const reclassified =
    Boolean(id) &&
    (form.category !== initial.category ||
      special !== initial.specialCategory ||
      form.shareability !== initial.shareability);
  const peerReleasesEnd =
    reclassified &&
    ((special && (!initial.specialCategory || initial.category !== form.category)) ||
      (form.shareability === 'internal' && initial.shareability !== 'internal'));
  const fieldNames = form.fields.map((f) => f.name.trim()).filter((n) => FIELD_NAME_RE.test(n));
  const uniqueNames = [...new Set(fieldNames)];
  const dateFields = form.fields.filter(
    (f) => (f.type === 'date' || f.type === 'datetime') && FIELD_NAME_RE.test(f.name.trim()),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const observed = form.observedAtField;
    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      category: form.category,
      specialCategory: health || form.specialCategory,
      shareability: form.shareability,
      fields: form.fields.map(draftToField),
      keyFields: form.keyFields.filter((k) => uniqueNames.includes(k)),
      observedAtField: observed && dateFields.some((f) => f.name.trim() === observed) ? observed : null,
      ownerContact: form.ownerContact.trim(),
    };
    if (id) {
      const checked = clientValidate(UpdateSchema, body);
      if (!checked.ok) return setClientError(checked.error);
      setClientError(null);
      update.mutate({ params: { id }, body: checked.data });
    } else {
      const checked = clientValidate(DatasetInput, { ...body, slug: form.slug.trim() });
      if (!checked.ok) return setClientError(checked.error);
      setClientError(null);
      create.mutate({ body: checked.data });
    }
  };

  const labelOf = (name: string) => form.fields.find((f) => f.name.trim() === name)?.label.trim() || name;
  // Schlüssel und Beobachtungsdatum: aufgeklappt, wenn gesetzt (Bearbeiten) oder dort ein Fehler steht
  const advancedOpen = useOpenWhen(
    initial.keyFields.length > 0 ||
      initial.observedAtField !== '' ||
      Boolean(fe('keyFields') ?? fe('observedAtField')),
  );

  const back = id
    ? { to: `/datensaetze/${id}`, label: t('datasets.backToDetail') }
    : { to: '/datensaetze', label: t('datasets.backToList') };
  const error = clientError ?? mutation.error;

  return (
    <>
      <PageHeader
        title={id ? t('datasets.editTitle') : t('datasets.createTitle')}
        description={subtitle}
        back={back}
      />
      <form className="form form-wide stack-lg" onSubmit={submit} noValidate>
        {id && (
          <div className="alert alert-warning">
            <p>{t('datasets.versionWarning')}</p>
          </div>
        )}

        <Section title={t('datasets.general')}>
          <div className="form-grid">
            <FormField label={t('datasets.name')} required error={fe('name')}>
              {(a) => (
                <input
                  {...a}
                  className="input"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                />
              )}
            </FormField>
            {!id && (
              <FormField label={t('datasets.slug')} required hint={t('datasets.slugHint')} error={fe('slug')}>
                {(a) => (
                  <input
                    {...a}
                    className="input mono"
                    autoComplete="off"
                    spellCheck={false}
                    value={form.slug}
                    onChange={(e) => set('slug', e.target.value)}
                  />
                )}
              </FormField>
            )}
            <FormField label={t('datasets.description')} error={fe('description')} className="span-2">
              {(a) => (
                <textarea
                  {...a}
                  className="input"
                  maxLength={2000}
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('datasets.category')} required error={fe('category')}>
              {(a) => (
                <select
                  {...a}
                  className="input"
                  value={form.category}
                  onChange={(e) => set('category', e.target.value as DataCategory | '')}
                >
                  <option value="">{t('common.select')}</option>
                  {DATA_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`categories.${c}`)}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField
              label={t('datasets.shareability')}
              hint={t('datasets.shareabilityHint')}
              error={fe('shareability')}
            >
              {(a) => (
                <select
                  {...a}
                  className="input"
                  value={form.shareability}
                  onChange={(e) => set('shareability', e.target.value as Shareability)}
                >
                  {SHAREABILITY.map((s) => (
                    <option key={s} value={s}>
                      {t(`shareability.${s}`)}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <Checkbox
              className="span-2"
              label={t('datasets.specialCategory')}
              hint={t('datasets.specialHint')}
              checked={health || form.specialCategory}
              disabled={health}
              error={fe('specialCategory')}
              onChange={(checked) => set('specialCategory', checked)}
            />
            {reclassified && (
              <div className="alert alert-warning span-2" role="status">
                <p>{t('datasets.reclassifyWarning')}</p>
                {peerReleasesEnd && <p>{t('datasets.reclassifyPeerWarning')}</p>}
              </div>
            )}
            <FormField
              label={t('datasets.ownerContact')}
              hint={t('datasets.ownerContactHint')}
              error={fe('ownerContact')}
            >
              {(a) => (
                <input
                  {...a}
                  className="input"
                  maxLength={200}
                  value={form.ownerContact}
                  onChange={(e) => set('ownerContact', e.target.value)}
                />
              )}
            </FormField>
          </div>
        </Section>

        <Section title={t('datasets.fields.title')} description={t('datasets.fields.intro')}>
          {fe('fields') && <p className="field-error">{fe('fields')}</p>}
          <FieldEditor value={form.fields} onChange={(fields) => set('fields', fields)} fieldError={fe} />
        </Section>

        <Details summary={t('datasets.advanced')} defaultOpen={advancedOpen}>
          <Fieldset
            legend={t('datasets.keyFields')}
            hint={t('datasets.keyFieldsHint')}
            error={fe('keyFields')}
          >
            {uniqueNames.length === 0 ? (
              <p className="muted">{t('datasets.keyFieldsNone')}</p>
            ) : (
              <div className="checkbox-grid">
                {uniqueNames.map((name) => (
                  <Checkbox
                    key={name}
                    label={
                      <>
                        {labelOf(name)} <span className="small muted mono">({name})</span>
                      </>
                    }
                    checked={form.keyFields.includes(name)}
                    onChange={(checked) =>
                      set(
                        'keyFields',
                        checked ? [...form.keyFields, name] : form.keyFields.filter((k) => k !== name),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </Fieldset>
          <FormField
            label={t('datasets.observedAtField')}
            hint={t('datasets.observedAtHint')}
            error={fe('observedAtField')}
          >
            {(a) => (
              <select
                {...a}
                className="input"
                value={
                  dateFields.some((f) => f.name.trim() === form.observedAtField) ? form.observedAtField : ''
                }
                onChange={(e) => set('observedAtField', e.target.value)}
              >
                <option value="">{t('datasets.observedAtNone')}</option>
                {dateFields.map((f) => (
                  <option key={f.uid} value={f.name.trim()}>
                    {f.label.trim() ? `${f.label.trim()} (${f.name.trim()})` : f.name.trim()}
                  </option>
                ))}
              </select>
            )}
          </FormField>
        </Details>

        {error && <ErrorMessage error={error} />}
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
}
