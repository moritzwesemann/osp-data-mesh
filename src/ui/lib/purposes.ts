import { useCallback } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { useApiQuery } from './query.ts';

/** Zweck-Vokabular (purposes.list), selten geändert. */
export function usePurposes() {
  return useApiQuery('purposes.list', {}, { staleTime: 10 * 60_000 });
}

/** Funktion Zweck-Code → Bezeichnung in der aktuellen Sprache ('*' = alle Zwecke). */
export function usePurposeLabel(): (code: string) => string {
  const { lang, t } = useI18n();
  const q = usePurposes();
  const items = q.data?.items;
  return useCallback(
    (code: string) => {
      if (code === '*') return t('common.allPurposes');
      const p = items?.find((x) => x.code === code);
      if (!p) return code;
      return lang === 'de' ? p.labelDe : p.labelEn;
    },
    [items, lang, t],
  );
}
