/** Klassennamen zusammensetzen. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Liest eine JSON-Datei; wirft bei ungültigem Inhalt. */
export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  return JSON.parse(text) as unknown;
}

/** Erzeugt eine lokale, stabile ID für Listeneinträge in Formularen. */
let counter = 0;
export function uid(prefix = 'k'): string {
  counter += 1;
  return `${prefix}${counter}`;
}

/** YYYY-MM-DD des heutigen Tages in Europe/Berlin. */
export function todayBerlin(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** ISO-Zeitstempel → Wert für <input type="datetime-local"> (lokale Zeit des Browsers). */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Wert aus <input type="datetime-local"> → ISO-Zeitstempel mit Offset (UTC) oder null. */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Leere Zeichenkette → null (für optionale Felder). */
export function emptyToNull(s: string): string | null {
  const v = s.trim();
  return v === '' ? null : v;
}
