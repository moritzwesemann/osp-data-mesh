import { type FormEvent, useState } from 'react';
import { PullDialog, type PullTarget } from '../components/federation/PullDialog.tsx';
import { DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, Loading, QueryView } from '../components/QueryState.tsx';
import { Badge, CategoryBadge, SpecialCategoryBadge, StatusBadge } from '../components/StatusBadge.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { codeText } from '../lib/errors.ts';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type PeerResult = ApiOutput<'discovery.search'>['results'][number];
type Offer = PeerResult['offers'][number];
type OfferRelease = Offer['releases'][number];

/** /katalog/partner – Discovery: Kataloge aller vertrauenswürdigen Partner live abfragen. */
export function PartnerCatalog() {
  const { t, fmt } = useI18n();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [pullTarget, setPullTarget] = useState<PullTarget | null>(null);
  const discovery = useApiQuery('discovery.search', { query: { q: q || undefined } }, { staleTime: 60_000 });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = input.trim();
    if (next === q) void discovery.refetch();
    else setQ(next);
  };

  return (
    <div className="page">
      <PageHeader
        title={t('catalog.partnerTitle')}
        description={t('catalog.partnerIntro')}
        back={{ to: '/katalog', label: t('catalog.localCatalog') }}
      />
      <Section>
        <form className="toolbar" onSubmit={submit}>
          <div className="field field-grow">
            <label className="field-label" htmlFor="discovery-q">
              {t('catalog.partnerSearchLabel')}
            </label>
            <input
              id="discovery-q"
              className="input"
              type="search"
              value={input}
              placeholder={t('common.searchPlaceholder')}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={discovery.isFetching}>
            {t('common.search')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={discovery.isFetching}
            onClick={() => void discovery.refetch()}
          >
            {t('catalog.searchAgain')}
          </button>
        </form>
        {discovery.isFetching && !discovery.isPending && <Loading label={t('catalog.searching')} />}
      </Section>

      <QueryView query={discovery} loading={<Loading label={t('catalog.searching')} />}>
        {(data) =>
          data.results.length === 0 ? (
            <EmptyState message={t('catalog.noPeers')} />
          ) : (
            <>
              <p className="small muted">{t('catalog.queriedAt', { time: fmt.dateTime(data.at) })}</p>
              {data.results.map((r) => (
                <PeerResultSection key={r.peer.id} result={r} onPull={setPullTarget} />
              ))}
            </>
          )
        }
      </QueryView>

      <PullDialog target={pullTarget} onClose={() => setPullTarget(null)} />
    </div>
  );
}

function PeerResultSection({ result, onPull }: { result: PeerResult; onPull: (t: PullTarget) => void }) {
  const i = useI18n();
  const { t } = i;
  return (
    <Section
      title={
        <span className="row">
          <span>{result.peer.displayName}</span>
          <span className="mono small muted">{result.peer.nodeId}</span>
          <StatusBadge group="discoveryStatus" value={result.status} />
        </span>
      }
    >
      {result.status !== 'ok' && result.errorCode && (
        <div className="alert alert-warning">
          <p>{codeText(i, result.errorCode)}</p>
        </div>
      )}
      {result.status === 'ok' && result.offers.length === 0 && <EmptyState message={t('catalog.noOffers')} />}
      {result.offers.length > 0 && (
        <ul className="list-plain list-divided">
          {result.offers.map((o) => (
            <li key={o.productId}>
              <OfferView offer={o} peerId={result.peer.id} onPull={onPull} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function OfferView({
  offer,
  peerId,
  onPull,
}: {
  offer: Offer;
  peerId: string;
  onPull: (t: PullTarget) => void;
}) {
  const { t } = useI18n();
  return (
    <article className="stack-sm">
      <div className="row-between">
        <h3>{offer.name}</h3>
        <div className="badges">
          <CategoryBadge category={offer.category} />
          <Badge>{t('common.versionN', { version: offer.version })}</Badge>
          <SpecialCategoryBadge show={offer.specialCategory} />
        </div>
      </div>
      {offer.description && <p className="muted">{offer.description}</p>}
      <p className="small">
        <strong>{t('catalog.offerColumns')}:</strong>{' '}
        {offer.columns.map((c) => c.label).join(', ') || t('common.none')}
      </p>
      <h4 className="small">{t('catalog.releasesForUs')}</h4>
      {offer.releases.length === 0 ? (
        <p className="small muted">{t('catalog.noReleases')}</p>
      ) : (
        <div className="stack-sm">
          {offer.releases.map((r) => (
            <ReleaseView key={r.releaseId} offer={offer} release={r} peerId={peerId} onPull={onPull} />
          ))}
        </div>
      )}
    </article>
  );
}

function ReleaseView({
  offer,
  release,
  peerId,
  onPull,
}: {
  offer: Offer;
  release: OfferRelease;
  peerId: string;
  onPull: (t: PullTarget) => void;
}) {
  const { t, fmt } = useI18n();
  const session = useSession();
  const purposeLabel = usePurposeLabel();
  const labels = new Map(offer.columns.map((c) => [c.key, c.label]));
  const validity = release.validUntil
    ? t('catalog.validRange', {
        from: fmt.dateTime(release.validFrom),
        until: fmt.dateTime(release.validUntil),
      })
    : t('catalog.validOpen', { from: fmt.dateTime(release.validFrom) });
  const dataWindow =
    release.dataFrom || release.dataUntil
      ? `${fmt.date(release.dataFrom)} – ${fmt.date(release.dataUntil)}`
      : t('catalog.dataWindowAll');

  return (
    <div className="card">
      <DescriptionList
        items={[
          [t('common.purposes'), release.purposes.map(purposeLabel).join(', ')],
          [t('catalog.releasedColumns'), release.columns.map((k) => labels.get(k) ?? k).join(', ')],
          [t('catalog.validity'), validity],
          [t('catalog.dataWindow'), dataWindow],
          [t('catalog.consentRequired'), release.requiresConsent ? t('common.yes') : t('common.no')],
        ]}
      />
      {session.can('received.pull') && (
        <div className="row">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() =>
              onPull({
                peerId,
                releaseId: release.releaseId,
                purposes: release.purposes,
                productName: offer.name,
              })
            }
          >
            {t('catalog.pull')}
          </button>
        </div>
      )}
    </div>
  );
}
