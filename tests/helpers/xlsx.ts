/**
 * Excel-Dateien (.xlsx) für Tests erzeugen: kleine SpreadsheetML-Pakete mit voller Kontrolle über den
 * ZIP-Container (Größenangaben, CRC, Flags), damit auch feindliche Dateien (ZIP-Bomben, ZIP64,
 * verschlüsselte Einträge) gebaut werden können.
 */
import { Deflate, deflateSync } from 'fflate';

export interface ZipFile {
  name: string;
  /** unkomprimierter Inhalt (oder stattdessen compressed + size + crc) */
  data?: Uint8Array | string;
  /** 0 = gespeichert, 8 = deflate (Standard) */
  method?: 0 | 8;
  /** bereits komprimierte Daten (method 8) */
  compressed?: Uint8Array;
  /** Größe/CRC im Verzeichnis überschreiben (z. B. gelogene Größe einer ZIP-Bombe) */
  size?: number;
  crc?: number;
  flags?: number;
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

/** CRC-32 fortschreiben (Start mit -1, Ergebnis mit crcEnd) */
export function crcUpdate(crc: number, data: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return c;
}
export const crcEnd = (c: number) => (c ^ -1) >>> 0;

const enc = new TextEncoder();
const bytesOf = (d: Uint8Array | string) => (typeof d === 'string' ? enc.encode(d) : d);

/** ZIP-Archiv schreiben (ohne ZIP64; Werte im Verzeichnis wie angegeben) */
export function zip(files: ZipFile[], opts: { totalEntries?: number } = {}): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const method = f.method ?? 8;
    const raw = f.data !== undefined ? bytesOf(f.data) : null;
    const body =
      f.compressed ?? (raw ? (method === 8 ? deflateSync(raw, { level: 6 }) : raw) : new Uint8Array());
    const size = f.size ?? raw?.length ?? 0;
    const crc = f.crc ?? (raw ? crcEnd(crcUpdate(-1, raw)) : 0);
    const name = enc.encode(f.name);
    const flags = (f.flags ?? 0) | 0x800;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, flags, true);
    lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    local.push(new Uint8Array(lh.buffer), name, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, flags, true);
    ch.setUint16(10, method, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  const count = opts.totalEntries ?? files.length;
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Inhalt in Blöcken komprimieren, ohne ihn ganz im Speicher zu halten (für große Testdateien) */
export function deflateRepeated(
  block: string,
  times: number,
  prefix = '',
  suffix = '',
): {
  compressed: Uint8Array;
  size: number;
  crc: number;
} {
  const parts: Uint8Array[] = [];
  const d = new Deflate({ level: 1 }, (chunk) => parts.push(chunk));
  let size = 0;
  let crc = -1;
  const push = (s: string, final = false) => {
    const b = enc.encode(s);
    size += b.length;
    crc = crcUpdate(crc, b);
    d.push(b, final);
  };
  push(prefix);
  for (let i = 0; i < times; i++) push(block);
  push(suffix, true);
  const compressed = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    compressed.set(p, o);
    o += p.length;
  }
  return { compressed, size, crc: crcEnd(crc) };
}

// ---------------------------------------------------------------------------------------------
// SpreadsheetML
// ---------------------------------------------------------------------------------------------

/** Zellformate (Index in cellXfs) der erzeugten Formatvorlagen */
export const STYLE = {
  general: 0,
  date: 1, // eingebaut 14
  datetime: 2, // dd/mm/yyyy\ hh:mm
  time: 3, // mm:ss.0
  elapsed: 4, // eingebaut 46 [h]:mm:ss
  decimal2: 5, // eingebaut 2 (0.00)
  percent: 6, // eingebaut 9 (0%)
  dateDe: 7, // [$-407]dd\.mm\.yyyy;@
  text: 8, // eingebaut 49 (@)
} as const;

export type Cell =
  | string
  | number
  | boolean
  | null
  | undefined
  /** Zahl mit Zellformat */
  | { n: number; style: keyof typeof STYLE }
  /** Datum (YYYY-MM-DD, optional mit Uhrzeit HH:MM:SS) als Seriennummer mit Datumsformat */
  | { date: string; style?: keyof typeof STYLE }
  /** Formel, optional mit gespeichertem Ergebnis */
  | { f: string; v?: string | number; t?: 'str' | 'n' | 'b' | 'e' }
  | { error: string }
  | { bool: string }
  | { inline: string }
  /** gemeinsamer Text als Rich Text mit phonetischer Lesehilfe */
  | { rich: string[]; phonetic?: string };

export interface SheetSpec {
  name: string;
  /** Zeilen ab Zeile 1; null = Zeile fehlt (Lücke); Zellen ab Spalte A (undefined = Zelle fehlt) */
  rows?: (Cell[] | null)[];
  /** gesamtes Blatt als XML (ersetzt rows) */
  xml?: string;
}

export interface XlsxSpec {
  sheets: SheetSpec[];
  date1904?: boolean;
  /** Texte als gemeinsame Texte (Standard) oder als Inline-Texte */
  sharedStrings?: boolean;
  /** Namensraum-Präfix für SpreadsheetML-Elemente (z. B. "x" wie im OpenXML SDK) */
  prefix?: string;
  /** zusätzliche oder ersetzte Teile (Pfad → Inhalt bzw. ZipFile-Angaben) */
  parts?: Record<string, string | Partial<ZipFile>>;
  /** Teile weglassen */
  omit?: string[];
  method?: 0 | 8;
}

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function colName(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** Datum (YYYY-MM-DD[THH:MM:SS]) → Excel-Seriennummer */
export function serialOf(date: string, date1904 = false): number {
  const [d, t = '00:00:00'] = date.split('T');
  const [y, m, day] = d!.split('-').map(Number) as [number, number, number];
  const [hh, mm, ss] = t.split(':').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, day, hh, mm, ss);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return (ms - epoch) / 86_400_000;
}

/** Excel-Datei aus einer Beschreibung bauen */
export function buildXlsx(spec: XlsxSpec): Uint8Array {
  const p = spec.prefix ? `${spec.prefix}:` : '';
  const ns = spec.prefix ? `xmlns:${spec.prefix}="${MAIN_NS}"` : `xmlns="${MAIN_NS}"`;
  const shared = spec.sharedStrings ?? true;
  const sst: string[] = [];
  const sstIndex = new Map<string, number>();
  const sstXml: string[] = [];
  const share = (s: string): number => {
    let i = sstIndex.get(s);
    if (i === undefined) {
      i = sst.length;
      sst.push(s);
      sstIndex.set(s, i);
      sstXml.push(`<${p}si><${p}t xml:space="preserve">${esc(s)}</${p}t></${p}si>`);
    }
    return i;
  };
  const cellXml = (cell: Cell, ref: string): string => {
    if (cell === null || cell === undefined) return '';
    if (typeof cell === 'string') {
      if (shared) return `<${p}c r="${ref}" t="s"><${p}v>${share(cell)}</${p}v></${p}c>`;
      return `<${p}c r="${ref}" t="inlineStr"><${p}is><${p}t>${esc(cell)}</${p}t></${p}is></${p}c>`;
    }
    if (typeof cell === 'number') return `<${p}c r="${ref}"><${p}v>${cell}</${p}v></${p}c>`;
    if (typeof cell === 'boolean') return `<${p}c r="${ref}" t="b"><${p}v>${cell ? 1 : 0}</${p}v></${p}c>`;
    if ('n' in cell) return `<${p}c r="${ref}" s="${STYLE[cell.style]}"><${p}v>${cell.n}</${p}v></${p}c>`;
    if ('date' in cell) {
      const style = STYLE[cell.style ?? (cell.date.includes('T') ? 'datetime' : 'date')];
      return `<${p}c r="${ref}" s="${style}"><${p}v>${serialOf(cell.date, spec.date1904)}</${p}v></${p}c>`;
    }
    if ('f' in cell) {
      const t = cell.t ? ` t="${cell.t}"` : '';
      const v = cell.v === undefined ? '' : `<${p}v>${esc(String(cell.v))}</${p}v>`;
      return `<${p}c r="${ref}"${t}><${p}f>${esc(cell.f)}</${p}f>${v}</${p}c>`;
    }
    if ('error' in cell) return `<${p}c r="${ref}" t="e"><${p}v>${esc(cell.error)}</${p}v></${p}c>`;
    if ('bool' in cell) return `<${p}c r="${ref}" t="b"><${p}v>${esc(cell.bool)}</${p}v></${p}c>`;
    if ('inline' in cell) {
      return `<${p}c r="${ref}" t="inlineStr"><${p}is><${p}t>${esc(cell.inline)}</${p}t></${p}is></${p}c>`;
    }
    // Rich Text mit phonetischer Lesehilfe als gemeinsamer Text
    const i = sst.length;
    sst.push(cell.rich.join(''));
    const runs = cell.rich.map((r) => `<${p}r><${p}t>${esc(r)}</${p}t></${p}r>`).join('');
    const ph = cell.phonetic ? `<${p}rPh sb="0" eb="1"><${p}t>${esc(cell.phonetic)}</${p}t></${p}rPh>` : '';
    sstXml.push(`<${p}si>${runs}${ph}</${p}si>`);
    return `<${p}c r="${ref}" t="s"><${p}v>${i}</${p}v></${p}c>`;
  };
  const sheetXml = (s: SheetSpec): string => {
    if (s.xml !== undefined) return s.xml;
    const rows = (s.rows ?? [])
      .map((cells, ri) => {
        if (cells === null) return '';
        const r = ri + 1;
        const cs = cells.map((c, ci) => cellXml(c, `${colName(ci + 1)}${r}`)).join('');
        return `<${p}row r="${r}">${cs}</${p}row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}worksheet ${ns} xmlns:r="${REL_NS}"><${p}sheetData>${rows}</${p}sheetData></${p}worksheet>`;
  };
  const sheetFiles = spec.sheets.map((s, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: sheetXml(s),
  }));

  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><${p}workbook ${ns} xmlns:r="${REL_NS}"><${p}workbookPr${spec.date1904 ? ' date1904="1"' : ''}/><${p}sheets>${spec.sheets
      .map((s, i) => `<${p}sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</${p}sheets></${p}workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG_REL_NS}">${spec.sheets
      .map(
        (_s, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        '',
      )}<Relationship Id="rIdS" Type="${REL_NS}/styles" Target="styles.xml"/><Relationship Id="rIdT" Type="${REL_NS}/sharedStrings" Target="/xl/sharedStrings.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><${p}styleSheet ${ns}><${p}numFmts count="3"><${p}numFmt numFmtId="164" formatCode="dd/mm/yyyy\\ hh:mm"/><${p}numFmt numFmtId="165" formatCode="mm:ss.0"/><${p}numFmt numFmtId="166" formatCode="[$-407]dd\\.mm\\.yyyy;@"/></${p}numFmts><${p}cellStyleXfs count="2"><${p}xf numFmtId="14"/><${p}xf numFmtId="0"/></${p}cellStyleXfs><${p}cellXfs count="9"><${p}xf numFmtId="0" xfId="0"/><${p}xf numFmtId="14"/><${p}xf numFmtId="164"/><${p}xf numFmtId="165"/><${p}xf numFmtId="46"/><${p}xf numFmtId="2"/><${p}xf numFmtId="9"/><${p}xf numFmtId="166"/><${p}xf numFmtId="49"/></${p}cellXfs></${p}styleSheet>`,
  };
  // Blätter zuerst bauen (füllen die gemeinsamen Texte)
  const sheetsBuilt = sheetFiles;
  files['xl/sharedStrings.xml'] =
    `<?xml version="1.0" encoding="UTF-8"?><${p}sst ${ns} count="${sst.length}" uniqueCount="${sst.length}">${sstXml.join('')}</${p}sst>`;
  const all: ZipFile[] = [];
  for (const [name, data] of Object.entries(files)) all.push({ name, data, method: spec.method });
  for (const f of sheetsBuilt) all.push({ ...f, method: spec.method });
  const omit = new Set(spec.omit ?? []);
  const out: ZipFile[] = [];
  for (const f of all) {
    if (omit.has(f.name)) continue;
    const override = spec.parts?.[f.name];
    if (override === undefined) out.push(f);
    else out.push(typeof override === 'string' ? { ...f, data: override } : { ...f, ...override });
  }
  for (const [name, v] of Object.entries(spec.parts ?? {})) {
    if (all.some((f) => f.name === name)) continue;
    out.push(typeof v === 'string' ? { name, data: v, method: spec.method } : { name, ...v });
  }
  return zip(out);
}
