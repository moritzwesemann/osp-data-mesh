import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { z } from 'zod';
import {
  type AthleteMatch,
  type Connector,
  ConnectorInput,
  type CsvConfig,
} from '../../shared/contract/index.ts';
import {
  ApiConfigFields,
  type ApiState,
  apiStateFrom,
  buildApiConfig,
  CsvConfigFields,
  DEFAULT_API,
  DEFAULT_CSV,
} from '../components/connectors/ConfigFields.tsx';
import {
  buildMapping,
  draftsFromMapping,
  type MappingDraft,
  MappingEditor,
  type MappingField,
} from '../components/connectors/MappingEditor.tsx';
import { SecretSection } from '../components/connectors/SecretSection.tsx';
import { targetLabel, targetOptions } from '../components/connectors/shared.ts';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { Checkbox, FormActions, FormField } from '../components/FormField.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { QueryView } from '../components/QueryState.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import { ApiError, api } from '../lib/api.ts';
import { clientValidate, useFieldErrors } from '../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

const UpdateInput = ConnectorInput.omit({ slug: true }).partial();

type Kind = Connector['kind'];
type TargetType = Connector['targetType'];
type Strategy = AthleteMatch['strategy'];

const REQUIRED_FOR: Record<Strategy, readonly string[]> = {
  natural_key: ['athlete.last_name', 'athlete.first_name', 'athlete.date_of_birth'],
  external_id: ['athlete.external_id'],
};

/** /quellen/neu und /quellen/:id/bearbeiten – Quelle anlegen oder ändern. */
export function ConnectorForm() {
  const { id } = useParams();
  const { t } = useI18n();
  const existing = useApiQuery('connectors.get', { params: { id: id ?? '' } }, { enabled: Boolean(id) });
  return (
    <div className="page">
      <PageHeader
        title={id ? t('connectors.editTitle') : t('connectors.newTitle')}
        description={id ? t('connectors.editVersionHint') : undefined}
        back={
          id
            ? { to: `/quellen/${id}`, label: t('connectors.backToConnector') }
            : { to: '/quellen', label: t('connectors.backToList') }
        }
      />
      {id ? (
        <QueryView query={existing}>{(c) => <ConnectorEditor key={c.id} connector={c} />}</QueryView>
      ) : (
        <ConnectorEditor connector={null} />
      )}
    </div>
  );
}

function ConnectorEditor({ connector }: { connector: Connector | null }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const navigate = useNavigate();
  const session = useSession();
  const datasets = useApiQuery('datasets.list', {});

  const [slug, setSlug] = useState(connector?.slug ?? '');
  const [name, setName] = useState(connector?.name ?? '');
  const [description, setDescription] = useState(connector?.description ?? '');
  const [kind, setKind] = useState<Kind>(connector?.kind ?? 'csv_upload');
  const [targetType, setTargetType] = useState<TargetType>(connector?.targetType ?? 'dataset');
  const [datasetId, setDatasetId] = useState(connector?.targetDatasetId ?? '');
  const [csv, setCsv] = useState<CsvConfig>(
    connector?.config.type === 'csv' ? connector.config : DEFAULT_CSV,
  );
  const [apiState, setApiState] = useState<ApiState>(
    connector?.config.type === 'http_api' ? apiStateFrom(connector.config) : DEFAULT_API,
  );
  const [drafts, setDrafts] = useState<MappingDraft[]>(() => draftsFromMapping(connector?.mapping ?? []));
  const [strategy, setStrategy] = useState<Strategy>(connector?.athleteMatch.strategy ?? 'natural_key');
  const [system, setSystem] = useState(
    connector?.athleteMatch.strategy === 'external_id' ? connector.athleteMatch.system : '',
  );
  const [onError, setOnError] = useState<Connector['onError']>(connector?.onError ?? 'skip_row');
  const [active, setActive] = useState(connector?.active ?? true);
  const [secret, setSecret] = useState('');
  const [clientError, setClientError] = useState<ApiError | null>(null);
  const [mappedUids, setMappedUids] = useState<string[]>([]);
  const [invalidValueMaps, setInvalidValueMaps] = useState<string[]>([]);
  const [queryInvalid, setQueryInvalid] = useState(false);

  const create = useApiMutation('connectors.create', {
    invalidate: ['connectors.list', 'catalog.local'],
    onSuccess: async (c) => {
      if (kind === 'http_api' && apiState.authType !== 'none' && secret) {
        try {
          await api('connectors.setSecret', { params: { id: c.id }, body: { secret } });
        } catch {
          toast.error(t('connectors.secretSaveFailed'));
        }
      }
      toast.success(t('connectors.createdToast'));
      navigate(`/quellen/${c.id}`);
    },
  });
  const update = useApiMutation('connectors.update', {
    invalidate: ['connectors.list', 'connectors.get', 'catalog.local'],
    onSuccess: (c) => {
      toast.success(t('connectors.saved'));
      navigate(`/quellen/${c.id}`);
    },
  });
  const mutation = connector ? update : create;
  const error = clientError ?? mutation.error;

  // Beispielabruf mit Zugangsgeheimnis: vorhandene Quelle → gespeichertes Geheimnis (connectorId),
  // neue Quelle → das gerade eingegebene Geheimnis (wird dabei nicht gespeichert)
  const inspectAccess =
    kind !== 'http_api' || apiState.authType === 'none'
      ? undefined
      : connector
        ? connector.hasSecret
          ? { connectorId: connector.id }
          : undefined
        : secret
          ? { secret }
          : undefined;
  const fe = useFieldErrors(clientError, mutation.error);

  const datasetItems = datasets.data?.items ?? [];
  const selectedDataset = datasetItems.find((d) => d.id === datasetId) ?? null;
  const options = targetOptions(i, targetType === 'dataset' ? selectedDataset : null);
  const apiBuilt = buildApiConfig(apiState);
  const config: z.input<typeof ConnectorInput>['config'] = kind === 'csv_upload' ? csv : apiBuilt.config;

  const mappedTargets = new Set(drafts.map((d) => d.target).filter(Boolean));
  const missing = REQUIRED_FOR[strategy].filter((x) => !mappedTargets.has(x));

  const rowError = (uid: string, field: MappingField) => {
    const idx = mappedUids.indexOf(uid);
    if (idx < 0) return undefined;
    return fe(`mapping.${idx}.${field}`) ?? (field === 'target' ? fe(`mapping.${idx}`) : undefined);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = buildMapping(drafts);
    const qInvalid = kind === 'http_api' && apiBuilt.queryInvalid;
    setMappedUids(built.mappedUids);
    setInvalidValueMaps(built.invalidValueMaps);
    setQueryInvalid(qInvalid);
    if (built.invalidValueMaps.length > 0 || qInvalid) {
      setClientError(new ApiError({ status: 400, code: 'validation_failed' }));
      return;
    }
    if (targetType === 'dataset' && !datasetId) {
      setClientError(
        new ApiError({
          status: 400,
          code: 'validation_failed',
          fields: { 'body.targetDatasetId': 'required' },
        }),
      );
      return;
    }
    const athleteMatch: z.input<typeof ConnectorInput>['athleteMatch'] =
      strategy === 'external_id' ? { strategy, system: system.trim() } : { strategy: 'natural_key' };
    const input: z.input<typeof ConnectorInput> = {
      slug: slug.trim(),
      name: name.trim(),
      description: description.trim(),
      kind,
      targetType,
      targetDatasetId: targetType === 'dataset' ? datasetId : null,
      config,
      mapping: built.mapping,
      athleteMatch,
      onError,
      active,
    };
    if (connector) {
      const { slug: _slug, ...rest } = input;
      const v = clientValidate(UpdateInput, rest);
      if (!v.ok) return setClientError(v.error);
      setClientError(null);
      update.mutate({ params: { id: connector.id }, body: rest });
    } else {
      const v = clientValidate(ConnectorInput, input);
      if (!v.ok) return setClientError(v.error);
      setClientError(null);
      create.mutate({ body: input });
    }
  };

  return (
    <>
      <form className="form form-wide" onSubmit={submit} noValidate>
        <Section title={t('connectors.sectionBasics')}>
          <div className="form-grid">
            {!connector && (
              <FormField
                label={t('connectors.slug')}
                required
                hint={t('connectors.slugHint')}
                error={fe('slug')}
              >
                {(a) => (
                  <input
                    {...a}
                    className="input mono"
                    autoComplete="off"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                  />
                )}
              </FormField>
            )}
            <FormField
              label={t('connectors.name')}
              required
              error={fe('name')}
              className={connector ? 'span-2' : undefined}
            >
              {(a) => (
                <input {...a} className="input" value={name} onChange={(e) => setName(e.target.value)} />
              )}
            </FormField>
            <FormField className="span-2" label={t('connectors.description')} error={fe('description')}>
              {(a) => (
                <textarea
                  {...a}
                  className="input"
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </FormField>
            <FormField label={t('connectors.kind')} required error={fe('kind')}>
              {(a) => (
                <select
                  {...a}
                  className="input"
                  value={kind}
                  onChange={(e) => setKind(e.target.value === 'http_api' ? 'http_api' : 'csv_upload')}
                >
                  <option value="csv_upload">{t('connectorKind.csv_upload')}</option>
                  <option value="http_api">{t('connectorKind.http_api')}</option>
                </select>
              )}
            </FormField>
            <div />
            <FormField label={t('connectors.targetType')} required error={fe('targetType')}>
              {(a) => (
                <select
                  {...a}
                  className="input"
                  value={targetType}
                  onChange={(e) => setTargetType(e.target.value === 'athletes' ? 'athletes' : 'dataset')}
                >
                  <option value="dataset">{t('targetType.dataset')}</option>
                  <option value="athletes">{t('targetType.athletes')}</option>
                </select>
              )}
            </FormField>
            {targetType === 'dataset' ? (
              <FormField
                label={t('connectors.targetDataset')}
                required
                error={fe('targetDatasetId')}
                hint={
                  datasets.isSuccess && datasetItems.length === 0 ? (
                    <>
                      {t('connectors.noDatasets')}{' '}
                      {session.can('datasets.create') && (
                        <Link to="/datensaetze/neu">{t('nav.datasets')}</Link>
                      )}
                    </>
                  ) : undefined
                }
              >
                {(a) => (
                  <select
                    {...a}
                    className="input"
                    value={datasetId}
                    disabled={datasets.isPending}
                    onChange={(e) => setDatasetId(e.target.value)}
                  >
                    <option value="">{datasets.isPending ? t('common.loading') : t('common.select')}</option>
                    {datasetItems.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            ) : (
              <div />
            )}
          </div>
          {datasets.isError && (
            <ErrorMessage error={datasets.error} onRetry={() => void datasets.refetch()} />
          )}
        </Section>

        <Section title={kind === 'csv_upload' ? t('connectors.sectionCsv') : t('connectors.sectionApi')}>
          {kind === 'csv_upload' ? (
            <CsvConfigFields value={csv} onChange={setCsv} fe={fe} />
          ) : (
            <ApiConfigFields
              value={apiState}
              onChange={setApiState}
              fe={fe}
              queryInvalid={queryInvalid}
              secret={connector ? null : { value: secret, onChange: setSecret }}
            />
          )}
        </Section>

        <Section title={t('connectors.sectionMapping')}>
          <MappingEditor
            kind={kind}
            config={config}
            options={options}
            datasetName={selectedDataset?.name ?? null}
            value={drafts}
            setValue={setDrafts}
            rowError={rowError}
            invalidValueMaps={invalidValueMaps}
            error={fe('mapping')}
            inspectAccess={inspectAccess}
          />
        </Section>

        <Section title={t('connectors.sectionMatching')}>
          <div className="form-grid">
            <FormField
              label={t('connectors.matchStrategy')}
              hint={
                strategy === 'natural_key'
                  ? t('connectors.matchNaturalHint')
                  : t('connectors.matchExternalHint')
              }
              error={fe('athleteMatch.strategy') ?? fe('athleteMatch')}
            >
              {(a) => (
                <select
                  {...a}
                  className="input"
                  value={strategy}
                  onChange={(e) =>
                    setStrategy(e.target.value === 'external_id' ? 'external_id' : 'natural_key')
                  }
                >
                  <option value="natural_key">{t('matchStrategy.natural_key')}</option>
                  <option value="external_id">{t('matchStrategy.external_id')}</option>
                </select>
              )}
            </FormField>
            {strategy === 'external_id' ? (
              <FormField
                label={t('connectors.matchSystem')}
                required
                hint={t('connectors.matchSystemHint')}
                error={fe('athleteMatch.system')}
              >
                {(a) => (
                  <input
                    {...a}
                    className="input mono"
                    value={system}
                    onChange={(e) => setSystem(e.target.value)}
                  />
                )}
              </FormField>
            ) : (
              <div />
            )}
            {missing.length > 0 && drafts.length > 0 && (
              <div className="alert alert-warning span-2">
                <p>
                  {t('connectors.matchMissing', {
                    fields: missing.map((m) => targetLabel(i, m, null)).join(', '),
                  })}
                </p>
              </div>
            )}
            <FormField label={t('connectors.onError')} error={fe('onError')}>
              {(a) => (
                <select
                  {...a}
                  className="input"
                  value={onError}
                  onChange={(e) => setOnError(e.target.value === 'abort' ? 'abort' : 'skip_row')}
                >
                  <option value="skip_row">{t('onError.skip_row')}</option>
                  <option value="abort">{t('onError.abort')}</option>
                </select>
              )}
            </FormField>
            <Checkbox
              label={t('connectors.activeLabel')}
              hint={t('connectors.activeHint')}
              checked={active}
              onChange={setActive}
            />
          </div>
        </Section>

        {error && <ErrorMessage error={error} />}
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? t('common.saving') : connector ? t('common.save') : t('common.create')}
          </button>
          <Link to={connector ? `/quellen/${connector.id}` : '/quellen'} className="btn">
            {t('common.cancel')}
          </Link>
        </FormActions>
      </form>
      {connector && <SecretSection connector={connector} />}
    </>
  );
}
