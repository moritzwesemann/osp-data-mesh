/** Strukturiertes Logging als JSON-Zeilen auf stdout/stderr. Keine personenbezogenen Daten loggen. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(level: LogLevel = 'info', base: Record<string, unknown> = {}): Logger {
  const emit = (l: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[l] < ORDER[level]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: l, msg, ...base, ...fields });
    if (l === 'error' || l === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger(level, { ...base, ...f }),
  };
}

/** Logger, der nichts ausgibt (Tests) */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
