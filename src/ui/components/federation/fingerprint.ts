/** Fingerprint für Vergleiche normalisieren (Leerzeichen, Doppelpunkte, Bindestriche, Groß-/Kleinschreibung). */
export function normalizeFingerprint(value: string): string {
  return value.replace(/[\s:-]/g, '').toLowerCase();
}

/** Gekürzte Anzeige eines langen Fingerprints oder Hashes. */
export function shortHash(value: string | null | undefined, length = 19): string {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

/** Fingerprint in Zeilen zu je fünf Vierergruppen (zum Vorlesen beim telefonischen Abgleich). */
export function fingerprintLines(value: string, groupsPerLine = 5): string[] {
  const groups = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += groupsPerLine)
    lines.push(groups.slice(i, i + groupsPerLine).join(' '));
  return lines;
}
