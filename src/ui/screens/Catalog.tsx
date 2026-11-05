import type { UseQueryResult } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { AccessGrant, ColumnDef, RouteId } from '../../shared/contract/index.ts';
import { Dialog } from '../components/Dialog.tsx';
import { PullDialog, type PullTarget } from '../components/federation/PullDialog.tsx';
import { DescriptionList, Details, MetaLine, Tabs } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { dataWindowText, validityText } from '../components/products/grantText.ts';
import { EmptyState, Loading, QueryView, Skeleton } from '../components/QueryState.tsx';
import { Badge, SpecialCategoryBadge, StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiError, ApiOutput } from '../lib/api.ts';
import { codeText } from '../lib/errors.ts';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type Entry = ApiOutput<'catalog.local'>['items'][number];
type Kind = Entry['kind'];
type PeerResult = ApiOutput<'discovery.search'>['results'][number];
type Offer = PeerResult['offers'][number];
type OfferRelease = Offer['releases'][number];
type Received = ApiOutput<'received.list'>['items'][number];
type Discovery = UseQueryResult<ApiOutput<'discovery.search'>, ApiError>;
type ReceivedQuery = UseQueryResult<ApiOutput<'received.list'>, ApiError>;

/** Schlüssel eines Partnerprodukts (Partner + Produkt beim Partner) */
const offerKey = (peerId: string, productId: string) => `${peerId}:${productId}`;

/** Bereiche des Katalogs (URL-Parameter „wo“) */
type Where = 'alle' | 'hier' | 'partner' | 'empfangen';
/** Arten eigener Einträge (URL-Parameter „art“); Standard: Datenprodukte */
type KindFilter = 'produkte' | 'datensaetze' | 'quellen' | 'alles';

const KIND_OF_FILTER: Record<KindFilter, Kind | undefined> = {
  produkte: 'product',
  datensaetze: 'dataset',
  quellen: 'source',
  alles: undefined,
};

const KIND_LINKS: Record<Kind, { path: string; route: RouteId }> = {
  source: { path: '/quellen/', route: 'connectors.get' },
  dataset: { path: '/datensaetze/', route: 'datasets.get' },
  product: { path: '/produkte/', route: 'products.get' },
};

/**
 * /katalog – Daten finden: eigene Datenprodukte (mit „für Sie freigegeben“), Angebote der Partner (live
 * abgefragt, ohne zentrale Stelle, mit „für uns freigegeben“ und Abruf) und empfangene Kopien – eine Suche.
 * Alte Adressen /katalog/partner und /empfangen leiten hierher (wo=partner bzw. wo=empfangen).
 */
export function Catalog() {
  const { t } = useI18n();
  const s = useSession();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  // Suchfeld folgt der Adresse (z. B. Klick auf „Katalog“ in der Navigation setzt die Suche zurück)
  const [lastQ, setLastQ] = useState(q);
  if (q !== lastQ) {
    setLastQ(q);
    setInput(q);
  }

  const canPartners = s.can('discovery.search');
  const canReceived = s.can('received.list');
  const received = useApiQuery('received.list', {}, { enabled: canReceived });

  const requested = params.get('wo') as Where | null;
  const allowed: Where[] = [
    'alle',
    'hier',
    ...(canPartners ? (['partner'] as const) : []),
    ...(canReceived ? (['empfangen'] as const) : []),
  ];
  const where: Where = requested && allowed.includes(requested) ? requested : 'alle';
  const showPartners = canPartners && (where === 'alle' || where === 'partner');
  // Partnerkataloge werden live abgefragt (keine zentrale Stelle); Ergebnis fünf Minuten wiederverwenden,
  // „Neu abfragen“ fragt sofort neu
  const discovery = useApiQuery(
    'discovery.search',
    { query: { q: q || undefined } },
    { staleTime: 5 * 60_000, enabled: showPartners },
  );
  const kindParam = params.get('art') as KindFilter | null;
  const kindFilter: KindFilter =
    kindParam && Object.hasOwn(KIND_OF_FILTER, kindParam) ? kindParam : 'produkte';

  const update = (next: { q?: string; wo?: Where; art?: KindFilter }) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      const isDefault = (k === 'wo' && v === 'alle') || (k === 'art' && v === 'produkte') || v === '';
      if (isDefault) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    update({ q: input.trim() });
  };

  const receivedCount = received.data?.items.length;
  const tabs = allowed.map((id) => ({
    id,
    label:
      id === 'empfangen' && receivedCount !== undefined
        ? `${t('catalog.whereReceived')} (${receivedCount})`
        : t(
            id === 'alle'
              ? 'catalog.whereAll'
              : id === 'hier'
                ? 'catalog.whereHere'
                : id === 'partner'
                  ? 'catalog.wherePartners'
                  : 'catalog.whereReceived',
          ),
  }));

  return (
    <div className="page">
      <PageHeader
        title={t('catalog.title')}
        description={canPartners ? t('catalog.intro') : t('catalog.introLocal')}
      />
      <form className="search-bar" onSubmit={submit}>
        <label className="sr-only" htmlFor="catalog-q">
          {t('catalog.searchLabel')}
        </label>
        <input
          id="catalog-q"
          className="input"
          type="search"
          value={input}
          placeholder={t('catalog.searchPlaceholder')}
          onChange={(e) => {
            setInput(e.target.value);
            if (e.target.value === '' && q !== '') update({ q: '' });
          }}
        />
        <button type="submit" className="btn btn-primary">
          {t('common.search')}
        </button>
      </form>
      {allowed.length > 2 && (
        <Tabs tabs={tabs} active={where} onChange={(wo) => update({ wo })} label={t('catalog.whereLabel')} />
      )}

      {(where === 'alle' || where === 'hier') && (
        <OwnSection
          q={q}
          kindFilter={kindFilter}
          onKind={(art) => update({ art })}
          compact={where === 'alle'}
        />
      )}
      {showPartners && <PartnerSection q={q} discovery={discovery} received={received.data?.items ?? []} />}
      {canReceived && where === 'empfangen' && <ReceivedSection q={q} query={received} />}
      {canReceived && where === 'alle' && (
        <ReceivedSection q={q} query={received} unlistedOf={canPartners ? discovery : undefined} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- Bei uns

function OwnSection({
  q,
  kindFilter,
  onKind,
  compact,
}: {
  q: string;
  kindFilter: KindFilter;
  onKind: (k: KindFilter) => void;
  /** Unter „Alle“: leere Ergebnisse nur als kurze Zeile */
  compact: boolean;
}) {
  const { t } = useI18n();
  const s = useSession();
  const [selected, setSelected] = useState<Entry | null>(null);
  const catalog = useApiQuery(
    'catalog.local',
    { query: { q: q || undefined, kind: KIND_OF_FILTER[kindFilter] } },
    { keepPrevious: true },
  );
  const grants = useApiQuery('access.list', {}, { enabled: s.can('access.list') });
  const grantFor = (e: Entry): AccessGrant | undefined =>
    e.kind === 'product' ? grants.data?.items.find((g) => g.product.id === e.id) : undefined;

  return (
    <Section
      title={t('catalog.hereTitle', { node: s.node.displayName })}
      actions={
        <label className="inline-select">
          <span className="small muted">{t('catalog.kindLabel')}</span>
          <select
            className="input input-sm"
            value={kindFilter}
            onChange={(e) => onKind(e.target.value as KindFilter)}
          >
            <option value="produkte">{t('catalog.kindProducts')}</option>
            <option value="datensaetze">{t('catalog.kindDatasets')}</option>
            <option value="quellen">{t('catalog.kindSources')}</option>
            <option value="alles">{t('catalog.kindAll')}</option>
          </select>
        </label>
      }
    >
      <QueryView query={catalog} loading={<Skeleton lines={3} />}>
        {(data) =>
          data.items.length === 0 ? (
            compact ? (
              <p className="muted">{q ? t('catalog.empty') : t('catalog.emptyAll')}</p>
            ) : (
              <EmptyState message={q ? t('catalog.empty') : t('catalog.emptyAll')} />
            )
          ) : (
            <ul className="list-plain results">
              {data.items.map((e) => {
                const grant = grantFor(e);
                return (
                  <ResultItem
                    key={`${e.kind}:${e.id}`}
                    title={e.name}
                    onOpen={() => setSelected(e)}
                    description={e.description}
                    meta={[
                      kindFilter === 'alles' || kindFilter !== 'produkte' ? t(`catalogKind.${e.kind}`) : null,
                      t(`categories.${e.category}`),
                      e.fields.length > 0 ? t('catalog.columnsCount', { count: e.fields.length }) : null,
                    ]}
                    badges={
                      <>
                        <SpecialCategoryBadge show={e.specialCategory} />
                        {e.shareability === 'internal' && <Badge>{t('shareability.internal')}</Badge>}
                      </>
                    }
                    status={grant ? <Badge tone="success">{t('catalog.releasedToYou')}</Badge> : undefined}
                    actions={
                      <>
                        {grant && (
                          <Link to={`/meine-daten/${grant.releaseId}`} className="btn btn-primary btn-sm">
                            {t('catalog.openData')}
                          </Link>
                        )}
                        <button type="button" className="btn btn-sm" onClick={() => setSelected(e)}>
                          {t('common.details')}
                        </button>
                      </>
                    }
                  />
                );
              })}
            </ul>
          )
        }
      </QueryView>
      <EntryDialog entry={selected} onClose={() => setSelected(null)} />
    </Section>
  );
}

function EntryDialog({ entry, onClose }: { entry: Entry | null; onClose: () => void }) {
  const { t } = useI18n();
  const session = useSession();

  const link = (kind: Kind, id: string, name: string) => {
    const target = KIND_LINKS[kind];
    return session.can(target.route) ? (
      <Link to={`${target.path}${id}`} onClick={onClose}>
        {name}
      </Link>
    ) : (
      <span>{name}</span>
    );
  };

  return (
    <Dialog open={entry !== null} onClose={onClose} title={entry?.name ?? ''} size="lg">
      {entry && (
        <div className="stack">
          <MetaLine
            items={[
              t(`catalogKind.${entry.kind}`),
              t(`categories.${entry.category}`),
              t(`shareability.${entry.shareability}`),
              entry.specialCategory ? <SpecialCategoryBadge key="sc" /> : null,
            ]}
          />
          {entry.description && <p>{entry.description}</p>}
          {session.can(KIND_LINKS[entry.kind].route) && (
            <p>
              <Link to={`${KIND_LINKS[entry.kind].path}${entry.id}`} onClick={onClose}>
                {t('catalog.openEntry')}
              </Link>
            </p>
          )}

          <h3>{entry.kind === 'source' ? t('catalog.sourceFields') : t('catalog.fields')}</h3>
          <ColumnsList columns={entry.fields} empty={t('catalog.fieldsEmpty')} />

          {entry.kind === 'source' && entry.mappings.length > 0 && (
            <>
              <h3>{t('catalog.mappings')}</h3>
              <ul className="list-plain list-divided">
                {entry.mappings.map((m) => (
                  <li key={`${m.source}→${m.target}`} className="small">
                    <span className="mono">{m.source}</span> → <span className="mono">{m.target}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {entry.related.length > 0 && (
            <>
              <h3>{t('catalog.related')}</h3>
              <ul className="list-plain list-divided">
                {entry.related.map((r) => (
                  <li key={`${r.kind}:${r.id}`} className="row">
                    <span className="small muted">{t(`catalogKind.${r.kind}`)}</span>
                    {link(r.kind, r.id, r.name)}
                  </li>
                ))}
              </ul>
            </>
          )}

          <Details>
            <DescriptionList
              items={[
                [
                  t('catalog.slug'),
                  <span key="slug" className="mono">
                    {entry.slug}
                  </span>,
                ],
                [t('common.version'), entry.version],
                [t('common.updatedAt'), <DateText key="u" value={entry.updatedAt} />],
              ]}
            />
            {entry.fields.length > 0 && (
              <ColumnTable columns={entry.fields} caption={t('catalog.fieldKeys')} />
            )}
          </Details>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------- Partner

function PartnerSection({
  q,
  discovery,
  received,
}: {
  q: string;
  discovery: Discovery;
  received: readonly Received[];
}) {
  const i = useI18n();
  const { t, fmt } = i;
  const s = useSession();
  const [pullTarget, setPullTarget] = useState<PullTarget | null>(null);
  const [selected, setSelected] = useState<{ result: PeerResult; offer: Offer } | null>(null);

  /** Aktive (sonst jüngste) lokale Kopie eines Partnerprodukts */
  const copyOf = (result: PeerResult, offer: Offer) =>
    received
      .filter((r) => r.peer.id === result.peer.id && r.remoteProductId === offer.productId)
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))[0];

  return (
    <Section
      title={t('catalog.partnersTitle')}
      actions={
        discovery.data ? (
          <span className="row small muted">
            {t('catalog.queriedAt', { time: fmt.dateTime(discovery.data.at) })}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={discovery.isFetching}
              onClick={() => void discovery.refetch()}
            >
              {discovery.isFetching ? t('catalog.searching') : t('catalog.searchAgain')}
            </button>
          </span>
        ) : undefined
      }
    >
      <QueryView query={discovery} loading={<Loading label={t('catalog.searching')} />}>
        {(data) => {
          if (data.results.length === 0) {
            return (
              <EmptyState
                message={t('catalog.noPeers')}
                action={
                  s.can('peers.list') ? (
                    <Link to="/partner" className="btn">
                      {t('catalog.toPartners')}
                    </Link>
                  ) : undefined
                }
              />
            );
          }
          const failed = data.results.filter((r) => r.status !== 'ok');
          const offers = data.results.flatMap((r) => r.offers.map((o) => ({ result: r, offer: o })));
          // Freigegebene Angebote zuerst, danach alphabetisch
          offers.sort(
            (a, b) =>
              Number(b.offer.releases.length > 0) - Number(a.offer.releases.length > 0) ||
              a.offer.name.localeCompare(b.offer.name, i.lang),
          );
          return (
            <div className="stack">
              {failed.length > 0 && (
                <div className="alert alert-warning">
                  <ul className="list-plain">
                    {failed.map((r) => (
                      <li key={r.peer.id}>
                        {t('catalog.peerFailed', {
                          name: r.peer.displayName,
                          status: t(`discoveryStatus.${r.status}`),
                        })}
                        {r.errorCode && <span className="small"> – {codeText(i, r.errorCode)}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {offers.length === 0 ? (
                <EmptyState message={q ? t('catalog.noOffersFor') : t('catalog.noOffers')} />
              ) : (
                <ul className="list-plain results">
                  {offers.map(({ result, offer }) => {
                    const copy = copyOf(result, offer);
                    const release = offer.releases[0];
                    const open = () => setSelected({ result, offer });
                    return (
                      <ResultItem
                        key={`${result.peer.id}:${offer.productId}`}
                        title={offer.name}
                        onOpen={open}
                        description={offer.description}
                        meta={[
                          result.peer.displayName,
                          t(`categories.${offer.category}`),
                          t('catalog.columnsCount', { count: offer.columns.length }),
                        ]}
                        badges={<SpecialCategoryBadge show={offer.specialCategory} />}
                        status={<OfferStatus offer={offer} copy={copy} />}
                        actions={
                          <>
                            {copy?.status === 'active' ? (
                              <Link to={`/empfangen/${copy.id}`} className="btn btn-primary btn-sm">
                                {t('catalog.openCopy')}
                              </Link>
                            ) : (
                              release &&
                              s.can('received.pull') && (
                                <button
                                  type="button"
                                  className="btn btn-primary btn-sm"
                                  onClick={() => setPullTarget(pullTargetOf(result, offer, release))}
                                >
                                  {t('catalog.pull')}
                                </button>
                              )
                            )}
                            <button type="button" className="btn btn-sm" onClick={open}>
                              {t('common.details')}
                            </button>
                          </>
                        }
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          );
        }}
      </QueryView>
      <OfferDialog
        selected={selected}
        copy={selected ? copyOf(selected.result, selected.offer) : undefined}
        onClose={() => setSelected(null)}
        onPull={(target) => {
          setSelected(null);
          setPullTarget(target);
        }}
      />
      <PullDialog target={pullTarget} onClose={() => setPullTarget(null)} />
    </Section>
  );
}

function pullTargetOf(result: PeerResult, offer: Offer, release: OfferRelease): PullTarget {
  return {
    peerId: result.peer.id,
    releaseId: release.releaseId,
    purposes: release.purposes,
    productName: offer.name,
  };
}

/** Kurzstatus eines Partnerangebots aus Sicht dieses Knotens */
function OfferStatus({ offer, copy }: { offer: Offer; copy: Received | undefined }) {
  const { t, fmt } = useI18n();
  if (copy?.status === 'active') {
    return (
      <span className="row">
        <Badge tone="info">{t('catalog.received')}</Badge>
        <span className="small muted">
          {t('catalog.receivedInfo', {
            count: copy.rowCount,
            time: copy.lastPulledAt ? fmt.date(copy.lastPulledAt) : t('common.empty'),
          })}
        </span>
      </span>
    );
  }
  if (offer.releases.length > 0) return <Badge tone="success">{t('catalog.releasedToUs')}</Badge>;
  return <span className="small muted">{t('catalog.notReleased')}</span>;
}

function OfferDialog({
  selected,
  copy,
  onClose,
  onPull,
}: {
  selected: { result: PeerResult; offer: Offer } | null;
  copy: Received | undefined;
  onClose: () => void;
  onPull: (t: PullTarget) => void;
}) {
  const i = useI18n();
  const { t } = i;
  const s = useSession();
  const purposeLabel = usePurposeLabel();
  const offer = selected?.offer;
  const result = selected?.result;

  return (
    <Dialog open={selected !== null} onClose={onClose} title={offer?.name ?? ''} size="lg">
      {offer && result && (
        <div className="stack">
          <MetaLine
            items={[
              result.peer.displayName,
              t(`categories.${offer.category}`),
              offer.specialCategory ? <SpecialCategoryBadge key="sc" /> : null,
            ]}
          />
          {offer.description && <p>{offer.description}</p>}

          {copy && (
            <div className="alert alert-info">
              <p>
                {copy.status === 'active'
                  ? t('catalog.copyActive', { count: copy.rowCount })
                  : t('catalog.copyInactive', { status: t(`receivedStatus.${copy.status}`) })}{' '}
                <Link to={`/empfangen/${copy.id}`} onClick={onClose}>
                  {t('catalog.openCopy')}
                </Link>
              </p>
            </div>
          )}

          <h3>{t('catalog.releasesForUs')}</h3>
          {offer.releases.length === 0 ? (
            <p className="muted">{t('catalog.noReleases')}</p>
          ) : (
            offer.releases.map((r) => {
              const labels = new Map(offer.columns.map((c) => [c.key, c.label]));
              return (
                <div key={r.releaseId} className="card card-flat stack-sm">
                  <DescriptionList
                    items={[
                      [t('common.purposes'), r.purposes.map(purposeLabel).join(', ')],
                      [t('catalog.releasedColumns'), r.columns.map((k) => labels.get(k) ?? k).join(', ')],
                      [t('catalog.validity'), validityText(i, r)],
                      [t('catalog.dataWindow'), dataWindowText(i, r)],
                      ...(r.requiresConsent
                        ? ([[t('catalog.consent'), t('catalog.consentRequired')]] as [string, string][])
                        : []),
                    ]}
                  />
                  {s.can('received.pull') ? (
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => onPull(pullTargetOf(result, offer, r))}
                      >
                        {copy?.status === 'active' ? t('catalog.pullAgain') : t('catalog.pull')}
                      </button>
                    </div>
                  ) : (
                    <p className="small muted">{t('catalog.pullBySteward')}</p>
                  )}
                </div>
              );
            })
          )}

          <h3>{t('catalog.offerColumns')}</h3>
          <ColumnsList columns={offer.columns} empty={t('common.none')} />

          <Details>
            <DescriptionList
              items={[
                [
                  t('catalog.partnerNode'),
                  <span key="n" className="mono">
                    {result.peer.nodeId}
                  </span>,
                ],
                [
                  t('catalog.slug'),
                  <span key="s" className="mono">
                    {offer.slug}
                  </span>,
                ],
                [t('common.version'), offer.version],
                ...offer.releases.map(
                  (r) =>
                    [
                      t('catalog.releaseId'),
                      <span key={r.releaseId} className="mono break">
                        {r.releaseId}
                      </span>,
                    ] as [string, ReactNode],
                ),
              ]}
            />
            <ColumnTable columns={offer.columns} caption={t('catalog.offerColumns')} />
          </Details>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------- Empfangen

function ReceivedSection({
  q,
  query,
  unlistedOf,
}: {
  q: string;
  query: ReceivedQuery;
  /**
   * Unter „Alle“: nur Kopien zeigen, deren Partnerprodukt nicht unter „Bei Partnern“ erscheint (z. B. widerrufen,
   * abgelaufen, Partner nicht erreichbar) – alle anderen stehen dort beim Angebot.
   */
  unlistedOf?: Discovery;
}) {
  const i = useI18n();
  const { t, fmt } = i;
  const s = useSession();
  const purposeLabel = usePurposeLabel();
  const needle = q.toLocaleLowerCase(i.lang);
  const matches = (r: Received) =>
    !needle ||
    // dieselben Felder wie die Suche bei Partnern (Name, Kennung, Beschreibung), damit „Alle“ stimmig bleibt
    [r.title, r.remoteProductSlug, r.description].some((x) => x.toLocaleLowerCase(i.lang).includes(needle));

  const columns: Column<Received>[] = [
    {
      key: 'title',
      header: t('catalog.receivedProduct'),
      render: (r) => (
        <span className="row">
          <Link to={`/empfangen/${r.id}`}>{r.title}</Link>
          <SpecialCategoryBadge show={r.specialCategory} />
          {r.status !== 'active' && <StatusBadge group="receivedStatus" value={r.status} />}
        </span>
      ),
    },
    { key: 'from', header: t('catalog.from'), render: (r) => r.peer.displayName },
    { key: 'purpose', header: t('common.purpose'), render: (r) => purposeLabel(r.purpose) },
    {
      key: 'rows',
      header: t('catalog.rowsHeader'),
      className: 'num',
      render: (r) => fmt.number(r.rowCount),
    },
    {
      key: 'pulled',
      header: t('catalog.pulledAt'),
      className: 'nowrap',
      render: (r) => (r.lastPulledAt ? fmt.date(r.lastPulledAt) : t('common.empty')),
    },
  ];

  return (
    <QueryView query={query} loading={<Skeleton lines={2} />}>
      {(data) => {
        const onlyUnlisted = unlistedOf !== undefined;
        if (unlistedOf?.isPending) return null;
        const listed = new Set(
          (unlistedOf?.data?.results ?? []).flatMap((r) =>
            r.offers.map((o) => offerKey(r.peer.id, o.productId)),
          ),
        );
        const rows = data.items
          .filter(matches)
          .filter((r) => !onlyUnlisted || !listed.has(offerKey(r.peer.id, r.remoteProductId)));
        if (onlyUnlisted && rows.length === 0) return null;
        return (
          <Section
            title={onlyUnlisted ? t('catalog.receivedInactiveTitle') : t('catalog.receivedTitle')}
            description={onlyUnlisted ? t('catalog.receivedInactiveIntro') : undefined}
          >
            <Table
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              caption={t('catalog.receivedTitle')}
              empty={
                <EmptyState
                  message={q ? t('catalog.empty') : t('catalog.receivedEmpty')}
                  action={
                    !q && s.can('discovery.search') ? (
                      <Link to="/katalog?wo=partner" className="btn">
                        {t('catalog.wherePartners')}
                      </Link>
                    ) : undefined
                  }
                />
              }
            />
          </Section>
        );
      }}
    </QueryView>
  );
}

// ---------------------------------------------------------------------------------------------- Bausteine

/** Ein Treffer: Titel (öffnet Details), Beschreibung, Kurzangaben, Status, Aktionen. */
function ResultItem({
  title,
  onOpen,
  description,
  meta,
  badges,
  status,
  actions,
}: {
  title: string;
  onOpen: () => void;
  description: string;
  meta: ReactNode[];
  badges?: ReactNode;
  status?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="result">
      <div className="result-main">
        <div className="row">
          <h3 className="result-title">
            <button type="button" className="btn-link" onClick={onOpen}>
              {title}
            </button>
          </h3>
          {badges}
        </div>
        {description && <p className="result-description clamp-2">{description}</p>}
        <MetaLine items={meta} />
        {status && <div className="result-status">{status}</div>}
      </div>
      <div className="result-actions">{actions}</div>
    </li>
  );
}

/** Spalten als kurze Liste „Bezeichnung (Einheit)“ – Schlüssel stehen unter „Technische Details“. */
function ColumnsList({
  columns,
  empty,
}: {
  columns: readonly { key: string; label: string; unit?: string }[];
  empty: string;
}) {
  if (columns.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="list-plain chips">
      {columns.map((c) => (
        <li key={c.key} className="chip">
          {c.label}
          {c.unit ? <span className="muted"> ({c.unit})</span> : null}
        </li>
      ))}
    </ul>
  );
}

function DateText({ value }: { value: string }) {
  const { fmt } = useI18n();
  return <time dateTime={value}>{fmt.dateTime(value)}</time>;
}

/** Spalten mit Schlüssel, Typ und Einheit (unter „Technische Details“) */
function ColumnTable({ columns, caption }: { columns: readonly ColumnDef[]; caption: string }) {
  const { t } = useI18n();
  return (
    <Table
      columns={[
        { key: 'label', header: t('catalog.label'), render: (c) => c.label },
        { key: 'type', header: t('common.type'), render: (c) => t(`fieldTypes.${c.type}`) },
        { key: 'unit', header: t('common.unit'), render: (c) => c.unit ?? t('common.empty') },
        { key: 'key', header: t('catalog.key'), className: 'mono', render: (c) => c.key },
      ]}
      rows={columns}
      rowKey={(c) => c.key}
      caption={caption}
    />
  );
}
