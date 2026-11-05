import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import type { ExchangeLogEntry } from '../../shared/contract/index.ts';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { FormField } from '../components/FormField.tsx';
import { DateTime, DescriptionList, Details } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import {
  ConditionText,
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
import { codeText, revocationReasonText } from '../lib/errors.ts';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useRememberVisit } from '../lib/recent.ts';
import { useSession } from '../lib/session.tsx';

type ReleaseWithHistory = ApiOutput<'releases.get'>;

/** /freigaben/:id – Überblick, Austauschhistorie, Widerruf (releases.get, releases.revoke). */
export function ReleaseDetail() {
  const { id = '' } = useParams();
  const release = useApiQuery('releases.get', { params: { id } });
  useRememberVisit('release', id, release.isSuccess);
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

  // Richtung und Partner nur zeigen, wenn sie sich unterscheiden (sonst steht beides schon im Kopf)
  const showDirection = r.exchanges.some((e) => e.direction !== 'outgoing');
  const recipientNode = r.recipient.type === 'peer' ? r.recipient.peerNodeId : null;
  const showPeer = r.exchanges.some((e) => e.peerNodeId !== recipientNode);

  const historyColumns: Column<ExchangeLogEntry>[] = [
    { key: 'at', header: t('releases.colAt'), className: 'nowrap', render: (e) => <DateTime value={e.at} /> },
    ...(showDirection
      ? [
          {
            key: 'direction',
            header: t('releases.colDirection'),
            render: (e: ExchangeLogEntry) => t(`exchangeDirection.${e.direction}`),
          },
        ]
      : []),
    ...(showPeer
      ? [
          {
            key: 'peer',
            header: t('releases.colPeer'),
            className: 'mono',
            render: (e: ExchangeLogEntry) => e.peerNodeId,
          },
        ]
      : []),
    {
      key: 'purpose',
      header: t('releases.colPurpose'),
      render: (e) => (e.purpose ? purposeLabel(e.purpose) : t('common.empty')),
    },
    {
      key: 'outcome',
      header: t('releases.colOutcome'),
      render: (e) => (
        <div className="stack-sm">
          <span>
            <StatusBadge group="exchangeOutcome" value={e.outcome} />
          </span>
          {e.denyReason && (
            <span className="small muted">
              {i.tx(`denyReasons.${e.denyReason}`) ?? codeText(i, e.denyReason)}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'rows',
      header: t('releases.colRows'),
      className: 'num',
      render: (e) => (
        <span title={e.payloadSha256 ? t('releases.payloadTitle', { sha: e.payloadSha256 }) : undefined}>
          {fmt.number(e.rowCount)}
        </span>
      ),
    },
  ];

  const productName = t('releases.productWithVersion', { name: r.productName, version: r.productVersion });
  const dataWindowSet = Boolean(r.dataFrom || r.dataUntil);
  const hasRestrictions = r.rowFilter.length > 0 || dataWindowSet || r.requiresConsent;

  return (
    <>
      <PageHeader
        title={r.productName}
        docTitle={`${t('releases.title')}: ${r.productName}`}
        back={{ to: '/freigaben', label: t('releases.backToList') }}
        meta={r.status !== 'active' ? <StatusBadge group="releaseStatus" value={r.status} /> : undefined}
        description={
          <>
            {t('releases.detailRecipient')} <RecipientLabel recipient={r.recipient} />
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
          <p className="alert-title">
            {r.revokedAt
              ? t('releases.revokedOn', { date: fmt.dateTime(r.revokedAt) })
              : t('releases.revokedTitle')}
          </p>
          {r.revocationReason && <p>{revocationReasonText(i, r.revocationReason)}</p>}
        </div>
      )}

      <Section title={t('releases.summaryTitle')} description={t('releases.immutableHint')}>
        <DescriptionList
          items={[
            [t('releases.purposes'), <PurposeList key="p" purposes={r.purposes} />],
            [
              t('releases.releasedColumns'),
              r.columns.length === 0 ? (
                <span key="c" className="muted">
                  {t('common.noColumns')}
                </span>
              ) : (
                // Ohne Leserecht auf das Produkt (z. B. Revision) fehlen Bezeichnungen: Schlüssel als Code zeigen
                <span key="c">
                  {r.columns.map((key, n) => (
                    <span key={key}>
                      {n > 0 && ', '}
                      {labels.get(key) ?? <code>{key}</code>}
                    </span>
                  ))}
                </span>
              ),
            ],
            [
              t('releases.restrictions'),
              hasRestrictions ? (
                <ul key="f" className="list-plain stack-sm">
                  {r.rowFilter.map((c) => (
                    <li key={JSON.stringify(c)}>
                      <ConditionText condition={c} labels={labels} />
                    </li>
                  ))}
                  {dataWindowSet && (
                    <li>
                      {t('releases.dataWindowLine', {
                        range: rangeText(t, fmt.date, r.dataFrom, r.dataUntil, ''),
                      })}
                    </li>
                  )}
                  {r.requiresConsent && <li>{t('releases.consentOn')}</li>}
                </ul>
              ) : (
                <span key="f" className="muted">
                  {t('releases.noRestrictions')}
                </span>
              ),
            ],
            [t('releases.validity'), validityText(i, r.validFrom, r.validUntil)],
          ]}
        />
        <Details summary={t('releases.moreDetails')}>
          <DescriptionList
            items={[
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
              [
                t('releases.product'),
                canProduct ? (
                  <Link key="p" to={`/produkte/${r.productId}`}>
                    {productName}
                  </Link>
                ) : (
                  productName
                ),
              ],
              [t('releases.createdAt'), <DateTime key="c" value={r.createdAt} />],
              ...(r.recipient.type === 'peer'
                ? ([
                    [
                      t('releases.peerNodeId'),
                      <code key="pn" className="mono">
                        {r.recipient.peerNodeId}
                      </code>,
                    ],
                  ] as [string, ReactNode][])
                : []),
              [
                t('releases.columnKeys'),
                <span key="k" className="mono break">
                  {r.columns.join(', ') || t('common.empty')}
                </span>,
              ],
              [
                t('releases.releaseId'),
                <code key="i" className="mono break">
                  {r.id}
                </code>,
              ],
            ]}
          />
        </Details>
      </Section>

      <Section
        title={t('releases.historyCount', { count: r.exchanges.length })}
        description={t('releases.historyIntro')}
        collapsible
      >
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
