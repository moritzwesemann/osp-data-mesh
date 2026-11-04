/**
 * Anmelde-Richtlinien: Passwortregeln, Kontosperre, Ratenbegrenzung.
 */
import { randomToken } from '../../core/crypto.ts';
import { AppError } from '../../core/errors.ts';
import { hashPassword } from './sessions.ts';

export const MIN_PASSWORD_LENGTH = 12;
/** Fehlversuche in Folge, nach denen das Konto gesperrt wird */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
/** Anmeldeversuche je IP-Adresse und Zeitfenster */
export const LOGIN_RATE_LIMIT = 30;
export const LOGIN_RATE_WINDOW_MS = 5 * 60_000;

/**
 * Prüft ein neues Passwort. Liefert einen maschinenlesbaren Grund oder null.
 * Mindestlänge, nicht gleich der E-Mail-Adresse, nicht gleich dem bisherigen Passwort.
 */
export function passwordPolicyViolation(
  password: string,
  ctx: { email?: string; current?: string } = {},
): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (ctx.email && password.trim().toLowerCase() === ctx.email.trim().toLowerCase()) return 'equals_email';
  if (ctx.current !== undefined && password === ctx.current) return 'equals_current';
  return null;
}

export function assertPasswordPolicy(password: string, ctx: { email?: string; current?: string } = {}): void {
  const reason = passwordPolicyViolation(password, ctx);
  if (reason) throw new AppError('password_too_weak', { reason });
}

let dummyHash: Promise<string> | null = null;
/**
 * Argon2id-Hash eines Zufallswerts. Bei unbekannter E-Mail wird trotzdem ein Passwort geprüft,
 * damit die Antwortzeit nicht verrät, ob ein Konto existiert.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomToken(24));
  return dummyHash;
}

/**
 * Gleitendes Zeitfenster je Schlüssel (z. B. IP-Adresse), nur im Speicher dieses Prozesses.
 * Abgewiesene Versuche zählen nicht mit, damit das Fenster von selbst wieder aufgeht.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  /** Beginn der aktuellen Sperrphase je Schlüssel (für "erste Abweisung" → Audit nur einmal) */
  private readonly blockedSince = new Map<string, number>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  hit(key: string, nowMs: number): { allowed: boolean; firstBlocked: boolean } {
    const since = nowMs - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      const blockedAt = this.blockedSince.get(key);
      const firstBlocked = blockedAt === undefined || blockedAt <= since;
      if (firstBlocked) this.blockedSince.set(key, nowMs);
      return { allowed: false, firstBlocked };
    }
    list.push(nowMs);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune(nowMs);
    return { allowed: true, firstBlocked: false };
  }

  private prune(nowMs: number): void {
    const since = nowMs - this.windowMs;
    for (const [k, v] of this.hits) {
      if (!v.some((t) => t > since)) {
        this.hits.delete(k);
        this.blockedSince.delete(k);
      }
    }
  }
}
