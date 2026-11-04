/**
 * Eingabefelder für die Quellkonfiguration: CSV-Upload oder HTTP-API.
 */
import type { z } from 'zod';
import { type CsvConfig, DateFormat, type HttpApiConfig } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import { FormField } from '../FormField.tsx';
import { dateFormatLabel, delimiterLabel, ENCODING_LABELS, formatKv, parseKv } from './shared.ts';

type FieldErr = (path: string) => string | undefined;

export const DEFAULT_CSV: CsvConfig = {
  type: 'csv',
  delimiter: 'auto',
  encoding: 'utf-8',
  decimalSeparator: '.',
  dateFormat: 'YYYY-MM-DD',
};

/** Bearbeitungszustand der API-Konfiguration (Zahlen als Text, Parameter als Zeilen). */
export interface ApiState {
  url: string;
  itemsPath: string;
  authType: 'none' | 'bearer' | 'header';
  headerName: string;
  paginationType: 'none' | 'page' | 'cursor';
  pageParam: string;
  sizeParam: string;
  pageSize: string;
  firstPage: '0' | '1';
  maxPages: string;
  cursorParam: string;
  nextCursorPath: string;
  queryText: string;
  dateFormat: DateFormat;
  timeoutMs: string;
}

export const DEFAULT_API: ApiState = {
  url: '',
  itemsPath: '',
  authType: 'none',
  headerName: '',
  paginationType: 'none',
  pageParam: 'page',
  sizeParam: '',
  pageSize: '100',
  firstPage: '1',
  maxPages: '50',
  cursorParam: 'cursor',
  nextCursorPath: '',
  queryText: '',
  dateFormat: 'ISO_DATETIME',
  timeoutMs: '15000',
};

export function apiStateFrom(cfg: HttpApiConfig): ApiState {
  const s: ApiState = {
    ...DEFAULT_API,
    url: cfg.url,
    itemsPath: cfg.itemsPath,
    authType: cfg.auth.type,
    headerName: cfg.auth.type === 'header' ? cfg.auth.headerName : '',
    paginationType: cfg.pagination.type,
    queryText: formatKv(cfg.query),
    dateFormat: cfg.dateFormat,
    timeoutMs: String(cfg.timeoutMs),
  };
  const p = cfg.pagination;
  if (p.type === 'page') {
    s.pageParam = p.pageParam;
    s.sizeParam = p.sizeParam ?? '';
    s.pageSize = String(p.pageSize);
    s.firstPage = p.firstPage === 0 ? '0' : '1';
    s.maxPages = String(p.maxPages);
  } else if (p.type === 'cursor') {
    s.cursorParam = p.cursorParam;
    s.nextCursorPath = p.nextCursorPath;
    s.maxPages = String(p.maxPages);
  }
  return s;
}

const num = (s: string): number => (s.trim() === '' ? Number.NaN : Number(s));

/** Zustand → Konfiguration laut Vertrag; queryInvalid bei fehlerhaften Parameterzeilen. */
export function buildApiConfig(s: ApiState): {
  config: z.input<typeof HttpApiConfig>;
  queryInvalid: boolean;
} {
  const query = parseKv(s.queryText);
  const auth: z.input<typeof HttpApiConfig>['auth'] =
    s.authType === 'header' ? { type: 'header', headerName: s.headerName.trim() } : { type: s.authType };
  let pagination: z.input<typeof HttpApiConfig>['pagination'] = { type: 'none' };
  if (s.paginationType === 'page') {
    pagination = {
      type: 'page',
      pageParam: s.pageParam.trim(),
      sizeParam: s.sizeParam.trim() || undefined,
      pageSize: num(s.pageSize),
      firstPage: s.firstPage === '0' ? 0 : 1,
      maxPages: num(s.maxPages),
    };
  } else if (s.paginationType === 'cursor') {
    pagination = {
      type: 'cursor',
      cursorParam: s.cursorParam.trim(),
      nextCursorPath: s.nextCursorPath.trim(),
      maxPages: num(s.maxPages),
    };
  }
  return {
    config: {
      type: 'http_api',
      url: s.url.trim(),
      itemsPath: s.itemsPath.trim(),
      auth,
      pagination,
      query: query.map,
      dateFormat: s.dateFormat,
      timeoutMs: num(s.timeoutMs),
    },
    queryInvalid: query.invalid,
  };
}

function DateFormatSelect({
  value,
  onChange,
  fe,
}: {
  value: DateFormat;
  onChange: (v: DateFormat) => void;
  fe: FieldErr;
}) {
  const i = useI18n();
  return (
    <FormField label={i.t('connectors.dateFormat')} error={fe('config.dateFormat')}>
      {(a) => (
        <select
          {...a}
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value as DateFormat)}
        >
          {DateFormat.options.map((f) => (
            <option key={f} value={f}>
              {dateFormatLabel(i, f)}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}

export function CsvConfigFields({
  value,
  onChange,
  fe,
}: {
  value: CsvConfig;
  onChange: (v: CsvConfig) => void;
  fe: FieldErr;
}) {
  const i = useI18n();
  const { t } = i;
  const delimiters: CsvConfig['delimiter'][] = ['auto', ',', ';', '\t'];
  const encodings: CsvConfig['encoding'][] = ['utf-8', 'windows-1252', 'iso-8859-1'];
  return (
    <div className="form-grid">
      <FormField label={t('connectors.delimiter')} error={fe('config.delimiter')}>
        {(a) => (
          <select
            {...a}
            className="input"
            value={value.delimiter}
            onChange={(e) => onChange({ ...value, delimiter: e.target.value as CsvConfig['delimiter'] })}
          >
            {delimiters.map((d) => (
              <option key={d} value={d}>
                {delimiterLabel(i, d)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label={t('connectors.encoding')} error={fe('config.encoding')}>
        {(a) => (
          <select
            {...a}
            className="input"
            value={value.encoding}
            onChange={(e) => onChange({ ...value, encoding: e.target.value as CsvConfig['encoding'] })}
          >
            {encodings.map((enc) => (
              <option key={enc} value={enc}>
                {ENCODING_LABELS[enc]}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField label={t('connectors.decimalSeparator')} error={fe('config.decimalSeparator')}>
        {(a) => (
          <select
            {...a}
            className="input"
            value={value.decimalSeparator}
            onChange={(e) =>
              onChange({ ...value, decimalSeparator: e.target.value as CsvConfig['decimalSeparator'] })
            }
          >
            <option value=".">{t('connectors.decimalPoint')}</option>
            <option value=",">{t('connectors.decimalComma')}</option>
          </select>
        )}
      </FormField>
      <DateFormatSelect
        value={value.dateFormat}
        onChange={(dateFormat) => onChange({ ...value, dateFormat })}
        fe={fe}
      />
    </div>
  );
}

export function ApiConfigFields({
  value,
  onChange,
  fe,
  queryInvalid,
  secret,
}: {
  value: ApiState;
  onChange: (v: ApiState) => void;
  fe: FieldErr;
  queryInvalid?: boolean;
  /** nur beim Anlegen: Geheimnis direkt mit erfassen */
  secret?: { value: string; onChange: (v: string) => void } | null;
}) {
  const { t } = useI18n();
  const set = <K extends keyof ApiState>(k: K, v: ApiState[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="form-grid">
      <FormField
        className="span-2"
        label={t('connectors.url')}
        required
        hint={t('connectors.urlHint')}
        error={fe('config.url')}
      >
        {(a) => (
          <input
            {...a}
            className="input mono"
            type="url"
            inputMode="url"
            placeholder="https://"
            value={value.url}
            onChange={(e) => set('url', e.target.value)}
          />
        )}
      </FormField>
      <FormField
        className="span-2"
        label={t('connectors.itemsPath')}
        hint={t('connectors.itemsPathHint')}
        error={fe('config.itemsPath')}
      >
        {(a) => (
          <input
            {...a}
            className="input mono"
            value={value.itemsPath}
            onChange={(e) => set('itemsPath', e.target.value)}
          />
        )}
      </FormField>
      <FormField label={t('connectors.auth')} error={fe('config.auth')}>
        {(a) => (
          <select
            {...a}
            className="input"
            value={value.authType}
            onChange={(e) => set('authType', e.target.value as ApiState['authType'])}
          >
            <option value="none">{t('connectors.authNone')}</option>
            <option value="bearer">{t('connectors.authBearer')}</option>
            <option value="header">{t('connectors.authHeader')}</option>
          </select>
        )}
      </FormField>
      {value.authType === 'header' ? (
        <FormField label={t('connectors.headerName')} required error={fe('config.auth.headerName')}>
          {(a) => (
            <input
              {...a}
              className="input mono"
              placeholder="X-Api-Key"
              value={value.headerName}
              onChange={(e) => set('headerName', e.target.value)}
            />
          )}
        </FormField>
      ) : (
        <div />
      )}
      {secret && value.authType !== 'none' && (
        <FormField className="span-2" label={t('connectors.secret')} hint={t('connectors.secretHint')}>
          {(a) => (
            <input
              {...a}
              className="input"
              type="password"
              autoComplete="new-password"
              value={secret.value}
              onChange={(e) => secret.onChange(e.target.value)}
            />
          )}
        </FormField>
      )}
      <FormField label={t('connectors.pagination')} error={fe('config.pagination')}>
        {(a) => (
          <select
            {...a}
            className="input"
            value={value.paginationType}
            onChange={(e) => set('paginationType', e.target.value as ApiState['paginationType'])}
          >
            <option value="none">{t('connectors.paginationNone')}</option>
            <option value="page">{t('connectors.paginationPage')}</option>
            <option value="cursor">{t('connectors.paginationCursor')}</option>
          </select>
        )}
      </FormField>
      {value.paginationType !== 'none' ? (
        <FormField label={t('connectors.maxPages')} error={fe('config.pagination.maxPages')}>
          {(a) => (
            <input
              {...a}
              className="input"
              type="number"
              min={1}
              max={1000}
              value={value.maxPages}
              onChange={(e) => set('maxPages', e.target.value)}
            />
          )}
        </FormField>
      ) : (
        <div />
      )}
      {value.paginationType === 'page' && (
        <>
          <FormField label={t('connectors.pageParam')} required error={fe('config.pagination.pageParam')}>
            {(a) => (
              <input
                {...a}
                className="input mono"
                value={value.pageParam}
                onChange={(e) => set('pageParam', e.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('connectors.firstPage')} error={fe('config.pagination.firstPage')}>
            {(a) => (
              <select
                {...a}
                className="input"
                value={value.firstPage}
                onChange={(e) => set('firstPage', e.target.value === '0' ? '0' : '1')}
              >
                <option value="1">1</option>
                <option value="0">0</option>
              </select>
            )}
          </FormField>
          <FormField label={t('connectors.sizeParam')} error={fe('config.pagination.sizeParam')}>
            {(a) => (
              <input
                {...a}
                className="input mono"
                value={value.sizeParam}
                onChange={(e) => set('sizeParam', e.target.value)}
              />
            )}
          </FormField>
          <FormField label={t('connectors.pageSize')} error={fe('config.pagination.pageSize')}>
            {(a) => (
              <input
                {...a}
                className="input"
                type="number"
                min={1}
                max={1000}
                value={value.pageSize}
                onChange={(e) => set('pageSize', e.target.value)}
              />
            )}
          </FormField>
        </>
      )}
      {value.paginationType === 'cursor' && (
        <>
          <FormField label={t('connectors.cursorParam')} required error={fe('config.pagination.cursorParam')}>
            {(a) => (
              <input
                {...a}
                className="input mono"
                value={value.cursorParam}
                onChange={(e) => set('cursorParam', e.target.value)}
              />
            )}
          </FormField>
          <FormField
            label={t('connectors.nextCursorPath')}
            required
            hint={t('connectors.nextCursorPathHint')}
            error={fe('config.pagination.nextCursorPath')}
          >
            {(a) => (
              <input
                {...a}
                className="input mono"
                value={value.nextCursorPath}
                onChange={(e) => set('nextCursorPath', e.target.value)}
              />
            )}
          </FormField>
        </>
      )}
      <FormField
        className="span-2"
        label={t('connectors.queryParams')}
        hint={t('connectors.queryParamsHint')}
        error={queryInvalid ? t('connectors.kvInvalid') : fe('config.query')}
      >
        {(a) => (
          <textarea
            {...a}
            className="input mono"
            rows={3}
            value={value.queryText}
            onChange={(e) => set('queryText', e.target.value)}
          />
        )}
      </FormField>
      <DateFormatSelect value={value.dateFormat} onChange={(v) => set('dateFormat', v)} fe={fe} />
      <FormField label={t('connectors.timeoutMs')} error={fe('config.timeoutMs')}>
        {(a) => (
          <input
            {...a}
            className="input"
            type="number"
            min={1000}
            max={60000}
            step={1000}
            value={value.timeoutMs}
            onChange={(e) => set('timeoutMs', e.target.value)}
          />
        )}
      </FormField>
    </div>
  );
}
