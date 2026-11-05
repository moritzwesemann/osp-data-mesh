/**
 * Excel-Dateien (.xlsx, Office Open XML/SpreadsheetML) als Importquelle (ADR 0015).
 *
 * Die Datei gilt als feindliche Eingabe:
 *  - ZIP-Container: zentrales Verzeichnis selbst gelesen (kein ZIP64, keine mehrteiligen Archive, keine
 *    verschlüsselten Einträge, nur „stored“/„deflate“, höchstens MAX_ZIP_ENTRIES Einträge, keine doppelten
 *    Namen). Gelesen werden nur die benötigten Teile: Beziehungen, Arbeitsmappe, Formatvorlagen,
 *    gemeinsame Texte und das gewählte Tabellenblatt.
 *  - Entpacken als Datenstrom (fflate): Die Obergrenzen für die entpackte Größe (Schutz vor ZIP-Bomben)
 *    werden während des Entpackens an den tatsächlich erzeugten Bytes geprüft, nicht an den Angaben im
 *    Archiv; Größe und CRC-32 jedes vollständig gelesenen Teils müssen stimmen.
 *  - XML: eigener, linearer Leser für den benötigten Ausschnitt: keine DTD, keine Entitäten außer den
 *    fünf vordefinierten und Zeichenreferenzen (kein XXE, keine Entitätsexpansion), Attribute in Maps,
 *    Obergrenze je Element bzw. Textstück.
 *  - Formeln werden nie ausgewertet: übernommen wird nur der in der Datei gespeicherte Ergebniswert.
 *
 * Ergebnis ist dieselbe Tabelle wie beim CSV-Import (SourceTable); Zuordnung, Prüfung, Vorschau,
 * Fehlerprotokoll und Übernahme laufen danach unverändert (pipeline.ts, runs.ts).
 *
 * Zellwerte werden zu Text, den die Pipeline wie CSV-Werte prüft:
 *  - Zahlenzellen: gespeicherter Wert (höchstens 15 signifikante Stellen wie in Excel), mit dem
 *    eingestellten Dezimaltrennzeichen, damit Zahlen- und Textzellen gleich gelesen werden;
 *  - Datumszellen (Zahlenformat mit Tag/Monat/Jahr): ISO 8601 „YYYY-MM-DD“, mit Uhrzeit
 *    „YYYY-MM-DDTHH:MM:SS“ (Ortszeit ohne Offset), reine Zeitformate „HH:MM:SS“; 1900- und 1904-System;
 *  - Wahrheitswerte „true“/„false“, Fehlerwerte als Text (z. B. „#DIV/0!“), Text unverändert.
 */
import { Inflate } from 'fflate';
import {
  type Issue,
  MAX_SOURCE_COLUMNS,
  MAX_SOURCE_ROWS,
  type SourceLimit,
  type SourceRow,
  type SourceTable,
  uniqueColumnNames,
} from './pipeline.ts';
import type { IssueParams } from './validate.ts';

/** Höchstzahl der Einträge im ZIP-Verzeichnis */
export const MAX_ZIP_ENTRIES = 10_000;
/** Höchstens so viele Bytes werden insgesamt entpackt (alle gelesenen Teile zusammen) */
export const MAX_INFLATED_BYTES = 100 * 1024 * 1024;
/** Obergrenze je Verwaltungsteil (Beziehungen, Arbeitsmappe, Formatvorlagen) */
export const MAX_META_PART_BYTES = 8 * 1024 * 1024;
export const MAX_SHARED_STRINGS = 1_000_000;
export const MAX_SHEETS = 1000;
const MAX_STYLES = 100_000;
/** längstes zusammenhängendes XML-Stück (Element mit Attributen oder Text); Excel-Zellen: ≤ 32 767 Zeichen */
const MAX_XML_TOKEN = 1024 * 1024;
const MAX_ATTRIBUTES = 64;
/** komprimierte Bytes je Entpackschritt: begrenzt die Ausgabe eines Schritts auf etwa 4 MB */
const INFLATE_STEP = 4 * 1024;
const STORED_STEP = 256 * 1024;
const MAX_ROW = 1_048_576;
const MAX_COL = 16_384;
/** Längster Zellwert, den Excel selbst speichern kann; längere Werte gibt es nur in präparierten Dateien */
export const MAX_CELL_CHARS = 32_767;
/**
 * Höchstens so viele Zeichen Zellwerte je Lesevorgang – so viel Text, wie eine CSV-Datei der Höchstgröße
 * (20 MB) enthalten kann. Verweise auf gemeinsame Texte kosten beim Entpacken nichts; ohne diese Grenze
 * könnte eine kleine Datei Milliarden Zeichen erzeugen (ein langer Text, millionenfach referenziert).
 */
export const MAX_SHEET_CHARS = 20_000_000;

/** Grund, aus dem eine Datei nicht gelesen wird (import_error.params.reason bei invalid_file) */
export type XlsxFailureReason =
  | 'not_xlsx'
  | 'xls_or_encrypted'
  | 'xlsx_corrupt'
  | 'xlsx_too_large'
  | 'xlsx_unsupported';

export class XlsxError extends Error {
  constructor(readonly reason: XlsxFailureReason) {
    super(reason);
    this.name = 'XlsxError';
  }
}

/** interner Abbruch: genug Zeilen gelesen bzw. Obergrenze erreicht */
class Stop extends Error {}

export interface XlsxReadOptions {
  /** Name des Tabellenblatts; leer = erstes Tabellenblatt */
  sheet: string;
  /** Kopfzeile = erste nicht leere Zeile ab dieser Zeilennummer */
  headerRow: number;
  /** Dezimaltrennzeichen, mit dem Zahlenzellen als Text ausgegeben werden */
  decimalSeparator: '.' | ',';
  /** höchstens so viele Datenzeilen (sonst limit=too_many_rows mit den ersten maxRows Zeilen) */
  maxRows?: number;
}

export type XlsxRead =
  /** headerRow: tatsächliche Zeilennummer der Kopfzeile im Blatt (erste nicht leere Zeile ab opts.headerRow) */
  | { ok: true; table: SourceTable; sheets: string[]; sheet: string; headerRow: number | null }
  | { ok: false; code: 'invalid_file' | 'sheet_not_found'; params: IssueParams; sheets: string[] };

// ---------------------------------------------------------------------------------------------
// ZIP-Container
// ---------------------------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
/** Compound File Binary (OLE): alte .xls-Dateien und kennwortgeschützte (verschlüsselte) .xlsx-Dateien */
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Teilnamen sind in OPC unabhängig von Groß-/Kleinschreibung */
function partKey(name: string): string {
  return name.replace(/^\/+/, '').toLowerCase();
}

function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  if (bytes.length >= 8 && CFB_MAGIC.every((v, i) => bytes[i] === v)) throw new XlsxError('xls_or_encrypted');
  if (bytes.length < 22 || u32(bytes, 0) !== SIG_LOCAL) throw new XlsxError('not_xlsx');
  // Ende des zentralen Verzeichnisses: am Dateiende, ggf. vor einem Kommentar (höchstens 65 535 Bytes)
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === SIG_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new XlsxError('xlsx_corrupt');
  const disk = u16(bytes, end + 4);
  const cdDisk = u16(bytes, end + 6);
  const onDisk = u16(bytes, end + 8);
  const total = u16(bytes, end + 10);
  const cdSize = u32(bytes, end + 12);
  const cdOffset = u32(bytes, end + 16);
  // ZIP64 (Platzhalterwerte) und mehrteilige Archive kommen in .xlsx-Dateien nicht vor
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new XlsxError('xlsx_unsupported');
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) throw new XlsxError('xlsx_unsupported');
  if (total > MAX_ZIP_ENTRIES) throw new XlsxError('xlsx_too_large');
  const cdEnd = cdOffset + cdSize;
  if (cdEnd > end) throw new XlsxError('xlsx_corrupt');

  const names = new TextDecoder('utf-8');
  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cdEnd || u32(bytes, p) !== SIG_CENTRAL) throw new XlsxError('xlsx_corrupt');
    const nameLen = u16(bytes, p + 28);
    const next = p + 46 + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
    if (next > cdEnd) throw new XlsxError('xlsx_corrupt');
    const entry: ZipEntry = {
      name: names.decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      flags: u16(bytes, p + 8),
      method: u16(bytes, p + 10),
      crc: u32(bytes, p + 16),
      compressedSize: u32(bytes, p + 20),
      size: u32(bytes, p + 24),
      offset: u32(bytes, p + 42),
    };
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) {
      throw new XlsxError('xlsx_unsupported');
    }
    const key = partKey(entry.name);
    // doppelte Namen: welcher Teil gilt, wäre je nach Programm verschieden
    if (entries.has(key)) throw new XlsxError('xlsx_corrupt');
    entries.set(key, entry);
    p = next;
  }
  return entries;
}

/** komprimierte Daten eines Eintrags (hinter dem lokalen Kopf) */
function entryData(bytes: Uint8Array, e: ZipEntry): Uint8Array {
  if (e.flags & 0x1) throw new XlsxError('xlsx_unsupported');
  if (e.method !== 0 && e.method !== 8) throw new XlsxError('xlsx_unsupported');
  const o = e.offset;
  if (o + 30 > bytes.length || u32(bytes, o) !== SIG_LOCAL) throw new XlsxError('xlsx_corrupt');
  const start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
  const stop = start + e.compressedSize;
  if (stop > bytes.length) throw new XlsxError('xlsx_corrupt');
  if (e.method === 0 && e.compressedSize !== e.size) throw new XlsxError('xlsx_corrupt');
  return bytes.subarray(start, stop);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(crc: number, data: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}

/** Restbudget an entpackten Bytes für die ganze Datei */
class Budget {
  constructor(public left: number) {}
  take(n: number): void {
    this.left -= n;
    if (this.left < 0) throw new XlsxError('xlsx_too_large');
  }
}

/**
 * Eintrag entpacken und als UTF-8-Text in Stücken an onText geben. Grenzen: partLimit für diesen Teil,
 * budget für die ganze Datei – beides an den tatsächlich entpackten Bytes gemessen.
 */
function streamEntry(
  bytes: Uint8Array,
  e: ZipEntry,
  budget: Budget,
  partLimit: number,
  onText: (text: string) => void,
): void {
  const data = entryData(bytes, e);
  // schnelle Abweisung anhand der Angabe im Archiv (die eigentliche Prüfung folgt beim Entpacken)
  if (e.size > Math.min(budget.left, partLimit)) throw new XlsxError('xlsx_too_large');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let produced = 0;
  let crc = -1;
  const emit = (chunk: Uint8Array) => {
    produced += chunk.length;
    if (produced > partLimit) throw new XlsxError('xlsx_too_large');
    budget.take(chunk.length);
    crc = crc32(crc, chunk);
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: true });
    } catch {
      throw new XlsxError('xlsx_corrupt');
    }
    if (text) onText(text);
  };
  if (e.method === 0) {
    for (let i = 0; i < data.length; i += STORED_STEP) emit(data.subarray(i, i + STORED_STEP));
  } else {
    const inflate = new Inflate((chunk) => emit(chunk));
    try {
      if (data.length === 0) inflate.push(new Uint8Array(0), true);
      for (let i = 0; i < data.length; i += INFLATE_STEP) {
        inflate.push(data.subarray(i, i + INFLATE_STEP), i + INFLATE_STEP >= data.length);
      }
    } catch (err) {
      if (err instanceof XlsxError || err instanceof Stop) throw err;
      throw new XlsxError('xlsx_corrupt');
    }
  }
  let tail: string;
  try {
    tail = decoder.decode();
  } catch {
    throw new XlsxError('xlsx_corrupt');
  }
  if (tail) onText(tail);
  if (produced !== e.size || (crc ^ -1) >>> 0 !== e.crc) throw new XlsxError('xlsx_corrupt');
}

// ---------------------------------------------------------------------------------------------
// XML (nur der von SpreadsheetML benötigte Ausschnitt)
// ---------------------------------------------------------------------------------------------

export interface XmlEvents {
  /** Elementname ohne Namensraum-Präfix; Attribute mit Präfix (z. B. "r:id") */
  open(name: string, attrs: Map<string, string>): void;
  close(name: string): void;
  text(value: string): void;
}

const ENTITY_RE = /&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(lt|gt|amp|quot|apos));/g;
const NAMED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** vordefinierte Entitäten und Zeichenreferenzen auflösen; alles andere bleibt wörtlich stehen */
export function decodeXmlText(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(ENTITY_RE, (m, hex: string | undefined, dec: string | undefined, named?: string) => {
    if (named) return NAMED_ENTITIES.get(named) ?? m;
    const cp = hex ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? '', 10);
    if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return m;
    return String.fromCodePoint(cp);
  });
}

/** Escapes in Excel-Texten (ST_Xstring): "_x000D_" = Wagenrücklauf, "_x005F_" = Unterstrich */
export function decodeExcelEscapes(s: string): string {
  if (!s.includes('_x')) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
}

function localName(qname: string): string {
  const i = qname.indexOf(':');
  return i < 0 ? qname : qname.slice(i + 1);
}

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/** Obergrenze für ein XML-Stück bzw. einen zusammengesetzten Zell- oder Textwert */
function tokenLength(n: number): void {
  if (n > MAX_XML_TOKEN) throw new XlsxError('xlsx_too_large');
}

/**
 * Inkrementeller XML-Leser: nimmt Text in beliebigen Stücken an und meldet Elemente und Text.
 * Ein unvollständiges Stück am Ende bleibt für den nächsten Aufruf stehen; die Suche nach seinem Ende
 * setzt dort fort, wo sie aufgehört hat (linearer Aufwand auch bei sehr kleinen Stücken).
 */
export class XmlScanner {
  private buf = '';
  /** Fortsetzung der Suche im unvollständigen Stück am Anfang von buf (Abstand vom Anfang) */
  private resume = 0;
  /** offenes Anführungszeichen im unvollständigen Element (0 = keines) */
  private quote = 0;

  constructor(private readonly ev: XmlEvents) {}

  feed(chunk: string): void {
    this.buf = this.buf.length > 0 ? this.buf + chunk : chunk;
    this.run();
  }

  end(): void {
    this.run();
    if (this.buf.trim() !== '') throw new XlsxError('xlsx_corrupt');
    this.buf = '';
  }

  private pause(s: string, at: number, resume: number): void {
    this.buf = at === 0 ? s : s.slice(at);
    this.resume = resume;
    if (this.buf.length > MAX_XML_TOKEN) throw new XlsxError('xlsx_too_large');
  }

  private run(): void {
    const s = this.buf;
    let i = 0;
    while (i < s.length) {
      const from = i === 0 ? this.resume : 0;
      if (i !== 0 || this.resume === 0) this.quote = 0;
      if (s.charCodeAt(i) !== 0x3c) {
        const lt = s.indexOf('<', i + Math.max(from, 0));
        if (lt < 0) {
          this.pause(s, i, s.length - i);
          return;
        }
        tokenLength(lt - i);
        this.ev.text(decodeXmlText(s.slice(i, lt)));
        i = lt;
        this.resume = 0;
        continue;
      }
      const rest = s.length - i;
      if (rest < 2) {
        this.pause(s, i, 0);
        return;
      }
      const c1 = s.charCodeAt(i + 1);
      if (c1 === 0x3f /* ? */) {
        const e = s.indexOf('?>', i + Math.max(from, 2));
        if (e < 0) {
          this.pause(s, i, Math.max(2, rest - 1));
          return;
        }
        tokenLength(e - i);
        i = e + 2;
        this.resume = 0;
        continue;
      }
      if (c1 === 0x21 /* ! */) {
        if (s.startsWith('<!--', i)) {
          const e = s.indexOf('-->', i + Math.max(from, 4));
          if (e < 0) {
            this.pause(s, i, Math.max(4, rest - 2));
            return;
          }
          tokenLength(e - i);
          i = e + 3;
        } else if (s.startsWith('<![CDATA[', i)) {
          const e = s.indexOf(']]>', i + Math.max(from, 9));
          if (e < 0) {
            this.pause(s, i, Math.max(9, rest - 2));
            return;
          }
          tokenLength(e - i);
          this.ev.text(s.slice(i + 9, e));
          i = e + 3;
        } else if (rest < 9 && ('<![CDATA['.startsWith(s.slice(i)) || '<!--'.startsWith(s.slice(i)))) {
          this.pause(s, i, 0);
          return;
        } else {
          // DTD/DOCTYPE: in SpreadsheetML nicht vorgesehen; abgelehnt (keine Entitätsdefinitionen)
          throw new XlsxError('xlsx_unsupported');
        }
        this.resume = 0;
        continue;
      }
      const e = this.tagEnd(s, i + Math.max(from, 1));
      if (e < 0) {
        this.pause(s, i, rest);
        return;
      }
      tokenLength(e - i);
      this.tag(s.slice(i + 1, e));
      i = e + 1;
      this.resume = 0;
    }
    this.buf = '';
    this.resume = 0;
  }

  /** Ende eines Elements ('>' außerhalb von Anführungszeichen) ab Position from, sonst -1 */
  private tagEnd(s: string, from: number): number {
    let q = this.quote;
    for (let j = from; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (q !== 0) {
        if (c === q) q = 0;
      } else if (c === 0x22 || c === 0x27) {
        q = c;
      } else if (c === 0x3e) {
        this.quote = 0;
        return j;
      } else if (c === 0x3c) {
        throw new XlsxError('xlsx_corrupt');
      }
    }
    this.quote = q;
    return -1;
  }

  private tag(inner: string): void {
    if (inner.charCodeAt(0) === 0x2f /* / */) {
      this.ev.close(localName(inner.slice(1).trim()));
      return;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    let j = 0;
    while (j < body.length && !isSpace(body.charCodeAt(j))) j++;
    const name = localName(body.slice(0, j));
    if (name === '') throw new XlsxError('xlsx_corrupt');
    const attrs = new Map<string, string>();
    while (j < body.length) {
      while (j < body.length && isSpace(body.charCodeAt(j))) j++;
      if (j >= body.length) break;
      const eq = body.indexOf('=', j);
      if (eq < 0) throw new XlsxError('xlsx_corrupt');
      const attrName = body.slice(j, eq).trim();
      let k = eq + 1;
      while (k < body.length && isSpace(body.charCodeAt(k))) k++;
      const q = body[k];
      if (q !== '"' && q !== "'") throw new XlsxError('xlsx_corrupt');
      const close = body.indexOf(q, k + 1);
      if (close < 0) throw new XlsxError('xlsx_corrupt');
      if (attrs.size >= MAX_ATTRIBUTES) throw new XlsxError('xlsx_corrupt');
      attrs.set(attrName, decodeXmlText(body.slice(k + 1, close)));
      j = close + 1;
    }
    this.ev.open(name, attrs);
    if (selfClosing) this.ev.close(name);
  }
}

/** Attribut mit beliebigem Namensraum-Präfix, z. B. "r:id" (Beziehungs-ID eines Blatts) */
function prefixedAttr(attrs: Map<string, string>, local: string): string | undefined {
  for (const [k, v] of attrs) if (k.includes(':') && localName(k) === local) return v;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Zahlenformate, Datumswerte
// ---------------------------------------------------------------------------------------------

/** Art eines Zahlenformats: Datum, Datum mit Uhrzeit, Uhrzeit, verstrichene Zeit ([h]:mm) oder Zahl */
export type FormatKind = 'date' | 'datetime' | 'time' | 'elapsed' | null;

/** eingebaute Datums- und Zeitformate (ECMA-376 Teil 1, 18.8.30; 27–36 und 50–58 ostasiatisch) */
const BUILTIN_FORMATS = new Map<number, FormatKind>([
  [14, 'date'],
  [15, 'date'],
  [16, 'date'],
  [17, 'date'],
  [18, 'time'],
  [19, 'time'],
  [20, 'time'],
  [21, 'time'],
  [22, 'datetime'],
  [27, 'date'],
  [28, 'date'],
  [29, 'date'],
  [30, 'date'],
  [31, 'date'],
  [32, 'time'],
  [33, 'time'],
  [34, 'time'],
  [35, 'time'],
  [36, 'date'],
  [45, 'time'],
  [46, 'elapsed'],
  [47, 'time'],
  [50, 'date'],
  [51, 'date'],
  [52, 'date'],
  [53, 'date'],
  [54, 'date'],
  [55, 'date'],
  [56, 'date'],
  [57, 'date'],
  [58, 'date'],
]);

/** Art eines benutzerdefinierten Formatcodes (erster Abschnitt, ohne Texte, Escapes und Farben) */
export function formatKind(code: string): FormatKind {
  let s = '';
  let elapsed = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === ';') break;
    if (c === '"') {
      const e = code.indexOf('"', i + 1);
      i = e < 0 ? code.length : e;
    } else if (c === '\\' || c === '_' || c === '*') {
      i++;
    } else if (c === '[') {
      const e = code.indexOf(']', i + 1);
      const inner = code.slice(i + 1, e < 0 ? code.length : e);
      if (/^(h+|m+|s+)$/i.test(inner)) {
        elapsed = true;
        s += inner;
      }
      i = e < 0 ? code.length : e;
    } else {
      s += c;
    }
  }
  s = s.replace(/general/gi, '');
  const time = /[hs]/i.test(s);
  const date = /[yd]/i.test(s) || (/m/i.test(s) && !time);
  if (elapsed) return 'elapsed';
  if (date && time) return 'datetime';
  if (date) return 'date';
  if (time) return 'time';
  return null;
}

const DAY_MS = 86_400_000;
/** 9999-12-31 im 1900-System */
const MAX_SERIAL = 2_958_465;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function clockText(ms: number, hours: number): string {
  const rest = ms % 3_600_000;
  const out = `${pad(hours)}:${pad(Math.floor(rest / 60_000))}:${pad(Math.floor((rest % 60_000) / 1000))}`;
  return ms % 1000 ? `${out}.${pad(ms % 1000, 3)}` : out;
}

/** Excel-Seriennummer → Text (ISO 8601 bzw. Uhrzeit) oder null, wenn kein gültiges Datum */
export function serialText(
  serial: number,
  kind: Exclude<FormatKind, null>,
  date1904: boolean,
): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial >= MAX_SERIAL + 1) return null;
  if (kind === 'elapsed') {
    const ms = Math.round(serial * DAY_MS);
    return clockText(ms, Math.floor(ms / 3_600_000));
  }
  if (kind === 'time') {
    let ms = Math.round((serial - Math.floor(serial)) * DAY_MS);
    if (ms >= DAY_MS) ms -= DAY_MS;
    return clockText(ms, Math.floor(ms / 3_600_000));
  }
  // Datum: angezeigt wird der Tag (abgeschnitten), bei Datum mit Uhrzeit auf Millisekunden gerundet
  const days = Math.floor(serial);
  let epoch: number;
  if (date1904) epoch = Date.UTC(1904, 0, 1);
  else if (days === 60)
    return null; // 29.02.1900 gibt es nicht (Lotus-1-2-3-Kompatibilität)
  else epoch = days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  if (kind === 'date') return new Date(epoch + days * DAY_MS).toISOString().slice(0, 10);
  const iso = new Date(epoch + Math.round(serial * DAY_MS)).toISOString();
  return iso.endsWith('.000Z') ? iso.slice(0, 19) : iso.slice(0, 23);
}

/** Zahl → Text mit höchstens 15 signifikanten Stellen (wie Excel) und gewähltem Dezimaltrennzeichen */
export function numberText(value: number, decimalSeparator: '.' | ','): string {
  const n = Number(value.toPrecision(15));
  const s = String(n === 0 ? 0 : n);
  return decimalSeparator === ',' ? s.replace('.', ',') : s;
}

// ---------------------------------------------------------------------------------------------
// Teile der Arbeitsmappe
// ---------------------------------------------------------------------------------------------

interface Relationship {
  target: string;
  type: string;
}

/** Zielpfad einer Beziehung relativ zum Quellteil bzw. absolut ("/xl/…") */
function resolveTarget(sourcePart: string, target: string): string {
  let t = target;
  try {
    t = decodeURIComponent(target);
  } catch {
    // ungültige %-Kodierung: wörtlich verwenden
  }
  const parts = t.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
  for (const seg of t.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

function relsPartOf(part: string): string {
  const i = part.lastIndexOf('/');
  return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

interface WorkbookSheet {
  name: string;
  rid: string;
}

interface SheetContext {
  sst: string[];
  kinds: FormatKind[];
  date1904: boolean;
  decimalSeparator: '.' | ',';
}

/** Kennbuchstaben → Spaltennummer (A = 1 … XFD = 16384) */
function columnOf(ref: string): number {
  let col = 0;
  let i = 0;
  for (; i < ref.length && i < 4; i++) {
    const c = ref.charCodeAt(i) & ~0x20;
    if (c < 0x41 || c > 0x5a) break;
    col = col * 26 + (c - 0x40);
  }
  if (i === 0 || col > MAX_COL) throw new XlsxError('xlsx_corrupt');
  return col;
}

function cellText(type: string, style: number, v: string | null, inline: string | null, ctx: SheetContext) {
  switch (type) {
    case 's': {
      if (v === null) return null;
      const idx = Number(v);
      if (!Number.isInteger(idx) || idx < 0 || idx >= ctx.sst.length) throw new XlsxError('xlsx_corrupt');
      return ctx.sst[idx]!;
    }
    case 'inlineStr':
      return inline === null ? null : decodeExcelEscapes(inline);
    case 'str':
      return v === null ? null : decodeExcelEscapes(v);
    case 'b':
      return v === null ? null : v.trim() === '1' || v.trim().toLowerCase() === 'true' ? 'true' : 'false';
    case 'e':
    case 'd':
      return v;
    default: {
      if (v === null) return inline === null ? null : decodeExcelEscapes(inline);
      const t = v.trim();
      const n = Number(t);
      if (t === '' || !Number.isFinite(n)) return v;
      const kind = ctx.kinds[style] ?? null;
      if (kind) return serialText(n, kind, ctx.date1904) ?? numberText(n, ctx.decimalSeparator);
      return numberText(n, ctx.decimalSeparator);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------------------------

/**
 * Excel-Datei lesen: gewähltes Tabellenblatt (Name oder erstes Blatt), Kopfzeile ab headerRow, leere Zeilen
 * übersprungen. Zeilennummern wie beim CSV-Import: 1-basiert ohne Kopfzeile, nur nicht leere Zeilen.
 */
export function readXlsx(bytes: Uint8Array, opts: XlsxReadOptions): XlsxRead {
  let sheets: string[] = [];
  try {
    const entries = readZipDirectory(bytes);
    const budget = new Budget(MAX_INFLATED_BYTES);
    const parse = (part: string, limit: number, ev: XmlEvents): boolean => {
      const e = entries.get(partKey(part));
      if (!e) return false;
      const scanner = new XmlScanner(ev);
      streamEntry(bytes, e, budget, limit, (t) => scanner.feed(t));
      scanner.end();
      return true;
    };
    const readRels = (part: string): Map<string, Relationship> => {
      const rels = new Map<string, Relationship>();
      parse(relsPartOf(part), MAX_META_PART_BYTES, {
        open(name, a) {
          if (name !== 'Relationship' || a.get('TargetMode') === 'External') return;
          const id = a.get('Id');
          const target = a.get('Target');
          if (!id || !target || rels.has(id)) return;
          if (rels.size >= MAX_ZIP_ENTRIES) throw new XlsxError('xlsx_too_large');
          rels.set(id, { target: resolveTarget(part, target), type: a.get('Type') ?? '' });
        },
        close() {},
        text() {},
      });
      return rels;
    };

    // Paket → Arbeitsmappe
    if (!entries.has('[content_types].xml')) throw new XlsxError('not_xlsx');
    const rootRels = readRels('');
    const workbookPart =
      [...rootRels.values()].find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
    // Binärformat (.xlsb) wird nicht gelesen
    if (workbookPart.toLowerCase().endsWith('.bin')) throw new XlsxError('xlsx_unsupported');
    const wbSheets: WorkbookSheet[] = [];
    let date1904 = false;
    let isWorkbook = false;
    const found = parse(workbookPart, MAX_META_PART_BYTES, {
      open(name, a) {
        if (name === 'workbook') {
          isWorkbook = true;
        } else if (name === 'workbookPr') {
          const v = (a.get('date1904') ?? '').toLowerCase();
          date1904 = v === '1' || v === 'true';
        } else if (name === 'sheet') {
          if (wbSheets.length >= MAX_SHEETS) throw new XlsxError('xlsx_too_large');
          wbSheets.push({ name: a.get('name') ?? '', rid: prefixedAttr(a, 'id') ?? '' });
        }
      },
      close() {},
      text() {},
    });
    // andere Office-Dateien (z. B. .docx) haben dieselbe Paketstruktur, aber keine Arbeitsmappe
    if (!found || !isWorkbook) throw new XlsxError('not_xlsx');
    const wbRels = readRels(workbookPart);
    const relOfType = (suffix: string) => [...wbRels.values()].find((r) => r.type.endsWith(suffix));

    // nur Tabellenblätter (keine Diagrammblätter)
    const worksheets = wbSheets
      .map((s) => ({ name: s.name, rel: wbRels.get(s.rid) }))
      .filter((s): s is { name: string; rel: Relationship } => !!s.rel && s.rel.type.endsWith('/worksheet'));
    sheets = worksheets.map((s) => s.name);
    const wanted = opts.sheet.trim();
    const chosen =
      wanted === ''
        ? worksheets[0]
        : (worksheets.find((s) => s.name === opts.sheet) ??
          worksheets.find((s) => s.name.toLocaleLowerCase('de') === wanted.toLocaleLowerCase('de')));
    if (!chosen) return { ok: false, code: 'sheet_not_found', params: { sheet: opts.sheet }, sheets };

    // Formatvorlagen: Zahlenformat je Zellformat (cellXfs) → Datum/Zeit oder Zahl
    const numFmts = new Map<number, string>();
    const xfFormats: number[] = [];
    const stylesPart = relOfType('/styles')?.target;
    if (stylesPart) {
      let inCellXfs = false;
      parse(stylesPart, MAX_META_PART_BYTES, {
        open(name, a) {
          if (name === 'numFmt') {
            const id = Number(a.get('numFmtId'));
            if (Number.isInteger(id)) numFmts.set(id, a.get('formatCode') ?? '');
          } else if (name === 'cellXfs') {
            inCellXfs = true;
          } else if (name === 'xf' && inCellXfs) {
            if (xfFormats.length >= MAX_STYLES) throw new XlsxError('xlsx_too_large');
            xfFormats.push(Number(a.get('numFmtId') ?? 0));
          }
        },
        close(name) {
          if (name === 'cellXfs') inCellXfs = false;
        },
        text() {},
      });
    }
    const kinds = xfFormats.map((id) => {
      const code = numFmts.get(id);
      return code !== undefined ? formatKind(code) : (BUILTIN_FORMATS.get(id) ?? null);
    });

    // gemeinsame Texte (ohne phonetische Lesehilfen <rPh>)
    const sst: string[] = [];
    const sstPart = relOfType('/sharedStrings')?.target;
    if (sstPart) {
      let item: string | null = null;
      let inT = false;
      let phonetic = 0;
      parse(sstPart, MAX_INFLATED_BYTES, {
        open(name) {
          if (name === 'si') item = '';
          else if (name === 'rPh') phonetic++;
          else if (name === 't' && item !== null && phonetic === 0) inT = true;
        },
        close(name) {
          if (name === 't') inT = false;
          else if (name === 'rPh') phonetic--;
          else if (name === 'si' && item !== null) {
            if (sst.length >= MAX_SHARED_STRINGS) throw new XlsxError('xlsx_too_large');
            sst.push(decodeExcelEscapes(item));
            item = null;
          }
        },
        text(value) {
          if (inT && item !== null) {
            item += value;
            tokenLength(item.length);
          }
        },
      });
    }

    if (!entries.has(partKey(chosen.rel.target))) throw new XlsxError('xlsx_corrupt');
    const { table, headerRow } = readSheet(
      (ev) => parse(chosen.rel.target, MAX_INFLATED_BYTES, ev),
      { sst, kinds, date1904, decimalSeparator: opts.decimalSeparator },
      opts,
    );
    return { ok: true, table, sheets, sheet: chosen.name, headerRow };
  } catch (err) {
    if (err instanceof XlsxError) {
      return { ok: false, code: 'invalid_file', params: { reason: err.reason }, sheets };
    }
    throw err;
  }
}

/** Tabellenblatt zeilenweise lesen und in eine Quelltabelle umsetzen */
function readSheet(
  parse: (ev: XmlEvents) => boolean,
  ctx: SheetContext,
  opts: XlsxReadOptions,
): { table: SourceTable; headerRow: number | null } {
  let headerAt: number | null = null;
  // ausgegebene Zeichen aller Zellwerte (Grenze MAX_SHEET_CHARS)
  let emittedChars = 0;
  const maxRows = opts.maxRows ?? MAX_SOURCE_ROWS;
  let header: { first: number; last: number; columns: string[] } | null = null;
  const rows: SourceRow[] = [];
  const issues: Issue[] = [];
  let limit: SourceLimit | undefined;

  const onRow = (rowNum: number, cells: Map<number, string>) => {
    if (rowNum < opts.headerRow) return;
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const [c, v] of cells) {
      if (v.trim() === '') continue;
      if (c < min) min = c;
      if (c > max) max = c;
    }
    if (max === 0) return; // leere Zeile
    if (!header) {
      if (max - min + 1 > MAX_SOURCE_COLUMNS) {
        limit = 'too_many_columns';
        throw new Stop();
      }
      const names: (string | null)[] = [];
      for (let c = min; c <= max; c++) names.push(cells.get(c) ?? null);
      header = { first: min, last: max, columns: uniqueColumnNames(names) };
      headerAt = rowNum;
      return;
    }
    if (rows.length >= maxRows) {
      limit = 'too_many_rows';
      throw new Stop();
    }
    const rowNumber = rows.length + 1;
    // ohne Prototyp: Spaltennamen wie "constructor" oder "__proto__" sind gewöhnliche Schlüssel
    const raw: Record<string, string | null> = Object.create(null);
    for (const [c, v] of cells) {
      if (c >= header.first && c <= header.last) raw[header.columns[c - header.first]!] = v;
    }
    // Werte außerhalb der Spalten der Kopfzeile: Zeile passt nicht zur Kopfzeile (wie beim CSV-Import)
    if (min < header.first || max > header.last) {
      issues.push({
        rowNumber,
        field: null,
        code: 'invalid_row',
        severity: 'error',
        rawValue: null,
        params: {
          expected: header.columns.length,
          actual: Math.max(max, header.last) - Math.min(min, header.first) + 1,
        },
      });
    }
    rows.push({ rowNumber, raw });
  };

  let inSheetData = false;
  let rowNum = 0;
  let lastRow = 0;
  let cells: Map<number, string> | null = null;
  let lastCol = 0;
  let cell: { col: number; type: string; style: number } | null = null;
  let v: string | null = null;
  let inline: string | null = null;
  let inV = false;
  let inIs = false;
  let inT = false;
  let phonetic = 0;

  try {
    parse({
      open(name, a) {
        switch (name) {
          case 'sheetData':
            inSheetData = true;
            break;
          case 'row': {
            if (!inSheetData) break;
            const r = a.get('r');
            rowNum = r === undefined ? lastRow + 1 : Number(r);
            if (!Number.isInteger(rowNum) || rowNum <= lastRow || rowNum > MAX_ROW) {
              throw new XlsxError('xlsx_corrupt');
            }
            lastRow = rowNum;
            cells = new Map();
            lastCol = 0;
            break;
          }
          case 'c': {
            if (!cells) break;
            const ref = a.get('r');
            const col = ref === undefined ? lastCol + 1 : columnOf(ref);
            if (col > MAX_COL) throw new XlsxError('xlsx_corrupt');
            lastCol = col;
            const style = Number(a.get('s') ?? 0);
            cell = { col, type: a.get('t') ?? 'n', style: Number.isInteger(style) ? style : 0 };
            v = null;
            inline = null;
            break;
          }
          case 'v':
            if (cell) inV = true;
            break;
          case 'is':
            if (cell) {
              inIs = true;
              inline ??= '';
            }
            break;
          case 'rPh':
            if (inIs) phonetic++;
            break;
          case 't':
            if (inIs && phonetic === 0) inT = true;
            break;
          // <f> (Formel) wird bewusst ignoriert: nur der gespeicherte Wert <v> zählt
        }
      },
      close(name) {
        switch (name) {
          case 'v':
            inV = false;
            break;
          case 't':
            inT = false;
            break;
          case 'rPh':
            if (inIs) phonetic--;
            break;
          case 'is':
            inIs = false;
            break;
          case 'c':
            if (cell && cells) {
              const value = cellText(cell.type, cell.style, v, inline, ctx);
              if (value !== null && value !== '') {
                if (value.length > MAX_CELL_CHARS) throw new XlsxError('xlsx_too_large');
                emittedChars += value.length;
                if (emittedChars > MAX_SHEET_CHARS) throw new XlsxError('xlsx_too_large');
                cells.set(cell.col, value);
              }
            }
            cell = null;
            break;
          case 'row':
            if (cells) onRow(rowNum, cells);
            cells = null;
            break;
          case 'sheetData':
            inSheetData = false;
            break;
        }
      },
      text(value) {
        if (inV) {
          v = (v ?? '') + value;
          tokenLength(v.length);
        } else if (inT) {
          inline = (inline ?? '') + value;
          tokenLength(inline.length);
        }
      },
    });
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
  }
  // (in Rückrufen gesetzt; ohne Umwandlung engt TypeScript die Typen auf den Anfangswert ein)
  const lim = limit as SourceLimit | undefined;
  const h = header as { columns: string[] } | null;
  if (lim === 'too_many_columns')
    return { table: { columns: [], rows: [], issues: [], limit: lim }, headerRow: null };
  if (!h) return { table: { columns: [], rows: [], issues: [] }, headerRow: null };
  return { table: { columns: h.columns, rows, issues, ...(lim ? { limit: lim } : {}) }, headerRow: headerAt };
}
