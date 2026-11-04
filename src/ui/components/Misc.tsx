import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { cx } from '../lib/util.ts';
import { useToast } from './Toast.tsx';

/** Zeitstempel (ISO) in Europe/Berlin, de-DE bzw. en-GB. mode="date" für reine Datumsangaben. */
export function DateTime({
  value,
  mode = 'dateTime',
}: {
  value: string | null | undefined;
  mode?: 'dateTime' | 'date';
}) {
  const { fmt, t } = useI18n();
  if (!value) return <span className="muted">{t('common.empty')}</span>;
  return <time dateTime={value}>{mode === 'date' ? fmt.date(value) : fmt.dateTime(value)}</time>;
}

/** Kopiert Text in die Zwischenablage, mit Rückmeldung. */
export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <button
      type="button"
      className={cx('btn btn-sm', className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success(t('common.copied'));
        } catch {
          toast.error(t('common.copyFailed'));
        }
      }}
    >
      {label ?? t('common.copy')}
    </button>
  );
}

/** Schlüssel-Wert-Liste */
export function DescriptionList({
  items,
  className,
}: {
  items: [ReactNode, ReactNode][];
  className?: string;
}) {
  return (
    <dl className={cx('dl', className)}>
      {items.map(([k, v], n) => (
        // Reihenfolge ist fest; Index als Schlüssel ist hier stabil
        // biome-ignore lint/suspicious/noArrayIndexKey: statische Liste
        <div key={n} className="dl-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
}

/** Registerkarten (Pfeiltasten wechseln). Inhalt rendert der Aufrufer anhand von active. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: readonly TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, n: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (n + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    const tab = tabs[next];
    if (tab) {
      onChange(tab.id);
      refs.current[next]?.focus();
    }
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, n) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[n] = el;
          }}
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab.id === active}
          tabIndex={tab.id === active ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => onKey(e, n)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Monospace-Block mit Kopierknopf (z. B. Code-Beispiele, Tokens, Fingerprints). */
export function CodeBlock({ code, copy = true, label }: { code: string; copy?: boolean; label?: string }) {
  return (
    <div className="code-block">
      {label && <div className="code-block-label">{label}</div>}
      <pre>
        <code>{code}</code>
      </pre>
      {copy && <CopyButton text={code} className="code-block-copy" />}
    </div>
  );
}

/** Ja/Nein */
export function YesNo({ value }: { value: boolean }) {
  const { t } = useI18n();
  return <>{value ? t('common.yes') : t('common.no')}</>;
}
