import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Consent } from '../../shared/contract/index.ts';
import { ConsentDialog } from '../components/athletes/ConsentDialog.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { DateTime, DescriptionList, Details } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { CategoryBadge, StatusBadge } from '../components/StatusBadge.tsx';
import { type Column, Table } from '../components/Table.tsx';
import { useToast } from '../components/Toast.tsx';
import { useI18n } from '../i18n/index.tsx';
import type { ApiOutput } from '../lib/api.ts';
import { usePurposeLabel } from '../lib/purposes.ts';
import { useApiMutation, useApiQuery } from '../lib/query.ts';
import { useSession } from '../lib/session.tsx';

type Detail = ApiOutput<'athletes.get'>;
type Identifier = Detail['identifiers'][number];
type RecordCount = Detail['recordCounts'][number];

/** /athleten/:id – Stammdaten, Datenbestand, Einwilligungen, Löschung; Kennungen und Zeitstempel aufklappbar. */
export function AthleteDetail() {
  const { id = '' } = useParams();
  const athlete = useApiQuery('athletes.get', { params: { id } });
  return (
    <div className="page">
      <QueryView query={athlete}>{(a) => <AthleteDetailBody athlete={a} />}</QueryView>
    </div>
  );
}

function AthleteDetailBody({ athlete: a }: { athlete: Detail }) {
  const { t, fmt } = useI18n();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const purposeLabel = usePurposeLabel();
  const noteId = useId();
  const [consentOpen, setConsentOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState<Consent | null>(null);
  const [withdrawNote, setWithdrawNote] = useState('');
  const [deleting, setDeleting] = useState(false);
  const fullName = `${a.firstName} ${a.lastName}`;

  const withdraw = useApiMutation('consents.withdraw', {
    invalidate: ['athletes.get'],
    onSuccess: () => {
      toast.success(t('athletes.consents.withdrawn'));
      setWithdrawing(null);
    },
  });
  const remove = useApiMutation('athletes.delete', {
    invalidate: ['athletes.list', 'athletes.sports'],
    onSuccess: () => {
      toast.success(t('athletes.deleted'));
      navigate('/athleten', { replace: true });
    },
  });

  const canEdit = session.can('athletes.update');
  const canDelete = session.can('athletes.delete');
  const canAddConsent = session.can('consents.create');
  const canWithdraw = session.can('consents.withdraw');

  const identifierColumns: Column<Identifier>[] = [
    { key: 'system', header: t('athletes.identifierSystem'), className: 'mono', render: (x) => x.system },
    { key: 'value', header: t('athletes.identifierValue'), className: 'mono break', render: (x) => x.value },
  ];

  const recordColumns: Column<RecordCount>[] = [
    {
      key: 'dataset',
      header: t('athletes.dataset'),
      render: (r) => <Link to={`/datensaetze/${r.datasetId}`}>{r.datasetName}</Link>,
    },
    { key: 'count', header: t('athletes.recordCount'), className: 'num', render: (r) => r.count },
  ];

  // Einwilligungen: gültige zuerst (mit Widerruf), widerrufene als aufklappbarer Verlauf
  const validity = (c: Consent) =>
    c.validUntil
      ? t('athletes.consents.validRange', { from: fmt.date(c.validFrom), until: fmt.date(c.validUntil) })
      : t('athletes.consents.validOpenEnded', { from: fmt.date(c.validFrom) });
  const evidence = (c: Consent) => (
    <span className="stack-sm">
      {c.evidenceNote ? <span>{c.evidenceNote}</span> : <span className="muted">{t('common.empty')}</span>}
      <span className="small muted">
        {t('athletes.consents.recordedAt')}: <DateTime value={c.recordedAt} />
      </span>
    </span>
  );
  const baseColumns: Column<Consent>[] = [
    { key: 'purpose', header: t('athletes.consents.purpose'), render: (c) => purposeLabel(c.purpose) },
    {
      key: 'category',
      header: t('athletes.consents.category'),
      render: (c) => <CategoryBadge category={c.dataCategory} />,
    },
    { key: 'validity', header: t('athletes.consents.validity'), render: validity },
  ];
  const grantedColumns: Column<Consent>[] = [
    ...baseColumns,
    { key: 'evidence', header: t('athletes.consents.evidenceNote'), render: evidence },
    {
      key: 'actions',
      header: <span className="sr-only">{t('common.actions')}</span>,
      render: (c) =>
        canWithdraw ? (
          <button
            type="button"
            className="btn btn-sm btn-danger-outline"
            onClick={() => {
              withdraw.reset();
              setWithdrawNote('');
              setWithdrawing(c);
            }}
          >
            {t('athletes.consents.withdraw')}
          </button>
        ) : null,
    },
  ];
  const withdrawnColumns: Column<Consent>[] = [
    ...baseColumns,
    {
      key: 'status',
      header: t('athletes.consents.status'),
      render: (c) =>
        c.withdrawnAt ? (
          t('athletes.consents.withdrawnAt', { date: fmt.dateTime(c.withdrawnAt) })
        ) : (
          <StatusBadge group="consentStatus" value={c.status} />
        ),
    },
    { key: 'evidence', header: t('athletes.consents.evidenceNote'), render: evidence },
  ];
  const granted = a.consents.filter((c) => c.status === 'granted');
  const withdrawn = a.consents.filter((c) => c.status !== 'granted');
  const addConsent = canAddConsent ? (
    <button type="button" className="btn btn-primary" onClick={() => setConsentOpen(true)}>
      {t('athletes.consents.add')}
    </button>
  ) : null;

  return (
    <>
      <PageHeader
        title={fullName}
        back={{ to: '/athleten', label: t('athletes.backToList') }}
        actions={
          <>
            {canEdit && (
              <Link to={`/athleten/${a.id}/bearbeiten`} className="btn">
                {t('athletes.edit')}
              </Link>
            )}
            {canDelete && (
              <button
                type="button"
                className="btn btn-danger-outline"
                onClick={() => {
                  remove.reset();
                  setDeleting(true);
                }}
              >
                {t('athletes.delete')}
              </button>
            )}
          </>
        }
      />

      <div className="grid-2">
        <Section title={t('athletes.masterData')}>
          <DescriptionList
            items={[
              [t('athletes.dateOfBirth'), <DateTime key="dob" value={a.dateOfBirth} mode="date" />],
              [t('athletes.sex'), a.sex ? t(`sex.${a.sex}`) : t('sex.unknown')],
              [t('athletes.sportDiscipline'), a.discipline ? `${a.sport} · ${a.discipline}` : a.sport],
              [t('athletes.squad'), t(`squad.${a.squadStatus}`)],
              [t('athletes.club'), a.club ?? t('common.empty')],
            ]}
          />
        </Section>
        <Section title={t('athletes.records')}>
          <Table
            columns={recordColumns}
            rows={a.recordCounts}
            rowKey={(r) => r.datasetId}
            caption={t('athletes.records')}
            empty={t('athletes.recordsEmpty')}
          />
        </Section>
      </div>

      <Section
        title={t('athletes.consents.title')}
        description={t('athletes.consents.intro')}
        actions={granted.length > 0 ? addConsent : null}
      >
        {granted.length === 0 ? (
          <EmptyState
            message={withdrawn.length > 0 ? t('athletes.consents.noneValid') : t('athletes.consents.empty')}
            action={addConsent ?? undefined}
          />
        ) : (
          <Table
            columns={grantedColumns}
            rows={granted}
            rowKey={(c) => c.id}
            caption={t('athletes.consents.caption')}
          />
        )}
        {withdrawn.length > 0 && (
          <Details summary={t('athletes.consents.withdrawnList', { count: withdrawn.length })}>
            <Table
              columns={withdrawnColumns}
              rows={withdrawn}
              rowKey={(c) => c.id}
              caption={t('athletes.consents.withdrawnList', { count: withdrawn.length })}
            />
          </Details>
        )}
      </Section>

      <Details>
        <DescriptionList
          items={[
            [t('athletes.lastName'), a.lastName],
            [t('athletes.firstName'), a.firstName],
            [t('athletes.createdAt'), <DateTime key="created" value={a.createdAt} />],
            [t('athletes.updatedAt'), <DateTime key="updated" value={a.updatedAt} />],
          ]}
        />
        <h3>{t('athletes.identifiers')}</h3>
        <Table
          columns={identifierColumns}
          rows={a.identifiers}
          rowKey={(x) => `${x.system}:${x.value}`}
          caption={t('athletes.identifiers')}
          empty={t('athletes.identifiersEmpty')}
        />
      </Details>

      <ConsentDialog athleteId={a.id} open={consentOpen} onClose={() => setConsentOpen(false)} />

      <ConfirmDialog
        open={withdrawing !== null}
        title={t('athletes.consents.withdrawTitle')}
        message={
          <p>
            {withdrawing && (
              <strong>
                {purposeLabel(withdrawing.purpose)} ·{' '}
                {withdrawing.dataCategory === '*'
                  ? t('common.allCategories')
                  : t(`categories.${withdrawing.dataCategory}`)}
              </strong>
            )}
            <br />
            {t('athletes.consents.withdrawConfirm')}
          </p>
        }
        confirmLabel={t('athletes.consents.withdraw')}
        destructive
        busy={withdraw.isPending}
        error={withdraw.error}
        onCancel={() => setWithdrawing(null)}
        onConfirm={() => {
          if (withdrawing)
            withdraw.mutate({ params: { id: withdrawing.id }, body: { note: withdrawNote.trim() } });
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor={noteId}>
            {t('athletes.consents.withdrawNote')}
          </label>
          <textarea
            id={noteId}
            className="input"
            maxLength={1000}
            aria-describedby={`${noteId}-hint`}
            value={withdrawNote}
            onChange={(e) => setWithdrawNote(e.target.value)}
          />
          <p id={`${noteId}-hint`} className="field-hint">
            {t('athletes.consents.withdrawNoteHint')}
          </p>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting}
        title={t('athletes.deleteTitle')}
        message={<p>{t('athletes.deleteExplanation', { name: fullName })}</p>}
        confirmLabel={t('athletes.deleteConfirm')}
        destructive
        requireWord={t('common.confirmWord')}
        busy={remove.isPending}
        error={remove.error}
        onCancel={() => setDeleting(false)}
        onConfirm={() => remove.mutate({ params: { id: a.id } })}
      />
    </>
  );
}
