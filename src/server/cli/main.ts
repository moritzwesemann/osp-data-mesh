/**
 * Betriebs-Kommandozeile eines OSP-Data-Nodes: `bun run cli <befehl> [optionen]`.
 * Exit-Codes: 0 ok, 1 Fehler, 2 falscher Aufruf. Geheimnisse werden nie ausgegeben, außer dem
 * erzeugten Initialpasswort (create-admin) bzw. Schlüssel (gen-key), für die der Befehl existiert.
 */
import { commands, UsageError } from './commands.ts';

export const HELP = `OSP-Data-Mesh – Betriebs-CLI / operations CLI

Aufruf / usage:  bun run cli <befehl> [optionen]

Befehle / commands:
  migrate                          Migrationen anwenden (MESH_DB_OWNER_URL), üblicher Aufruf:
                                   bun --env-file=.env --env-file=.env.owner run cli migrate
  db-bootstrap [--superuser-url <url>] [--db mesh] [--force]
                                   Rollen + Datenbank anlegen (deploy/postgres/bootstrap.sql); Superuser-URL
                                   bevorzugt aus MESH_DB_SUPERUSER_URL (nicht auf der Kommandozeile);
                                   Passwörter aus MESH_DB_OWNER_PASSWORD, MESH_DB_APP_PASSWORD, MESH_DB_BI_PASSWORD.
                                   Ein PostgreSQL-Cluster je Knoten: bricht ab, wenn der Cluster schon eine
                                   andere Datenbank von mesh_owner enthält (außer mit --force)
  gen-key                          zufälligen 32-Byte-Schlüssel (base64) ausgeben
  create-admin --email <e> --name <n>
                                   Administrator anlegen (MESH_DB_URL); Passwort aus MESH_ADMIN_PASSWORD,
                                   sonst erzeugt und einmalig angezeigt (muss bei Anmeldung geändert werden)
  backup                           verschlüsselte Sicherung erstellen (Server-Konfiguration + MESH_BACKUP_KEY)
  restore --file <datei.mbk> --yes [--allow-other-node] [--force]
                                   Sicherung wiederherstellen (MESH_DB_OWNER_URL, MESH_BACKUP_KEY, MESH_NODE_ID).
                                   Der Knoten MUSS dabei gestoppt sein: bricht ab, solange der Server mit der
                                   Datenbank verbunden ist (außer mit --force). Alle Sitzungen werden beendet.
  verify-audit                     Hash-Kette des Audit-Logs prüfen (Exit 1 bei Bruch)
  rotate-master-key                Geheimnisse mit neuem Master-Key neu verschlüsseln
                                   (MESH_MASTER_KEY = neu, MESH_MASTER_KEY_PREVIOUS = alt, MESH_DB_URL)
  node-card                        Knotenkarte (JSON) für die Vertrauensaufnahme ausgeben
  help                             diese Hilfe

Exit-Codes: 0 ok, 1 Fehler / failure, 2 falscher Aufruf / usage error
`;

export async function runCli(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    process.stdout.write(HELP);
    return name ? 0 : 2;
  }
  const cmd = commands[name];
  if (!cmd) {
    process.stderr.write(`Unbekannter Befehl / unknown command: ${name}\n\n${HELP}`);
    return 2;
  }
  try {
    return await cmd(rest);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`Aufruf / usage: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`Fehler / error: ${(err as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
