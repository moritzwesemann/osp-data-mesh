import { z } from 'zod';
import { IdParam, IsoDateTime, Ok, Pagination, paginated, Scalar, Uuid } from './common.ts';
import { DatasetInput } from './datasets.ts';
import { route } from './route.ts';

export const DateFormat = z.enum(['YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'ISO_DATETIME']);
export type DateFormat = z.infer<typeof DateFormat>;

export const CsvConfig = z.object({
  type: z.literal('csv'),
  delimiter: z.enum([',', ';', '\t', 'auto']).default('auto'),
  encoding: z.enum(['utf-8', 'windows-1252', 'iso-8859-1']).default('utf-8'),
  decimalSeparator: z.enum(['.', ',']).default('.'),
  dateFormat: DateFormat.default('YYYY-MM-DD'),
});
export type CsvConfig = z.infer<typeof CsvConfig>;

/**
 * Excel-Datei (.xlsx). Zahlen- und Datumszellen sind eindeutig und werden unabhängig von den Angaben
 * unten gelesen; Dezimaltrennzeichen und Datumsformat gelten für Werte, die als Text gespeichert sind.
 */
export const XlsxConfig = z.object({
  type: z.literal('xlsx'),
  /** Name des Tabellenblatts; leer = erstes Tabellenblatt */
  sheet: z.string().max(31).default(''),
  /** Kopfzeile = erste nicht leere Zeile ab dieser Zeilennummer des Blatts (Titelzeilen davor werden übersprungen) */
  headerRow: z.number().int().min(1).max(1000).default(1),
  decimalSeparator: z.enum(['.', ',']).default(','),
  dateFormat: DateFormat.default('DD.MM.YYYY'),
});
export type XlsxConfig = z.infer<typeof XlsxConfig>;

export const ApiAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  /** Geheimnis wird separat über connectors.setSecret gesetzt und verschlüsselt gespeichert */
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('header'), headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }),
  /**
   * OAuth 2.0 Client Credentials (RFC 6749, Abschnitt 4.4): Zugriffstoken vom Token-Endpunkt, als
   * Bearer-Token gesendet. Das Client-Geheimnis wird separat über connectors.setSecret gesetzt.
   */
  z.object({
    type: z.literal('oauth2_client_credentials'),
    tokenUrl: z.url({ protocol: /^https?$/ }),
    clientId: z.string().min(1).max(500),
    scope: z.string().max(1000).optional(),
    audience: z.string().max(1000).optional(),
    /** Übermittlung von Client-Kennung und -Geheimnis: HTTP-Basic (Standard) oder im Formular */
    clientAuth: z.enum(['basic', 'body']).default('basic'),
  }),
]);
export type ApiAuth = z.infer<typeof ApiAuth>;

export const ApiPagination = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('page'),
    pageParam: z.string().min(1).max(64),
    sizeParam: z.string().max(64).optional(),
    pageSize: z.number().int().min(1).max(1000).default(100),
    firstPage: z.number().int().min(0).max(1).default(1),
    maxPages: z.number().int().min(1).max(1000).default(50),
  }),
  z.object({
    type: z.literal('cursor'),
    cursorParam: z.string().min(1).max(64),
    /** Punkt-Pfad zum nächsten Cursor in der Antwort, z. B. "meta.next" */
    nextCursorPath: z.string().min(1).max(200),
    maxPages: z.number().int().min(1).max(1000).default(50),
  }),
]);

export const HttpApiConfig = z.object({
  type: z.literal('http_api'),
  url: z.url({ protocol: /^https?$/ }),
  /** Punkt-Pfad zum Array der Einträge in der JSON-Antwort; leer = Wurzel ist das Array */
  itemsPath: z.string().max(200).default(''),
  auth: ApiAuth.default({ type: 'none' }),
  pagination: ApiPagination.default({ type: 'none' }),
  query: z.record(z.string(), z.string()).default({}),
  dateFormat: DateFormat.default('ISO_DATETIME'),
  timeoutMs: z.number().int().min(1000).max(60000).default(15000),
});
export type HttpApiConfig = z.infer<typeof HttpApiConfig>;

export const ConnectorConfig = z.discriminatedUnion('type', [CsvConfig, XlsxConfig, HttpApiConfig]);
export type ConnectorConfig = z.infer<typeof ConnectorConfig>;

/**
 * Ziel einer Feldzuordnung:
 *  - athlete.<feld>       Feld des Athletenkerns (last_name, first_name, date_of_birth, sport, squad_status, sex, club, discipline)
 *  - athlete.external_id  Kennung der Person im Quellsystem (für Zuordnung per external_id)
 *  - data.<feld>          Feld des Ziel-Datensatzes
 */
export const MappingTarget = z
  .string()
  .regex(
    /^(athlete\.(last_name|first_name|date_of_birth|sport|squad_status|sex|club|discipline|external_id)|data\.[a-z][a-z0-9_]{0,40})$/,
  );

export const FieldMapping = z.object({
  /** Spaltenüberschrift (CSV, Excel) bzw. Punkt-Pfad im JSON-Eintrag (API) */
  source: z.string().min(1).max(200),
  target: MappingTarget,
  transform: z.enum(['none', 'trim', 'upper', 'lower']).default('trim'),
  /** Wertübersetzung, z. B. {"Olympiakader": "OK"} */
  valueMap: z.record(z.string(), z.string()).optional(),
  /** Ersatzwert, wenn die Quelle leer ist */
  defaultValue: z.string().max(200).optional(),
});
export type FieldMapping = z.infer<typeof FieldMapping>;

export const AthleteMatch = z.discriminatedUnion('strategy', [
  /** Zuordnung über Nachname + Vorname + Geburtsdatum (Mapping auf athlete.last_name/first_name/date_of_birth nötig) */
  z.object({ strategy: z.literal('natural_key') }),
  /** Zuordnung über eine Kennung im Quellsystem (Mapping auf athlete.external_id nötig) */
  z.object({ strategy: z.literal('external_id'), system: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/) }),
]);
export type AthleteMatch = z.infer<typeof AthleteMatch>;

/** Art der Quelle; legt den Konfigurationstyp fest (csv_upload ↔ csv, xlsx_upload ↔ xlsx, http_api ↔ http_api) */
export const ConnectorKind = z.enum(['csv_upload', 'xlsx_upload', 'http_api']);
export type ConnectorKind = z.infer<typeof ConnectorKind>;

export const ConnectorInput = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9_-]{1,50}$/),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  kind: ConnectorKind,
  targetType: z.enum(['athletes', 'dataset']),
  targetDatasetId: Uuid.nullable().default(null),
  config: ConnectorConfig,
  mapping: z.array(FieldMapping).min(1).max(200),
  athleteMatch: AthleteMatch.default({ strategy: 'natural_key' }),
  onError: z.enum(['skip_row', 'abort']).default('skip_row'),
  active: z.boolean().default(true),
});
export type ConnectorInput = z.infer<typeof ConnectorInput>;

export const Connector = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  kind: ConnectorKind,
  targetType: z.enum(['athletes', 'dataset']),
  targetDatasetId: Uuid.nullable(),
  targetDatasetName: z.string().nullable(),
  config: ConnectorConfig,
  mapping: z.array(FieldMapping),
  athleteMatch: AthleteMatch,
  onError: z.enum(['skip_row', 'abort']),
  version: z.number().int(),
  active: z.boolean(),
  hasSecret: z.boolean(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastRun: z
    .object({
      id: Uuid,
      status: z.enum(['previewed', 'committed', 'discarded', 'failed']),
      createdAt: IsoDateTime,
    })
    .nullable(),
});
export type Connector = z.infer<typeof Connector>;

/** Portable, wiederverwendbare Connector-Definition (ohne Geheimnisse), austauschbar zwischen Knoten. */
export const ConnectorDefinition = z.object({
  format: z.literal('osp-data-mesh/connector@1'),
  connector: ConnectorInput.omit({ targetDatasetId: true }).extend({
    targetDatasetSlug: z.string().nullable().default(null),
  }),
  /** Optional mitgelieferte Datensatz-Struktur, die beim Import angelegt werden kann */
  dataset: DatasetInput.nullable().default(null),
});
export type ConnectorDefinition = z.infer<typeof ConnectorDefinition>;

export const ImportRunStatus = z.enum(['previewed', 'committed', 'discarded', 'failed']);
export const ImportRun = z.object({
  id: Uuid,
  connectorId: Uuid,
  connectorName: z.string(),
  connectorVersion: z.number().int(),
  status: ImportRunStatus,
  sourceName: z.string(),
  sourceSha256: z.string(),
  sourceSize: z.number().int(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  errorRows: z.number().int(),
  warningRows: z.number().int(),
  insertedRows: z.number().int(),
  updatedRows: z.number().int(),
  /** Übersetzbarer Fehlercode bei status=failed */
  failureCode: z.string().nullable(),
  createdAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
});
export type ImportRun = z.infer<typeof ImportRun>;

export const IMPORT_ERROR_CODES = [
  'required',
  'invalid_number',
  'invalid_integer',
  'invalid_date',
  'invalid_datetime',
  'invalid_boolean',
  'invalid_enum',
  'out_of_range',
  'implausible_date',
  'future_date',
  'athlete_not_found',
  'athlete_ambiguous',
  'duplicate_in_source',
  'missing_column',
  'invalid_row',
  /** Text länger als zulässig (params.max) */
  'too_long',
  /** Hinweis (warning): vorhandene Person bzw. vorhandener Eintrag wird mit geänderten Werten überschrieben */
  'will_update',
  /** Hinweis (warning, Zeile 0): Datei ist kein gültiges UTF-8, wurde als Windows-1252 gelesen */
  'encoding_fallback',
  /** Hinweis (warning, Zeile 0): API-Abruf nach maxPages Seiten beendet, evtl. unvollständig */
  'max_pages_reached',
  /** Zeile 0 eines fehlgeschlagenen API-Abrufs (params.status = HTTP-Status, falls vorhanden) */
  'source_unreachable',
  'invalid_response',
  /** Zeile 0: Quelle hat mehr Spalten als zulässig (params.max) */
  'too_many_columns',
  /** Zeile 0: Quelle hat mehr Zeilen bzw. Einträge als zulässig (params.max) */
  'too_many_rows',
  /** Zeile 0: Datei ist keine lesbare Excel-Datei (.xlsx) oder überschreitet eine Obergrenze (params.reason) */
  'invalid_file',
  /** Zeile 0: Tabellenblatt der Excel-Datei nicht gefunden (params.sheet) */
  'sheet_not_found',
  /** Hinweis (warning, Zeile 0): Excel-Kopfzeile automatisch weiter unten erkannt (params.headerRow) */
  'header_row_detected',
] as const;

/** Übersetzbare Gründe für status=failed eines Importlaufs (ImportRun.failureCode) */
export const IMPORT_FAILURE_CODES = [
  'missing_column',
  'source_unreachable',
  'invalid_response',
  'too_many_columns',
  'too_many_rows',
  'invalid_file',
  'sheet_not_found',
] as const;

export const ImportError = z.object({
  rowNumber: z.number().int(),
  field: z.string().nullable(),
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  rawValue: z.string().nullable(),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});

export const PreviewRow = z.object({
  rowNumber: z.number().int(),
  raw: z.record(z.string(), z.string().nullable()),
  mapped: z.record(z.string(), Scalar),
  status: z.enum(['valid', 'warning', 'error']),
});

export const ImportRunDetail = z.object({
  run: ImportRun,
  preview: z.object({ sourceColumns: z.array(z.string()), rows: z.array(PreviewRow) }),
  errorSummary: z.array(
    z.object({ code: z.string(), field: z.string().nullable(), count: z.number().int() }),
  ),
});

export const InspectResult = z.object({
  columns: z.array(z.string()),
  sampleRows: z.array(z.record(z.string(), z.string().nullable())),
  detectedDelimiter: z.string().nullable(),
  /** Excel: Namen aller Tabellenblätter der Datei (in Reihenfolge) und das gelesene Blatt */
  sheets: z.array(z.string()).optional(),
  sheet: z.string().optional(),
});

export const connectorRoutes = {
  'connectors.list': route({
    method: 'GET',
    path: '/api/v1/connectors',
    auth: ['data_steward'],
    summary: 'Datenquellen/Connectoren auflisten',
    tag: 'Datenquellen',
    response: z.object({ items: z.array(Connector) }),
  }),
  'connectors.templates': route({
    method: 'GET',
    path: '/api/v1/connector-templates',
    auth: ['data_steward'],
    summary: 'Mitgelieferte Connector-Vorlagen',
    tag: 'Datenquellen',
    response: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
          definition: ConnectorDefinition,
        }),
      ),
    }),
  }),
  'connectors.get': route({
    method: 'GET',
    path: '/api/v1/connectors/:id',
    auth: ['data_steward'],
    summary: 'Connector mit Zuordnung',
    tag: 'Datenquellen',
    params: IdParam,
    response: Connector,
  }),
  'connectors.create': route({
    method: 'POST',
    path: '/api/v1/connectors',
    auth: ['data_steward'],
    summary: 'Connector anlegen',
    tag: 'Datenquellen',
    body: ConnectorInput,
    response: Connector,
  }),
  'connectors.update': route({
    method: 'PATCH',
    path: '/api/v1/connectors/:id',
    auth: ['data_steward'],
    summary: 'Connector ändern (erhöht die Version)',
    tag: 'Datenquellen',
    params: IdParam,
    body: ConnectorInput.omit({ slug: true }).partial(),
    response: Connector,
  }),
  'connectors.setSecret': route({
    method: 'PUT',
    path: '/api/v1/connectors/:id/secret',
    auth: ['data_steward'],
    summary:
      'Zugangsgeheimnis der API-Quelle (Token, Schlüssel oder OAuth2-Client-Geheimnis) setzen oder entfernen (verschlüsselt gespeichert, nie wieder ausgegeben)',
    tag: 'Datenquellen',
    params: IdParam,
    body: z.object({ secret: z.string().min(1).max(4000).nullable() }),
    response: Ok,
  }),
  'connectors.export': route({
    method: 'GET',
    path: '/api/v1/connectors/:id/export',
    auth: ['data_steward'],
    summary: 'Portable Connector-Definition (ohne Geheimnisse) exportieren',
    tag: 'Datenquellen',
    params: IdParam,
    response: ConnectorDefinition,
  }),
  'connectors.import': route({
    method: 'POST',
    path: '/api/v1/connectors/import',
    auth: ['data_steward'],
    summary: 'Connector-Definition importieren (optional mit Datensatz-Struktur)',
    tag: 'Datenquellen',
    body: z.object({ definition: ConnectorDefinition, createDataset: z.boolean().default(true) }),
    response: Connector,
  }),
  'connectors.inspect': route({
    method: 'POST',
    path: '/api/v1/connectors/inspect',
    auth: ['data_steward'],
    summary:
      'Beispieldatei (CSV, Excel) oder API-Antwort analysieren (Spalten, Beispielzeilen, Tabellenblätter) für die Zuordnung',
    tag: 'Datenquellen',
    body: 'multipart',
    response: InspectResult,
  }),
  'imports.start': route({
    method: 'POST',
    path: '/api/v1/connectors/:id/runs',
    auth: ['data_steward'],
    summary:
      'Import starten: CSV- oder Excel-Datei hochladen (Feld "file") oder API abrufen; erzeugt Vorschau mit Prüfergebnis',
    tag: 'Importe',
    params: IdParam,
    body: 'multipart',
    response: ImportRunDetail,
  }),
  'imports.list': route({
    method: 'GET',
    path: '/api/v1/connectors/:id/runs',
    auth: ['data_steward'],
    summary: 'Importläufe eines Connectors',
    tag: 'Importe',
    params: IdParam,
    response: z.object({ items: z.array(ImportRun) }),
  }),
  'imports.get': route({
    method: 'GET',
    path: '/api/v1/import-runs/:id',
    auth: ['data_steward'],
    summary: 'Importlauf mit Vorschau und Fehlerübersicht',
    tag: 'Importe',
    params: IdParam,
    response: ImportRunDetail,
  }),
  'imports.errors': route({
    method: 'GET',
    path: '/api/v1/import-runs/:id/errors',
    auth: ['data_steward'],
    summary: 'Fehlerprotokoll eines Importlaufs',
    tag: 'Importe',
    params: IdParam,
    query: Pagination,
    response: paginated(ImportError),
  }),
  'imports.commit': route({
    method: 'POST',
    path: '/api/v1/import-runs/:id/commit',
    auth: ['data_steward'],
    summary: 'Geprüfte Zeilen übernehmen',
    tag: 'Importe',
    params: IdParam,
    response: ImportRun,
  }),
  'imports.discard': route({
    method: 'POST',
    path: '/api/v1/import-runs/:id/discard',
    auth: ['data_steward'],
    summary: 'Importlauf verwerfen',
    tag: 'Importe',
    params: IdParam,
    response: ImportRun,
  }),
} as const;
