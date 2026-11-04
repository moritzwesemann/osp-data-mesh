/**
 * Serialisierung von Datenprodukten in offene Formate (CSV, JSON, XML).
 * CSV: RFC 4180, Komma, UTF-8 mit BOM (Excel/Power Query), Schutz vor Formel-Injection.
 */
import type { ColumnDef, ExportFormat, Scalar } from '../../shared/contract/common.ts';

export function toCsv(columns: readonly ColumnDef[], rows: readonly Record<string, Scalar>[]): string {
  const lines = [columns.map((c) => csvCell(c.key)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key] ?? null)).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

function csvCell(v: Scalar | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = v;
  // Formel-Injection in Tabellenkalkulationen verhindern
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function xmlEscape(s: string): string {
  return (
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // in XML 1.0 unzulässige Steuerzeichen entfernen
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Steuerzeichen werden bewusst entfernt
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  );
}

export function toXml(
  meta: { name: string; generatedAt: string; [k: string]: string },
  columns: readonly ColumnDef[],
  rows: readonly Record<string, Scalar>[],
): string {
  const attrs = Object.entries(meta)
    .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
    .join('');
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', `<dataProduct${attrs}>`, '  <columns>'];
  for (const c of columns) {
    out.push(
      `    <column key="${xmlEscape(c.key)}" type="${c.type}" label="${xmlEscape(c.label)}"${c.unit ? ` unit="${xmlEscape(c.unit)}"` : ''}/>`,
    );
  }
  out.push('  </columns>', '  <rows>');
  for (const r of rows) {
    out.push('    <row>');
    for (const c of columns) {
      const v = r[c.key];
      if (v === null || v === undefined) out.push(`      <${c.key} nil="true"/>`);
      else out.push(`      <${c.key}>${xmlEscape(String(v))}</${c.key}>`);
    }
    out.push('    </row>');
  }
  out.push('  </rows>', '</dataProduct>');
  return `${out.join('\n')}\n`;
}

/** Datei-Antwort für Exporte (CSV/XML/JSON als Download) */
export function fileResponse(
  format: ExportFormat,
  baseName: string,
  meta: { name: string; generatedAt: string; [k: string]: string },
  columns: readonly ColumnDef[],
  rows: readonly Record<string, Scalar>[],
): Response {
  const safe = baseName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'export';
  if (format === 'csv') {
    return new Response(toCsv(columns, rows), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${safe}.csv"`,
      },
    });
  }
  if (format === 'xml') {
    return new Response(toXml(meta, columns, rows), {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="${safe}.xml"`,
      },
    });
  }
  return new Response(JSON.stringify({ meta, columns, rows }, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${safe}.json"`,
    },
  });
}
