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
import { DateTime, DescriptionList, Details } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { Badge, StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

/** /quellen/:id – Quelle: Import starten, kurzer Überblick, Feldzuordnung, Laufhistorie, technische Details. */
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
  const cfg = c.config;

  // Überblick: was die Quelle ist, wohin die Daten gehen, wie Personen erkannt werden, letzter Lauf
  const summary: [ReactNode, ReactNode][] = [
    [t('connectors.kind'), t(`connectorKind.${c.kind}`)],
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
  ];
  if (cfg.type === 'http_api') {
    summary.push([
      t('connectors.url'),
      <span key="url" className="mono break">
        {cfg.url}
      </span>,
    ]);
  }
  summary.push([
    t('connectors.colLastRun'),
    c.lastRun ? (
      <span key="last" className="row">
        <Link to={`/importe/${c.lastRun.id}`}>
          <DateTime value={c.lastRun.createdAt} />
        </Link>
        <StatusBadge group="importStatus" value={c.lastRun.status} />
      </span>
    ) : (
      <span key="none" className="muted">
        {t('connectors.noRun')}
      </span>
    ),
  ]);

  // Technische Details: Kennung, Version, Formatangaben, Fehlerbehandlung, Zeitstempel
  const technical: [ReactNode, ReactNode][] = [
    [
      t('connectors.slug'),
      <span key="slug" className="mono">
        {c.slug}
      </span>,
    ],
    [t('common.version'), c.version],
  ];
  if (cfg.type === 'csv') {
    technical.push(
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
    technical.push(
      [
        t('connectors.itemsPath'),
        cfg.itemsPath ? (
          <span key="items" className="mono">
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
          <span key="query" className="mono break">
            {query.map(([k, v]) => `${k}=${v}`).join(' · ')}
          </span>
        ),
      ],
      [t('connectors.dateFormat'), dateFormatLabel(i, cfg.dateFormat)],
      [t('connectors.timeoutMs'), i.fmt.number(cfg.timeoutMs)],
    );
    if (needsSecret(c)) {
      technical.push([
        t('connectors.secretState'),
        c.hasSecret ? (
          <Badge key="secret" tone="success">
            {t('connectors.secretYes')}
          </Badge>
        ) : (
          <Badge key="secret" tone="warning">
            {t('connectors.secretNo')}
          </Badge>
        ),
      ]);
    }
  }
  technical.push(
    [t('connectors.onError'), t(`onError.${c.onError}`)],
    [t('common.createdAt'), <DateTime key="created" value={c.createdAt} />],
    [t('common.updatedAt'), <DateTime key="updated" value={c.updatedAt} />],
  );

  // Feldzuordnung: auf einen Blick nur „Quellspalte → Zielfeld“, Pfade und Umwandlungen aufklappbar
  const mappingColumns: Column<FieldMapping>[] = [
    {
      key: 'source',
      header: t('connectors.sourceField'),
      // CSV: Spaltennamen der Datei; API: Punkt-Pfade im JSON (technisch, daher Monospace)
      className: c.kind === 'http_api' ? 'mono break' : undefined,
      render: (m) => m.source,
    },
    { key: 'target', header: t('connectors.targetField'), render: (m) => targetLabel(i, m.target, fields) },
  ];
  const mappingTechColumns: Column<FieldMapping>[] = [
    {
      key: 'source',
      header: t('connectors.sourceField'),
      className: 'mono break',
      render: (m) => m.source,
    },
    { key: 'path', header: t('connectors.targetPath'), className: 'mono', render: (m) => m.target },
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
        return <span className="mono break">{entries.map(([k, v]) => `${k}=${v}`).join(' · ')}</span>;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title={c.name}
        back={{ to: '/quellen', label: t('connectors.backToList') }}
        description={c.description || undefined}
        meta={c.active ? undefined : <StatusBadge group="activeState" value="inactive" />}
        actions={
          <>
            {session.can('connectors.update') && (
              <Link to={`/quellen/${c.id}/bearbeiten`} className="btn">
                {t('common.edit')}
              </Link>
            )}
            {session.can('connectors.export') && (
              <button type="button" className="btn" onClick={() => void exportConnector(c)}>
                {t('connectors.exportAction')}
              </button>
            )}
          </>
        }
      />

      <ImportStarter connector={c} />

      <div className="grid-2">
        <Section title={t('connectors.summaryTitle')}>
          <DescriptionList items={summary} />
          <Details>
            <DescriptionList items={technical} />
          </Details>
        </Section>
        <Section title={t('connectors.mappingTitle')}>
          {c.mapping.length === 0 ? (
            <EmptyState message={t('connectors.mappingEmpty')} />
          ) : (
            <>
              <Table
                caption={t('connectors.mappingTitle')}
                columns={mappingColumns}
                rows={c.mapping}
                rowKey={(m) => `${m.source}→${m.target}`}
              />
              <Details summary={t('connectors.mappingDetails')}>
                <Table
                  caption={t('connectors.mappingDetails')}
                  columns={mappingTechColumns}
                  rows={c.mapping}
                  rowKey={(m) => `${m.source}→${m.target}`}
                />
              </Details>
            </>
          )}
        </Section>
      </div>

      <SecretSection connector={c} />

      <RunHistory connectorId={c.id} open={c.lastRun?.status === 'previewed'} />
    </>
  );
}

/** Ergebnis eines Laufs in einer Zeile, z. B. „78 von 80 übernommen · 2 Fehler“. */
function RunResult({ run: r }: { run: ImportRun }) {
  const { t } = useI18n();
  if (r.status === 'failed') return <span className="muted">{t('common.empty')}</span>;
  return (
    <span>
      {r.status === 'committed'
        ? t('connectors.resultCommitted', { done: r.insertedRows + r.updatedRows, total: r.totalRows })
        : t('connectors.resultChecked', { valid: r.validRows, total: r.totalRows })}
      {r.errorRows > 0 && (
        <>
          {' · '}
          <span className="text-danger">{t('connectors.resultErrors', { count: r.errorRows })}</span>
        </>
      )}
    </span>
  );
}

function RunHistory({ connectorId, open }: { connectorId: string; open: boolean }) {
  const { t } = useI18n();
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
    { key: 'result', header: t('connectors.colResult'), render: (r) => <RunResult run={r} /> },
  ];
  return (
    <Section title={t('connectors.historyTitle')} collapsible defaultOpen={open}>
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
