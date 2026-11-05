import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { type Connector, ConnectorDefinition } from '../../shared/contract/index.ts';
import { useConnectorExport } from '../components/connectors/shared.ts';
import { Dialog } from '../components/Dialog.tsx';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { Checkbox } from '../components/FormField.tsx';
import { DateTime, DescriptionList, YesNo } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { Badge, StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';
import { readJsonFile } from '../lib/util.ts';

/** /quellen – Quellen (Connectoren), Vorlagen, Import/Export von Definitionen. */
export function ConnectorList() {
  const { t } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const exportConnector = useConnectorExport();
  const list = useApiQuery('connectors.list', {});
  const canCreate = session.can('connectors.create');
  const canImport = session.can('connectors.import');
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pending, setPending] = useState<ConnectorDefinition | null>(null);
  const [createDataset, setCreateDataset] = useState(true);

  const importDef = useApiMutation('connectors.import', {
    invalidate: ['connectors.list', 'datasets.list', 'catalog.local'],
    onSuccess: (c) => {
      setPending(null);
      toast.success(t('connectors.imported'));
      navigate(`/quellen/${c.id}`);
    },
  });

  const onFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    let json: unknown;
    try {
      json = await readJsonFile(file);
    } catch {
      setFileError(t('common.invalidJsonFile'));
      return;
    }
    const parsed = ConnectorDefinition.safeParse(json);
    if (!parsed.success) {
      setFileError(t('connectors.invalidDefinition'));
      return;
    }
    importDef.reset();
    setCreateDataset(true);
    setPending(parsed.data);
  };

  const columns: Column<Connector>[] = [
    {
      key: 'name',
      header: t('connectors.colName'),
      render: (c) => (
        <span className="row">
          <Link to={`/quellen/${c.id}`}>{c.name}</Link>
          {!c.active && <StatusBadge group="activeState" value="inactive" />}
        </span>
      ),
    },
    {
      key: 'kind',
      header: t('connectors.colKind'),
      className: 'nowrap',
      render: (c) => t(`connectorKind.${c.kind}`),
    },
    {
      key: 'target',
      header: t('connectors.colTarget'),
      render: (c) =>
        c.targetType === 'dataset' ? (
          <span className="break">{c.targetDatasetName ?? t('targetType.dataset')}</span>
        ) : (
          t('targetType.athletes')
        ),
    },
    {
      key: 'lastRun',
      header: t('connectors.colLastRun'),
      render: (c) =>
        c.lastRun ? (
          <span className="row">
            <Link to={`/importe/${c.lastRun.id}`} className="nowrap">
              <DateTime value={c.lastRun.createdAt} />
            </Link>
            {c.lastRun.status !== 'committed' && (
              <StatusBadge group="importStatus" value={c.lastRun.status} />
            )}
          </span>
        ) : (
          <span className="muted small">{t('connectors.noRun')}</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('common.actions')}</span>,
      className: 'num',
      render: (c) =>
        session.can('connectors.export') ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void exportConnector(c)}>
            {t('connectors.exportAction')}
          </button>
        ) : null,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={t('connectors.listTitle')}
        description={t('connectors.listIntro')}
        actions={
          <>
            {canImport && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={(e) => {
                    void onFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                  {t('connectors.importDefinition')}
                </button>
              </>
            )}
            {canCreate && (
              <Link to="/quellen/neu" className="btn btn-primary">
                {t('connectors.create')}
              </Link>
            )}
          </>
        }
      />

      {fileError && (
        <div className="alert alert-error" role="alert">
          <p>{fileError}</p>
        </div>
      )}

      <QueryView query={list}>
        {(data) => (
          <Table
            caption={t('connectors.listTitle')}
            columns={columns}
            rows={data.items}
            rowKey={(c) => c.id}
            empty={
              <EmptyState
                message={t('connectors.empty')}
                action={
                  canCreate ? (
                    <Link to="/quellen/neu" className="btn btn-primary">
                      {t('connectors.create')}
                    </Link>
                  ) : undefined
                }
              />
            }
          />
        )}
      </QueryView>

      {session.can('connectors.templates') && (
        <TemplateGallery canImport={canImport} open={list.isSuccess && list.data.items.length === 0} />
      )}

      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t('connectors.importDialogTitle')}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setPending(null)}
              disabled={importDef.isPending}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={importDef.isPending || !pending}
              onClick={() => {
                if (pending)
                  importDef.mutate({
                    body: { definition: pending, createDataset: pending.dataset ? createDataset : false },
                  });
              }}
            >
              {t('connectors.importNow')}
            </button>
          </>
        }
      >
        {pending && (
          <>
            <p className="muted">{t('connectors.importDialogIntro')}</p>
            <DescriptionList
              items={[
                [t('connectors.definitionName'), pending.connector.name],
                [
                  t('connectors.definitionSlug'),
                  <span key="k232" className="mono">
                    {pending.connector.slug}
                  </span>,
                ],
                [t('connectors.kind'), t(`connectorKind.${pending.connector.kind}`)],
                [t('connectors.targetType'), t(`targetType.${pending.connector.targetType}`)],
                [
                  t('connectors.definitionTargetDataset'),
                  pending.connector.targetDatasetSlug ? (
                    <span key="k238" className="mono">
                      {pending.connector.targetDatasetSlug}
                    </span>
                  ) : (
                    t('common.empty')
                  ),
                ],
                [
                  t('connectors.datasetIncluded'),
                  pending.dataset ? (
                    <>
                      <YesNo value /> – {pending.dataset.name}
                    </>
                  ) : (
                    <YesNo key="k250" value={false} />
                  ),
                ],
              ]}
            />
            {pending.dataset && (
              <Checkbox
                label={t('connectors.createDataset')}
                hint={t('connectors.createDatasetHint')}
                checked={createDataset}
                onChange={setCreateDataset}
              />
            )}
            {importDef.error && <ErrorMessage error={importDef.error} />}
          </>
        )}
      </Dialog>
    </div>
  );
}

function TemplateGallery({ canImport, open }: { canImport: boolean; open: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const templates = useApiQuery('connectors.templates', {}, { staleTime: 10 * 60_000 });
  const [applying, setApplying] = useState<string | null>(null);
  const apply = useApiMutation('connectors.import', {
    invalidate: ['connectors.list', 'datasets.list', 'catalog.local'],
    onSuccess: (c) => {
      toast.success(t('connectors.templateApplied'));
      navigate(`/quellen/${c.id}`);
    },
  });

  return (
    <Section
      title={t('connectors.templatesTitle')}
      description={t('connectors.templatesIntro')}
      collapsible
      defaultOpen={open}
    >
      {apply.error && <ErrorMessage error={apply.error} />}
      <QueryView query={templates}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState message={t('connectors.templatesEmpty')} />
          ) : (
            <div className="card-grid">
              {data.items.map((tpl) => (
                <article key={tpl.id} className="card">
                  <h3>{tpl.name}</h3>
                  <div className="badges">
                    <Badge tone="info">{t(`connectorKind.${tpl.definition.connector.kind}`)}</Badge>
                    <Badge>{t(`targetType.${tpl.definition.connector.targetType}`)}</Badge>
                  </div>
                  {tpl.description && <p className="small muted">{tpl.description}</p>}
                  {canImport && (
                    <div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={apply.isPending}
                        aria-busy={(apply.isPending && applying === tpl.id) || undefined}
                        onClick={() => {
                          setApplying(tpl.id);
                          apply.mutate({ body: { definition: tpl.definition, createDataset: true } });
                        }}
                      >
                        {t('connectors.useTemplate')}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )
        }
      </QueryView>
    </Section>
  );
}
