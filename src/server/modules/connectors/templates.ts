/**
 * Mitgelieferte Connector-Vorlagen: JSON-Dateien (ConnectorDefinition) im Verzeichnis templates/.
 * Dateiname ohne Endung = Vorlagen-ID. Ungültige Dateien werden protokolliert und übersprungen.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectorDefinition } from '../../../shared/contract/connectors.ts';
import type { Logger } from '../../core/logger.ts';

export const TEMPLATES_DIR = join(import.meta.dir, 'templates');

export interface ConnectorTemplate {
  id: string;
  name: string;
  description: string;
  definition: ConnectorDefinition;
}

export function loadTemplates(dir = TEMPLATES_DIR, log?: Logger): ConnectorTemplate[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
  const out: ConnectorTemplate[] = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    try {
      const definition = ConnectorDefinition.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
      out.push({
        id,
        name: definition.connector.name,
        description: definition.connector.description,
        definition,
      });
    } catch (err) {
      log?.error('invalid connector template', { template: id, error: (err as Error).message });
    }
  }
  return out;
}
