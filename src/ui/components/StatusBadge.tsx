import type { ReactNode } from 'react';
import type { DataCategory, Shareability } from '../../shared/contract/index.ts';
import { type MessageKey, useI18n } from '../i18n/index.tsx';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Farbton je Statuswert; Gruppenname = Abschnitt im Wörterbuch. */
export const STATUS_TONES = {
  releaseStatus: {
    active: 'success',
    scheduled: 'info',
    expired: 'neutral',
    revoked: 'danger',
    outdated: 'warning',
  },
  importStatus: { previewed: 'info', committed: 'success', discarded: 'neutral', failed: 'danger' },
  peerStatus: { pending: 'warning', trusted: 'success', suspended: 'danger' },
  receivedStatus: { active: 'success', revoked: 'danger', expired: 'neutral', deleted: 'neutral' },
  consentStatus: { granted: 'success', withdrawn: 'neutral' },
  outboxStatus: { pending: 'warning', delivered: 'success', failed: 'danger' },
  backupStatus: { running: 'info', ok: 'success', failed: 'danger' },
  biViewStatus: { ok: 'success', error: 'danger', dropped: 'neutral' },
  auditOutcome: { success: 'success', denied: 'warning', error: 'danger' },
  exchangeOutcome: { delivered: 'success', denied: 'warning', error: 'danger' },
  discoveryStatus: { ok: 'success', unreachable: 'warning', rejected: 'danger', error: 'danger' },
  rowStatus: { valid: 'success', warning: 'warning', error: 'danger' },
  productStatus: { active: 'success', retired: 'neutral' },
  severity: { error: 'danger', warning: 'warning' },
  activeState: { active: 'success', inactive: 'neutral', locked: 'warning' },
} as const satisfies Record<string, Record<string, Tone>>;

export type StatusGroup = keyof typeof STATUS_TONES;

/** Übersetzter Status-Chip, z. B. <StatusBadge group="releaseStatus" value="active" /> */
export function StatusBadge<G extends StatusGroup>({
  group,
  value,
}: {
  group: G;
  value: keyof (typeof STATUS_TONES)[G] & string;
}) {
  const { tx } = useI18n();
  const tones = STATUS_TONES[group] as Record<string, Tone>;
  return <Badge tone={tones[value] ?? 'neutral'}>{tx(`${group}.${value}`) ?? value}</Badge>;
}

export function CategoryBadge({ category }: { category: DataCategory | '*' }) {
  const { t } = useI18n();
  if (category === '*') return <Badge>{t('common.allCategories')}</Badge>;
  return <Badge tone={category === 'health' ? 'warning' : 'neutral'}>{t(`categories.${category}`)}</Badge>;
}

export function SpecialCategoryBadge({ show = true }: { show?: boolean }) {
  const { t } = useI18n();
  if (!show) return null;
  return <Badge tone="warning">{t('common.specialCategory')}</Badge>;
}

export function ShareabilityBadge({ value }: { value: Shareability }) {
  const { t } = useI18n();
  return <Badge tone={value === 'internal' ? 'neutral' : 'info'}>{t(`shareability.${value}`)}</Badge>;
}

export function RoleBadge({ role }: { role: string }) {
  const { tx } = useI18n();
  return <Badge tone="accent">{tx(`roles.${role}`) ?? tx(`recipientRoles.${role}`) ?? role}</Badge>;
}

/** Typsicherer Schlüssel für dynamische Enum-Übersetzungen */
export function enumKey(group: string, value: string): MessageKey {
  return `${group}.${value}` as MessageKey;
}
