/**
 * Übersetzungen (Deutsch primär, Englisch sekundär).
 *
 * Platzhalter: "{name}" wird ersetzt; Zahlen werden sprachabhängig formatiert.
 * Einzahl/Mehrzahl: "{count|Zeile|Zeilen}" wählt nach params.count (1 → erste Form).
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { de, type Messages } from './de.ts';
import { en } from './en.ts';

export type Lang = 'de' | 'en';
export type Params = Record<string, string | number | null | undefined>;

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Messages>;

const DICTS: Record<Lang, Messages> = { de, en };
const STORAGE_KEY = 'osp.lang';
export const TIME_ZONE = 'Europe/Berlin';

function lookup(dict: Messages, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && part in cur) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(template: string, params: Params | undefined, lang: Lang): string {
  if (!params) return template;
  const nf = new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-GB');
  return template
    .replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (_m, name: string, one: string, other: string) =>
      Number(params[name]) === 1 ? one : other,
    )
    .replace(/\{(\w+)\}/g, (m, name: string) => {
      const v = params[name];
      if (v === undefined || v === null) return m;
      return typeof v === 'number' ? nf.format(v) : v;
    });
}

export interface Formatters {
  /** ISO-Zeitstempel → Datum und Uhrzeit (Europe/Berlin) */
  dateTime: (iso: string | null | undefined) => string;
  /** YYYY-MM-DD oder ISO-Zeitstempel → Datum */
  date: (value: string | null | undefined) => string;
  /** grouping=false für Werte wie Jahreszahlen (2001 statt 2.001) */
  number: (n: number | null | undefined, maxFractionDigits?: number, grouping?: boolean) => string;
  bytes: (n: number | null | undefined) => string;
  duration: (seconds: number) => string;
}

/** Übersetzungsfunktionen einer Sprache (ohne React; fehlende Schlüssel fallen auf Deutsch zurück). */
export function createTranslator(lang: Lang): Pick<I18n, 't' | 'tx' | 'fmt'> {
  const dict = DICTS[lang];
  const tx = (key: string, params?: Params) => {
    const s = lookup(dict, key) ?? lookup(de, key);
    return s === undefined ? undefined : interpolate(s, params, lang);
  };
  return { t: (key, params) => tx(key, params) ?? key, tx, fmt: makeFormatters(lang) };
}

export interface I18n {
  lang: Lang;
  locale: string;
  setLang: (lang: Lang) => void;
  /** Sprache aus dem Benutzerprofil übernehmen, sofern nicht lokal gewählt */
  applyUserLocale: (lang: Lang) => void;
  t: (key: MessageKey, params?: Params) => string;
  /** Dynamischer Schlüssel; undefined, wenn er nicht existiert */
  tx: (key: string, params?: Params) => string | undefined;
  fmt: Formatters;
}

const I18nContext = createContext<I18n | null>(null);

function storedLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'de' || v === 'en' ? v : null;
  } catch {
    return null;
  }
}

function browserLang(): Lang {
  const l = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'de';
  return l.startsWith('de') ? 'de' : l.startsWith('en') ? 'en' : 'de';
}

const EMPTY = '–';

function makeFormatters(lang: Lang): Formatters {
  const locale = lang === 'de' ? 'de-DE' : 'en-GB';
  const dt = new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const d = new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, dateStyle: 'medium' });
  const dUtc = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' });
  return {
    dateTime: (iso) => {
      if (!iso) return EMPTY;
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? iso : dt.format(date);
    },
    date: (value) => {
      if (!value) return EMPTY;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const date = new Date(`${value}T00:00:00Z`);
        return Number.isNaN(date.getTime()) ? value : dUtc.format(date);
      }
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : d.format(date);
    },
    number: (n, maxFractionDigits = 3, grouping = true) =>
      n === null || n === undefined
        ? EMPTY
        : new Intl.NumberFormat(locale, {
            maximumFractionDigits: maxFractionDigits,
            useGrouping: grouping,
          }).format(n),
    bytes: (n) => {
      if (n === null || n === undefined) return EMPTY;
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let v = n;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
    },
    duration: (seconds) => {
      const s = Math.max(0, Math.floor(seconds));
      const days = Math.floor(s / 86400);
      const hours = Math.floor((s % 86400) / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const unit = lang === 'de' ? { d: 'T', h: 'Std.', m: 'Min.' } : { d: 'd', h: 'h', m: 'min' };
      if (days > 0) return `${days} ${unit.d} ${hours} ${unit.h}`;
      if (hours > 0) return `${hours} ${unit.h} ${minutes} ${unit.m}`;
      return `${minutes} ${unit.m}`;
    },
  };
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => storedLang() ?? browserLang());

  const setLang = useCallback((next: Lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Speicher nicht verfügbar: nur für diese Sitzung
    }
    setLangState(next);
  }, []);

  const applyUserLocale = useCallback((next: Lang) => {
    if (!storedLang()) setLangState(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo<I18n>(
    () => ({
      lang,
      locale: lang === 'de' ? 'de-DE' : 'en-GB',
      setLang,
      applyUserLocale,
      ...createTranslator(lang),
    }),
    [lang, setLang, applyUserLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
