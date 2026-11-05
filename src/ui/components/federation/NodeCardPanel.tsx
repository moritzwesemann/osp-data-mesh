import { type ReactNode, useState } from 'react';
import { useI18n } from '../../i18n/index.tsx';
import type { ApiOutput } from '../../lib/api.ts';
import { saveJson } from '../../lib/api.ts';
import { codeText } from '../../lib/errors.ts';
import { useApiQuery } from '../../lib/query.ts';
import { useSession } from '../../lib/session.tsx';
import { CopyButton, DateTime, DescriptionList, Details } from '../Misc.tsx';
import { Section } from '../PageHeader.tsx';
import { QueryView } from '../QueryState.tsx';
import { FingerprintBox } from './FingerprintBox.tsx';
import { RotateKeyDialog } from './RotateKeyDialog.tsx';

type KeyStatus = ApiOutput<'node.keyStatus'>;

/**
 * Eigene Knotenkarte (node.card): Fingerprint und Download sichtbar, übrige Angaben und Kopieren in Details.
 * Für die Administration zusätzlich Stand des Schlüsselwechsels und die Aktion „Schlüssel wechseln“.
 */
export function NodeCardPanel() {
  const { t } = useI18n();
  const session = useSession();
  const card = useApiQuery('node.card', {}, { staleTime: 10 * 60_000 });
  const keyStatus = useApiQuery('node.keyStatus', {}, { enabled: session.can('node.keyStatus') });
  const [rotating, setRotating] = useState(false);

  return (
    <Section
      title={t('partners.ownCard')}
      description={t('partners.ownCardIntro')}
      actions={
        session.can('node.rotateKey') ? (
          <button type="button" className="btn" onClick={() => setRotating(true)}>
            {t('partners.rotateKey')}
          </button>
        ) : undefined
      }
    >
      <QueryView query={card}>
        {(c) => (
          <div className="stack">
            {keyStatus.data && <KeyRotationState status={keyStatus.data} />}
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
                  ...(keyStatus.data
                    ? [
                        [
                          t('partners.keyCreatedAt'),
                          <DateTime key="kc" value={keyStatus.data.keyCreatedAt} />,
                        ] satisfies [ReactNode, ReactNode],
                      ]
                    : []),
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
      <RotateKeyDialog open={rotating} onClose={() => setRotating(false)} />
    </Section>
  );
}

/**
 * Laufender Wechsel: wie viele Partner den neuen Schlüssel bestätigt haben. Nach dem Ende der Übergangszeit:
 * Partner ohne Bestätigung müssen die neue Karte aufnehmen. Nach einem Wechsel wegen Kompromittierung:
 * Erinnerung an das manuelle Vorgehen.
 */
function KeyRotationState({ status }: { status: KeyStatus }) {
  const i = useI18n();
  const { t, fmt } = i;
  const r = status.rotation;
  if (!r) return null;
  const open = r.peers.filter((p) => !p.confirmedAt);
  if (r.mode === 'compromised') {
    // nur kurz nach dem Wechsel (Übergang) relevant: Hinweis bleibt sichtbar, bis ein neuer Wechsel folgt
    return (
      <div className="alert alert-warning" role="status">
        <p className="alert-title">{t('partners.compromisedDone', { date: fmt.dateTime(r.rotatedAt) })}</p>
        <p>{t('partners.compromisedDoneHint')}</p>
      </div>
    );
  }
  if (!r.running && open.length === 0) return null;
  return (
    <div className={r.running ? 'alert alert-info' : 'alert alert-warning'} role="status">
      <p className="alert-title">
        {r.running
          ? t('partners.rotationRunning', {
              date: fmt.dateTime(r.graceUntil),
              confirmed: r.peers.length - open.length,
              total: r.peers.length,
            })
          : t('partners.rotationUnconfirmed', { count: open.length })}
      </p>
      <p className="small">
        {t('partners.previousFingerprintLabel', { fingerprint: r.previousFingerprint })}
      </p>
      {open.length > 0 && (
        <ul className="list-plain small">
          {open.map((p) => (
            <li key={p.peerId}>
              {p.displayName}
              {' – '}
              {p.lastError ? codeText(i, p.lastError) : t('partners.rotationPeerPending')}
            </li>
          ))}
        </ul>
      )}
      {!r.running && <p className="small">{t('partners.rotationUnconfirmedHint')}</p>}
    </div>
  );
}
