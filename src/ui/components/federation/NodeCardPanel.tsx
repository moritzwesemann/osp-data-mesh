import { useI18n } from '../../i18n/index.tsx';
import { saveJson } from '../../lib/api.ts';
import { useApiQuery } from '../../lib/query.ts';
import { CopyButton, DescriptionList, Details } from '../Misc.tsx';
import { Section } from '../PageHeader.tsx';
import { QueryView } from '../QueryState.tsx';
import { FingerprintBox } from './FingerprintBox.tsx';

/** Eigene Knotenkarte (node.card): Fingerprint und Download sichtbar, übrige Angaben und Kopieren in Details. */
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
            <div className="row">
              <button type="button" className="btn" onClick={() => saveJson(c, `${c.nodeId}.node-card.json`)}>
                {t('partners.downloadCard')}
              </button>
            </div>
            <Details>
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
                <CopyButton text={c.fingerprint} label={t('partners.copyFingerprint')} className="btn" />
                <CopyButton
                  text={JSON.stringify(c, null, 2)}
                  label={t('partners.copyCard')}
                  className="btn"
                />
              </div>
            </Details>
          </div>
        )}
      </QueryView>
    </Section>
  );
}
