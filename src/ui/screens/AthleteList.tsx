import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { type Athlete, SQUAD_STATUSES, type SquadStatus } from '../../shared/contract/index.ts';
import { DateTime } from '../components/Misc.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { type Column, Pagination, Table } from '../components/Table.tsx';
import { useI18n } from '../i18n/index.tsx';
import { useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

const PAGE_SIZE = 50;

function isSquad(v: string | null): v is SquadStatus {
  return v !== null && (SQUAD_STATUSES as readonly string[]).includes(v);
}

/** /athleten – Suche mit Sportart- und Kaderfilter, seitenweise. */
export function AthleteList() {
  const { t } = useI18n();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const sport = params.get('sport') ?? '';
  const squadParam = params.get('kader');
  const squad = isSquad(squadParam) ? squadParam : undefined;
  const page = Math.max(1, Number(params.get('seite')) || 1);
  const [qInput, setQInput] = useState(q);

  const sports = useApiQuery('athletes.sports', {}, { staleTime: 60_000 });
  const list = useApiQuery(
    'athletes.list',
    {
      query: {
        page,
        pageSize: PAGE_SIZE,
        q: q || undefined,
        sport: sport || undefined,
        squadStatus: squad,
      },
    },
    { keepPrevious: true },
  );

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('seite' in patch)) next.delete('seite');
    setParams(next, { replace: true });
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    update({ q: qInput.trim() || undefined });
  };

  const filtered = Boolean(q || sport || squad);
  const canCreate = session.can('athletes.create');
  const createButton = canCreate ? (
    <Link to="/athleten/neu" className="btn btn-primary">
      {t('athletes.create')}
    </Link>
  ) : null;

  const columns: Column<Athlete>[] = [
    {
      key: 'name',
      header: t('athletes.name'),
      render: (a) => (
        <Link to={`/athleten/${a.id}`}>
          {a.lastName}, {a.firstName}
        </Link>
      ),
    },
    {
      key: 'dob',
      header: t('athletes.dateOfBirth'),
      className: 'nowrap',
      render: (a) => <DateTime value={a.dateOfBirth} mode="date" />,
    },
    { key: 'sport', header: t('athletes.sport'), render: (a) => a.sport },
    { key: 'squad', header: t('athletes.squad'), render: (a) => t(`squad.${a.squadStatus}`) },
    { key: 'club', header: t('athletes.club'), render: (a) => a.club ?? t('common.empty') },
    {
      key: 'updated',
      header: t('athletes.updatedAt'),
      className: 'nowrap',
      render: (a) => <DateTime value={a.updatedAt} />,
    },
  ];

  return (
    <div className="page">
      <PageHeader title={t('athletes.title')} description={t('athletes.intro')} actions={createButton} />

      <form className="toolbar" onSubmit={onSearch} aria-label={t('athletes.search')}>
        <div className="field field-grow">
          <label className="field-label" htmlFor="athlete-q">
            {t('athletes.search')}
          </label>
          <input
            id="athlete-q"
            className="input"
            type="search"
            value={qInput}
            placeholder={t('athletes.searchPlaceholder')}
            onChange={(e) => setQInput(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="athlete-sport">
            {t('athletes.sport')}
          </label>
          <select
            id="athlete-sport"
            className="input"
            value={sport}
            onChange={(e) => update({ sport: e.target.value || undefined })}
          >
            <option value="">{t('athletes.allSports')}</option>
            {(sports.data?.items ?? []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="athlete-squad">
            {t('athletes.squad')}
          </label>
          <select
            id="athlete-squad"
            className="input"
            value={squad ?? ''}
            onChange={(e) => update({ kader: e.target.value || undefined })}
          >
            <option value="">{t('athletes.allSquads')}</option>
            {SQUAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`squad.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <button type="submit" className="btn">
            {t('common.search')}
          </button>
          {filtered && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setQInput('');
                setParams(new URLSearchParams(), { replace: true });
              }}
            >
              {t('common.resetFilters')}
            </button>
          )}
        </div>
      </form>

      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState
              message={filtered ? t('athletes.emptyFiltered') : t('athletes.empty')}
              action={filtered ? undefined : createButton}
            />
          ) : (
            <div className="stack">
              <Table
                columns={columns}
                rows={data.items}
                rowKey={(a) => a.id}
                caption={t('athletes.listCaption')}
              />
              <Pagination
                page={data.page}
                pageSize={data.pageSize}
                total={data.total}
                onPageChange={(p) => update({ seite: p > 1 ? String(p) : undefined })}
              />
            </div>
          )
        }
      </QueryView>
    </div>
  );
}
