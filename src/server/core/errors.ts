import type { ErrorCode } from '../../shared/contract/common.ts';

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  csrf_failed: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  account_locked: 423,
  invalid_credentials: 401,
  password_too_weak: 400,
  payload_too_large: 413,
  unsupported_format: 415,
  import_failed: 422,
  source_unreachable: 502,
  source_not_allowed: 400,
  release_invalid: 422,
  access_denied: 403,
  peer_unreachable: 502,
  peer_rejected: 502,
  peer_untrusted: 409,
  signature_invalid: 502,
  backup_failed: 500,
  internal_error: 500,
};

/**
 * Fachlicher Fehler mit übersetzbarem Code. Wird vom zentralen Fehlerbehandler in eine JSON-Antwort
 * {error:{code, requestId, reason?, fields?}} umgewandelt. Niemals interne Details in "reason" packen.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly reason?: string;
  readonly fields?: Record<string, string>;

  constructor(
    code: ErrorCode,
    opts: { reason?: string; fields?: Record<string, string>; cause?: unknown } = {},
  ) {
    super(opts.reason ? `${code}: ${opts.reason}` : code, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.reason = opts.reason;
    this.fields = opts.fields;
  }
}

export const notFound = () => new AppError('not_found');
export const forbidden = () => new AppError('forbidden');
export const conflict = (reason?: string) => new AppError('conflict', { reason });
export const invalid = (fields: Record<string, string>, reason?: string) =>
  new AppError('validation_failed', { fields, reason });
