/**
 * Bausteine für Freigaben: Empfänger, Bedingungen als Sätze, Zeitfenster.
 */
import type { Condition, Release } from '../../../shared/contract/index.ts';
import { type I18n, useI18n } from '../../i18n/index.tsx';
import { usePurposeLabel } from '../../lib/purposes.ts';

type Recipient = Release['recipient'];

/** Empfänger: Rolle (übersetzt) oder Partnerknoten (Name + Knoten-ID). */
export function RecipientLabel({ recipient }: { recipient: Recipient }) {
  const { t } = useI18n();
  if (recipient.type === 'role') return <>{t(`recipientRoles.${recipient.role}`)}</>;
  return (
    <span>
      {recipient.peerName} <span className="muted small mono">{recipient.peerNodeId}</span>
    </span>
  );
}

/** Zwecke als Text in der aktuellen Sprache. */
export function PurposeList({ purposes }: { purposes: readonly string[] }) {
  const label = usePurposeLabel();
  return <>{purposes.map(label).join(', ')}</>;
}

function valueText(i: Pick<I18n, 't' | 'fmt'>, v: Condition['value']): string {
  if (v === undefined || v === null) return i.t('common.empty');
  if (Array.isArray(v)) return v.map((x) => valueText(i, x)).join(', ');
  if (typeof v === 'boolean') return v ? i.t('common.yes') : i.t('common.no');
  if (typeof v === 'number') return i.fmt.number(v, 6);
  return v;
}

/** Bedingungen als lesbare Sätze: Spalte – Bedingung – Wert. */
export function ConditionSummary({
  conditions,
  labels,
  emptyText,
}: {
  conditions: readonly Condition[];
  /** Spaltenschlüssel → Bezeichnung (falls bekannt) */
  labels?: ReadonlyMap<string, string>;
  emptyText: string;
}) {
  const i = useI18n();
  if (conditions.length === 0) return <span className="muted">{emptyText}</span>;
  return (
    <ul className="list-plain stack-sm">
      {conditions.map((c) => (
        <li key={JSON.stringify(c)}>
          <strong>{labels?.get(c.column) ?? c.column}</strong> {i.t(`conditionOps.${c.op}`)}
          {c.op !== 'is_null' && c.op !== 'not_null' && (
            <>
              {' '}
              <span className="mono">{valueText(i, c.value)}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Zeitraum als Text; format formatiert die Grenzen (Datum oder Zeitpunkt). */
export function rangeText(
  t: I18n['t'],
  format: (v: string) => string,
  from: string | null,
  until: string | null,
  emptyText: string,
): string {
  if (from && until) return t('releases.rangeBoth', { from: format(from), until: format(until) });
  if (from) return t('releases.rangeFrom', { from: format(from) });
  if (until) return t('releases.rangeUntil', { until: format(until) });
  return emptyText;
}

/** Gültigkeit: ab validFrom, bis vor validUntil (exklusiv) bzw. unbefristet. */
export function validityText(
  i: Pick<I18n, 't' | 'fmt'>,
  validFrom: string,
  validUntil: string | null,
): string {
  if (validUntil) {
    return i.t('releases.validUntilExclusive', {
      from: i.fmt.dateTime(validFrom),
      until: i.fmt.dateTime(validUntil),
    });
  }
  return `${i.t('releases.rangeFrom', { from: i.fmt.dateTime(validFrom) })}, ${i.t('releases.openEnded')}`;
}
