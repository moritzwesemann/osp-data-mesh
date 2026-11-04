import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { Connector, FieldMapping, ImportRun } from '../../shared/contract/index.ts';
import { ImportStarter } from '../components/connectors/ImportStarter.tsx';
import { needsSecret, SecretSection } from '../components/connectors/SecretSection.tsx';
import {
  dateFormatLabel,
  delimiterLabel,
  ENCODING_LABELS,
  targetLabel,
  useConnectorExport,
} from '../components/connectors/shared.ts';
import { DateTime, DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { QueryView } from '../components/QueryState.tsx';
import { Badge, StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

/** /quellen/:id – Quelle mit Konfiguration, Zuordnung, Import starten und Laufhistorie. */
export function ConnectorDetail() {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const query = useApiQuery('connectors.get', { params: { id } });
  return (
    <div className="page">
      <QueryView
        query={query}
        loading={
          <PageHeader
            title={t('common.loading')}
            back={{ to: '/quellen', label: t('connectors.backToList') }}
          />
        }
      >
        {(c) => <ConnectorView connector={c} />}
      </QueryView>
    </div>
  );
}

function ConnectorView({ connector: c }: { connector: Connector }) {
  const i = useI18n();
  const { t } = i;
  const session = useSession();
  const exportConnector = useConnectorExport();
  const dataset = useApiQuery(
    'datasets.get',
    { params: { id: c.targetDatasetId ?? '' } },
    { enabled: c.targetType === 'dataset' && Boolean(c.targetDatasetId) },
  );
  const fields = dataset.data ?? null;

  const configItems: [ReactNode, ReactNode][] = [
    [
      t('connectors.slug'),
      <span key="k57" className="mono">
        {c.slug}
      </span>,
    ],
    [
      t('connectors.targetType'),
      c.targetType === 'dataset' ? (
        <>
          {t('targetType.dataset')}:{' '}
          {c.targetDatasetId ? (
            <Link to={`/datensaetze/${c.targetDatasetId}`}>{c.targetDatasetName ?? c.targetDatasetId}</Link>
          ) : (
            t('common.empty')
          )}
        </>
      ) : (
        t('targetType.athletes')
      ),
    ],
  ];
  const cfg = c.config;
  if (cfg.type === 'csv') {
    configItems.push(
      [t('connectors.delimiter'), delimiterLabel(i, cfg.delimiter)],
      [t('connectors.encoding'), ENCODING_LABELS[cfg.encoding]],
      [
        t('connectors.decimalSeparator'),
        cfg.decimalSeparator === ',' ? t('connectors.decimalComma') : t('connectors.decimalPoint'),
      ],
      [t('connectors.dateFormat'), dateFormatLabel(i, cfg.dateFormat)],
    );
  } else {
    const p = cfg.pagination;
    const query = Object.entries(cfg.query);
    configItems.push(
      [
        t('connectors.url'),
        <span key="k89" className="mono break">
          {cfg.url}
        </span>,
      ],
      [
        t('connectors.itemsPath'),
        cfg.itemsPath ? (
          <span key="k92" className="mono">
            {cfg.itemsPath}
          </span>
        ) : (
          t('common.empty')
        ),
      ],
      [
        t('connectors.auth'),
        cfg.auth.type === 'header' ? (
          <>
            {t('connectors.authHeader')}: <span className="mono">{cfg.auth.headerName}</span>
          </>
        ) : cfg.auth.type === 'bearer' ? (
          t('connectors.authBearer')
        ) : (
          t('connectors.authNone')
        ),
      ],
      [
        t('connectors.pagination'),
        p.type === 'page' ? (
          <>
            {t('connectors.paginationPage')} (<span className="mono">{p.pageParam}</span>
            {p.sizeParam && (
              <>
                , <span className="mono">{p.sizeParam}</span>={p.pageSize}
              </>
            )}
            ; {t('connectors.maxPages')}: {p.maxPages})
          </>
        ) : p.type === 'cursor' ? (
          <>
            {t('connectors.paginationCursor')} (<span className="mono">{p.cursorParam}</span> ←{' '}
            <span className="mono">{p.nextCursorPath}</span>; {t('connectors.maxPages')}: {p.maxPages})
          </>
        ) : (
          t('connectors.paginationNone')
        ),
      ],
      [
        t('connectors.queryParams'),
        query.length === 0 ? (
          t('connectors.queryParamsNone')
        ) : (
          <span key="k132" className="mono break">
            {query.map(([k, v]) => `${k}=${v}`).join(' · ')}
          </span>
        ),
      ],
      [t('connectors.dateFormat'), dateFormatLabel(i, cfg.dateFormat)],
      [t('connectors.timeoutMs'), i.fmt.number(cfg.timeoutMs)],
    );
    if (needsSecret(c)) {
      configItems.push([
        t('connectors.secretState'),
        c.hasSecret ? (
          <Badge key="k142" tone="success">
            {t('connectors.secretYes')}
          </Badge>
        ) : (
          <Badge key="k144" tone="warning">
            {t('connectors.secretNo')}
          </Badge>
        ),
      ]);
    }
  }
  configItems.push(
    [
      t('connectors.matchStrategy'),
      c.athleteMatch.strategy === 'external_id' ? (
        <>
          {t('matchStrategy.external_id')}: <span className="mono">{c.athleteMatch.system}</span>
        </>
      ) : (
        t('matchStrategy.natural_key')
      ),
    ],
    [t('connectors.onError'), t(`onError.${c.onError}`)],
    [t('common.createdAt'), <DateTime key="k161" value={c.createdAt} />],
    [t('common.updatedAt'), <DateTime key="k162" value={c.updatedAt} />],
  );

  const mappingColumns: Column<FieldMapping>[] = [
    {
      key: 'source',
      header: t('connectors.sourceField'),
      className: 'nowrap',
      render: (m) => <span className="mono">{m.source}</span>,
    },
    {
      key: 'target',
      header: t('connectors.targetField'),
      render: (m) => (
        <span>
          {targetLabel(i, m.target, fields)} <span className="small muted mono">{m.target}</span>
        </span>
      ),
    },
    { key: 'transform', header: t('connectors.transform'), render: (m) => t(`transform.${m.transform}`) },
    {
      key: 'default',
      header: t('connectors.defaultValue'),
      render: (m) => (m.defaultValue ? <span className="mono">{m.defaultValue}</span> : t('common.empty')),
    },
    {
      key: 'valueMap',
      header: t('connectors.valueMap'),
      render: (m) => {
        const entries = Object.entries(m.valueMap ?? {});
        if (entries.length === 0) return t('common.empty');
        return (
          <span title={entries.map(([k, v]) => `${k}=${v}`).join('\n')}>
            {t('connectors.valueMapCount', { count: entries.length })}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title={c.name}
        back={{ to: '/quellen', label: t('connectors.backToList') }}
        description={c.description || undefined}
        meta={
          <>
            <Badge tone="info">{t(`connectorKind.${c.kind}`)}</Badge>
            <StatusBadge group="activeState" value={c.active ? 'active' : 'inactive'} />
            <Badge>{t('common.versionN', { version: c.version })}</Badge>
          </>
        }
        actions={
          <>
            {session.can('connectors.export') && (
              <button type="button" className="btn" onClick={() => void exportConnector(c)}>
                {t('connectors.exportAction')}
              </button>
            )}
            {session.can('connectors.update') && (
              <Link to={`/quellen/${c.id}/bearbeiten`} className="btn btn-primary">
                {t('common.edit')}
              </Link>
            )}
          </>
        }
      />

      <ImportStarter connector={c} />

      <div className="grid-2">
        <Section title={t('connectors.configTitle')}>
          <DescriptionList items={configItems} />
        </Section>
        <Section title={t('connectors.mappingTitle')}>
          <Table
            caption={t('connectors.mappingTitle')}
            columns={mappingColumns}
            rows={c.mapping}
            rowKey={(m) => `${m.source}→${m.target}`}
            empty={t('connectors.mappingEmpty')}
          />
        </Section>
      </div>

      <SecretSection connector={c} />

      <RunHistory connectorId={c.id} />
    </>
  );
}

function RunHistory({ connectorId }: { connectorId: string }) {
  const { t, fmt } = useI18n();
  const runs = useApiQuery('imports.list', { params: { id: connectorId } });
  const columns: Column<ImportRun>[] = [
    {
      key: 'created',
      header: t('connectors.colStarted'),
      className: 'nowrap',
      render: (r) => (
        <Link to={`/importe/${r.id}`}>
          <DateTime value={r.createdAt} />
        </Link>
      ),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge group="importStatus" value={r.status} />,
    },
    {
      key: 'source',
      header: t('connectors.colSourceName'),
      render: (r) => <span className="break">{r.sourceName}</span>,
    },
    {
      key: 'total',
      header: t('connectors.colRows'),
      className: 'num',
      render: (r) => fmt.number(r.totalRows),
    },
    {
      key: 'valid',
      header: t('connectors.colValid'),
      className: 'num',
      render: (r) => fmt.number(r.validRows),
    },
    {
      key: 'errors',
      header: t('connectors.colErrors'),
      className: 'num',
      render: (r) => (r.errorRows > 0 ? <span className="text-danger">{fmt.number(r.errorRows)}</span> : '0'),
    },
    {
      key: 'inserted',
      header: t('connectors.colInserted'),
      className: 'num',
      render: (r) => fmt.number(r.insertedRows),
    },
    {
      key: 'updated',
      header: t('connectors.colUpdated'),
      className: 'num',
      render: (r) => fmt.number(r.updatedRows),
    },
  ];
  return (
    <Section title={t('connectors.historyTitle')}>
      <QueryView query={runs}>
        {(data) => (
          <Table
            caption={t('connectors.historyTitle')}
            columns={columns}
            rows={data.items}
            rowKey={(r) => r.id}
            empty={t('connectors.historyEmpty')}
          />
        )}
      </QueryView>
    </Section>
  );
}
