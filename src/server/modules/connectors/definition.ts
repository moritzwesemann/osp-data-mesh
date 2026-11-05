/**
 * Prüfung von Connector-Definitionen gegen das Ziel (Athletenkern oder Datensatz).
 */
import type { ConnectorInput } from '../../../shared/contract/connectors.ts';
import { invalid } from '../../core/errors.ts';
import { type DatasetShape, requiredTargets } from './pipeline.ts';

/** Art der Quelle je Konfigurationstyp */
const KIND_OF_CONFIG: Record<ConnectorInput['config']['type'], ConnectorInput['kind']> = {
  csv: 'csv_upload',
  xlsx: 'xlsx_upload',
  http_api: 'http_api',
};

/** Zielfelder des Athletenkerns, die bei Ziel "Datensatz" nur zur Personenzuordnung dienen */
const MATCH_TARGETS = new Set([
  'athlete.last_name',
  'athlete.first_name',
  'athlete.date_of_birth',
  'athlete.external_id',
]);

/**
 * Prüft Art/Konfiguration, Ziel und Zuordnungen. Liefert die normalisierte Eingabe
 * (Ziel Athletenkern → targetDatasetId = null) oder wirft validation_failed mit Feldcodes.
 */
export function validateConnectorInput(
  input: ConnectorInput,
  dataset: DatasetShape | null,
  prefix = 'body',
): ConnectorInput {
  const errors: Record<string, string> = {};
  const p = (path: string) => (prefix ? `${prefix}.${path}` : path);

  if (KIND_OF_CONFIG[input.config.type] !== input.kind) errors[p('config.type')] = 'kind_mismatch';

  const normalized: ConnectorInput = {
    ...input,
    targetDatasetId: input.targetType === 'athletes' ? null : input.targetDatasetId,
  };
  if (input.targetType === 'dataset') {
    if (!input.targetDatasetId) errors[p('targetDatasetId')] = 'required';
    else if (!dataset) errors[p('targetDatasetId')] = 'not_found';
  }

  const fieldNames = new Set((dataset?.fields ?? []).map((f) => f.name));
  const seen = new Set<string>();
  input.mapping.forEach((m, i) => {
    const key = p(`mapping.${i}.target`);
    if (seen.has(m.target)) {
      errors[key] = 'duplicate_target';
      return;
    }
    seen.add(m.target);
    if (input.targetType === 'athletes') {
      if (!m.target.startsWith('athlete.')) errors[key] = 'not_allowed';
    } else if (m.target.startsWith('data.')) {
      if (dataset && !fieldNames.has(m.target.slice(5))) errors[key] = 'unknown_field';
    } else if (!MATCH_TARGETS.has(m.target)) {
      errors[key] = 'not_allowed';
    }
  });

  if (input.targetType === 'athletes' || dataset) {
    for (const target of requiredTargets({
      targetType: input.targetType,
      athleteMatch: input.athleteMatch,
      dataset,
    })) {
      if (!seen.has(target)) errors[p(`mapping[${target}]`)] = 'required';
    }
  }

  if (Object.keys(errors).length > 0) throw invalid(errors);
  return normalized;
}
