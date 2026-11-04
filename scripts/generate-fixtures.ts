/**
 * Erzeugt die synthetischen Demo-Daten unter fixtures/ (deterministisch, fester Startwert).
 *
 *   bun scripts/generate-fixtures.ts
 *
 * Alle Personen sind frei erfunden (Zufallskombinationen häufiger deutscher Vor- und Nachnamen);
 * Vereine und Knoten ("osp-nord", "osp-mitte", "osp-sued") sind fiktiv.
 * Das Mock-Messsystem (scripts/mock-measurement-api.ts) nutzt dieselben Athletendaten.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const FIXTURES_DIR = resolve(import.meta.dir, '..', 'fixtures');

// ---------------------------------------------------------------------------------------------
// Zufall (deterministisch)
// ---------------------------------------------------------------------------------------------

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = prng(seed);
  }
  float(min = 0, max = 1): number {
    return min + (max - min) * this.next();
  }
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------------------------------------
// Vokabular
// ---------------------------------------------------------------------------------------------

// biome-ignore format: kompakte Namenslisten
const LAST_NAMES = [
  'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Koch',
  'Bauer', 'Richter', 'Klein', 'Wolf', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Hartmann', 'Lange',
  'Werner', 'Krause', 'Lehmann', 'Schulze', 'Maier', 'Walter', 'Huber', 'Kaiser', 'Fuchs', 'Peters',
  'Scholz', 'Jung', 'Hahn', 'Vogel', 'Keller', 'Frank', 'Berger', 'Winkler', 'Roth', 'Beck',
  'Lorenz', 'Baumann', 'Albrecht', 'Schuster', 'Ludwig', 'Winter', 'Sommer', 'Brandt', 'Haas', 'Graf',
];
// biome-ignore format: kompakte Namenslisten
const LAST_NAMES_UMLAUT = [
  'Müller', 'Schäfer', 'Krüger', 'Köhler', 'Weiß', 'Groß', 'Jäger', 'Böhm', 'Möller', 'Günther',
  'König', 'Krämer', 'Kühn', 'Schröder', 'Bäumer', 'Fröhlich', 'Gärtner', 'Härtel', 'Hölzle', 'Süß',
];
// biome-ignore format: kompakte Namenslisten
const FIRST_NAMES_F = [
  'Anna', 'Lena', 'Lea', 'Laura', 'Julia', 'Sarah', 'Lisa', 'Hannah', 'Marie', 'Sophie',
  'Emma', 'Mia', 'Leonie', 'Johanna', 'Paula', 'Clara', 'Jana', 'Katharina', 'Charlotte', 'Amelie',
  'Nele', 'Greta', 'Maja', 'Zoë', 'Lotta',
];
// biome-ignore format: kompakte Namenslisten
const FIRST_NAMES_M = [
  'Lukas', 'Leon', 'Finn', 'Jonas', 'Paul', 'Luis', 'Felix', 'Noah', 'Elias', 'Ben',
  'Maximilian', 'Tim', 'Niklas', 'Jan', 'Moritz', 'David', 'Simon', 'Tobias', 'Fabian', 'Julian',
  'Philipp', 'Erik', 'Hannes', 'Jakob', 'Sören', 'Björn', 'Jörg', 'Jürgen',
];

export const SPORTS: Record<string, readonly string[]> = {
  Rudern: ['Einer', 'Doppelzweier', 'Leichtgewichts-Doppelzweier', 'Achter'],
  'Kanu-Rennsport': ['K1 500 m', 'K2 500 m', 'C1 1000 m'],
  Leichtathletik: ['100 m', '400 m Hürden', 'Weitsprung', 'Hochsprung', '1500 m', 'Speerwurf'],
  Schwimmen: ['100 m Freistil', '200 m Brust', '100 m Rücken', '400 m Lagen'],
  Radsport: ['Bahn Sprint', 'Straße', 'Mountainbike'],
  Judo: ['bis 57 kg', 'bis 73 kg', 'bis 90 kg', 'über 78 kg'],
  Ringen: ['Freistil bis 65 kg', 'Griechisch-römisch bis 77 kg'],
  Fechten: ['Degen', 'Florett', 'Säbel'],
};

const CLUBS: Record<string, readonly string[]> = {
  Rudern: ['Ruderclub Seewinkel', 'Ruderverein Großsee'],
  'Kanu-Rennsport': ['Kanu-Club Auenstein', 'Paddelfreunde Mühlwasser'],
  Leichtathletik: ['LG Talblick', 'TSG Eichenhain'],
  Schwimmen: ['Schwimmverein Lindenwasser', 'SG Blauweiher'],
  Radsport: ['RSV Hügelfeld', 'Radteam Sonnenhang'],
  Judo: ['Judo-Club Mühlbach', 'Budo-Sport Kastanienhof'],
  Ringen: ['AC Eichenhain', 'KSV Felsental'],
  Fechten: ['Fechtclub Burgberg', 'Fechtsport Schönau'],
};

/** Kaderstatus (Code) → Bezeichnung in der Quelldatei */
export const SQUAD_LABELS: Record<string, string> = {
  OK: 'Olympiakader',
  PK: 'Perspektivkader',
  EK: 'Ergänzungskader',
  NK1: 'Nachwuchskader 1',
  NK2: 'Nachwuchskader 2',
  LK: 'Landeskader',
  none: 'kein Kader',
};
const SQUAD_WEIGHTS: [string, number][] = [
  ['OK', 2],
  ['PK', 3],
  ['EK', 2],
  ['NK1', 4],
  ['NK2', 4],
  ['LK', 3],
  ['none', 2],
];

// ---------------------------------------------------------------------------------------------
// Athletinnen und Athleten
// ---------------------------------------------------------------------------------------------

export interface FixtureAthlete {
  externalId: string;
  lastName: string;
  firstName: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  /** Geschlecht wie in der Quelldatei: w | m */
  sex: 'w' | 'm';
  sport: string;
  discipline: string;
  /** Code (OK, PK, …, none) */
  squadStatus: string;
  club: string;
}

/** Zeile der Quelldatei, ggf. absichtlich fehlerhaft */
export interface AthleteSourceRow extends FixtureAthlete {
  /** Rohwerte, die in der Datei anders stehen als im gültigen Datensatz */
  override?: Partial<Record<'Geburtsdatum' | 'Sportart' | 'Kaderstatus', string>>;
}

function weighted(rng: Rng, items: [string, number][]): string {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng.float(0, total);
  for (const [v, w] of items) {
    r -= w;
    if (r < 0) return v;
  }
  return items[items.length - 1]![0];
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function makeAthletes(prefix: string, count: number, seed: number, umlautShare: number): FixtureAthlete[] {
  const rng = new Rng(seed);
  const used = new Set<string>();
  const out: FixtureAthlete[] = [];
  const sports = Object.keys(SPORTS);
  for (let i = 1; i <= count; i++) {
    const sex: 'w' | 'm' = rng.chance(0.5) ? 'w' : 'm';
    let lastName = '';
    let firstName = '';
    do {
      lastName = rng.chance(umlautShare) ? rng.pick(LAST_NAMES_UMLAUT) : rng.pick(LAST_NAMES);
      firstName = sex === 'w' ? rng.pick(FIRST_NAMES_F) : rng.pick(FIRST_NAMES_M);
    } while (used.has(`${lastName}|${firstName}`));
    used.add(`${lastName}|${firstName}`);
    const sport = rng.pick(sports);
    const year = rng.int(1996, 2010);
    const month = rng.int(1, 12);
    const day = rng.int(1, 28);
    out.push({
      externalId: `${prefix}-${pad(i, 4)}`,
      lastName,
      firstName,
      dateOfBirth: `${year}-${pad(month)}-${pad(day)}`,
      sex,
      sport,
      discipline: rng.pick(SPORTS[sport]!),
      squadStatus: weighted(rng, SQUAD_WEIGHTS),
      club: rng.pick(CLUBS[sport]!),
    });
  }
  return out;
}

/** Positionen (1-basiert) der absichtlich fehlerhaften Zeilen in osp-nord/athleten.csv */
export const NORD_FAULTY_ROWS = {
  invalidDate: 13,
  missingSport: 27,
  unknownSquad: 38,
} as const;

/** Alle Zeilen der Datei osp-nord/athleten.csv (40 gültige + 3 fehlerhafte) */
export function nordAthleteRows(): AthleteSourceRow[] {
  const rows: AthleteSourceRow[] = makeAthletes('NORD', 43, 20260101, 0.25);
  rows[NORD_FAULTY_ROWS.invalidDate - 1]!.override = { Geburtsdatum: '31.02.2004' };
  rows[NORD_FAULTY_ROWS.missingSport - 1]!.override = { Sportart: '' };
  rows[NORD_FAULTY_ROWS.unknownSquad - 1]!.override = { Kaderstatus: 'Bundeskader' };
  return rows;
}

/** Gültige Athletinnen und Athleten von osp-nord (werden beim Import angelegt) */
export function nordAthletes(): FixtureAthlete[] {
  return nordAthleteRows().filter((r) => !r.override);
}

export function mitteAthletes(): FixtureAthlete[] {
  return makeAthletes('MITTE', 25, 20260202, 0.8);
}

export function suedAthletes(): FixtureAthlete[] {
  return makeAthletes('SUED', 20, 20260303, 0.3);
}

function toGermanDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

const ATHLETE_HEADER = [
  'Athleten-ID',
  'Nachname',
  'Vorname',
  'Geburtsdatum',
  'Geschlecht',
  'Sportart',
  'Disziplin',
  'Kaderstatus',
  'Verein',
];

function csvCell(value: string, delimiter: string): string {
  return value.includes(delimiter) || value.includes('"') || /[\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function csv(header: string[], rows: string[][], delimiter: string, eol = '\n'): string {
  return [header, ...rows].map((r) => r.map((c) => csvCell(c, delimiter)).join(delimiter)).join(eol) + eol;
}

function athleteCsv(rows: AthleteSourceRow[], eol = '\n'): string {
  return csv(
    ATHLETE_HEADER,
    rows.map((a) => [
      a.externalId,
      a.lastName,
      a.firstName,
      a.override?.Geburtsdatum ?? toGermanDate(a.dateOfBirth),
      a.sex,
      a.override?.Sportart ?? a.sport,
      a.discipline,
      a.override?.Kaderstatus ?? SQUAD_LABELS[a.squadStatus]!,
      a.club,
    ]),
    ';',
    eol,
  );
}

// ---------------------------------------------------------------------------------------------
// Leistungsdiagnostik (osp-nord)
// ---------------------------------------------------------------------------------------------

const PROTOCOL_BY_SPORT: Record<string, string> = {
  Rudern: 'Stufentest Ruderergometer',
  'Kanu-Rennsport': 'Stufentest Radergometer',
  Radsport: 'Stufentest Radergometer',
};

function isoDay(rng: Rng, from: string, to: string): string {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  const days = Math.floor((b - a) / 86_400_000);
  return new Date(a + rng.int(0, days) * 86_400_000).toISOString().slice(0, 10);
}

export const LD_FAULTY = { vo2maxTooHigh: 140, futureDate: '2099-03-15' } as const;

export function leistungsdiagnostikCsv(): string {
  const rng = new Rng(20260404);
  const athletes = nordAthletes();
  const rows: string[][] = [];
  const used = new Set<string>();
  let i = 0;
  while (rows.length < 80) {
    const a = athletes[i % athletes.length]!;
    i++;
    const protocol = PROTOCOL_BY_SPORT[a.sport] ?? 'Stufentest Laufband';
    const date = isoDay(rng, '2024-01-08', '2026-09-30');
    const key = `${a.externalId}|${date}|${protocol}`;
    if (used.has(key)) continue;
    used.add(key);
    const female = a.sex === 'w';
    const vo2 = rng.float(female ? 44 : 50, female ? 66 : 78);
    const power =
      protocol === 'Stufentest Laufband'
        ? ''
        : String(Math.round(rng.float(female ? 170 : 220, female ? 320 : 420)));
    rows.push([
      a.lastName,
      a.firstName,
      a.dateOfBirth,
      date,
      protocol,
      vo2.toFixed(1),
      power,
      String(rng.int(178, 208)),
    ]);
  }
  // zwei absichtlich unplausible Zeilen (Fehlerprotokoll in der Demo)
  rows[16]![5] = LD_FAULTY.vo2maxTooHigh.toFixed(1);
  rows[57]![3] = LD_FAULTY.futureDate;
  return csv(
    ['Nachname', 'Vorname', 'Geburtsdatum', 'Testdatum', 'Protokoll', 'VO2max', 'Laktatschwelle_W', 'HFmax'],
    rows,
    ',',
  );
}

// ---------------------------------------------------------------------------------------------
// Verletzungen (osp-nord, Gesundheitsdaten)
// ---------------------------------------------------------------------------------------------

export const BODY_REGIONS = [
  'Knie',
  'Sprunggelenk',
  'Schulter',
  'Rücken',
  'Oberschenkel',
  'Hand/Handgelenk',
  'Sonstige',
] as const;
export const INJURY_TYPES = [
  'Muskelverletzung',
  'Bänderverletzung',
  'Überlastung',
  'Fraktur',
  'Prellung',
  'Sonstige',
] as const;
export const INJURY_STATUS = ['akut', 'in Reha', 'ausgeheilt'] as const;

export function verletzungenCsv(): string {
  const rng = new Rng(20260505);
  const athletes = nordAthletes();
  const rows: string[][] = [];
  const used = new Set<string>();
  while (rows.length < 25) {
    const a = rng.pick(athletes);
    const date = isoDay(rng, '2024-02-01', '2026-10-20');
    const region = rng.pick(BODY_REGIONS);
    const key = `${a.externalId}|${date}|${region}`;
    if (used.has(key)) continue;
    used.add(key);
    const type = rng.pick(INJURY_TYPES);
    const days =
      type === 'Fraktur' ? rng.int(30, 120) : type === 'Prellung' ? rng.int(0, 10) : rng.int(3, 60);
    const status =
      date >= '2026-09-01'
        ? rng.pick(['akut', 'in Reha'] as const)
        : date >= '2026-06-01'
          ? 'in Reha'
          : 'ausgeheilt';
    rows.push([a.externalId, toGermanDate(date), region, type, String(days), status]);
  }
  return csv(
    ['Athleten-ID', 'Verletzungsdatum', 'Körperregion', 'Verletzungsart', 'Ausfalltage', 'Status'],
    rows,
    ';',
  );
}

// ---------------------------------------------------------------------------------------------
// Kodierung Windows-1252
// ---------------------------------------------------------------------------------------------

// biome-ignore format: kompakte Zeichentabelle
const CP1252_EXTRA: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89,
  'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

export function encodeWindows1252(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out.push(code);
    else if (CP1252_EXTRA[ch] !== undefined) out.push(CP1252_EXTRA[ch]);
    else throw new Error(`character not representable in windows-1252: ${ch}`);
  }
  return new Uint8Array(out);
}

// ---------------------------------------------------------------------------------------------
// Ausgabe
// ---------------------------------------------------------------------------------------------

const README = `# Synthetische Demo-Daten

Alle Dateien in diesem Verzeichnis sind **frei erfunden** und werden von
\`scripts/generate-fixtures.ts\` deterministisch erzeugt (\`bun scripts/generate-fixtures.ts\`).
Namen sind Zufallskombinationen häufiger deutscher Vor- und Nachnamen; Übereinstimmungen mit realen
Personen wären zufällig. Vereine und die Knoten "osp-nord", "osp-mitte" und "osp-sued" sind fiktiv.

## Dateien

| Datei | Inhalt | Format | Vorlage (Connector) |
|---|---|---|---|
| \`osp-nord/athleten.csv\` | 43 Zeilen Stammdaten (Kennungen \`NORD-0001\` …), davon **3 absichtlich fehlerhaft** | Semikolon, UTF-8, Datum TT.MM.JJJJ | \`athleten-stammdaten-csv\` |
| \`osp-nord/leistungsdiagnostik.csv\` | 80 Stufentests (VO2max, Laktatschwelle, HFmax), davon **2 unplausibel** | Komma, UTF-8, ISO-Datum, Dezimalpunkt | \`leistungsdiagnostik-csv\` |
| \`osp-nord/verletzungen.csv\` | 25 Verletzungen (Gesundheitsdaten, besondere Kategorie Art. 9 DSGVO) | Semikolon, UTF-8, Datum TT.MM.JJJJ | \`verletzungen-csv\` |
| \`osp-mitte/athleten.csv\` | 25 Stammdatensätze (\`MITTE-0001\` …) mit Umlauten | Semikolon, **Windows-1252**, CRLF | \`athleten-stammdaten-csv\` |
| \`osp-sued/athleten.csv\` | 20 Stammdatensätze (\`SUED-0001\` …) | Semikolon, UTF-8 mit BOM | \`athleten-stammdaten-csv\` |

Die Sprungkraft-Messungen (API-Quelle) liefert das Mock-Messsystem \`scripts/mock-measurement-api.ts\`
(\`bun run mock-api\`, Vorlage \`sprungkraft-api\`): 123 Messungen für Athletinnen und Athleten von osp-nord,
davon 3 absichtlich fehlerhaft (unbekannte Kennung, Sprunghöhe 250 cm, unbekannte Testart).

## Absichtliche Fehler (Fehlerprotokoll)

- \`osp-nord/athleten.csv\`: Zeile ${NORD_FAULTY_ROWS.invalidDate} Geburtsdatum \`31.02.2004\` (ungültiges Datum),
  Zeile ${NORD_FAULTY_ROWS.missingSport} ohne Sportart (Pflichtfeld), Zeile ${NORD_FAULTY_ROWS.unknownSquad} Kaderstatus \`Bundeskader\` (unbekannter Wert).
- \`osp-nord/leistungsdiagnostik.csv\`: eine Zeile mit VO2max 140 ml/kg/min (außerhalb 20–95),
  eine Zeile mit Testdatum in der Zukunft (${LD_FAULTY.futureDate}).

Die Zuordnung erfolgt bei Stammdaten und Verletzungen über die Kennung \`Athleten-ID\` (System \`osp-id\`),
bei der Leistungsdiagnostik über Nachname, Vorname und Geburtsdatum. Der Kaderstatus steht in den
Dateien als Bezeichnung (z. B. "Perspektivkader") und wird über die Wertübersetzung der Vorlage auf den
Code (z. B. \`PK\`) abgebildet.
`;

export function fixtureFiles(): Record<string, string | Uint8Array> {
  const mitte = athleteCsv(mitteAthletes(), '\r\n');
  return {
    'README.md': README,
    'osp-nord/athleten.csv': athleteCsv(nordAthleteRows()),
    'osp-nord/leistungsdiagnostik.csv': leistungsdiagnostikCsv(),
    'osp-nord/verletzungen.csv': verletzungenCsv(),
    'osp-mitte/athleten.csv': encodeWindows1252(mitte),
    'osp-sued/athleten.csv': `﻿${athleteCsv(suedAthletes())}`,
  };
}

if (import.meta.main) {
  for (const [rel, content] of Object.entries(fixtureFiles())) {
    const path = join(FIXTURES_DIR, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`geschrieben: fixtures/${rel}`);
  }
}
