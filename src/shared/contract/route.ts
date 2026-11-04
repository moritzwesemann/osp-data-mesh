import type { z } from 'zod';
import type { Role } from './common.ts';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Zugriffsregel einer Route:
 *  - 'public'         ohne Anmeldung (nur Login, Health)
 *  - 'authenticated'  jede angemeldete Person
 *  - Role[]           mindestens eine der Rollen
 */
export type AuthRule = 'public' | 'authenticated' | readonly Role[];

export interface RouteDef<
  P extends z.ZodType | undefined = z.ZodType | undefined,
  Q extends z.ZodType | undefined = z.ZodType | undefined,
  B extends z.ZodType | 'multipart' | undefined = z.ZodType | 'multipart' | undefined,
  R extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  /** Hono-Pfad, z. B. /api/v1/athletes/:id */
  path: string;
  auth: AuthRule;
  /** Kurzbeschreibung (deutsch) für die OpenAPI-Dokumentation */
  summary: string;
  tag: string;
  params?: P;
  query?: Q;
  /** zod-Schema für JSON-Bodies oder 'multipart' für Datei-Uploads (Feld "file", optional Feld "config" als JSON) */
  body?: B;
  /** Antwortschema für JSON-Antworten. Ausgaben werden serverseitig hiergegen geprüft (unbekannte Felder werden entfernt). */
  response: R;
  /** true, wenn die Route über ?format=csv|xml|json auch Dateien liefert */
  download?: boolean;
}

export function route<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | 'multipart' | undefined = undefined,
  R extends z.ZodType = z.ZodType,
>(def: RouteDef<P, Q, B, R>): RouteDef<P, Q, B, R> {
  return def;
}

type InferOr<T, Fallback> = T extends z.ZodType ? z.infer<T> : Fallback;
type InputOf<T, Fallback> = T extends z.ZodType ? z.input<T> : Fallback;

export type RouteParams<D> =
  D extends RouteDef<infer P, infer _Q, infer _B, infer _R> ? InferOr<P, Record<string, never>> : never;
export type RouteQuery<D> =
  D extends RouteDef<infer _P, infer Q, infer _B, infer _R> ? InferOr<Q, Record<string, never>> : never;
export type RouteBody<D> =
  D extends RouteDef<infer _P, infer _Q, infer B, infer _R>
    ? B extends 'multipart'
      ? FormData
      : InferOr<B, undefined>
    : never;
export type RouteResponse<D> = D extends RouteDef<infer _P, infer _Q, infer _B, infer R> ? z.infer<R> : never;

/** Eingaben aus Sicht des Clients (vor Defaults/Coercion). */
export type RouteClientInput<D> =
  D extends RouteDef<infer P, infer Q, infer B, infer _R>
    ? (P extends z.ZodType ? { params: InputOf<P, never> } : { params?: undefined }) &
        (Q extends z.ZodType ? { query?: Partial<InputOf<Q, never>> } : { query?: undefined }) &
        (B extends 'multipart'
          ? { body: FormData }
          : B extends z.ZodType
            ? { body: InputOf<B, never> }
            : { body?: undefined })
    : never;
