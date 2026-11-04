/**
 * Welche Lieferungen erfasst ein Einwilligungswiderruf? Maßgeblich ist die Einstufung bei der Lieferung
 * (exchange_log.data_category, consent_applied), nicht die heutige des Datensatzes.
 */
import { describe, expect, test } from 'bun:test';
import { consentWithdrawalCovers } from '../../src/server/modules/federation/outbox.ts';

const delivered = {
  purpose: 'training_steering',
  data_category: 'performance',
  consent_applied: true,
  // heutiger Stand (nach Neueinstufung)
  requires_consent: true,
  source_type: 'dataset',
  category: 'training',
  special_category: false,
};

describe('consentWithdrawalCovers', () => {
  test('Kategorie wie geliefert, nicht wie heute', () => {
    expect(
      consentWithdrawalCovers({ purpose: 'training_steering', dataCategory: 'performance' }, delivered),
    ).toBe(true);
    expect(
      consentWithdrawalCovers({ purpose: 'training_steering', dataCategory: 'training' }, delivered),
    ).toBe(false);
  });

  test('Zweck wie geliefert; * erfasst jeden Zweck bzw. jede Kategorie', () => {
    expect(consentWithdrawalCovers({ purpose: 'research', dataCategory: '*' }, delivered)).toBe(false);
    expect(consentWithdrawalCovers({ purpose: '*', dataCategory: 'performance' }, delivered)).toBe(true);
    expect(consentWithdrawalCovers({ purpose: 'training_steering', dataCategory: '*' }, delivered)).toBe(
      true,
    );
    expect(consentWithdrawalCovers({ purpose: '*', dataCategory: '*' }, delivered)).toBe(true);
  });

  test('ohne Einwilligungsbezug bei der Lieferung: kein Widerruf (auch wenn die Freigabe heute einen hätte)', () => {
    expect(
      consentWithdrawalCovers({ purpose: '*', dataCategory: '*' }, { ...delivered, consent_applied: false }),
    ).toBe(false);
  });

  test('Lieferungen ohne diese Angaben: heutige Einstufung, unbekannt → im Zweifel erfasst', () => {
    const legacy = { ...delivered, data_category: null, consent_applied: null };
    expect(consentWithdrawalCovers({ purpose: 'training_steering', dataCategory: 'training' }, legacy)).toBe(
      true,
    );
    expect(
      consentWithdrawalCovers({ purpose: 'training_steering', dataCategory: 'performance' }, legacy),
    ).toBe(false);
    expect(
      consentWithdrawalCovers(
        { purpose: 'training_steering', dataCategory: 'performance' },
        { ...legacy, requires_consent: false },
      ),
    ).toBe(false);
    const unknown = {
      ...legacy,
      requires_consent: null,
      source_type: null,
      category: null,
      special_category: null,
    };
    expect(consentWithdrawalCovers({ purpose: 'training_steering', dataCategory: 'health' }, unknown)).toBe(
      true,
    );
    expect(
      consentWithdrawalCovers(
        { purpose: 'training_steering', dataCategory: 'master' },
        { ...legacy, source_type: 'athletes', category: null },
      ),
    ).toBe(true);
  });
});
