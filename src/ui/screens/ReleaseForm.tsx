import { type FormEvent, useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  type Product,
  type Purpose,
  RECIPIENT_ROLES,
  type RecipientRole,
  type Release,
  ReleaseInput,
} from '../../shared/contract/index.ts';
import {
  ConditionBuilder,
  type ConditionDraft,
  conditionToDraft,
  draftsToConditions,
  type FilterColumn,
} from '../components/ConditionBuilder.tsx';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { Checkbox, FormActions, FormField } from '../components/FormField.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, Skeleton } from '../components/QueryState.tsx';
import { ReleasePreviewResult } from '../components/releases/ReleasePreviewResult.tsx';
import { CategoryBadge, ShareabilityBadge, SpecialCategoryBadge } from '../components/StatusBadge.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiError, ApiOutput } from '../lib/api.ts';
import { clientValidate, useFieldErrors } from '../lib/errors.ts';
import { usePurposes } from '../lib/purposes.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';
import { isoToLocalInput, localInputToIso } from '../lib/util.ts';

interface FormState {
  productId: string;
  recipientType: 'role' | 'peer';
  role: RecipientRole | '';
  peerId: string;
  purposes: string[];
  columns: string[];
  filters: ConditionDraft[];
  dataFrom: string;
  dataUntil: string;
  /** Werte für <input type="datetime-local"> */
  validFrom: string;
  validUntil: string;
  requiresConsent: boolean;
  legalBasis: string;
  note: string;
}

function emptyState(productId: string): FormState {
  return {
    productId,
    recipientType: 'role',
    role: '',
    peerId: '',
    purposes: [],
    columns: [],
    filters: [],
    dataFrom: '',
    dataUntil: '',
    validFrom: '',
    validUntil: '',
    requiresConsent: false,
    legalBasis: '',
    note: '',
  };
}

function filterColumnsOf(product: Product | null | undefined): FilterColumn[] {
  return (product?.columns ?? []).map((c) => ({ key: c.key, label: c.label, type: c.type }));
}

/** Vorlage aus bestehender Freigabe: gleiche Angaben, Gültigkeit beginnt neu. */
function stateFromRelease(r: Release, product: Product | null): FormState {
  const cols = filterColumnsOf(product);
  const productKeys = product ? new Set(product.columns.map((c) => c.key)) : null;
  const futureUntil = r.validUntil && Date.parse(r.validUntil) > Date.now() ? r.validUntil : null;
  return {
    productId: r.productId,
    recipientType: r.recipient.type,
    role: r.recipient.type === 'role' ? r.recipient.role : '',
    peerId: r.recipient.type === 'peer' ? r.recipient.peerId : '',
    purposes: [...r.purposes],
    columns: productKeys ? r.columns.filter((k) => productKeys.has(k)) : [...r.columns],
    filters: r.rowFilter.map((c) => conditionToDraft(c, cols)),
    dataFrom: r.dataFrom ?? '',
    dataUntil: r.dataUntil ?? '',
    validFrom: '',
    validUntil: isoToLocalInput(futureUntil),
    requiresConsent: r.requiresConsent,
    legalBasis: r.legalBasis,
    note: r.note,
  };
}

/** /freigaben/neu – Freigabe erteilen (optional ?produkt=<id> oder ?vorlage=<releaseId>). */
export function ReleaseForm() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const templateId = params.get('vorlage') ?? '';
  const preProduct = params.get('produkt') ?? '';

  const template = useApiQuery(
    'releases.get',
    { params: { id: templateId } },
    { enabled: templateId !== '' },
  );
  const templateProduct = useApiQuery(
    'products.get',
    { params: { id: template.data?.productId ?? '' } },
    { enabled: Boolean(template.data) },
  );

  if (templateId) {
    const loading =
      template.isPending || (templateProduct.isPending && templateProduct.fetchStatus !== 'idle');
    if (loading || template.isError) {
      return (
        <div className="page">
          <PageHeader
            title={t('releases.formTitle')}
            back={{ to: '/freigaben', label: t('releases.backToList') }}
          />
          {template.isError ? (
            <ErrorMessage error={template.error} onRetry={() => void template.refetch()} />
          ) : (
            <Skeleton lines={6} />
          )}
        </div>
      );
    }
  }

  const initial = template.data
    ? stateFromRelease(template.data, templateProduct.data ?? null)
    : emptyState(preProduct);
  return (
    <ReleaseFormInner
      key={template.data?.id ?? 'new'}
      initial={initial}
      fromTemplate={Boolean(template.data)}
    />
  );
}

function ReleaseFormInner({ initial, fromTemplate }: { initial: FormState; fromTemplate: boolean }) {
  const i = useI18n();
  const { t, lang } = i;
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const ids = useId();

  const [form, setForm] = useState<FormState>(initial);
  const [clientError, setClientError] = useState<ApiError | null>(null);
  const [showInvalid, setShowInvalid] = useState(false);
  const [previewPurpose, setPreviewPurpose] = useState('');
  const [previewSig, setPreviewSig] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);

  const products = useApiQuery('products.list', {});
  const product = useApiQuery(
    'products.get',
    { params: { id: form.productId } },
    { enabled: form.productId !== '' },
  );
  const peers = useApiQuery('peers.list', {}, { enabled: session.can('peers.list') });
  const purposes = usePurposes();

  const create = useApiMutation('releases.create', {
    invalidate: ['releases.list', 'products.list', 'products.get'],
    onSuccess: (created) => {
      toast.success(t('releases.created'));
      navigate(`/freigaben/${created.id}`);
    },
  });
  const preview = useApiMutation('releases.preview');
  const fe = useFieldErrors(clientError, create.error);

  const productData = product.data && product.data.id === form.productId ? product.data : null;
  const filterColumns = filterColumnsOf(productData);
  const special = productData?.specialCategory ?? false;
  const internal = productData?.shareability === 'internal';
  const isBi = form.recipientType === 'role' && form.role === 'bi';
  const activeProducts = (products.data?.items ?? [])
    .filter((p) => p.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name, i.locale));
  const trustedPeers = (peers.data?.items ?? []).filter((p) => p.status === 'trusted');
  const purposeItems: Purpose[] = (purposes.data?.items ?? []).filter(
    (p) => p.active || form.purposes.includes(p.code),
  );

  const { conditions, invalid } = draftsToConditions(form.filters, filterColumns);

  const update = (patch: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setClientError(null);
  };

  const draft = {
    productId: form.productId,
    recipient:
      form.recipientType === 'role'
        ? { type: 'role' as const, role: form.role }
        : { type: 'peer' as const, peerId: form.peerId },
    purposes: form.purposes,
    columns: productData
      ? productData.columns.map((c) => c.key).filter((k) => form.columns.includes(k))
      : form.columns,
    rowFilter: conditions,
    dataFrom: form.dataFrom || null,
    dataUntil: form.dataUntil || null,
    validFrom: localInputToIso(form.validFrom),
    validUntil: localInputToIso(form.validUntil),
    requiresConsent: special ? true : form.requiresConsent,
    legalBasis: form.legalBasis.trim(),
    note: form.note.trim(),
  };

  const effectivePurpose = form.purposes.includes(previewPurpose) ? previewPurpose : (form.purposes[0] ?? '');
  const signature = JSON.stringify({ draft, purpose: effectivePurpose });
  const previewStale = Boolean(preview.data) && previewSig !== signature;
  const canPreview =
    form.productId !== '' &&
    (form.recipientType === 'role' ? form.role !== '' : form.peerId !== '') &&
    form.purposes.length > 0 &&
    form.columns.length > 0;

  const validate = () => {
    if (invalid.length > 0) {
      setShowInvalid(true);
      return null;
    }
    const r = clientValidate(ReleaseInput, draft);
    if (!r.ok) {
      setClientError(r.error);
      return null;
    }
    return r.data;
  };

  const runPreview = () => {
    setPreviewError(null);
    if (invalid.length > 0) {
      setShowInvalid(true);
      return;
    }
    const r = clientValidate(ReleaseInput, draft);
    if (!r.ok) {
      setPreviewError(r.error);
      return;
    }
    setPreviewSig(signature);
    preview.mutate({ body: { release: r.data, purpose: effectivePurpose } });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = validate();
    if (body) create.mutate({ body });
  };

  const purposeLabel = (p: Purpose) => (lang === 'de' ? p.labelDe : p.labelEn);

  const togglePurpose = (code: string, on: boolean) => {
    if (isBi) return update({ purposes: on ? [code] : [] });
    update({ purposes: on ? [...form.purposes, code] : form.purposes.filter((c) => c !== code) });
  };

  const toggleColumn = (key: string, on: boolean) =>
    update({ columns: on ? [...form.columns, key] : form.columns.filter((c) => c !== key) });

  const selectProduct = (productId: string) =>
    update({ productId, columns: [], filters: [], requiresConsent: false });

  const selectRole = (role: RecipientRole | '') =>
    update({ role, purposes: role === 'bi' ? form.purposes.slice(0, 1) : form.purposes });

  return (
    <div className="page">
      <PageHeader
        title={t('releases.formTitle')}
        description={t('releases.formIntro')}
        back={{ to: '/freigaben', label: t('releases.backToList') }}
      />
      {fromTemplate && (
        <div className="alert alert-info">
          <p>{t('releases.templateLoaded')}</p>
        </div>
      )}

      <form className="form form-wide" onSubmit={submit} noValidate>
        <Section title={t('releases.sectionProduct')}>
          <ProductPicker
            products={products}
            activeProducts={activeProducts}
            productId={form.productId}
            currentName={productData?.name}
            error={fe('productId')}
            onChange={selectProduct}
          />
          {product.isError && <ErrorMessage error={product.error} onRetry={() => void product.refetch()} />}
          {productData && <ProductSummary product={productData} />}
        </Section>

        <Section title={t('releases.sectionRecipient')}>
          <fieldset className="fieldset">
            <legend>{t('releases.recipientType')}</legend>
            <div className="row">
              <div className="checkbox-row">
                <input
                  id={`${ids}-rt-role`}
                  type="radio"
                  name={`${ids}-recipient-type`}
                  checked={form.recipientType === 'role'}
                  onChange={() => update({ recipientType: 'role' })}
                />
                <label htmlFor={`${ids}-rt-role`}>{t('releases.recipientTypeRole')}</label>
              </div>
              <div className="checkbox-row">
                <input
                  id={`${ids}-rt-peer`}
                  type="radio"
                  name={`${ids}-recipient-type`}
                  checked={form.recipientType === 'peer'}
                  onChange={() => update({ recipientType: 'peer' })}
                />
                <label htmlFor={`${ids}-rt-peer`}>{t('releases.recipientTypePeer')}</label>
              </div>
            </div>
          </fieldset>

          {form.recipientType === 'role' ? (
            <FormField
              label={t('releases.selectRole')}
              required
              hint={isBi ? t('releases.biHint') : t('releases.roleHint')}
              error={fe('recipient.role') ?? fe('recipient')}
            >
              {(a) => (
                <select
                  {...a}
                  className="input"
                  value={form.role}
                  onChange={(e) => selectRole(e.target.value as RecipientRole | '')}
                >
                  <option value="">{t('common.select')}</option>
                  {RECIPIENT_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`recipientRoles.${r}`)}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          ) : (
            <>
              {internal && (
                <div className="alert alert-warning">
                  <p>{t('releases.productInternal')}</p>
                </div>
              )}
              {peers.isError && <ErrorMessage error={peers.error} onRetry={() => void peers.refetch()} />}
              {peers.isSuccess && trustedPeers.length === 0 ? (
                <EmptyState message={t('releases.noTrustedPeers')} />
              ) : (
                <FormField
                  label={t('releases.selectPeer')}
                  required
                  hint={t('releases.peerHint')}
                  error={fe('recipient.peerId') ?? fe('recipient')}
                >
                  {(a) => (
                    <select
                      {...a}
                      className="input"
                      value={form.peerId}
                      disabled={!peers.isSuccess}
                      onChange={(e) => update({ peerId: e.target.value })}
                    >
                      <option value="">{peers.isPending ? t('common.loading') : t('common.select')}</option>
                      {trustedPeers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {`${p.displayName} (${p.nodeId})`}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
              )}
            </>
          )}
        </Section>

        <Section
          title={t('releases.sectionPurposes')}
          description={isBi ? t('releases.purposeBiHint') : t('releases.purposesHint')}
        >
          {purposes.isPending ? (
            <Skeleton lines={2} />
          ) : purposes.isError ? (
            <ErrorMessage error={purposes.error} onRetry={() => void purposes.refetch()} />
          ) : purposeItems.length === 0 ? (
            <EmptyState message={t('releases.noPurposes')} />
          ) : (
            <div className="stack-sm">
              <div className="checkbox-grid">
                {purposeItems.map((p) =>
                  isBi ? (
                    <div className="checkbox-field" key={p.code}>
                      <div className="checkbox-row">
                        <input
                          id={`${ids}-pu-${p.code}`}
                          type="radio"
                          name={`${ids}-purpose-bi`}
                          checked={form.purposes[0] === p.code}
                          onChange={() => togglePurpose(p.code, true)}
                        />
                        <label htmlFor={`${ids}-pu-${p.code}`}>{purposeLabel(p)}</label>
                      </div>
                      {p.description && <p className="field-hint">{p.description}</p>}
                    </div>
                  ) : (
                    <Checkbox
                      key={p.code}
                      label={purposeLabel(p)}
                      hint={p.description || undefined}
                      checked={form.purposes.includes(p.code)}
                      onChange={(on) => togglePurpose(p.code, on)}
                    />
                  ),
                )}
              </div>
              {fe('purposes') && <p className="field-error">{fe('purposes')}</p>}
            </div>
          )}
        </Section>

        <Section title={t('releases.sectionColumns')} description={t('releases.columnsHint')}>
          {!productData ? (
            <p className="muted">{t('releases.chooseProductFirst')}</p>
          ) : (
            <div className="stack-sm">
              <div className="row">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => update({ columns: productData.columns.map((c) => c.key) })}
                >
                  {t('releases.selectAll')}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => update({ columns: [] })}>
                  {t('releases.selectNone')}
                </button>
                <span className="muted small" aria-live="polite">
                  {t('releases.columnsSelected', {
                    count: form.columns.length,
                    total: productData.columns.length,
                  })}
                </span>
              </div>
              <div className="checkbox-grid">
                {productData.columns.map((c) => (
                  <Checkbox
                    key={c.key}
                    label={c.unit ? `${c.label} (${c.unit})` : c.label}
                    hint={t('releases.columnMeta', { key: c.key, type: t(`fieldTypes.${c.type}`) })}
                    checked={form.columns.includes(c.key)}
                    onChange={(on) => toggleColumn(c.key, on)}
                  />
                ))}
              </div>
              {fe('columns') && <p className="field-error">{fe('columns')}</p>}
            </div>
          )}
        </Section>

        <Section title={t('releases.sectionRows')} description={t('releases.rowsHint')}>
          {!productData ? (
            <p className="muted">{t('releases.chooseProductFirst')}</p>
          ) : (
            <ConditionBuilder
              columns={filterColumns}
              value={form.filters}
              onChange={(filters) => update({ filters })}
              invalid={showInvalid ? invalid : []}
            />
          )}
          {fe('rowFilter') && <p className="field-error">{fe('rowFilter')}</p>}
        </Section>

        <Section title={t('releases.sectionTime')}>
          <div className="stack-sm">
            <p className="field-hint">{t('releases.dataWindowHint')}</p>
            <div className="form-grid">
              <FormField label={t('releases.dataFrom')} error={fe('dataFrom')}>
                {(a) => (
                  <input
                    {...a}
                    className="input"
                    type="date"
                    value={form.dataFrom}
                    onChange={(e) => update({ dataFrom: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label={t('releases.dataUntil')} error={fe('dataUntil')}>
                {(a) => (
                  <input
                    {...a}
                    className="input"
                    type="date"
                    value={form.dataUntil}
                    min={form.dataFrom || undefined}
                    onChange={(e) => update({ dataUntil: e.target.value })}
                  />
                )}
              </FormField>
            </div>
          </div>
          <div className="form-grid">
            <FormField
              label={t('releases.validFrom')}
              hint={t('releases.validFromHint')}
              error={fe('validFrom')}
            >
              {(a) => (
                <input
                  {...a}
                  className="input"
                  type="datetime-local"
                  value={form.validFrom}
                  onChange={(e) => update({ validFrom: e.target.value })}
                />
              )}
            </FormField>
            <FormField
              label={t('releases.validUntil')}
              hint={t('releases.validUntilHint')}
              error={fe('validUntil')}
            >
              {(a) => (
                <input
                  {...a}
                  className="input"
                  type="datetime-local"
                  value={form.validUntil}
                  min={form.validFrom || undefined}
                  onChange={(e) => update({ validUntil: e.target.value })}
                />
              )}
            </FormField>
          </div>
        </Section>

        <Section title={t('releases.sectionConsent')}>
          <Checkbox
            label={t('releases.requiresConsent')}
            checked={special || form.requiresConsent}
            disabled={special}
            hint={special ? t('releases.consentForced') : t('releases.consentHint')}
            error={fe('requiresConsent')}
            onChange={(on) => update({ requiresConsent: on })}
          />
        </Section>

        <Section title={t('releases.sectionDocumentation')}>
          <div className="form-grid">
            <FormField
              label={t('releases.legalBasis')}
              hint={t('releases.legalBasisHint')}
              error={fe('legalBasis')}
              className="span-2"
            >
              {(a) => (
                <input
                  {...a}
                  className="input"
                  maxLength={500}
                  value={form.legalBasis}
                  onChange={(e) => update({ legalBasis: e.target.value })}
                />
              )}
            </FormField>
            <FormField
              label={t('releases.note')}
              hint={t('releases.noteHint')}
              error={fe('note')}
              className="span-2"
            >
              {(a) => (
                <textarea
                  {...a}
                  className="input"
                  maxLength={2000}
                  value={form.note}
                  onChange={(e) => update({ note: e.target.value })}
                />
              )}
            </FormField>
          </div>
        </Section>

        <Section title={t('releases.previewTitle')} description={t('releases.previewIntro')}>
          {!canPreview ? (
            <p className="muted">{t('releases.previewNeeds')}</p>
          ) : (
            <div className="toolbar">
              <FormField label={t('releases.previewPurpose')}>
                {(a) => (
                  <select
                    {...a}
                    className="input"
                    value={effectivePurpose}
                    onChange={(e) => setPreviewPurpose(e.target.value)}
                  >
                    {form.purposes.map((code) => {
                      const p = purposeItems.find((x) => x.code === code);
                      return (
                        <option key={code} value={code}>
                          {p ? purposeLabel(p) : code}
                        </option>
                      );
                    })}
                  </select>
                )}
              </FormField>
              <button type="button" className="btn" disabled={preview.isPending} onClick={runPreview}>
                {preview.isPending ? t('releases.previewRunning') : t('releases.previewRun')}
              </button>
            </div>
          )}
          {previewError && <ErrorMessage error={previewError} />}
          {preview.error && !previewError && <ErrorMessage error={preview.error} />}
          {preview.data && !preview.isPending && !preview.error && (
            <ReleasePreviewResult result={preview.data} stale={previewStale} />
          )}
        </Section>

        {showInvalid && invalid.length > 0 && (
          <div className="alert alert-error" role="alert">
            <p>{t('releases.invalidConditions')}</p>
          </div>
        )}
        {clientError && <ErrorMessage error={clientError} />}
        {create.error && <ErrorMessage error={create.error} />}
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? t('releases.submitting') : t('releases.submit')}
          </button>
          <Link to="/freigaben" className="btn">
            {t('common.cancel')}
          </Link>
        </FormActions>
      </form>
    </div>
  );
}

function ProductPicker({
  products,
  activeProducts,
  productId,
  currentName,
  error,
  onChange,
}: {
  products: { isPending: boolean; isError: boolean; error: ApiError | null; refetch: () => unknown };
  activeProducts: ApiOutput<'products.list'>['items'];
  productId: string;
  currentName: string | undefined;
  error: string | undefined;
  onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  if (products.isPending) return <Skeleton lines={1} />;
  if (products.isError)
    return <ErrorMessage error={products.error} onRetry={() => void products.refetch()} />;
  if (activeProducts.length === 0 && !productId) {
    return (
      <EmptyState
        message={t('releases.noProducts')}
        action={
          <Link to="/produkte" className="btn">
            {t('releases.toProducts')}
          </Link>
        }
      />
    );
  }
  const missing = productId !== '' && !activeProducts.some((p) => p.id === productId);
  return (
    <FormField label={t('releases.selectProduct')} required error={error}>
      {(a) => (
        <select {...a} className="input" value={productId} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('common.select')}</option>
          {activeProducts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {missing && <option value={productId}>{currentName ?? productId}</option>}
        </select>
      )}
    </FormField>
  );
}

function ProductSummary({ product }: { product: Product }) {
  const { t } = useI18n();
  return (
    <div className="stack-sm">
      <div className="badges">
        <CategoryBadge category={product.category} />
        <SpecialCategoryBadge show={product.specialCategory} />
        <ShareabilityBadge value={product.shareability} />
        <span className="badge badge-neutral">{t('common.versionN', { version: product.version })}</span>
      </div>
      {product.description && <p className="muted">{product.description}</p>}
      {product.specialCategory && (
        <div className="alert alert-warning">
          <p>{t('releases.productSpecial')}</p>
        </div>
      )}
    </div>
  );
}
