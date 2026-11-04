import { type FormEvent, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { z } from 'zod';
import { type Dataset, type Product, ProductInput, type Shareability } from '../../shared/contract/index.ts';
import {
  ConditionBuilder,
  type ConditionDraft,
  conditionToDraft,
  draftsToConditions,
  type FilterColumn,
} from '../components/ConditionBuilder.tsx';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { Fieldset, FormActions, FormField } from '../components/FormField.tsx';
import { DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { ColumnPicker } from '../components/products/ColumnPicker.tsx';
import { type ColumnEntry, columnIssues, sourceOptions } from '../components/products/sources.ts';
import { QueryView } from '../components/QueryState.tsx';
import { CategoryBadge, SpecialCategoryBadge } from '../components/StatusBadge.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiError } from '../lib/api.ts';
import { clientValidate, useFieldErrors } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { uid } from '../lib/util.ts';

const ProductUpdate = ProductInput.omit({ slug: true, sourceType: true, datasetId: true }).partial();
type CreateBody = z.input<typeof ProductInput>;
type UpdateBody = z.input<typeof ProductUpdate>;

/** /produkte/neu und /produkte/:id/bearbeiten */
export function ProductForm() {
  const { id } = useParams();
  const { t } = useI18n();
  const datasets = useApiQuery('datasets.list', {});
  const product = useApiQuery('products.get', { params: { id: id ?? '' } }, { enabled: Boolean(id) });

  return (
    <div className="page">
      <PageHeader
        title={id ? t('products.editTitle') : t('products.newTitle')}
        back={
          id
            ? { to: `/produkte/${id}`, label: t('products.backToDetail') }
            : { to: '/produkte', label: t('products.backToList') }
        }
      />
      {id ? (
        <QueryView query={product}>
          {(p) => (
            <QueryView query={datasets}>
              {(ds) => <ProductEditor product={p} datasets={ds.items} />}
            </QueryView>
          )}
        </QueryView>
      ) : (
        <QueryView query={datasets}>{(ds) => <ProductEditor product={null} datasets={ds.items} />}</QueryView>
      )}
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, 51);
}

function ProductEditor({ product, datasets }: { product: Product | null; datasets: readonly Dataset[] }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const navigate = useNavigate();
  const ids = useId();
  const isEdit = product !== null;

  const [slug, setSlug] = useState(product?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [sourceType, setSourceType] = useState<'athletes' | 'dataset'>(product?.sourceType ?? 'athletes');
  const [datasetId, setDatasetId] = useState(product?.datasetId ?? '');
  const [shareability, setShareability] = useState<Shareability>(product?.shareability ?? 'on_request');
  const [columns, setColumns] = useState<ColumnEntry[]>(
    () =>
      product?.columns.map((c) => ({ uid: uid('col'), source: c.source, key: c.key, label: c.label })) ?? [],
  );
  const [filters, setFilters] = useState<ConditionDraft[]>(
    () => product?.filters.map((c) => conditionToDraft(c, product.columns)) ?? [],
  );
  const [invalidFilters, setInvalidFilters] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [clientError, setClientError] = useState<ApiError | null>(null);

  const onSaved = (p: Product, created: boolean) => {
    toast.success(created ? t('products.created') : t('products.saved'));
    navigate(`/produkte/${p.id}`);
  };
  const create = useApiMutation('products.create', {
    invalidate: ['products.list', 'catalog.local'],
    onSuccess: (p) => onSaved(p, true),
  });
  const update = useApiMutation('products.update', {
    invalidate: ['products.list', 'products.get', 'releases.list', 'catalog.local'],
    onSuccess: (p) => onSaved(p, false),
  });
  const fe = useFieldErrors(clientError, create.error, update.error);
  const serverError = isEdit ? update.error : create.error;
  const busy = create.isPending || update.isPending;

  const dataset = sourceType === 'dataset' ? (datasets.find((d) => d.id === datasetId) ?? null) : null;
  const options = useMemo(() => sourceOptions(i, dataset), [i, dataset]);

  const filterColumns: FilterColumn[] = columns.map((c) => {
    const o = options.find((x) => x.source === c.source);
    const fallbackType = product?.columns.find((pc) => pc.source === c.source)?.type ?? 'string';
    return { key: c.key, label: c.label || c.key, type: o?.type ?? fallbackType, enumValues: o?.enumValues };
  });

  const onColumnsChange = (next: ColumnEntry[]) => {
    const renames = new Map<string, string>();
    for (const n of next) {
      const prev = columns.find((p) => p.uid === n.uid);
      if (prev && prev.key !== n.key) renames.set(prev.key, n.key);
    }
    const keys = new Set(next.map((n) => n.key));
    setFilters((list) =>
      list
        .map((d) => {
          const renamed = renames.get(d.column);
          return renamed !== undefined ? { ...d, column: renamed } : d;
        })
        .filter((d) => keys.has(d.column)),
    );
    setColumns(next);
  };

  /** Quelle oder Datensatz gewechselt: nur Athletenkern-Spalten bleiben erhalten. */
  const resetSourceColumns = () => {
    onColumnsChange(columns.filter((c) => c.source.startsWith('athlete.')));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setClientError(null);
    if (!isEdit && sourceType === 'dataset' && !datasetId) {
      setLocalError(t('products.datasetRequired'));
      return;
    }
    if (columnIssues(columns).size > 0) {
      setLocalError(t('products.columnsInvalid'));
      return;
    }
    const { conditions, invalid } = draftsToConditions(filters, filterColumns);
    setInvalidFilters(invalid);
    if (invalid.length > 0) {
      setLocalError(t('products.filtersInvalid'));
      return;
    }
    const cols = columns.map((c) => ({ key: c.key, label: c.label.trim(), source: c.source }));
    if (product) {
      const body: UpdateBody = {
        name: name.trim(),
        description,
        columns: cols,
        filters: conditions,
        shareability,
      };
      const v = clientValidate(ProductUpdate, body);
      if (!v.ok) {
        setClientError(v.error);
        return;
      }
      update.mutate({ params: { id: product.id }, body });
    } else {
      const body: CreateBody = {
        slug,
        name: name.trim(),
        description,
        sourceType,
        datasetId: sourceType === 'dataset' ? datasetId : null,
        columns: cols,
        filters: conditions,
        shareability,
      };
      const v = clientValidate(ProductInput, body);
      if (!v.ok) {
        setClientError(v.error);
        return;
      }
      create.mutate({ body });
    }
  };

  const columnServerError = (n: number, field: 'key' | 'label') => fe(`columns.${n}.${field}`);

  return (
    <form className="form form-wide stack-lg" onSubmit={submit} noValidate>
      {product && product.activeReleaseCount > 0 && (
        <div className="alert alert-warning">
          <p>{t('products.versionWarning', { count: product.activeReleaseCount })}</p>
        </div>
      )}

      <Section title={t('products.basics')}>
        <div className="form-grid">
          {!isEdit && (
            <FormField label={t('products.slug')} required hint={t('products.slugHint')} error={fe('slug')}>
              {(a) => (
                <input
                  {...a}
                  className="input mono"
                  value={slug}
                  autoComplete="off"
                  onChange={(e) => {
                    setSlug(e.target.value.trim());
                    setSlugTouched(true);
                  }}
                />
              )}
            </FormField>
          )}
          <FormField label={t('products.name')} required error={fe('name')}>
            {(a) => (
              <input
                {...a}
                className="input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            )}
          </FormField>
          <FormField label={t('products.description')} className="span-2" error={fe('description')}>
            {(a) => (
              <textarea
                {...a}
                className="input"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </FormField>
          <FormField
            label={t('common.shareability')}
            hint={t('products.shareabilityHint')}
            error={fe('shareability')}
          >
            {(a) => (
              <select
                {...a}
                className="input"
                value={shareability}
                onChange={(e) => setShareability(e.target.value as Shareability)}
              >
                <option value="on_request">{t('shareability.on_request')}</option>
                <option value="internal">{t('shareability.internal')}</option>
              </select>
            )}
          </FormField>
        </div>
      </Section>

      <Section title={t('products.sourceType')}>
        {isEdit ? (
          <DescriptionList
            items={[
              [
                t('products.sourceType'),
                product.sourceType === 'athletes'
                  ? t('products.sourceTypeAthletes')
                  : `${t('products.dataset')}: ${product.datasetName ?? product.datasetId ?? ''}`,
              ],
              [
                t('common.category'),
                <span key="cat" className="badges">
                  <CategoryBadge category={product.category} />
                  <SpecialCategoryBadge show={product.specialCategory} />
                </span>,
              ],
            ]}
          />
        ) : (
          <div className="stack">
            <Fieldset legend={t('products.sourceType')} hint={t('products.sourceTypeHint')}>
              {(['athletes', 'dataset'] as const).map((st) => (
                <div key={st} className="checkbox-row">
                  <input
                    id={`${ids}-st-${st}`}
                    type="radio"
                    name={`${ids}-sourceType`}
                    checked={sourceType === st}
                    onChange={() => {
                      setSourceType(st);
                      resetSourceColumns();
                    }}
                  />
                  <label htmlFor={`${ids}-st-${st}`}>
                    {st === 'athletes' ? t('products.sourceTypeAthletes') : t('products.sourceTypeDataset')}
                  </label>
                </div>
              ))}
            </Fieldset>
            {sourceType === 'dataset' &&
              (datasets.length === 0 ? (
                <div className="alert alert-info">
                  <p>{t('products.noDatasets')}</p>
                  <p>
                    <Link to="/datensaetze/neu">{t('products.createDataset')}</Link>
                  </p>
                </div>
              ) : (
                <FormField
                  label={t('products.dataset')}
                  required
                  hint={t('products.categoryInherited')}
                  error={fe('datasetId')}
                >
                  {(a) => (
                    <select
                      {...a}
                      className="input"
                      value={datasetId}
                      onChange={(e) => {
                        setDatasetId(e.target.value);
                        resetSourceColumns();
                      }}
                    >
                      <option value="">{t('common.select')}</option>
                      {datasets.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  )}
                </FormField>
              ))}
            {dataset && (
              <div className="stack-sm">
                <div className="badges">
                  <CategoryBadge category={dataset.category} />
                  <SpecialCategoryBadge show={dataset.specialCategory} />
                </div>
                {dataset.specialCategory && <p className="field-hint">{t('products.specialHint')}</p>}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title={t('products.columnsTitle')} description={t('products.columnsIntro')}>
        <ColumnPicker
          options={options}
          value={columns}
          onChange={onColumnsChange}
          serverError={columnServerError}
          error={fe('columns')}
          disabled={busy}
          notice={
            sourceType === 'dataset' && !dataset ? (
              <p className="field-hint">{t('products.chooseDatasetFirst')}</p>
            ) : undefined
          }
        />
      </Section>

      <Section title={t('products.filtersTitle')} description={t('products.filtersIntro')}>
        {columns.length === 0 ? (
          <p className="muted">{t('products.filtersNeedColumns')}</p>
        ) : (
          <ConditionBuilder
            columns={filterColumns}
            value={filters}
            onChange={(next) => {
              setFilters(next);
              setInvalidFilters((inv) => inv.filter((u) => next.some((d) => d.uid === u)));
            }}
            invalid={invalidFilters}
            disabled={busy}
          />
        )}
      </Section>

      {localError && (
        <div className="alert alert-error" role="alert">
          <p>{localError}</p>
        </div>
      )}
      {clientError && <ErrorMessage error={clientError} />}
      {serverError && <ErrorMessage error={serverError} />}

      <FormActions>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t('common.saving') : isEdit ? t('common.save') : t('products.createSubmit')}
        </button>
        <Link to={product ? `/produkte/${product.id}` : '/produkte'} className="btn">
          {t('common.cancel')}
        </Link>
      </FormActions>
    </form>
  );
}
