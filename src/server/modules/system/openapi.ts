/**
 * OpenAPI-3.1-Dokument aus dem HTTP-Vertrag (src/shared/contract). Schemas über zod v4 `z.toJSONSchema`
 * (JSON Schema 2020-12, wie von OpenAPI 3.1 verwendet). Ausgeliefert unter GET /api/v1/openapi.json,
 * als Datei erzeugt mit `bun scripts/openapi.ts` (docs/api/openapi.json).
 */
import { z } from 'zod';
import { ErrorBody } from '../../../shared/contract/common.ts';
import { routes } from '../../../shared/contract/index.ts';
import type { RouteDef } from '../../../shared/contract/route.ts';
import { APP_VERSION } from '../../config.ts';

type JsonSchema = Record<string, unknown>;

function schemaOf(s: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as JsonSchema;
  return rest;
}

/** /api/v1/athletes/:id → /api/v1/athletes/{id} */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function operationId(id: string): string {
  return id.replace(/[._-]+([a-zA-Z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}

function parameters(def: RouteDef): JsonSchema[] {
  const out: JsonSchema[] = [];
  const add = (schema: z.ZodType | undefined, location: 'path' | 'query') => {
    if (!schema) return;
    const js = schemaOf(schema, 'input');
    const props = (js.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((js.required ?? []) as string[]);
    for (const [name, prop] of Object.entries(props)) {
      const { description, ...rest } = prop;
      out.push({
        name,
        in: location,
        required: location === 'path' ? true : required.has(name) && !('default' in prop),
        ...(description ? { description } : {}),
        schema: rest,
      });
    }
  };
  add(def.params, 'path');
  add(def.query, 'query');
  return out;
}

function security(def: RouteDef): JsonSchema[] {
  if (def.auth === 'public') return def.method === 'GET' ? [] : [{ csrfHeader: [] }];
  const session = def.method === 'GET' ? { sessionCookie: [] } : { sessionCookie: [], csrfHeader: [] };
  return [session, { bearerToken: [] }];
}

function accessNote(def: RouteDef): string {
  if (def.auth === 'public') return 'Öffentlich (ohne Anmeldung).';
  if (def.auth === 'authenticated') return 'Jede angemeldete Person.';
  return `Rollen: ${def.auth.join(', ')}.`;
}

const ERROR_RESPONSES: Record<string, string> = {
  '400': 'Eingabe ungültig (validation_failed, password_too_weak, …)',
  '401': 'Nicht angemeldet (unauthenticated) oder Anmeldedaten falsch (invalid_credentials)',
  '403': 'Keine Berechtigung (forbidden, csrf_failed, access_denied)',
  '404': 'Nicht gefunden (not_found)',
  '409': 'Konflikt (conflict)',
  '413': 'Anfrage zu groß (payload_too_large)',
  '429': 'Zu viele Anfragen (rate_limited)',
  '500': 'Interner Fehler (internal_error); Details nur im Fehlerprotokoll unter der Request-ID',
};

export function buildOpenApiDocument(opts: { serverUrl?: string } = {}): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  const tags = new Set<string>();

  for (const [id, raw] of Object.entries(routes)) {
    const def = raw as RouteDef;
    tags.add(def.tag);
    const errorRefs: Record<string, JsonSchema> = {};
    for (const code of Object.keys(ERROR_RESPONSES)) {
      if (def.auth === 'public' && (code === '401' || code === '403') && def.method === 'GET') continue;
      errorRefs[code] = { $ref: `#/components/responses/Error${code}` };
    }
    const content: Record<string, JsonSchema> = {
      'application/json': { schema: schemaOf(def.response, 'output') },
    };
    if (def.download) {
      content['text/csv'] = { schema: { type: 'string' } };
      content['application/xml'] = { schema: { type: 'string' } };
    }
    const op: JsonSchema = {
      operationId: operationId(id),
      'x-route-id': id,
      summary: def.summary,
      description: `${accessNote(def)}${def.download ? ' Liefert über ?format=… auch Dateien (Download).' : ''}`,
      tags: [def.tag],
      security: security(def),
      responses: { '200': { description: 'OK', content }, ...errorRefs },
    };
    if (Array.isArray(def.auth)) op['x-roles'] = def.auth;
    const params = parameters(def);
    if (params.length) op.parameters = params;
    if (def.body === 'multipart') {
      op.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                file: { type: 'string', contentMediaType: 'application/octet-stream', description: 'Datei' },
                config: { type: 'string', description: 'optionale Konfiguration als JSON' },
              },
              required: ['file'],
            },
          },
        },
      };
    } else if (def.body) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: schemaOf(def.body, 'input') } },
      };
    }
    const p = toOpenApiPath(def.path);
    paths[p] ??= {};
    paths[p][def.method.toLowerCase()] = op;
  }

  paths['/api/v1/openapi.json'] = {
    get: {
      operationId: 'openapi',
      summary: 'Dieses OpenAPI-Dokument',
      tags: ['Betrieb'],
      security: [],
      responses: {
        '200': {
          description: 'OpenAPI 3.1',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    },
  };

  const errorSchema = schemaOf(ErrorBody, 'output');
  const responses: Record<string, JsonSchema> = {};
  for (const [code, description] of Object.entries(ERROR_RESPONSES)) {
    responses[`Error${code}`] = {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'OSP-Data-Mesh Node API',
      version: APP_VERSION,
      description: [
        'REST-API eines OSP-Data-Nodes. Anmeldung per Sitzungs-Cookie (`osp_session`, Web-Oberfläche) oder',
        'API-Token (`Authorization: Bearer osp_…`, Werkzeuge wie Excel, Power BI, Python).',
        'Zustandsändernde Anfragen (alles außer GET) mit Sitzungs-Cookie sowie die Anmeldung selbst',
        'benötigen den Header `X-OSP-CSRF: 1`; Anfragen mit API-Token sind davon ausgenommen.',
        'Fehler werden als `{ "error": { "code", "requestId", "reason"?, "fields"? } }` geliefert;',
        'die Codes sind stabil und werden von Clients übersetzt. Das signierte Föderationsprotokoll',
        '(`/federation/v1/*`) ist nicht Teil dieses Dokuments (siehe Dokumentation "Protokoll").',
      ].join(' '),
      license: { name: 'EUPL-1.2', identifier: 'EUPL-1.2' },
    },
    ...(opts.serverUrl ? { servers: [{ url: opts.serverUrl }] } : {}),
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      schemas: { Error: errorSchema },
      responses,
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'osp_session',
          description: 'Sitzung nach POST /api/v1/auth/login (HttpOnly, SameSite=Strict)',
        },
        bearerToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'API-Token (osp_…), erzeugt unter POST /api/v1/auth/tokens; ohne CSRF-Header',
        },
        csrfHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-OSP-CSRF',
          description:
            'CSRF-Schutz: Wert "1"; Pflicht für nicht-GET-Anfragen mit Sitzungs-Cookie und für die Anmeldung',
        },
      },
    },
  };
}
