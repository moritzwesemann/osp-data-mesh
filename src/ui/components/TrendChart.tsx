import { useEffect, useRef, useState } from 'react';

export interface TrendPoint {
  /** Zeitpunkt (ISO) */
  at: string;
  value: number;
}

interface Props {
  points: readonly TrendPoint[];
  /** Zusammenfassung für Screenreader (Diagramm als Bild); die Werte stehen zusätzlich in der Tabelle */
  summary: string;
  formatValue: (n: number) => string;
  formatDate: (iso: string) => string;
  height?: number;
}

const M = { top: 14, right: 18, bottom: 26, left: 48 };

/** „Schöne“ Schrittweite für 3–5 Hilfslinien */
function niceStep(range: number): number {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/**
 * Verlauf einer Messgröße über die Zeit: eine Linie, Punkte je Messung, Hilfslinien, Wert am letzten Punkt,
 * Fadenkreuz mit Tooltip beim Überfahren. Pixelgenau (Breite per ResizeObserver), damit Punkte und Schrift
 * nicht verzerren.
 */
export function TrendChart({ points, summary, formatValue, formatDate, height = 200 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const xs = points.map((p) => Date.parse(p.at));
  const ys = points.map((p) => p.value);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const step = niceStep(yMax - yMin);
  yMin = Math.floor(yMin / step) * step;
  yMax = Math.ceil(yMax / step) * step;
  const ticks: number[] = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) ticks.push(Number(v.toFixed(10)));

  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;
  const x = (t: number) => M.left + (xMax === xMin ? innerW / 2 : ((t - xMin) / (xMax - xMin)) * innerW);
  const y = (v: number) => M.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
  const path = points.map((p, n) => `${n === 0 ? 'M' : 'L'}${x(xs[n] ?? 0)},${y(p.value)}`).join(' ');
  const last = points.length - 1;
  const lastPoint = points[last];
  const hovered = hover === null ? null : points[hover];

  const onMove = (clientX: number) => {
    const el = wrap.current;
    if (!el || points.length === 0) return;
    const px = clientX - el.getBoundingClientRect().left;
    let best = 0;
    for (let n = 1; n < points.length; n++) {
      if (Math.abs(x(xs[n] ?? 0) - px) < Math.abs(x(xs[best] ?? 0) - px)) best = n;
    }
    setHover(best);
  };

  return (
    <div ref={wrap} className="trend-chart" style={{ height }}>
      {width > 0 && (
        <svg
          onMouseLeave={() => setHover(null)}
          width={width}
          height={height}
          role="img"
          aria-label={summary}
          onMouseMove={(e) => onMove(e.clientX)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className="trend-grid" x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} />
              <text className="trend-axis" x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
                {formatValue(v)}
              </text>
            </g>
          ))}
          <text className="trend-axis" x={M.left} y={height - 6} textAnchor="start">
            {formatDate(points[0]?.at ?? '')}
          </text>
          {points.length > 1 && (
            <text className="trend-axis" x={width - M.right} y={height - 6} textAnchor="end">
              {formatDate(lastPoint?.at ?? '')}
            </text>
          )}
          {hovered && hover !== null && (
            <line
              className="trend-crosshair"
              x1={x(xs[hover] ?? 0)}
              x2={x(xs[hover] ?? 0)}
              y1={M.top}
              y2={M.top + innerH}
            />
          )}
          <path className="trend-line" d={path} />
          {points.map((p, n) => (
            <circle
              // Messungen können denselben Zeitpunkt haben; die Position in der sortierten Folge ist eindeutig
              // biome-ignore lint/suspicious/noArrayIndexKey: siehe oben
              key={`${p.at}-${n}`}
              className={hover === n ? 'trend-dot is-active' : 'trend-dot'}
              cx={x(xs[n] ?? 0)}
              cy={y(p.value)}
              r={hover === n ? 5.5 : 4}
            />
          ))}
          {lastPoint && hover === null && (
            <text
              className="trend-label"
              x={x(xs[last] ?? 0)}
              y={y(lastPoint.value) - 10}
              textAnchor={points.length > 1 ? 'end' : 'middle'}
            >
              {formatValue(lastPoint.value)}
            </text>
          )}
        </svg>
      )}
      {hovered && hover !== null && (
        <div
          className="trend-tip"
          style={{
            left: Math.min(Math.max(x(xs[hover] ?? 0), 70), width - 70),
            top: Math.max(y(hovered.value) - 52, 0),
          }}
        >
          <strong>{formatValue(hovered.value)}</strong>
          <span>{formatDate(hovered.at)}</span>
        </div>
      )}
    </div>
  );
}
