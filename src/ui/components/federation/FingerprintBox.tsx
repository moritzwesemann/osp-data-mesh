import { fingerprintLines } from './fingerprint.ts';

/** Fingerprint gut lesbar: zwei Zeilen zu je fünf Gruppen, auf allen Bildschirmbreiten gleich. */
export function FingerprintBox({ value }: { value: string }) {
  return (
    <div className="fingerprint">
      {fingerprintLines(value).map((line) => (
        <span key={line} className="fingerprint-line">
          {line}
        </span>
      ))}
    </div>
  );
}
