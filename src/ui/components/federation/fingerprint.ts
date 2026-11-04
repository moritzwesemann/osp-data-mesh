/** Fingerprint für Vergleiche normalisieren (Leerzeichen, Doppelpunkte, Bindestriche, Groß-/Kleinschreibung). */
export function normalizeFingerprint(value: string): string {
  return value.replace(/[\s:-]/g, '').toLowerCase();
}

/** Gekürzte Anzeige eines langen Fingerprints oder Hashes. */
export function shortHash(value: string | null | undefined, length = 19): string {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length)}…` : value;
}
