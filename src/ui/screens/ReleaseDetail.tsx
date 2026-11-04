import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { ExchangeLogEntry } from '../../shared/contract/index.ts';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { FormField } from '../components/FormField.tsx';
import { DateTime, DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import {
  ConditionSummary,
  PurposeList,
  RecipientLabel,
  rangeText,
  validityText,
} from '../components/releases/ReleaseParts.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { codeText } from '../lib/errors.ts';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type ReleaseWithHistory = ApiOutput<'releases.get'>;

/** /freigaben/:id – Beschränkungen, Austauschhistorie, Widerruf (releases.get, releases.revoke). */
export function ReleaseDetail() {
  const { id = '' } = useParams();
  const release = useApiQuery('releases.get', { params: { id } });
  return (
    <div className="page">
      <QueryView query={release}>{(r) => <ReleaseView release={r} />}</QueryView>
    </div>
  );
}

function ReleaseView({ release: r }: { release: ReleaseWithHistory }) {
  const i = useI18n();
  const { t, fmt } = i;
  const session = useSession();
  const toast = useToast();
  const purposeLabel = usePurposeLabel();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [reason, setReason] = useState('');

  const canProduct = session.can('products.get');
  const product = useApiQuery('products.get', { params: { id: r.productId } }, { enabled: canProduct });
  const labels = new Map((product.data?.columns ?? []).map((c) => [c.key, c.label]));

  const revoke = useApiMutation('releases.revoke', {
    invalidate: ['releases.get', 'releases.list', 'products.list', 'products.get'],
    onSuccess: () => {
      setRevokeOpen(false);
      setReason('');
      toast.success(t('releases.revoked'));
    },
  });

  const outdated = r.status === 'outdated' || r.productVersion !== r.currentProductVersion;
  const canRevoke = session.can('releases.revoke') && r.status !== 'revoked';
  const canCreate = session.can('releases.create');

  const historyColumns: Column<ExchangeLogEntry>[] = [
    { key: 'at', header: t('releases.colAt'), className: 'nowrap', render: (e) => <DateTime value={e.at} /> },
    {
      key: 'direction',
      header: t('releases.colDirection'),
      render: (e) => t(`exchangeDirection.${e.direction}`),
    },
    { key: 'peer', header: t('releases.colPeer'), className: 'mono', render: (e) => e.peerNodeId },
    {
      key: 'purpose',
      header: t('releases.colPurpose'),
      render: (e) => (e.purpose ? purposeLabel(e.purpose) : t('common.empty')),
    },
    {
      key: 'outcome',
      header: t('releases.colOutcome'),
      render: (e) => <StatusBadge group="exchangeOutcome" value={e.outcome} />,
    },
    {
      key: 'reason',
      header: t('releases.colReason'),
      render: (e) =>
        e.denyReason ? (i.tx(`denyReasons.${e.denyReason}`) ?? codeText(i, e.denyReason)) : t('common.empty'),
    },
    { key: 'rows', header: t('releases.colRows'), className: 'num', render: (e) => fmt.number(e.rowCount) },
    {
      key: 'payload',
      header: t('releases.colPayload'),
      className: 'mono nowrap',
      render: (e) =>
        e.payloadSha256 ? (
          <span title={e.payloadSha256}>{`${e.payloadSha256.slice(0, 12)}…`}</span>
        ) : (
          t('common.empty')
        ),
    },
  ];

  const productCell = canProduct ? (
    <Link to={`/produkte/${r.productId}`}>
      {t('releases.productWithVersion', { name: r.productName, version: r.productVersion })}
    </Link>
  ) : (
    t('releases.productWithVersion', { name: r.productName, version: r.productVersion })
  );

  const columnsCell =
    r.columns.length === 0 ? (
      <span className="muted">{t('common.noColumns')}</span>
    ) : (
      <ul className="list-plain stack-sm">
        {r.columns.map((key) => (
          <li key={key}>
            {labels.get(key) ? (
              <>
                {labels.get(key)} <code className="muted">{key}</code>
              </>
            ) : (
              <code>{key}</code>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <>
      <PageHeader
        title={r.productName}
        docTitle={`${t('releases.title')}: ${r.productName}`}
        back={{ to: '/freigaben', label: t('releases.backToList') }}
        description={t('releases.detailDescription', { date: fmt.dateTime(r.createdAt) })}
        meta={
          <>
            <StatusBadge group="releaseStatus" value={r.status} />
            <span className="muted small">
              <RecipientLabel recipient={r.recipient} />
            </span>
          </>
        }
        actions={
          <>
            {canCreate && (
              <Link to={`/freigaben/neu?vorlage=${r.id}`} className="btn">
                {t('releases.useAsTemplate')}
              </Link>
            )}
            {canRevoke && (
              <button type="button" className="btn btn-danger-outline" onClick={() => setRevokeOpen(true)}>
                {t('releases.revoke')}
              </button>
            )}
          </>
        }
      />

      {outdated && r.status !== 'revoked' && (
        <div className="alert alert-warning" role="status">
          <p className="alert-title">{t('releases.outdatedTitle')}</p>
          <p>{t('releases.outdatedText', { granted: r.productVersion, current: r.currentProductVersion })}</p>
          {canCreate && (
            <p>
              <Link to={`/freigaben/neu?vorlage=${r.id}`} className="btn btn-sm">
                {t('releases.regrant')}
              </Link>
            </p>
          )}
        </div>
      )}

      {r.status === 'revoked' && (
        <div className="alert alert-info">
          <p className="alert-title">{t('releases.revokedTitle')}</p>
          {r.revocationReason && <p>{r.revocationReason}</p>}
        </div>
      )}

      <Section title={t('releases.restrictions')} description={t('releases.immutableHint')}>
        <DescriptionList
          items={[
            [t('releases.product'), productCell],
            [t('releases.recipient'), <RecipientLabel key="r" recipient={r.recipient} />],
            [t('releases.purposes'), <PurposeList key="p" purposes={r.purposes} />],
            [t('releases.releasedColumns'), columnsCell],
            [
              t('releases.rowFilter'),
              <ConditionSummary
                key="f"
                conditions={r.rowFilter}
                labels={labels}
                emptyText={t('releases.noRowFilter')}
              />,
            ],
            [
              t('releases.dataWindow'),
              rangeText(t, fmt.date, r.dataFrom, r.dataUntil, t('releases.unrestricted')),
            ],
            [t('releases.validity'), validityText(i, r.validFrom, r.validUntil)],
            [t('releases.consent'), r.requiresConsent ? t('releases.consentOn') : t('releases.consentOff')],
            [
              t('releases.legalBasis'),
              r.legalBasis || (
                <span key="l" className="muted">
                  {t('common.empty')}
                </span>
              ),
            ],
            [
              t('releases.note'),
              r.note ? (
                <span key="n" className="break">
                  {r.note}
                </span>
              ) : (
                <span key="n" className="muted">
                  {t('common.empty')}
                </span>
              ),
            ],
            [t('releases.createdAt'), <DateTime key="c" value={r.createdAt} />],
            ...(r.revokedAt
              ? ([
                  [t('releases.revokedAt'), <DateTime key="v" value={r.revokedAt} />],
                  [t('releases.revocationReason'), r.revocationReason ?? t('common.empty')],
                ] as [string, ReactNode][])
              : []),
          ]}
        />
      </Section>

      <Section title={t('releases.history')} description={t('releases.historyIntro')}>
        {r.exchanges.length === 0 ? (
          <EmptyState message={t('releases.historyEmpty')} />
        ) : (
          <Table
            columns={historyColumns}
            rows={r.exchanges}
            rowKey={(e) => e.id}
            caption={t('releases.historyCaption')}
          />
        )}
      </Section>

      <ConfirmDialog
        open={revokeOpen}
        title={t('releases.revokeTitle')}
        destructive
        confirmLabel={t('releases.revokeConfirm')}
        busy={revoke.isPending}
        error={revoke.error}
        confirmDisabled={reason.trim() === ''}
        onCancel={() => {
          setRevokeOpen(false);
          revoke.reset();
        }}
        onConfirm={() => revoke.mutate({ params: { id: r.id }, body: { reason: reason.trim() } })}
        message={
          <div className="stack-sm">
            <p>{t('releases.revokeText')}</p>
            {r.recipient.type === 'peer' && <p>{t('releases.revokePeerText')}</p>}
            {r.recipient.type === 'role' && r.recipient.role === 'bi' && <p>{t('releases.revokeBiText')}</p>}
          </div>
        }
      >
        <FormField label={t('releases.revokeReason')} required hint={t('releases.revokeReasonHint')}>
          {(a) => (
            <textarea
              {...a}
              className="input"
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </FormField>
      </ConfirmDialog>
    </>
  );
}
