/**
 * „Zuletzt geöffnet“: Einträge werden nur vergessen, wenn eine frisch geladene Liste bestätigt, dass es sie
 * nicht mehr gibt – nie aufgrund zwischengespeicherter (möglicherweise veralteter) Listen.
 */
import { describe, expect, test } from 'bun:test';
import { confirmedGone, type RecentEntry, recentKey } from '../../src/ui/lib/recent.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const entries: RecentEntry[] = [
  { kind: 'product', id: A },
  { kind: 'dataset', id: B },
];
const since = 1_000;

describe('confirmedGone', () => {
  test('frisch geladene Liste ohne den Eintrag: vergessen', () => {
    const gone = confirmedGone(
      entries,
      { product: { ids: new Set(), fetchedAt: 1_500, fetching: false } },
      since,
    );
    expect(gone).toEqual([recentKey({ kind: 'product', id: A })]);
  });

  test('zwischengespeicherte Liste (vor dem Öffnen geladen) ohne den Eintrag: behalten', () => {
    expect(
      confirmedGone(entries, { product: { ids: new Set(), fetchedAt: 900, fetching: false } }, since),
    ).toEqual([]);
  });

  test('Liste lädt gerade neu: behalten', () => {
    expect(
      confirmedGone(entries, { product: { ids: new Set(), fetchedAt: 1_500, fetching: true } }, since),
    ).toEqual([]);
  });

  test('Eintrag vorhanden oder Liste unbekannt: behalten', () => {
    expect(
      confirmedGone(entries, { product: { ids: new Set([A]), fetchedAt: 1_500, fetching: false } }, since),
    ).toEqual([]);
    expect(confirmedGone(entries, {}, since)).toEqual([]);
  });
});
