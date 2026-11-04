/**
 * Konfiguration ausschließlich über Umgebungsvariablen (12-Factor). Siehe .env.example und docs/betrieb.md.
 */
import { z } from 'zod';
import { proxyListIssue } from './core/client-ip.ts';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const base64Key = z.string().refine((s) => {
  try {
    return Buffer.from(s, 'base64').length === 32;
  } catch {
    return false;
  }
}, 'must be 32 bytes, base64 encoded (bun run cli gen-key)');

const ConfigSchema = z.object({
  MESH_NODE_ID: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  MESH_NODE_NAME: z.string().min(1).max(200),
  /** Öffentliche Basis-URL dieses Knotens für Partner (in Produktion https://…) */
  MESH_PUBLIC_URL: z.url(),
  MESH_HOST: z.string().default('127.0.0.1'),
  MESH_PORT: z.coerce.number().int().min(1).max(65535).default(4401),
  /** Laufzeit-Verbindung (Rolle mesh_app) */
  MESH_DB_URL: z.string().startsWith('postgres'),
  MESH_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Master-Key für die Verschlüsselung gespeicherter Geheimnisse (AES-256-GCM) */
  MESH_MASTER_KEY: base64Key,
  /** Vorheriger Master-Key während einer Rotation (nur lesen) */
  MESH_MASTER_KEY_PREVIOUS: base64Key.optional(),
  /** Schlüssel für Sicherungsdateien (AES-256-GCM); ohne Schlüssel sind Sicherungen deaktiviert */
  MESH_BACKUP_KEY: base64Key.optional(),
  MESH_BACKUP_DIR: z.string().default('./backups'),
  MESH_BACKUP_INTERVAL_HOURS: z.coerce.number().min(0).max(168).default(24),
  MESH_BACKUP_RETENTION: z.coerce.number().int().min(1).max(365).default(14),
  /** Pfad zu pg_dump (Sicherung) */
  MESH_PG_DUMP: z.string().default('pg_dump'),
  /** Secure-Flag für Cookies; nur für lokale HTTP-Demo auf false setzen */
  MESH_COOKIE_SECURE: bool.default(true),
  MESH_SESSION_TTL_HOURS: z.coerce.number().min(1).max(72).default(12),
  /** Erlaubt http:// für Partneradressen (nur lokale Demo/Tests) */
  MESH_FEDERATION_ALLOW_HTTP: bool.default(false),
  /** Kommagetrennte Liste erlaubter Hosts (host[:port]) für API-Quellen (SSRF-Schutz). Leer = keine API-Quellen. */
  MESH_SOURCE_ALLOWED_HOSTS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  /**
   * Zugangsgeheimnisse von API-Quellen auch über unverschlüsseltes http:// senden (Standard false).
   * Ohne diese Einstellung nur über https:// bzw. an 127.0.0.1, ::1 und localhost.
   */
  MESH_SOURCE_ALLOW_INSECURE_HTTP: bool.default(false),
  /** X-Forwarded-For auswerten (nur hinter vertrauenswürdigem Reverse Proxy, z. B. Caddy) */
  MESH_TRUST_PROXY: bool.default(false),
  /**
   * Adressen der vertrauenswürdigen Reverse Proxys (kommagetrennt; IPv4, IPv6 oder Netz in CIDR-Schreibweise).
   * X-Forwarded-For gilt nur für Verbindungen von diesen Adressen (und nur mit MESH_TRUST_PROXY=true).
   */
  MESH_TRUSTED_PROXIES: z
    .string()
    .default('127.0.0.1,::1')
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .superRefine((list, ctx) => {
      const issue = proxyListIssue(list);
      if (issue) ctx.addIssue({ code: 'custom', message: issue });
    }),
  MESH_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Zeitzone für Datumsgrenzen (Einwilligungen) */
  MESH_TIMEZONE: z.string().default('Europe/Berlin'),
  /** Verzeichnis der gebauten Web-Oberfläche */
  MESH_UI_DIR: z.string().default('./dist/ui'),
  /** Verzeichnis der gebauten HTML-Dokumentation */
  MESH_DOCS_DIR: z.string().default('./dist/docs'),
  /** BI-Verbindungsdaten zur Anzeige in der Oberfläche (optional) */
  MESH_BI_DB_HOST: z.string().optional(),
  MESH_BI_DB_PORT: z.coerce.number().int().optional(),
  MESH_BI_DB_NAME: z.string().optional(),
  /** Hintergrundaufgaben (Outbox, Aufbewahrung, BI, Sicherungen) aktivieren */
  MESH_WORKERS: bool.default(true),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const cfg = parsed.data;
  if (!cfg.MESH_FEDERATION_ALLOW_HTTP && !cfg.MESH_PUBLIC_URL.startsWith('https://')) {
    throw new Error(
      'Invalid configuration:\n  MESH_PUBLIC_URL: must use https:// (or set MESH_FEDERATION_ALLOW_HTTP=true for local demos)',
    );
  }
  return cfg;
}

export const APP_VERSION = '0.1.0';
