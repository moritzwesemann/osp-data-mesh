/**
 * Hilfsfunktionen für Integrationstests der Datenintegration (Vorlagen, Fixture-Uploads, Importläufe).
 */
import { expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { FIXTURES_DIR } from '../../scripts/generate-fixtures.ts';
import type {
  Connector,
  ConnectorDefinition,
  ImportRun,
  ImportRunDetail,
} from '../../src/shared/contract/connectors.ts';
import type { TestNode, TestUser } from './node.ts';

export type RunDetail = z.infer<typeof ImportRunDetail>;

/** Multipart-Formular mit einer Datei aus fixtures/ (oder eigenem Inhalt) im Feld "file" */
export function fileForm(relOrContent: string | Uint8Array, name?: string): FormData {
  const bytes =
    typeof relOrContent === 'string' && !name
      ? new Uint8Array(readFileSync(join(FIXTURES_DIR, relOrContent)))
      : typeof relOrContent === 'string'
        ? new TextEncoder().encode(relOrContent)
        : relOrContent;
  const fileName = name ?? (relOrContent as string).split('/').pop()!;
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes)], fileName, { type: 'text/csv' }));
  return form;
}

export async function templateDefinition(
  node: TestNode,
  as: TestUser,
  id: string,
): Promise<ConnectorDefinition> {
  const r = await node.request<{ items: { id: string; definition: ConnectorDefinition }[] }>(
    'GET',
    '/api/v1/connector-templates',
    { as },
  );
  expect(r.status).toBe(200);
  const t = r.json.items.find((i) => i.id === id);
  if (!t) throw new Error(`template ${id} not found`);
  return structuredClone(t.definition);
}

/** Connector aus einer Vorlage anlegen (optional angepasst) */
export async function importTemplate(
  node: TestNode,
  as: TestUser,
  id: string,
  adjust?: (def: ConnectorDefinition) => void,
): Promise<Connector> {
  const definition = await templateDefinition(node, as, id);
  adjust?.(definition);
  const r = await node.request<Connector>('POST', '/api/v1/connectors/import', {
    as,
    body: { definition, createDataset: true },
  });
  if (r.status !== 200) throw new Error(`connectors.import failed: ${r.status} ${r.text}`);
  return r.json;
}

export async function startImport(
  node: TestNode,
  as: TestUser,
  connectorId: string,
  form?: FormData,
): Promise<RunDetail> {
  const r = await node.request<RunDetail>('POST', `/api/v1/connectors/${connectorId}/runs`, { as, form });
  if (r.status !== 200) throw new Error(`imports.start failed: ${r.status} ${r.text}`);
  return r.json;
}

export async function commitRun(node: TestNode, as: TestUser, runId: string): Promise<ImportRun> {
  const r = await node.request<ImportRun>('POST', `/api/v1/import-runs/${runId}/commit`, { as });
  if (r.status !== 200) throw new Error(`imports.commit failed: ${r.status} ${r.text}`);
  return r.json;
}

/** Audit-Einträge einer Aktion (neueste zuerst) */
export async function auditEntries(node: TestNode, action: string) {
  return node.deps.db
    .selectFrom('audit_log')
    .selectAll()
    .where('action', '=', action)
    .orderBy('seq', 'desc')
    .execute();
}
