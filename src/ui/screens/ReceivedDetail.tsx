import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { ExportFormat } from '../../shared/contract/index.ts';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { ErrorMessage } from '../components/ErrorMessage.tsx';
import { shortHash } from '../components/federation/fingerprint.ts';
import { DateTime, DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { QueryView, Skeleton } from '../components/QueryState.tsx';
import { ResultTable } from '../components/ResultTable.tsx';
import { SpecialCategoryBadge, StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Pagination, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import { type ApiOutput, downloadFile } from '../lib/api.ts';
import { codeText, describeError } from '../lib/errors.ts';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type Detail = ApiOutput<'received.get'>;
type HistoryEntry = Detail['history'][number];

const PAGE_SIZE = 50;
const FORMATS: readonly ExportFormat[] = ['csv', 'json', 'xml'];

/** /empfangen/:id – empfangenes Produkt mit Herkunftsnachweis, Zeilen, Export, erneutem Abruf. */
export function ReceivedDetail() {
  const { id = '' } = useParams();
  const detail = useApiQuery('received.get', { params: { id } }, { enabled: id !== '' });

  return (
    <div className="page">
      <QueryView query={detail}>{(d) => <ReceivedView detail={d} />}</QueryView>
    </div>
  );
}

function ReceivedView({ detail: d }: { detail: Detail }) {
  const i = useI18n();
  const { t, tx } = i;
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const purposeLabel = usePurposeLabel();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const repull = useApiMutation('received.pull', {
    invalidate: ['received.list', 'received.get', 'received.rows'],
    onSuccess: (r) => toast.success(t('received.repulled', { count: r.rowCount })),
  });
  const remove = useApiMutation('received.delete', {
    invalidate: ['received.list'],
    onSuccess: () => {
      toast.success(t('received.deleted'));
      navigate('/empfangen', { replace: true });
    },
  });

  const reason = d.statusReason
    ? (tx(`receivedReasons.${d.statusReason}`) ?? codeText(i, d.statusReason))
    : null;
  const p = d.provenance;

  return (
    <>
      <PageHeader
        title={d.title}
        back={{ to: '/empfangen', label: t('received.backToList') }}
        meta={
          <>
            <StatusBadge group="receivedStatus" value={d.status} />
            <SpecialCategoryBadge show={d.specialCategory} />
          </>
        }
        description={d.description || undefined}
        actions={
          <>
            {session.can('received.pull') && (
              <button
                type="button"
                className="btn"
                disabled={repull.isPending}
                onClick={() =>
                  repull.mutate({
                    body: { peerId: d.peer.id, releaseId: d.remoteReleaseId, purpose: d.purpose },
                  })
                }
              >
                {repull.isPending ? t('received.repulling') : t('received.repull')}
              </button>
            )}
            {session.can('received.delete') && (
              <button type="button" className="btn btn-danger-outline" onClick={() => setConfirmDelete(true)}>
                {t('received.deleteCopy')}
              </button>
            )}
          </>
        }
      />

      {repull.error && <ErrorMessage error={repull.error} />}

      {d.status !== 'active' && (
        <div className="alert alert-warning">
          <p className="alert-title">{t('received.inactiveTitle')}</p>
          {reason && <p>{reason}</p>}
          {d.statusChangedAt && (
            <p className="small">
              {t('received.statusChanged', { time: i.fmt.dateTime(d.statusChangedAt) })}
            </p>
          )}
        </div>
      )}

      <Section title={t('received.provenance')} description={t('received.provenanceIntro')}>
        <DescriptionList
          items={[
            [
              t('received.sourceNode'),
              <span key="node">
                {p.sourceNodeName} <span className="mono small muted">{p.sourceNodeId}</span>
              </span>,
            ],
            [
              t('received.sourceFingerprint'),
              <span key="fp" className="mono break">
                {p.sourceFingerprint}
              </span>,
            ],
            [
              t('received.remoteRelease'),
              <span key="rel" className="mono break">
                {p.remoteReleaseId}
              </span>,
            ],
            [
              t('received.remoteProduct'),
              <span key="prod">
                <span className="mono break">{p.remoteProductId}</span>{' '}
                <span className="mono small muted">({d.remoteProductSlug})</span>
              </span>,
            ],
            [t('received.productVersion'), p.productVersion],
            [t('common.purpose'), purposeLabel(p.purpose)],
            [t('received.pulledAt'), <DateTime key="pulled" value={p.pulledAt} />],
            [
              t('received.payloadSha'),
              p.payloadSha256 ? (
                <span key="sha" className="mono break">
                  {p.payloadSha256}
                </span>
              ) : (
                t('common.empty')
              ),
            ],
            [
              t('received.signature'),
              p.responseSignature ? (
                <span key="sig" className="mono break small">
                  {p.responseSignature}
                </span>
              ) : (
                t('common.empty')
              ),
            ],
            [t('common.status'), <StatusBadge key="status" group="receivedStatus" value={d.status} />],
            [
              t('received.validUntil'),
              d.releaseValidUntil ? (
                <DateTime key="valid" value={d.releaseValidUntil} />
              ) : (
                t('received.unlimited')
              ),
            ],
          ]}
        />
      </Section>

      <RowsSection detail={d} />

      <HistorySection history={d.history} />

      <ConfirmDialog
        open={confirmDelete}
        title={t('received.deleteTitle')}
        message={t('received.deleteConfirm', { name: d.title })}
        confirmLabel={t('received.deleteCopy')}
        destructive
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate({ params: { id: d.id } })}
        onCancel={() => {
          remove.reset();
          setConfirmDelete(false);
        }}
      />
    </>
  );
}

function RowsSection({ detail: d }: { detail: Detail }) {
  const i = useI18n();
  const { t } = i;
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const rows = useApiQuery(
    'received.rows',
    { params: { id: d.id }, query: { page, pageSize: PAGE_SIZE } },
    { keepPrevious: true },
  );

  const exportAs = async (format: ExportFormat) => {
    setExporting(format);
    try {
      await downloadFile(
        'received.rows',
        { params: { id: d.id }, query: { format } },
        `${d.remoteProductSlug}.${format}`,
      );
    } catch (e) {
      toast.error(describeError(i, e).message);
    } finally {
      setExporting(null);
    }
  };

  return (
    <Section
      title={t('received.rowsTitle')}
      actions={
        d.status === 'active' ? (
          <div className="row">
            <span className="small muted">{t('received.exportAs')}</span>
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                className="btn btn-sm"
                disabled={exporting !== null}
                onClick={() => void exportAs(f)}
              >
                {exporting === f ? t('received.exporting') : f.toUpperCase()}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      <QueryView query={rows} loading={<Skeleton lines={5} />}>
        {(data) => (
          <div className="stack">
            <p className="small muted">{t('common.rows', { count: data.total })}</p>
            <ResultTable
              columns={data.columns}
              rows={data.rows}
              caption={t('received.rowsTitle')}
              numbered
              offset={(data.page - 1) * data.pageSize}
            />
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPageChange={setPage} />
          </div>
        )}
      </QueryView>
    </Section>
  );
}

function HistorySection({ history }: { history: readonly HistoryEntry[] }) {
  const i = useI18n();
  const { t, tx, fmt } = i;
  const purposeLabel = usePurposeLabel();
  const columns: Column<HistoryEntry>[] = [
    { key: 'at', header: t('received.at'), className: 'nowrap', render: (h) => <DateTime value={h.at} /> },
    {
      key: 'outcome',
      header: t('received.outcome'),
      render: (h) => <StatusBadge group="exchangeOutcome" value={h.outcome} />,
    },
    {
      key: 'reason',
      header: t('received.reason'),
      render: (h) =>
        h.denyReason ? (tx(`denyReasons.${h.denyReason}`) ?? codeText(i, h.denyReason)) : t('common.empty'),
    },
    {
      key: 'purpose',
      header: t('common.purpose'),
      render: (h) => (h.purpose ? purposeLabel(h.purpose) : t('common.empty')),
    },
    { key: 'rows', header: t('received.rowCount'), className: 'num', render: (h) => fmt.number(h.rowCount) },
    {
      key: 'sha',
      header: t('received.checksum'),
      className: 'nowrap',
      render: (h) =>
        h.payloadSha256 ? (
          <span className="mono" title={h.payloadSha256}>
            {shortHash(h.payloadSha256, 16)}
          </span>
        ) : (
          t('common.empty')
        ),
    },
  ];
  return (
    <Section title={t('received.history')}>
      <Table
        columns={columns}
        rows={history}
        rowKey={(h) => h.id}
        caption={t('received.history')}
        empty={t('received.historyEmpty')}
      />
    </Section>
  );
}
