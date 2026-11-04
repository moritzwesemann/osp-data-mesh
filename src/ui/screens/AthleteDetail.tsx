import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Consent } from '../../shared/contract/index.ts';
import { ConsentDialog } from '../components/athletes/ConsentDialog.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { DateTime, DescriptionList } from '../components/Misc.tsx';
import { PageHeader, Section } from '../components/PageHeader.tsx';
import { EmptyState, QueryView } from '../components/QueryState.tsx';
import { Badge, CategoryBadge, StatusBadge } from '../components/StatusBadge.tsx';
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

/** /athleten/:id – Stammdaten, Kennungen, Datenbestand, Einwilligungen, Löschung. */
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

  const consentColumns: Column<Consent>[] = [
    { key: 'purpose', header: t('athletes.consents.purpose'), render: (c) => purposeLabel(c.purpose) },
    {
      key: 'category',
      header: t('athletes.consents.category'),
      render: (c) => <CategoryBadge category={c.dataCategory} />,
    },
    {
      key: 'status',
      header: t('athletes.consents.status'),
      render: (c) => (
        <div className="stack-sm">
          <StatusBadge group="consentStatus" value={c.status} />
          {c.withdrawnAt && (
            <span className="small muted">
              {t('athletes.consents.withdrawnAt', { date: fmt.dateTime(c.withdrawnAt) })}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'from',
      header: t('athletes.consents.validFrom'),
      className: 'nowrap',
      render: (c) => <DateTime value={c.validFrom} mode="date" />,
    },
    {
      key: 'until',
      header: t('athletes.consents.validUntil'),
      className: 'nowrap',
      render: (c) =>
        c.validUntil ? (
          <DateTime value={c.validUntil} mode="date" />
        ) : (
          <span className="muted">{t('athletes.consents.openEnded')}</span>
        ),
    },
    {
      key: 'evidence',
      header: t('athletes.consents.evidenceNote'),
      className: 'break',
      render: (c) => c.evidenceNote || <span className="muted">{t('common.empty')}</span>,
    },
    {
      key: 'recorded',
      header: t('athletes.consents.recordedAt'),
      className: 'nowrap',
      render: (c) => <DateTime value={c.recordedAt} />,
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('common.actions')}</span>,
      render: (c) =>
        canWithdraw && c.status === 'granted' ? (
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

  return (
    <>
      <PageHeader
        title={fullName}
        back={{ to: '/athleten', label: t('athletes.backToList') }}
        meta={
          <>
            <Badge tone="accent">{t(`squad.${a.squadStatus}`)}</Badge>
            <Badge>{a.sport}</Badge>
          </>
        }
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
              [t('athletes.lastName'), a.lastName],
              [t('athletes.firstName'), a.firstName],
              [t('athletes.dateOfBirth'), <DateTime key="dob" value={a.dateOfBirth} mode="date" />],
              [t('athletes.sex'), a.sex ? t(`sex.${a.sex}`) : t('sex.unknown')],
              [t('athletes.sport'), a.sport],
              [t('athletes.squad'), t(`squad.${a.squadStatus}`)],
              [t('athletes.club'), a.club ?? t('common.empty')],
              [t('athletes.discipline'), a.discipline ?? t('common.empty')],
              [t('athletes.createdAt'), <DateTime key="created" value={a.createdAt} />],
              [t('athletes.updatedAt'), <DateTime key="updated" value={a.updatedAt} />],
            ]}
          />
        </Section>
        <div className="stack-lg">
          <Section title={t('athletes.identifiers')}>
            <Table
              columns={identifierColumns}
              rows={a.identifiers}
              rowKey={(x) => `${x.system}:${x.value}`}
              caption={t('athletes.identifiers')}
              empty={t('athletes.identifiersEmpty')}
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
      </div>

      <Section
        title={t('athletes.consents.title')}
        description={t('athletes.consents.intro')}
        actions={
          canAddConsent ? (
            <button type="button" className="btn btn-primary" onClick={() => setConsentOpen(true)}>
              {t('athletes.consents.add')}
            </button>
          ) : null
        }
      >
        {a.consents.length === 0 ? (
          <EmptyState
            message={t('athletes.consents.empty')}
            action={
              canAddConsent ? (
                <button type="button" className="btn btn-primary" onClick={() => setConsentOpen(true)}>
                  {t('athletes.consents.add')}
                </button>
              ) : undefined
            }
          />
        ) : (
          <Table
            columns={consentColumns}
            rows={a.consents}
            rowKey={(c) => c.id}
            caption={t('athletes.consents.caption')}
          />
        )}
      </Section>

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
