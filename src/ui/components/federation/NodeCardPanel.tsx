import { useI18n } from '../../i18n/index.tsx';
import { saveJson } from '../../lib/api.ts';
import { useApiQuery } from '../../lib/query.ts';
import { CopyButton, DescriptionList } from '../Misc.tsx';
import { Section } from '../PageHeader.tsx';
import { QueryView } from '../QueryState.tsx';
import { FingerprintBox } from './FingerprintBox.tsx';

/** Eigene Knotenkarte (node.card) mit hervorgehobenem Fingerprint, Download und Kopieren. */
export function NodeCardPanel() {
  const { t } = useI18n();
  const card = useApiQuery('node.card', {}, { staleTime: 10 * 60_000 });

  return (
    <Section title={t('partners.ownCard')} description={t('partners.ownCardIntro')}>
      <QueryView query={card}>
        {(c) => (
          <div className="stack">
            <div className="stack-sm">
              <span className="field-label">{t('common.fingerprint')}</span>
              <FingerprintBox value={c.fingerprint} />
            </div>
            <DescriptionList
              items={[
                [t('partners.displayName'), c.displayName],
                [
                  t('partners.nodeId'),
                  <span key="node" className="mono">
                    {c.nodeId}
                  </span>,
                ],
                [
                  t('partners.baseUrl'),
                  <span key="url" className="break">
                    {c.baseUrl}
                  </span>,
                ],
                [
                  t('partners.publicKey'),
                  <span key="pk" className="mono break small">
                    {c.publicKey}
                  </span>,
                ],
              ]}
            />
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => saveJson(c, `${c.nodeId}.node-card.json`)}
              >
                {t('partners.downloadCard')}
              </button>
              <CopyButton text={c.fingerprint} label={t('partners.copyFingerprint')} className="btn" />
              <CopyButton text={JSON.stringify(c, null, 2)} label={t('partners.copyCard')} className="btn" />
            </div>
          </div>
        )}
      </QueryView>
    </Section>
  );
}
