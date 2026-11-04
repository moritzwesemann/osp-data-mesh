/**
 * Mock eines fiktiven Sprung-/Kraftmessplatten-Systems ("Messsystem") als API-Quelle für Demo und Tests.
 *
 *   bun scripts/mock-measurement-api.ts            → http://127.0.0.1:4410 (MOCK_API_PORT)
 *
 *   GET /v1/health
 *   GET /v1/measurements?page=1&page_size=50&since=YYYY-MM-DD
 *       Authorization: Bearer <MOCK_API_TOKEN, Standard "demo-messsystem-token">
 *       → { data: [{ measurement_id, athlete: { external_id, display_name }, test_type, jump_height_cm,
 *            peak_power_w, contact_time_ms | null, measured_at }], meta: { page, page_size, total, next_page } }
 *
 * Die Messungen sind deterministisch (fester Startwert, festes Bezugsdatum) und gehören zu den
 * synthetischen Athletinnen und Athleten von osp-nord (fixtures/osp-nord/athleten.csv).
 * Drei Einträge sind absichtlich fehlerhaft (unbekannte Kennung, Sprunghöhe 250 cm, unbekannte Testart).
 */
import { nordAthletes, Rng } from './generate-fixtures.ts';

export const DEFAULT_TOKEN = 'demo-messsystem-token';
/** Bezugsdatum: Messungen liegen in den 12 Monaten davor */
export const REFERENCE_DATE = '2026-10-30';

export interface Measurement {
  measurement_id: string;
  athlete: { external_id: string; display_name: string };
  test_type: string;
  jump_height_cm: number;
  peak_power_w: number;
  contact_time_ms: number | null;
  measured_at: string;
}

export const BAD_MEASUREMENTS = {
  unknownAthlete: 'NORD-0999',
  jumpHeight: 250,
  testType: 'BJ',
} as const;

export function generateMeasurements(referenceDate = REFERENCE_DATE): Measurement[] {
  const rng = new Rng(20261030);
  const athletes = nordAthletes();
  const end = Date.parse(`${referenceDate}T00:00:00Z`);
  const items: Omit<Measurement, 'measurement_id'>[] = [];
  for (let i = 0; i < 120; i++) {
    const a = athletes[i % athletes.length]!;
    const testType = rng.pick(['CMJ', 'CMJ', 'SJ', 'DJ'] as const);
    const female = a.sex === 'w';
    const base = testType === 'CMJ' ? 38 : testType === 'SJ' ? 34 : 30;
    const height = rng.float(base - 10, base + 14) - (female ? 6 : 0);
    const dayOffset = rng.int(0, 364);
    const minutes = rng.int(7 * 60, 18 * 60);
    const at = new Date(end - dayOffset * 86_400_000 + minutes * 60_000);
    items.push({
      athlete: { external_id: a.externalId, display_name: `${a.firstName} ${a.lastName}` },
      test_type: testType,
      jump_height_cm: Math.round(height * 10) / 10,
      peak_power_w: Math.round(rng.float(female ? 1800 : 2600, female ? 3800 : 5600)),
      contact_time_ms: testType === 'DJ' ? rng.int(150, 290) : null,
      measured_at: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
  }
  // absichtlich fehlerhafte Einträge
  const sample = (i: number) => ({ ...items[i]! });
  items.push({
    ...sample(3),
    athlete: { external_id: BAD_MEASUREMENTS.unknownAthlete, display_name: 'Unbekannt' },
  });
  items.push({ ...sample(7), jump_height_cm: BAD_MEASUREMENTS.jumpHeight });
  items.push({ ...sample(11), test_type: BAD_MEASUREMENTS.testType });
  items.sort((x, y) => x.measured_at.localeCompare(y.measured_at));
  return items.map((m, i) => ({ measurement_id: `SPR-${String(i + 1).padStart(5, '0')}`, ...m }));
}

export interface MockApiOptions {
  token?: string;
  referenceDate?: string;
  measurements?: Measurement[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** fetch-Handler (für Tests über TestMesh.routes oder als Bun.serve-Handler) */
export function createMockMeasurementApi(opts: MockApiOptions = {}): (req: Request) => Response {
  const token = opts.token ?? DEFAULT_TOKEN;
  const all = opts.measurements ?? generateMeasurements(opts.referenceDate);
  return (req: Request) => {
    const url = new URL(req.url);
    if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (url.pathname === '/v1/health') return json({ status: 'ok', system: 'Messsystem (Mock)' });
    if (url.pathname !== '/v1/measurements') return json({ error: 'not_found' }, 404);
    if (req.headers.get('authorization') !== `Bearer ${token}`) return json({ error: 'unauthorized' }, 401);
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('page_size') ?? '50');
    const since = url.searchParams.get('since');
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 200
    ) {
      return json({ error: 'invalid_paging' }, 400);
    }
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return json({ error: 'invalid_since' }, 400);
    const filtered = since ? all.filter((m) => m.measured_at.slice(0, 10) >= since) : all;
    const start = (page - 1) * pageSize;
    const data = filtered.slice(start, start + pageSize);
    return json({
      data,
      meta: {
        page,
        page_size: pageSize,
        total: filtered.length,
        next_page: start + pageSize < filtered.length ? page + 1 : null,
      },
    });
  };
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_API_PORT ?? 4410);
  const token = process.env.MOCK_API_TOKEN ?? DEFAULT_TOKEN;
  const handler = createMockMeasurementApi({ token });
  const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: handler });
  console.log(`Mock-Messsystem: http://127.0.0.1:${server.port}/v1/measurements (Bearer-Token: ${token})`);
}
