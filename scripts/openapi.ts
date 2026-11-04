/**
 * Schreibt das OpenAPI-3.1-Dokument des HTTP-Vertrags nach docs/api/openapi.json.
 *   bun scripts/openapi.ts [ausgabedatei]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildOpenApiDocument } from '../src/server/modules/system/openapi.ts';

const target = resolve(import.meta.dir, '..', process.argv[2] ?? 'docs/api/openapi.json');
const doc = buildOpenApiDocument();
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
const paths = Object.keys(doc.paths as Record<string, unknown>).length;
console.log(`OpenAPI written: ${target} (${paths} paths)`);
