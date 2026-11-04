/**
 * Schutz des Föderationsendpunkts vor Überflutung mit abgelehnten Anfragen (im Speicher dieses Prozesses).
 *
 * Ratenbegrenzung: Ablehnungen der Protokollprüfung (Schritte 1–6, docs/protokoll.md) werden je IP-Adresse
 * und je behauptetem Absender (X-Mesh-Node) im Zeitfenster gezählt. Ist die Grenze erreicht, antwortet der
 * Endpunkt mit 429, ohne den Body zu lesen und ohne weitere Prüfung:
 *  - je IP-Adresse für jede Anfrage, noch vor dem Datenbankzugriff;
 *  - je behauptetem Absender nur, wenn dieser kein zugelassener Partner ist. Die Kennung im Header kann
 *    jeder fälschen; eine Sperre auch für zugelassene Partner würde es jedem erlauben, den Austausch mit
 *    einem echten Partner zu unterbinden. Für zugelassene Partner entscheidet weiterhin die Signatur.
 *
 * Audit: je Quelle (IP-Adresse + Partner bzw. "unbekannt") und Code wird nur die erste Ablehnung eines
 * Zeitfensters auditiert, insgesamt höchstens MAX_AUDITED_REJECTIONS je Zeitfenster (Schutz bei wechselnden
 * Adressen). Alle Ablehnungen stehen im Betriebslog; der nächste auditierte Eintrag derselben Quelle nennt
 * die Zahl der dazwischen nur geloggten Ablehnungen (`suppressed`).
 */
import { NODE_ID_RE } from './protocol.ts';

/** Zeitfenster der Ratenbegrenzung und der Audit-Zusammenfassung */
export const REJECTION_WINDOW_MS = 5 * 60_000;
/** Abgelehnte Anfragen je IP-Adresse im Zeitfenster; danach 429 */
export const MAX_REJECTIONS_PER_IP = 60;
/** Abgelehnte Anfragen je behauptetem Absender im Zeitfenster; danach 429 (nur nicht zugelassene Absender) */
export const MAX_REJECTIONS_PER_NODE = 60;
/** Höchstzahl auditierter Ablehnungen je Zeitfenster (alle Quellen zusammen) */
export const MAX_AUDITED_REJECTIONS = 20;
/** Höchstzahl gespeicherter Schlüssel je Zähler (Speicherschutz bei wechselnden Adressen) */
const MAX_KEYS = 20_000;

export interface GuardLimits {
  windowMs: number;
  perIp: number;
  perNode: number;
  audited: number;
}

const DEFAULT_LIMITS: GuardLimits = {
  windowMs: REJECTION_WINDOW_MS,
  perIp: MAX_REJECTIONS_PER_IP,
  perNode: MAX_REJECTIONS_PER_NODE,
  audited: MAX_AUDITED_REJECTIONS,
};

interface Entry {
  start: number;
  count: number;
}

/** Zähler mit festem Zeitfenster je Schlüssel */
class WindowCounter {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly windowMs: number) {}

  /** Eintrag im aktuellen Zeitfenster (eine zurückgestellte Uhr zählt als dasselbe Fenster) */
  current(key: string, nowMs: number): Entry | undefined {
    const e = this.entries.get(key);
    return e && nowMs - e.start < this.windowMs ? e : undefined;
  }

  /** Beginnt für den Schlüssel ein neues Zeitfenster */
  restart(key: string, nowMs: number): Entry {
    const e = { start: nowMs, count: 0 };
    this.entries.delete(key);
    this.entries.set(key, e);
    if (this.entries.size > MAX_KEYS) this.prune(nowMs);
    return e;
  }

  /** Neues Zeitfenster; liefert zusätzlich den Zählerstand des vorigen (abgelaufenen) Fensters */
  restartCarry(key: string, nowMs: number): { entry: Entry; previous: number } {
    const previous = this.entries.get(key)?.count ?? 0;
    return { entry: this.restart(key, nowMs), previous };
  }

  add(key: string, nowMs: number): number {
    const e = this.current(key, nowMs) ?? this.restart(key, nowMs);
    e.count++;
    return e.count;
  }

  private prune(nowMs: number): void {
    for (const [k, e] of this.entries) if (nowMs - e.start >= this.windowMs) this.entries.delete(k);
    // weiterhin zu viele: älteste Schlüssel verwerfen (Map behält die Einfügereihenfolge)
    for (const k of this.entries.keys()) {
      if (this.entries.size <= MAX_KEYS) break;
      this.entries.delete(k);
    }
  }
}

export interface AuditDecision {
  /** Ablehnung ins Audit-Log schreiben */
  audit: boolean;
  /** seit dem letzten Audit-Eintrag dieser Quelle nur geloggte Ablehnungen */
  suppressed: number;
  /** erstes Überschreiten des Audit-Budgets in diesem Zeitfenster (einmal deutlich loggen) */
  budgetExhausted: boolean;
}

const ipKey = (ip: string | null) => ip ?? 'unknown';
/** behaupteter Absender; fehlende oder ungültige Kennungen teilen sich einen Schlüssel */
const nodeKey = (headerNode: string) => (NODE_ID_RE.test(headerNode) ? headerNode : '-');

export class RejectionGuard {
  private readonly byIp: WindowCounter;
  private readonly byNode: WindowCounter;
  /** count = seit dem Audit-Eintrag nur geloggte Ablehnungen */
  private readonly audited: WindowCounter;
  private budgetStart = Number.NEGATIVE_INFINITY;
  private budgetUsed = 0;
  private budgetWarned = false;

  constructor(readonly limits: GuardLimits = DEFAULT_LIMITS) {
    this.byIp = new WindowCounter(limits.windowMs);
    this.byNode = new WindowCounter(limits.windowMs);
    this.audited = new WindowCounter(limits.windowMs);
  }

  /** IP-Adresse hat im Zeitfenster zu viele Ablehnungen erzeugt */
  ipBlocked(ip: string | null, nowMs: number): boolean {
    return (this.byIp.current(ipKey(ip), nowMs)?.count ?? 0) >= this.limits.perIp;
  }

  /** Behaupteter Absender hat zu viele Ablehnungen erzeugt (nur für nicht zugelassene Absender anwenden) */
  nodeBlocked(headerNode: string, nowMs: number): boolean {
    return (this.byNode.current(nodeKey(headerNode), nowMs)?.count ?? 0) >= this.limits.perNode;
  }

  /** Zählt eine Ablehnung der Protokollprüfung für IP-Adresse und behaupteten Absender */
  count(ip: string | null, headerNode: string, nowMs: number): void {
    this.byIp.add(ipKey(ip), nowMs);
    this.byNode.add(nodeKey(headerNode), nowMs);
  }

  /**
   * Entscheidet, ob eine Ablehnung auditiert wird: nur die erste je (Code, IP-Adresse, Quelle) und
   * Zeitfenster, solange das Budget des Zeitfensters reicht. `source` ist die nodeId eines bekannten
   * Partners oder '?' (frei wählbare unbekannte Kennungen erzeugen keine neuen Quellen).
   */
  decide(code: string, ip: string | null, source: string, nowMs: number): AuditDecision {
    const key = `${code}|${ipKey(ip)}|${source}`;
    const seen = this.audited.current(key, nowMs);
    if (seen) {
      seen.count++;
      return { audit: false, suppressed: seen.count, budgetExhausted: false };
    }
    if (nowMs - this.budgetStart >= this.limits.windowMs) {
      this.budgetStart = nowMs;
      this.budgetUsed = 0;
      this.budgetWarned = false;
    }
    const carried = this.audited.restartCarry(key, nowMs);
    if (this.budgetUsed >= this.limits.audited) {
      carried.entry.count = carried.previous + 1;
      const first = !this.budgetWarned;
      this.budgetWarned = true;
      return { audit: false, suppressed: carried.entry.count, budgetExhausted: first };
    }
    this.budgetUsed++;
    return { audit: true, suppressed: carried.previous, budgetExhausted: false };
  }
}
