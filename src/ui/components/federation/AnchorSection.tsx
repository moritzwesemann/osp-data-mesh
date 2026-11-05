import { useI18n } from '../../i18n/index.tsx';
import { type ApiOutput, api, saveJson } from '../../lib/api.ts';
import { codeText, describeError } from '../../lib/errors.ts';
import { useApiMutation, useApiQuery } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';
import { DateTime, MetaLine } from '../Misc.tsx';
import { Section } from '../PageHeader.tsx';
import { QueryView } from '../QueryState.tsx';
import { Badge } from '../StatusBadge.tsx';
import { type Column, Table } from '../Table.tsx';
import { useToast } from '../Toast.tsx';

type Verification = ApiOutput<'anchors.verify'>;
type PartnerResult = Verification['partners'][number];

/**
 * Externe Verankerung der Audit-Kette (ADR 0014): letzter signierter Prüfpunkt, Senden auf Anforderung,
 * Abgleich mit den bei Partnern verwahrten Prüfpunkten (erkennt Abschneiden und Umschreiben), Export.
 */
export function AnchorSection() {
  const i = useI18n();
  const { t, fmt } = i;
  const toast = useToast();
  const session = useSession();
  const status = useApiQuery('anchors.status', {});
  const create = useApiMutation('anchors.create', {
    invalidate: ['anchors.status', 'audit.list'],
    onSuccess: (r) =>
      toast.success(
        r.created
          ? t('audit.anchorsCreated', { seq: r.checkpoint.seq, peers: r.checkpoint.peers })
          : t('audit.anchorsExisting', { seq: r.checkpoint.seq }),
      ),
  });
  const verify = useApiMutation('anchors.verify', { invalidate: ['audit.list'] });

  const download = async () => {
    try {
      const exp = await api('anchors.latest', {});
      saveJson(exp, `audit-checkpoint-${exp.nodeId}-${exp.seq}.json`);
    } catch (err) {
      toast.error(describeError(i, err).message);
    }
  };

  const result = verify.data;
  const failed = status.data?.failed ?? 0;

  return (
    <Section
      collapsible
      defaultOpen={failed > 0 || result?.result === 'manipulated'}
      title={
        <span className="row">
          {t('audit.anchorsTitle')}
          {failed > 0 && <Badge tone="danger">{t('audit.anchorsFailedCount', { count: failed })}</Badge>}
        </span>
      }
      description={t('audit.anchorsIntro')}
    >
      <div className="stack">
        <QueryView query={status}>
          {(s) => (
            <MetaLine
              items={[
                s.latest
                  ? t('audit.anchorsLatest', { seq: s.latest.seq, date: fmt.dateTime(s.latest.at) })
                  : t('audit.anchorsNone'),
                s.intervalHours > 0
                  ? t('audit.anchorsInterval', { hours: s.intervalHours })
                  : t('audit.anchorsManualOnly'),
                s.pending + s.failed > 0
                  ? t('audit.anchorsDelivery', { pending: s.pending, failed: s.failed })
                  : t('audit.anchorsDelivered'),
              ]}
            />
          )}
        </QueryView>
        <div className="row">
          {session.can('anchors.verify') && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={verify.isPending}
              onClick={() => verify.mutate({})}
            >
              {verify.isPending ? t('audit.anchorsVerifying') : t('audit.anchorsVerify')}
            </button>
          )}
          {session.can('anchors.create') && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={create.isPending}
              onClick={() => create.mutate({}, { onError: (e) => toast.error(describeError(i, e).message) })}
            >
              {create.isPending ? t('audit.anchorsCreating') : t('audit.anchorsCreate')}
            </button>
          )}
          {session.can('anchors.latest') && status.data?.latest && (
            <button type="button" className="btn btn-sm" onClick={() => void download()}>
              {t('audit.anchorsDownload')}
            </button>
          )}
        </div>
        {verify.error && (
          <div className="alert alert-error" role="alert">
            <p className="alert-title">{describeError(i, verify.error).message}</p>
          </div>
        )}
        {result && !verify.isPending && <VerificationResult result={result} />}
        {status.data && status.data.heldForPartners.length > 0 && (
          <div className="stack-sm">
            <h3>{t('audit.anchorsHeldTitle')}</h3>
            <p className="field-hint">{t('audit.anchorsHeldIntro')}</p>
            <ul className="list-plain list-divided small">
              {status.data.heldForPartners.map((h) => (
                <li key={h.nodeId}>
                  <strong>{h.displayName}</strong>{' '}
                  {t('audit.anchorsHeld', { count: h.count, seq: h.latestSeq })}{' '}
                  <span className="muted">
                    (<DateTime value={h.latestReceivedAt} />)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}

type Finding = Verification['findings'][number];

function VerificationResult({ result }: { result: Verification }) {
  const i = useI18n();
  const { t, tx, fmt } = i;
  const tone =
    result.result === 'ok'
      ? 'alert-success'
      : result.result === 'manipulated'
        ? 'alert-error'
        : 'alert-warning';
  const problemText = (p: PartnerResult) => {
    if (!p.firstProblem) return null;
    const kind = p.firstProblem.kind;
    const args = { seq: p.firstProblem.seq, count: p.problems };
    if (kind === 'missing' || kind === 'lost_by_restore') return t('audit.anchorsProblemMissing', args);
    if (kind === 'beyond_pre_restore') return t('audit.anchorsProblemPreRestore', args);
    return t('audit.anchorsProblemHash', args);
  };
  const nodeName = (id: string | undefined) =>
    result.partners.find((p) => p.nodeId === id)?.displayName ?? id ?? '?';
  const findingText = (f: Finding) => {
    const node = nodeName(f.nodeId);
    switch (f.code) {
      case 'lost_by_restore':
        return f.severity === 'fail'
          ? t('audit.anchorsLostUndocumented', { count: f.count ?? 0, node })
          : t('audit.anchorsLostByRestore', { count: f.count ?? 0, node });
      case 'anchor_stale':
        return t('audit.anchorsStale', {
          seq: f.seq ?? '?',
          date: f.detail ? fmt.dateTime(f.detail) : '?',
          hours: result.anchoring.staleAfterHours ?? '?',
          count: f.count ?? 0,
        });
      case 'legacy_digest_ambiguous':
        return t('audit.anchorsLegacyAmbiguous', { count: f.count ?? 0 });
      case 'unknown_epoch':
        return t('audit.anchorsUnknownEpoch', { count: f.count ?? 0, node });
      case 'inconclusive':
        return t('audit.anchorsInconclusive', { count: f.count ?? 0, node });
      case 'restore_epoch':
        return t('audit.anchorsRestoreEpoch', {
          date: f.detail ? fmt.dateTime(f.detail) : '?',
          seq: f.seq ?? '?',
        });
      case 'insufficient_partners':
        return t('audit.anchorsInsufficient', { count: f.count ?? 0, required: f.seq ?? 1 });
      default:
        return t('audit.anchorsOtherFinding', { code: f.code, node: f.nodeId ? ` (${node})` : '' });
    }
  };
  const columns: Column<PartnerResult>[] = [
    {
      key: 'peer',
      header: t('audit.peer'),
      render: (p) => (
        <span className="stack-sm">
          <span>{p.displayName}</span>
          <span className="small muted mono">{p.fingerprint}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (p) => (
        <span className="stack-sm">
          <span>{tx(`audit.anchorStatus.${p.status}`) ?? p.status}</span>
          {p.errorCode && <span className="small text-danger">{codeText(i, p.errorCode)}</span>}
          {problemText(p) && <span className="small text-danger">{problemText(p)}</span>}
        </span>
      ),
    },
    { key: 'count', header: t('audit.anchorsCheckpoints'), className: 'num', render: (p) => p.checkpoints },
    {
      key: 'latest',
      header: t('audit.anchorsLatestSeq'),
      className: 'num',
      render: (p) => p.latestSeq ?? '–',
    },
  ];
  const findings = result.findings.filter(
    (f) => f.severity !== 'info' || f.code === 'restore_epoch' || f.code === 'legacy_digest_ambiguous',
  );
  const a = result.anchoring;
  return (
    <div className="stack-sm">
      <div className={`alert ${tone}`} role="status">
        <p className="alert-title">{t(`audit.anchorResult.${result.result}`)}</p>
        <p className="small">
          {result.local.ok
            ? t('audit.anchorsLocalOk', { checked: result.local.checked })
            : t('audit.verifyBroken', {
                seq: result.local.firstBrokenSeq ?? '?',
                checked: result.local.checked,
              })}
        </p>
        <p className="small">
          {a.lastAnchoredSeq === null
            ? t('audit.anchorsUnanchoredNone', { count: a.unanchoredEntries })
            : t('audit.anchorsUnanchored', {
                seq: a.lastAnchoredSeq,
                date: a.lastAnchoredAt ? fmt.dateTime(a.lastAnchoredAt) : '?',
                count: a.unanchoredEntries,
              })}
        </p>
        <p className="small muted">{t('audit.anchorsEpoch', { epoch: result.epoch.current })}</p>
      </div>
      {!result.independent && (
        <p className="field-hint" role="note">
          {t('audit.anchorsNotIndependent')}
        </p>
      )}
      {findings.length > 0 && (
        <div className="stack-sm">
          <h3>{t('audit.anchorsFindings')}</h3>
          <ul className="list-plain list-divided small">
            {findings.map((f) => (
              <li key={`${f.code}-${f.severity}-${f.nodeId ?? ''}-${f.epoch ?? ''}-${f.detail ?? ''}`}>
                {findingText(f)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Table
        caption={t('audit.anchorsTitle')}
        rows={result.partners}
        rowKey={(p) => p.nodeId}
        empty={t('audit.anchorsNoPartners')}
        columns={columns}
      />
    </div>
  );
}
