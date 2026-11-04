import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Connector } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import { useApiMutation } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';
import { ErrorMessage } from '../ErrorMessage.tsx';
import { FormActions, FormField } from '../FormField.tsx';
import { Section } from '../PageHeader.tsx';
import { useToast } from '../Toast.tsx';

/** Import starten: CSV hochladen oder API jetzt abrufen (imports.start) → Vorschau des Laufs. */
export function ImportStarter({ connector }: { connector: Connector }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const session = useSession();
  const [file, setFile] = useState<File | null>(null);
  const start = useApiMutation('imports.start', {
    invalidate: ['imports.list', 'connectors.list', 'connectors.get'],
    onSuccess: (detail) => {
      toast.success(t('connectors.importStarted'));
      navigate(`/importe/${detail.run.id}`);
    },
  });

  if (!session.can('imports.start')) return null;
  const csv = connector.kind === 'csv_upload';
  const blocked = !connector.active || start.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const fd = new FormData();
    if (csv) {
      if (!file) return;
      fd.append('file', file);
    }
    start.mutate({ params: { id: connector.id }, body: fd });
  };

  return (
    <Section
      title={t('connectors.runTitle')}
      description={csv ? t('connectors.runCsvHint') : t('connectors.runApiHint')}
    >
      {!connector.active && (
        <div className="alert alert-info">
          <p>{t('connectors.inactiveHint')}</p>
        </div>
      )}
      <form className="form" onSubmit={submit} noValidate>
        {csv && (
          <FormField label={t('connectors.importFile')} required>
            {(a) => (
              <input
                {...a}
                className="input"
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                disabled={!connector.active}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            )}
          </FormField>
        )}
        {start.error && <ErrorMessage error={start.error} />}
        <FormActions>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={blocked || (csv && !file)}
            aria-busy={start.isPending || undefined}
          >
            {start.isPending
              ? t('connectors.starting')
              : csv
                ? t('connectors.startImport')
                : t('connectors.fetchNow')}
          </button>
        </FormActions>
      </form>
    </Section>
  );
}
