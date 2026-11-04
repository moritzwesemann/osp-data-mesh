/**
 * Prozessinterner Ereignisbus zur Entkopplung der Module.
 *
 *  - inTx(trx, …): Handler laufen in der Transaktion des Auslösers. Fehler brechen die Transaktion ab.
 *    Für Folgen, die atomar mit der Änderung sein müssen (z. B. Widerrufsmitteilung ins Ausgangspostfach).
 *  - after(…): nach dem Commit; Fehler werden geloggt, nicht weitergereicht (z. B. BI-Aktualisierung).
 */
import type { Tx } from './db.ts';
import type { Logger } from './logger.ts';

export interface DomainEvents {
  'release.created': {
    releaseId: string;
    productId: string;
    recipientType: 'role' | 'peer';
    recipientRole: string | null;
    recipientPeerId: string | null;
  };
  'release.revoked': {
    releaseId: string;
    productId: string;
    recipientType: 'role' | 'peer';
    recipientRole: string | null;
    recipientPeerId: string | null;
    reason: string;
  };
  'product.changed': { productId: string; retired: boolean };
  'consent.withdrawn': { athleteId: string; consentId: string; purpose: string; dataCategory: string };
  'athlete.deleted': { athleteId: string };
  'data.changed': { datasetId: string | null };
}
export type EventName = keyof DomainEvents;

type TxHandler<K extends EventName> = (payload: DomainEvents[K], trx: Tx) => Promise<void>;
type AfterHandler<K extends EventName> = (payload: DomainEvents[K]) => Promise<void>;

export class EventBus {
  private readonly txHandlers = new Map<EventName, TxHandler<EventName>[]>();
  private readonly afterHandlers = new Map<EventName, AfterHandler<EventName>[]>();

  constructor(private readonly log: Logger) {}

  onTx<K extends EventName>(name: K, handler: TxHandler<K>): void {
    const list = this.txHandlers.get(name) ?? [];
    list.push(handler as unknown as TxHandler<EventName>);
    this.txHandlers.set(name, list);
  }

  onAfter<K extends EventName>(name: K, handler: AfterHandler<K>): void {
    const list = this.afterHandlers.get(name) ?? [];
    list.push(handler as unknown as AfterHandler<EventName>);
    this.afterHandlers.set(name, list);
  }

  async inTx<K extends EventName>(trx: Tx, name: K, payload: DomainEvents[K]): Promise<void> {
    for (const h of this.txHandlers.get(name) ?? []) await h(payload, trx);
  }

  /** Wartet auf alle Handler (Tests können darauf warten); Fehler werden nur geloggt. */
  async after<K extends EventName>(name: K, payload: DomainEvents[K]): Promise<void> {
    for (const h of this.afterHandlers.get(name) ?? []) {
      try {
        await h(payload);
      } catch (err) {
        this.log.error('event handler failed', { event: name, error: (err as Error).message });
      }
    }
  }
}
