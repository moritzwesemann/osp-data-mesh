import { describe, expect, test } from 'bun:test';
import {
  applyRelease,
  type ConsentFact,
  conditionValueFits,
  DENY_REASONS,
  dateInZone,
  decide,
  hasConsent,
  matches,
  type ProductMeta,
  type ProductRow,
  type ReleaseDraft,
  type ReleaseRule,
  type Requester,
  releaseStatus,
  validateRelease,
  withinDataWindow,
} from '../../src/server/modules/releases/engine.ts';
import type { ColumnDef, Condition } from '../../src/shared/contract/common.ts';

const T0 = new Date('2026-06-01T10:00:00Z');
const COLS: ColumnDef[] = [
  { key: 'last_name', label: 'Nachname', type: 'string' },
  { key: 'sport', label: 'Sportart', type: 'string' },
  { key: 'birth_year', label: 'Geburtsjahr', type: 'integer' },
  { key: 'cmj_cm', label: 'CMJ', type: 'number', unit: 'cm' },
  { key: 'test_date', label: 'Testdatum', type: 'date' },
  { key: 'valid', label: 'Gültig', type: 'boolean' },
];

function product(over: Partial<ProductMeta> = {}): ProductMeta {
  return {
    id: 'p1',
    version: 3,
    status: 'active',
    category: 'performance',
    specialCategory: false,
    shareability: 'on_request',
    columns: COLS,
    ...over,
  };
}

function release(over: Partial<ReleaseRule> = {}): ReleaseRule {
  return {
    id: 'r1',
    productId: 'p1',
    productVersion: 3,
    recipient: { type: 'role', role: 'analyst' },
    purposes: ['training_steering'],
    columns: ['last_name', 'sport', 'cmj_cm'],
    rowFilter: [],
    dataFrom: null,
    dataUntil: null,
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validUntil: null,
    requiresConsent: false,
    revokedAt: null,
    ...over,
  };
}

const analyst: Requester = { type: 'user', userId: 'u1', roles: ['analyst'] };
const coach: Requester = { type: 'user', userId: 'u2', roles: ['coach'] };
const trustedPeer: Requester = { type: 'peer', peerId: 'peerB', peerStatus: 'trusted' };

function req(
  over: {
    release?: ReleaseRule | null;
    product?: ProductMeta | null;
    requester?: Requester;
    purpose?: string;
    at?: Date;
  } = {},
) {
  return {
    release: over.release === undefined ? release() : over.release,
    product: over.product === undefined ? product() : over.product,
    requester: over.requester ?? analyst,
    purpose: over.purpose ?? 'training_steering',
    at: over.at ?? T0,
  };
}

function reason(d: ReturnType<typeof decide>) {
  return d.allowed ? 'allowed' : d.reason;
}

describe('decide: grundsätzlich', () => {
  test('erlaubt passenden Empfänger mit gültiger Freigabe', () => {
    const d = decide(req());
    expect(d.allowed).toBe(true);
  });
  test('ohne Freigabe: abgelehnt (deny by default)', () => {
    expect(reason(decide(req({ release: null })))).toBe('release_not_found');
  });
  test('ohne Produkt oder bei fremdem Produkt: abgelehnt', () => {
    expect(reason(decide(req({ product: null })))).toBe('product_mismatch');
    expect(reason(decide(req({ product: product({ id: 'other' }) })))).toBe('product_mismatch');
  });
  test('jeder Ablehnungsgrund ist dokumentiert', () => {
    expect(new Set<string>(DENY_REASONS).size).toBe(DENY_REASONS.length as number);
  });
});

describe('decide: Empfänger', () => {
  test('Rolle: Person ohne die Rolle wird abgelehnt', () => {
    expect(reason(decide(req({ requester: coach })))).toBe('recipient_mismatch');
  });
  test('Rolle: Person mit mehreren Rollen inkl. der Empfängerrolle ist berechtigt', () => {
    expect(
      decide(req({ requester: { type: 'user', userId: 'u', roles: ['coach', 'analyst'] } })).allowed,
    ).toBe(true);
  });
  test('Rolle: Person ohne Rollen wird abgelehnt', () => {
    expect(reason(decide(req({ requester: { type: 'user', userId: 'u', roles: [] } })))).toBe(
      'recipient_mismatch',
    );
  });
  test('Rolle: Administration hat keinen impliziten Datenzugriff', () => {
    expect(reason(decide(req({ requester: { type: 'user', userId: 'u', roles: ['admin'] } })))).toBe(
      'recipient_mismatch',
    );
  });
  test('Rolle: Partnerknoten kann keine Rollenfreigabe nutzen', () => {
    expect(reason(decide(req({ requester: trustedPeer })))).toBe('recipient_mismatch');
  });
  test('Rolle: BI-Materialisierung kann keine Analyse-Freigabe nutzen', () => {
    expect(reason(decide(req({ requester: { type: 'bi' } })))).toBe('recipient_mismatch');
  });
  test('BI-Freigabe: nur die BI-Materialisierung, keine Personen', () => {
    const r = release({ recipient: { type: 'role', role: 'bi' }, purposes: ['reporting'] });
    expect(decide(req({ release: r, requester: { type: 'bi' }, purpose: 'reporting' })).allowed).toBe(true);
    const everyRole: Requester = {
      type: 'user',
      userId: 'u',
      roles: ['admin', 'data_steward', 'analyst', 'coach', 'auditor'],
    };
    expect(reason(decide(req({ release: r, requester: everyRole, purpose: 'reporting' })))).toBe(
      'recipient_mismatch',
    );
  });
  test('Partner: nur der benannte, vertrauenswürdige Partner', () => {
    const r = release({ recipient: { type: 'peer', peerId: 'peerB' } });
    expect(decide(req({ release: r, requester: trustedPeer })).allowed).toBe(true);
    expect(
      reason(
        decide(req({ release: r, requester: { type: 'peer', peerId: 'peerC', peerStatus: 'trusted' } })),
      ),
    ).toBe('recipient_mismatch');
    expect(reason(decide(req({ release: r, requester: analyst })))).toBe('recipient_mismatch');
  });
  test('Partner: ausstehender oder gesperrter Partner wird abgelehnt', () => {
    const r = release({ recipient: { type: 'peer', peerId: 'peerB' } });
    expect(
      reason(
        decide(req({ release: r, requester: { type: 'peer', peerId: 'peerB', peerStatus: 'pending' } })),
      ),
    ).toBe('peer_not_trusted');
    expect(
      reason(
        decide(req({ release: r, requester: { type: 'peer', peerId: 'peerB', peerStatus: 'suspended' } })),
      ),
    ).toBe('peer_not_trusted');
  });
  test('Nicht-Empfänger erfahren nichts über Widerruf oder Ablauf', () => {
    const revoked = release({ revokedAt: new Date('2026-02-01T00:00:00Z') });
    expect(reason(decide(req({ release: revoked, requester: coach })))).toBe('recipient_mismatch');
    const expired = release({ validUntil: new Date('2026-02-01T00:00:00Z') });
    expect(reason(decide(req({ release: expired, requester: coach })))).toBe('recipient_mismatch');
  });
});

describe('decide: Zeit und Widerruf', () => {
  test('widerrufen: ab Widerrufszeitpunkt abgelehnt', () => {
    expect(reason(decide(req({ release: release({ revokedAt: T0 }) })))).toBe('revoked');
    expect(reason(decide(req({ release: release({ revokedAt: new Date('2026-05-01T00:00:00Z') }) })))).toBe(
      'revoked',
    );
  });
  test('Widerruf wirkt nicht rückwirkend auf frühere Zeitpunkte', () => {
    expect(decide(req({ release: release({ revokedAt: new Date(T0.getTime() + 1) }) })).allowed).toBe(true);
  });
  test('noch nicht gültig', () => {
    expect(reason(decide(req({ release: release({ validFrom: new Date(T0.getTime() + 1) }) })))).toBe(
      'not_yet_valid',
    );
  });
  test('gültig ab genau validFrom', () => {
    expect(decide(req({ release: release({ validFrom: T0 }) })).allowed).toBe(true);
  });
  test('abgelaufen: validUntil ist exklusiv', () => {
    expect(reason(decide(req({ release: release({ validUntil: T0 }) })))).toBe('expired');
    expect(decide(req({ release: release({ validUntil: new Date(T0.getTime() + 1) }) })).allowed).toBe(true);
  });
  test('Widerruf hat Vorrang vor Ablauf', () => {
    const r = release({
      revokedAt: new Date('2026-03-01T00:00:00Z'),
      validUntil: new Date('2026-04-01T00:00:00Z'),
    });
    expect(reason(decide(req({ release: r })))).toBe('revoked');
  });
});

describe('decide: Produkt', () => {
  test('stillgelegtes Produkt', () => {
    expect(reason(decide(req({ product: product({ status: 'retired' }) })))).toBe('product_inactive');
  });
  test('geänderte Produktversion erfordert neue Freigabe', () => {
    expect(reason(decide(req({ product: product({ version: 4 }) })))).toBe('product_changed');
  });
  test('internes Produkt: nie an Partner', () => {
    const r = release({ recipient: { type: 'peer', peerId: 'peerB' } });
    expect(
      reason(
        decide(req({ release: r, requester: trustedPeer, product: product({ shareability: 'internal' }) })),
      ),
    ).toBe('not_shareable');
  });
  test('internes Produkt: lokale Rollen erlaubt', () => {
    expect(decide(req({ product: product({ shareability: 'internal' }) })).allowed).toBe(true);
  });
});

describe('decide: Zweckbindung', () => {
  test('nicht freigegebener Zweck', () => {
    expect(reason(decide(req({ purpose: 'research' })))).toBe('purpose_not_allowed');
  });
  test('leerer Zweck', () => {
    expect(reason(decide(req({ purpose: '' })))).toBe('purpose_not_allowed');
  });
  test('einer von mehreren Zwecken', () => {
    const r = release({ purposes: ['training_steering', 'performance_diagnostics'] });
    expect(decide(req({ release: r, purpose: 'performance_diagnostics' })).allowed).toBe(true);
  });
  test('Zweck "*" in der Freigabe ist kein Platzhalter', () => {
    expect(reason(decide(req({ release: release({ purposes: ['*'] }), purpose: 'research' })))).toBe(
      'purpose_not_allowed',
    );
  });
});

describe('decide: besondere Kategorien und Spalten', () => {
  test('Gesundheitsdaten ohne Einwilligungspflicht werden nie herausgegeben', () => {
    const p = product({ specialCategory: true, category: 'health' });
    expect(reason(decide(req({ product: p })))).toBe('special_category_requires_consent');
    expect(decide(req({ product: p, release: release({ requiresConsent: true }) })).allowed).toBe(true);
  });
  test('Spalten: Schnittmenge in Produktreihenfolge', () => {
    const d = decide(req({ release: release({ columns: ['cmj_cm', 'last_name', 'unknown'] }) }));
    expect(d.allowed && d.columns.map((c) => c.key)).toEqual(['last_name', 'cmj_cm']);
  });
  test('Spalten: keine Überschneidung → abgelehnt', () => {
    expect(reason(decide(req({ release: release({ columns: ['gone'] }) })))).toBe('no_columns');
  });
  test('neue Produktspalten sind nicht automatisch freigegeben', () => {
    const p = product({ columns: [...COLS, { key: 'injury', label: 'Verletzung', type: 'string' }] });
    const d = decide(req({ product: p }));
    expect(d.allowed && d.columns.some((c) => c.key === 'injury')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

function row(
  athleteId: string | null,
  values: Record<string, string | number | boolean | null>,
  observedAt: string | null = '2026-03-15',
): ProductRow {
  return { athleteId, observedAt, values };
}

const ROWS: ProductRow[] = [
  row('a1', {
    last_name: 'Adler',
    sport: 'Rudern',
    birth_year: 2003,
    cmj_cm: 41.5,
    test_date: '2026-03-15',
    valid: true,
  }),
  row(
    'a2',
    {
      last_name: 'Berg',
      sport: 'Kanu',
      birth_year: 2005,
      cmj_cm: 38.0,
      test_date: '2026-04-20',
      valid: true,
    },
    '2026-04-20',
  ),
  row(
    'a3',
    {
      last_name: 'Conrad',
      sport: 'Rudern',
      birth_year: 2001,
      cmj_cm: null,
      test_date: '2025-12-01',
      valid: false,
    },
    '2025-12-01',
  ),
  row(
    'a4',
    {
      last_name: 'Dorn',
      sport: 'Leichtathletik',
      birth_year: 2004,
      cmj_cm: 52.3,
      test_date: null,
      valid: true,
    },
    null,
  ),
];

function apply(
  over: {
    release?: Partial<ReleaseRule>;
    product?: Partial<ProductMeta>;
    consents?: ConsentFact[];
    purpose?: string;
    at?: Date;
    rows?: ProductRow[];
  } = {},
) {
  const r = release(over.release);
  const p = product(over.product);
  const d = decide({
    release: r,
    product: p,
    requester: r.recipient.type === 'peer' ? trustedPeer : analyst,
    purpose: over.purpose ?? r.purposes[0]!,
    at: over.at ?? T0,
  });
  const columns = d.allowed ? d.columns : p.columns.filter((c) => r.columns.includes(c.key));
  return applyRelease({
    release: r,
    product: p,
    columns,
    rows: over.rows ?? ROWS,
    consents: over.consents ?? [],
    purpose: over.purpose ?? r.purposes[0]!,
    at: over.at ?? T0,
  });
}

describe('applyRelease: Spalten', () => {
  test('nur freigegebene Spalten werden ausgeliefert', () => {
    const { rows } = apply();
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(Object.keys(r.values).sort()).toEqual(['cmj_cm', 'last_name', 'sport']);
    expect(rows.some((r) => 'birth_year' in r.values)).toBe(false);
  });
  test('fehlende Werte werden als null ausgegeben', () => {
    const { rows } = apply({ rows: [row('a9', { last_name: 'X' })] });
    expect(rows[0]!.values).toEqual({ last_name: 'X', sport: null, cmj_cm: null });
  });
});

describe('applyRelease: Datenzeitraum', () => {
  test('nur ab dataFrom (inklusive)', () => {
    const { rows, stats } = apply({ release: { dataFrom: '2026-03-15' } });
    expect(rows.map((r) => r.athleteId)).toEqual(['a1', 'a2']);
    expect(stats.excludedByTime).toBe(2); // a3 zu alt, a4 ohne Datum
  });
  test('nur bis dataUntil (inklusive)', () => {
    const { rows } = apply({ release: { dataUntil: '2026-03-15' } });
    expect(rows.map((r) => r.athleteId)).toEqual(['a1', 'a3']);
  });
  test('Zeitfenster beidseitig', () => {
    const { rows } = apply({ release: { dataFrom: '2026-01-01', dataUntil: '2026-03-31' } });
    expect(rows.map((r) => r.athleteId)).toEqual(['a1']);
  });
  test('Zeilen ohne Datum sind bei Zeitfenster ausgeschlossen', () => {
    expect(withinDataWindow(null, '2020-01-01', null)).toBe(false);
    expect(withinDataWindow(null, null, null)).toBe(true);
  });
  test('Zeitstempel werden auf das Datum reduziert, ungültige ausgeschlossen', () => {
    expect(withinDataWindow('2026-03-15T23:59:00Z', '2026-03-15', '2026-03-15')).toBe(true);
    expect(withinDataWindow('15.03.2026', '2026-01-01', null)).toBe(false);
  });
});

describe('applyRelease: Zeilenbeschränkung', () => {
  test('Filter auf nicht freigegebene Spalte ist möglich, Spalte bleibt verborgen', () => {
    const { rows } = apply({ release: { rowFilter: [{ column: 'birth_year', op: 'gte', value: 2003 }] } });
    expect(rows.map((r) => r.athleteId)).toEqual(['a1', 'a2', 'a4']);
    expect(rows.some((r) => 'birth_year' in r.values)).toBe(false);
  });
  test('mehrere Bedingungen sind UND-verknüpft', () => {
    const { rows, stats } = apply({
      release: {
        rowFilter: [
          { column: 'sport', op: 'eq', value: 'Rudern' },
          { column: 'valid', op: 'eq', value: true },
        ],
      },
    });
    expect(rows.map((r) => r.athleteId)).toEqual(['a1']);
    expect(stats.excludedByFilter).toBe(3);
  });
  test('Statistik ist vollständig', () => {
    const { stats } = apply({
      release: { dataFrom: '2026-01-01', rowFilter: [{ column: 'sport', op: 'eq', value: 'Kanu' }] },
    });
    expect(stats.total).toBe(
      stats.returned + stats.excludedByFilter + stats.excludedByTime + stats.excludedByConsent,
    );
    expect(stats).toEqual({
      total: 4,
      returned: 1,
      excludedByFilter: 1,
      excludedByTime: 2,
      excludedByConsent: 0,
    });
  });
});

describe('matches: Operatoren', () => {
  const v = { s: 'Rudern', n: 41.5, i: 3, b: true, d: '2026-03-15', z: null };
  const cases: [Condition, boolean][] = [
    [{ column: 's', op: 'eq', value: 'Rudern' }, true],
    [{ column: 's', op: 'eq', value: 'rudern' }, false],
    [{ column: 's', op: 'neq', value: 'Kanu' }, true],
    [{ column: 's', op: 'neq', value: 'Rudern' }, false],
    [{ column: 's', op: 'in', value: ['Kanu', 'Rudern'] }, true],
    [{ column: 's', op: 'in', value: ['Kanu'] }, false],
    [{ column: 's', op: 'nin', value: ['Kanu'] }, true],
    [{ column: 's', op: 'nin', value: ['Rudern'] }, false],
    [{ column: 'n', op: 'gt', value: 41 }, true],
    [{ column: 'n', op: 'gt', value: 41.5 }, false],
    [{ column: 'n', op: 'gte', value: 41.5 }, true],
    [{ column: 'n', op: 'lt', value: 41.5 }, false],
    [{ column: 'n', op: 'lte', value: 41.5 }, true],
    [{ column: 'd', op: 'gte', value: '2026-03-01' }, true],
    [{ column: 'd', op: 'lt', value: '2026-03-01' }, false],
    [{ column: 'b', op: 'eq', value: true }, true],
    [{ column: 'b', op: 'gt', value: false }, false],
    [{ column: 'z', op: 'is_null' }, true],
    [{ column: 's', op: 'is_null' }, false],
    [{ column: 'z', op: 'not_null' }, false],
    [{ column: 's', op: 'not_null' }, true],
    // null erfüllt nur is_null
    [{ column: 'z', op: 'eq', value: null }, false],
    [{ column: 'z', op: 'neq', value: 'x' }, false],
    [{ column: 'z', op: 'nin', value: ['x'] }, false],
    [{ column: 'z', op: 'lt', value: 5 }, false],
    // fehlende Spalte erfüllt nichts
    [{ column: 'missing', op: 'is_null' }, false],
    [{ column: 'missing', op: 'neq', value: 'x' }, false],
    [{ column: 'missing', op: 'not_null' }, false],
    // Typfremde Vergleiche sind nie wahr
    [{ column: 'i', op: 'eq', value: '3' }, false],
    [{ column: 'i', op: 'neq', value: '3' }, false],
    [{ column: 'i', op: 'gt', value: '1' }, false],
    [{ column: 's', op: 'in', value: 'Rudern' }, false],
    [{ column: 's', op: 'eq', value: ['Rudern'] }, false],
    [{ column: 'i', op: 'in', value: ['3'] }, false],
  ];
  for (const [cond, expected] of cases) {
    test(`${cond.column} ${cond.op} ${JSON.stringify(cond.value)} → ${expected}`, () => {
      expect(matches(v, cond)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------------------------

function consent(over: Partial<ConsentFact> = {}): ConsentFact {
  return {
    athleteId: 'a1',
    purpose: 'medical_care',
    dataCategory: 'health',
    status: 'granted',
    validFrom: '2026-01-01',
    validUntil: null,
    ...over,
  };
}

describe('applyRelease: Einwilligung', () => {
  const health = { category: 'health' as const, specialCategory: true };
  const rel = { requiresConsent: true, purposes: ['medical_care'] };

  test('ohne Einwilligungspflicht (nicht besondere Kategorie): alle Zeilen', () => {
    expect(apply().rows).toHaveLength(4);
  });
  test('Einwilligungspflicht ohne erfasste Einwilligungen: keine Zeilen', () => {
    const { rows, stats } = apply({ product: health, release: rel });
    expect(rows).toHaveLength(0);
    expect(stats.excludedByConsent).toBe(4);
  });
  test('nur Personen mit gültiger Einwilligung für Zweck und Kategorie', () => {
    const { rows } = apply({
      product: health,
      release: rel,
      consents: [consent(), consent({ athleteId: 'a3' })],
    });
    expect(rows.map((r) => r.athleteId)).toEqual(['a1', 'a3']);
  });
  test('Einwilligung für anderen Zweck zählt nicht', () => {
    expect(
      apply({ product: health, release: rel, consents: [consent({ purpose: 'research' })] }).rows,
    ).toHaveLength(0);
  });
  test('Einwilligung für andere Kategorie zählt nicht', () => {
    expect(
      apply({ product: health, release: rel, consents: [consent({ dataCategory: 'performance' })] }).rows,
    ).toHaveLength(0);
  });
  test('Platzhalter * für Zweck und Kategorie', () => {
    expect(
      apply({ product: health, release: rel, consents: [consent({ purpose: '*', dataCategory: '*' })] }).rows,
    ).toHaveLength(1);
  });
  test('widerrufene Einwilligung zählt nicht', () => {
    expect(
      apply({ product: health, release: rel, consents: [consent({ status: 'withdrawn' })] }).rows,
    ).toHaveLength(0);
  });
  test('widerrufene und weitere gültige Einwilligung: gültige zählt', () => {
    const cs = [consent({ status: 'withdrawn' }), consent({ purpose: '*' })];
    expect(apply({ product: health, release: rel, consents: cs }).rows).toHaveLength(1);
  });
  test('Einwilligung noch nicht gültig', () => {
    expect(
      apply({ product: health, release: rel, consents: [consent({ validFrom: '2026-06-02' })] }).rows,
    ).toHaveLength(0);
  });
  test('Einwilligung abgelaufen; Enddatum inklusive', () => {
    expect(
      apply({ product: health, release: rel, consents: [consent({ validUntil: '2026-05-31' })] }).rows,
    ).toHaveLength(0);
    expect(
      apply({ product: health, release: rel, consents: [consent({ validUntil: '2026-06-01' })] }).rows,
    ).toHaveLength(1);
  });
  test('Zeile ohne Personenbezug kann Einwilligung nicht nachweisen', () => {
    const rows = [row(null, { last_name: 'Anonym' })];
    expect(apply({ product: health, release: rel, rows, consents: [consent()] }).rows).toHaveLength(0);
  });
  test('Einwilligungspflicht auch bei nicht besonderer Kategorie, wenn Freigabe sie verlangt', () => {
    const { rows } = apply({
      release: { requiresConsent: true },
      consents: [consent({ purpose: 'training_steering', dataCategory: 'performance', athleteId: 'a2' })],
    });
    expect(rows.map((r) => r.athleteId)).toEqual(['a2']);
  });
  test('besondere Kategorie: Einwilligung wird auch ohne Freigabe-Flag erzwungen (Verteidigung in der Tiefe)', () => {
    const { rows } = apply({
      product: health,
      release: { requiresConsent: false, purposes: ['medical_care'] },
    });
    expect(rows).toHaveLength(0);
  });
  test('Stichtag in Europe/Berlin: 31.03. 22:30 UTC ist bereits der 01.04.', () => {
    const at = new Date('2026-03-31T22:30:00Z');
    expect(dateInZone(at, 'Europe/Berlin')).toBe('2026-04-01');
    expect(
      hasConsent(
        [consent({ validFrom: '2026-04-01' })],
        'medical_care',
        'health',
        dateInZone(at, 'Europe/Berlin'),
      ),
    ).toBe(true);
    const r = apply({
      product: health,
      release: { ...rel, validFrom: new Date('2026-01-01T00:00:00Z') },
      consents: [consent({ validFrom: '2026-04-01' })],
      at,
    });
    expect(r.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

function draft(over: Partial<ReleaseDraft> = {}): ReleaseDraft {
  return {
    recipient: { type: 'role', role: 'analyst' },
    purposes: ['training_steering'],
    columns: ['last_name', 'cmj_cm'],
    rowFilter: [],
    dataFrom: null,
    dataUntil: null,
    validFrom: T0,
    validUntil: null,
    requiresConsent: false,
    ...over,
  };
}
const PURPOSES = ['training_steering', 'medical_care', 'reporting'];
const codes = (d: ReleaseDraft, p: ProductMeta = product()) =>
  validateRelease(d, p, PURPOSES).map((i) => i.code);

describe('validateRelease', () => {
  test('gültige Freigabe', () => {
    expect(codes(draft())).toEqual([]);
  });
  test('unbekannte Spalte', () => {
    expect(codes(draft({ columns: ['nope'] }))).toEqual(['unknown_column']);
  });
  test('Filter auf unbekannte Spalte', () => {
    expect(codes(draft({ rowFilter: [{ column: 'x', op: 'eq', value: 1 }] }))).toEqual([
      'unknown_filter_column',
    ]);
  });
  test('Filterwert passt nicht zum Spaltentyp', () => {
    expect(codes(draft({ rowFilter: [{ column: 'birth_year', op: 'eq', value: '2003' }] }))).toEqual([
      'invalid_filter_value',
    ]);
    expect(codes(draft({ rowFilter: [{ column: 'birth_year', op: 'eq', value: 2003.5 }] }))).toEqual([
      'invalid_filter_value',
    ]);
    expect(codes(draft({ rowFilter: [{ column: 'sport', op: 'in', value: [] }] }))).toEqual([
      'invalid_filter_value',
    ]);
    expect(codes(draft({ rowFilter: [{ column: 'valid', op: 'gt', value: true }] }))).toEqual([
      'invalid_filter_value',
    ]);
    expect(codes(draft({ rowFilter: [{ column: 'test_date', op: 'gte', value: '01.01.2026' }] }))).toEqual([
      'invalid_filter_value',
    ]);
    expect(codes(draft({ rowFilter: [{ column: 'sport', op: 'eq', value: ['Rudern'] }] }))).toEqual([
      'invalid_filter_value',
    ]);
  });
  test('gültige Filterwerte', () => {
    const f: Condition[] = [
      { column: 'birth_year', op: 'in', value: [2003, 2004] },
      { column: 'cmj_cm', op: 'gt', value: 30.5 },
      { column: 'test_date', op: 'gte', value: '2026-01-01' },
      { column: 'valid', op: 'eq', value: true },
      { column: 'sport', op: 'is_null' },
    ];
    expect(codes(draft({ rowFilter: f }))).toEqual([]);
  });
  test('besondere Kategorie verlangt Einwilligungspflicht', () => {
    expect(codes(draft(), product({ specialCategory: true, category: 'health' }))).toEqual([
      'special_category_requires_consent',
    ]);
    expect(
      codes(draft({ requiresConsent: true }), product({ specialCategory: true, category: 'health' })),
    ).toEqual([]);
  });
  test('internes Produkt nicht an Partner', () => {
    expect(
      codes(draft({ recipient: { type: 'peer', peerId: 'p' } }), product({ shareability: 'internal' })),
    ).toEqual(['not_shareable']);
  });
  test('BI-Freigabe mit genau einem Zweck', () => {
    expect(
      codes(draft({ recipient: { type: 'role', role: 'bi' }, purposes: ['reporting', 'training_steering'] })),
    ).toEqual(['bi_requires_single_purpose']);
    expect(codes(draft({ recipient: { type: 'role', role: 'bi' }, purposes: ['reporting'] }))).toEqual([]);
  });
  test('unbekannter Zweck', () => {
    expect(codes(draft({ purposes: ['marketing'] }))).toEqual(['unknown_purpose']);
  });
  test('Zeitfenster', () => {
    expect(codes(draft({ validUntil: T0 }))).toEqual(['invalid_time_window']);
    expect(codes(draft({ dataFrom: '2026-02-01', dataUntil: '2026-01-01' }))).toEqual([
      'invalid_data_window',
    ]);
  });
  test('stillgelegtes Produkt', () => {
    expect(codes(draft(), product({ status: 'retired' }))).toEqual(['product_inactive']);
  });
  test('is_null mit Wert ist ungültig', () => {
    expect(conditionValueFits({ column: 'x', op: 'is_null', value: 'a' }, 'string')).toBe(false);
  });
});

describe('releaseStatus', () => {
  test('alle Zustände', () => {
    expect(releaseStatus(release(), 3, T0)).toBe('active');
    expect(releaseStatus(release(), 4, T0)).toBe('outdated');
    expect(releaseStatus(release({ revokedAt: T0 }), 3, T0)).toBe('revoked');
    expect(releaseStatus(release({ validUntil: T0 }), 3, T0)).toBe('expired');
    expect(releaseStatus(release({ validFrom: new Date(T0.getTime() + 1000) }), 3, T0)).toBe('scheduled');
  });
});

// ---------------------------------------------------------------------------------------------
// Eigenschaftsbasierter Test: Für zufällige Freigaben und Daten gelten immer die Invarianten.
// ---------------------------------------------------------------------------------------------

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('Invarianten (zufallsbasiert, 500 Durchläufe)', () => {
  test('nie mehr Spalten, Zeilen oder Personen als erlaubt', () => {
    const rnd = prng(42);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const sports = ['Rudern', 'Kanu', 'Leichtathletik'];
    const purposes = ['training_steering', 'medical_care', 'research'];
    for (let iter = 0; iter < 500; iter++) {
      const rows: ProductRow[] = Array.from({ length: 30 }, (_, i) => ({
        athleteId: rnd() < 0.1 ? null : `a${i % 12}`,
        observedAt: rnd() < 0.1 ? null : `2026-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`,
        values: {
          last_name: `N${i}`,
          sport: rnd() < 0.1 ? null : pick(sports),
          birth_year: 1998 + Math.floor(rnd() * 10),
          cmj_cm: rnd() < 0.2 ? null : Math.round(rnd() * 600) / 10,
          test_date: null,
          valid: rnd() < 0.5,
        },
      }));
      const consents: ConsentFact[] = Array.from({ length: 10 }, () => ({
        athleteId: `a${Math.floor(rnd() * 12)}`,
        purpose: rnd() < 0.2 ? '*' : pick(purposes),
        dataCategory: rnd() < 0.5 ? '*' : pick(['performance', 'health']),
        status: rnd() < 0.3 ? 'withdrawn' : 'granted',
        validFrom: '2026-01-01',
        validUntil: rnd() < 0.3 ? '2026-03-01' : null,
      }));
      const p = product({ specialCategory: rnd() < 0.3, category: rnd() < 0.5 ? 'health' : 'performance' });
      const releasedCols = COLS.map((c) => c.key).filter(() => rnd() < 0.5);
      const filter: Condition[] = rnd() < 0.5 ? [{ column: 'sport', op: 'eq', value: pick(sports) }] : [];
      if (rnd() < 0.3) filter.push({ column: 'cmj_cm', op: 'gte', value: 30 });
      const r = release({
        columns: releasedCols.length ? releasedCols : ['last_name'],
        rowFilter: filter,
        requiresConsent: rnd() < 0.5,
        dataFrom: rnd() < 0.3 ? '2026-03-01' : null,
        dataUntil: rnd() < 0.3 ? '2026-06-30' : null,
        purposes: [pick(purposes)],
      });
      const purpose = pick(purposes);
      const d = decide({ release: r, product: p, requester: analyst, purpose, at: T0 });
      if (!d.allowed) {
        if (purpose !== r.purposes[0]) expect(d.reason).toBe('purpose_not_allowed');
        continue;
      }
      const res = applyRelease({
        release: r,
        product: p,
        columns: d.columns,
        rows,
        consents,
        purpose,
        at: T0,
      });
      const today = dateInZone(T0, 'Europe/Berlin');
      expect(res.stats.total).toBe(
        res.stats.returned +
          res.stats.excludedByConsent +
          res.stats.excludedByFilter +
          res.stats.excludedByTime,
      );
      for (const out of res.rows) {
        for (const k of Object.keys(out.values)) expect(r.columns).toContain(k);
        const src = rows.find(
          (x) => x.values.last_name === out.values.last_name || x.athleteId === out.athleteId,
        )!;
        expect(src).toBeDefined();
        if (r.requiresConsent || p.specialCategory) {
          expect(out.athleteId).not.toBeNull();
          expect(
            hasConsent(
              consents.filter((c) => c.athleteId === out.athleteId),
              purpose,
              p.category,
              today,
            ),
          ).toBe(true);
        }
      }
      for (const src of rows) {
        const passes =
          withinDataWindow(src.observedAt, r.dataFrom, r.dataUntil) &&
          r.rowFilter.every((c) => matches(src.values, c)) &&
          (!(r.requiresConsent || p.specialCategory) ||
            (src.athleteId !== null &&
              hasConsent(
                consents.filter((c) => c.athleteId === src.athleteId),
                purpose,
                p.category,
                today,
              )));
        const count = rows.filter((x) => x === src).length;
        expect(count).toBe(1);
        if (!passes) {
          // eine ausgeschlossene Zeile darf nicht ausgeliefert werden
          const leaked = res.rows.filter(
            (o) =>
              o.athleteId === src.athleteId &&
              (!('last_name' in o.values) || o.values.last_name === src.values.last_name),
          );
          if ('last_name' in (res.rows[0]?.values ?? {})) expect(leaked).toHaveLength(0);
        }
      }
    }
  });
});
