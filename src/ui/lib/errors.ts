/**
 * Übersetzung von API-Fehlern: nur Codes werden angezeigt, nie Server-Freitext.
 */
import type { z } from 'zod';
import { type I18n, useI18n } from '../i18n/index.tsx';
import { ApiError, toApiError } from './api.ts';

type Tr = Pick<I18n, 't' | 'tx'>;

export interface ErrorDescription {
  message: string;
  detail: string | undefined;
  requestId: string | null;
  fields: { path: string; text: string }[];
}

/** Detailgrund (reason) übersetzen; Format "code", "code:argument" oder "http_<status>". */
export function reasonText(i: Tr, reason: string | undefined | null): string | undefined {
  if (!reason) return undefined;
  const http = /^http_(\d{3})$/.exec(reason);
  if (http) return i.tx('reasons.http_status', { status: http[1] });
  const [code = reason, arg = '…'] = reason.split(':');
  const params = { column: arg, purpose: arg };
  return (
    i.tx(`reasons.${code}`) ??
    i.tx(`denyReasons.${code}`) ??
    i.tx(`releaseIssues.${code}`, params) ??
    i.tx(`importErrors.${code}`) ??
    i.tx(`federationErrors.${code}`)
  );
}

/** Beliebigen Fehler-/Statuscode (z. B. lastError, failureCode, errorCode) übersetzen. */
export function codeText(i: Tr, code: string | null | undefined): string {
  if (!code) return i.t('common.empty');
  return (
    i.tx(`errors.${code}`) ??
    i.tx(`clientErrors.${code}`) ??
    i.tx(`federationErrors.${code}`) ??
    i.tx(`importErrors.${code}`) ??
    reasonText(i, code) ??
    i.tx(`receivedReasons.${code}`) ??
    i.t('common.unknownCode', { code })
  );
}

/** true, wenn der Text wie ein maschinenlesbarer Code aussieht (snake_case, ohne Leerzeichen). */
export function looksLikeCode(text: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(text);
}

/**
 * Grund für den Status einer empfangenen Kopie: Code (Widerruf durch das System, Ablauf, Neueinstufung)
 * oder die Begründung, die die Datenverantwortung beim Datenhalter beim Widerruf eingegeben hat.
 */
export function receivedReasonText(i: Tr, reason: string): string {
  const known = i.tx(`receivedReasons.${reason}`);
  if (known) return known;
  if (looksLikeCode(reason)) return codeText(i, reason);
  return i.t('received.holderReason', { text: reason });
}

/** Widerrufsgrund einer Freigabe: Systemcode (Stilllegung, Neueinstufung) oder eingegebener Text. */
export function revocationReasonText(i: Tr, reason: string): string {
  if (!looksLikeCode(reason)) return reason;
  return i.tx(`reasons.${reason}`) ?? reason;
}

export function fieldCodeText(i: Tr, code: string): string {
  const [c = code] = code.split(':');
  return (
    i.tx(`fieldErrors.${c}`) ??
    i.tx(`importErrors.${c}`) ??
    i.tx(`releaseIssues.${c}`, { column: '…', purpose: '…' }) ??
    i.t('fieldErrors.invalid')
  );
}

export function describeError(i: Tr, error: unknown): ErrorDescription {
  const e = toApiError(error);
  const message =
    i.tx(`errors.${e.code}`) ?? i.tx(`clientErrors.${e.code}`) ?? i.t('common.unknownCode', { code: e.code });
  return {
    message,
    detail: reasonText(i, e.reason),
    requestId: e.requestId,
    fields: Object.entries(e.fields ?? {}).map(([path, code]) => ({
      path: path.replace(/^(body|query|params)\./, ''),
      text: fieldCodeText(i, code),
    })),
  };
}

const FIELD_PREFIXES = ['body.', '', 'query.', 'body.release.'] as const;

/**
 * Feldfehler zu einem Pfad (mit oder ohne Präfix "body.", bei der Freigabevorschau "body.release.").
 * Fehler an Unterpfaden zählen mit: "columns" findet auch "body.columns.3".
 */
export function rawFieldError(error: unknown, path: string): string | undefined {
  if (!(error instanceof ApiError) || !error.fields) return undefined;
  const fields = error.fields;
  for (const prefix of FIELD_PREFIXES) {
    const exact = fields[`${prefix}${path}`];
    if (exact) return exact;
  }
  for (const prefix of FIELD_PREFIXES) {
    const below = `${prefix}${path}.`;
    const key = Object.keys(fields).find((k) => k.startsWith(below));
    if (key) return fields[key];
  }
  return undefined;
}

/** Liefert eine Funktion Pfad → übersetzter Feldfehler (oder undefined). */
export function useFieldErrors(...errors: unknown[]): (path: string) => string | undefined {
  const i = useI18n();
  return (path: string) => {
    for (const err of errors) {
      const code = rawFieldError(err, path);
      if (code) return fieldCodeText(i, code);
    }
    return undefined;
  };
}

/**
 * Prüft Eingaben clientseitig mit dem Vertragsschema und liefert bei Fehlern einen ApiError
 * im selben Format wie der Server (validation_failed, fields mit Präfix "body.").
 */
export function clientValidate<T extends z.ZodType>(
  schema: T,
  data: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; error: ApiError } {
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, data: r.data };
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const path = ['body', ...issue.path.map(String)].join('.');
    fields[path] ??= issue.code;
  }
  return { ok: false, error: new ApiError({ status: 400, code: 'validation_failed', fields }) };
}
