import type { AccessGrant } from '../../../shared/contract/index.ts';
import type { I18n } from '../../i18n/index.tsx';

type Tr = Pick<I18n, 't' | 'fmt'>;

/** Gültigkeit einer Freigabe als Text, z. B. „ab 01.03.2026“ oder „01.03.2026 bis 31.12.2026“. */
export function validityText(i: Tr, g: Pick<AccessGrant, 'validFrom' | 'validUntil'>): string {
  const from = i.fmt.date(g.validFrom);
  if (!g.validUntil) return `${i.t('myData.validSince', { from })}, ${i.t('myData.validUnlimited')}`;
  return i.t('myData.validRange', { from, until: i.fmt.date(g.validUntil) });
}

/** Datenzeitraum einer Freigabe als Text. */
export function dataWindowText(i: Tr, g: Pick<AccessGrant, 'dataFrom' | 'dataUntil'>): string {
  if (g.dataFrom && g.dataUntil)
    return i.t('myData.dataRange', { from: i.fmt.date(g.dataFrom), until: i.fmt.date(g.dataUntil) });
  if (g.dataFrom) return i.t('myData.dataFrom', { from: i.fmt.date(g.dataFrom) });
  if (g.dataUntil) return i.t('myData.dataUntil', { until: i.fmt.date(g.dataUntil) });
  return i.t('myData.dataAll');
}

/** Gültigkeit kurz für Karten: „gültig ab …“ (beginnt später), „gültig bis …“ oder „unbefristet gültig“. */
export function validityShort(i: Tr, g: Pick<AccessGrant, 'validFrom' | 'validUntil'>): string {
  if (Date.parse(g.validFrom) > Date.now())
    return i.t('myData.validFromShort', { from: i.fmt.date(g.validFrom) });
  if (g.validUntil) return i.t('myData.validUntilShort', { until: i.fmt.date(g.validUntil) });
  return i.t('myData.validOpenShort');
}
