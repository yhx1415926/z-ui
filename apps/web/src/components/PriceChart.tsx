import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { useWidth } from './Charts.tsx';

/**
 * Apple-Stocks-style price chart: one 2px line over a light wash, colored by the direction of the
 * range (gain/loss tokens), an optional previous-close reference line, and a crosshair that snaps
 * to the nearest point. Points are spaced by index, so nights and weekends don't leave gaps.
 */

export type Point = [number, number];

/** ~4 round ticks covering [min, max]. */
function rangeTicks(min: number, max: number): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

export function PriceChart({
  points,
  base,
  baseLabel,
  color,
  height = 280,
  formatValue,
  formatAxis,
  formatTime,
  formatTick,
  label,
}: {
  points: Point[];
  /** Reference value drawn as a hairline (previous close on the 1D chart). */
  base?: number | null;
  baseLabel?: string;
  /** CSS color of the line and wash (gain or loss token). */
  color: string;
  height?: number;
  formatValue: (v: number) => string;
  formatAxis: (v: number) => string;
  formatTime: (t: number) => string;
  formatTick: (t: number) => string;
  /** Accessible name. */
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId();

  const m = { top: 12, right: 52, bottom: 24, left: 4 };
  const plotW = Math.max(0, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;

  const { lo, hi, ticks } = useMemo(() => {
    const values = points.map((p) => p[1]);
    if (base != null) values.push(base);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
    lo -= pad;
    hi += pad;
    return { lo, hi, ticks: rangeTicks(lo, hi) };
  }, [points, base]);

  const x = (i: number) => m.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => m.top + plotH - ((v - lo) / (hi - lo)) * plotH;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
  const area = points.length ? `${line}L${x(points.length - 1).toFixed(1)},${m.top + plotH}L${x(0).toFixed(1)},${m.top + plotH}Z` : '';
  // ~5 time labels, never colliding (~70px each).
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 70))));

  const pick = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    const i = Math.round(((clientX - r.left - m.left) / Math.max(1, plotW)) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (!points.length) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? points.length - 1) - step));
    else if (e.key === 'ArrowRight') setHover((h) => Math.min(points.length - 1, (h ?? 0) + step));
    else if (e.key === 'Home') setHover(0);
    else if (e.key === 'End') setHover(points.length - 1);
    else return;
    e.preventDefault();
  };

  const h = hover !== null ? points[hover] : undefined;
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover), 70), width - 70) : 0;

  return (
    <div
      ref={ref}
      className="viz-plot price-chart"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={label}
      onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
      onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKey}
      onBlur={() => setHover(null)}
    >
      {width > 0 && points.length > 0 && (
        <svg width={width} height={height} aria-hidden>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.14} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={m.left + plotW} y1={y(t)} y2={y(t)} className="viz-grid" />
              <text x={m.left + plotW + 6} y={y(t)} dy="0.32em" className="viz-tick">
                {formatAxis(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % labelEvery === 0 && x(i) < m.left + plotW - 30 ? (
              <text key={p[0]} x={x(i)} y={height - 6} className="viz-tick">
                {formatTick(p[0])}
              </text>
            ) : null,
          )}
          {base != null && (
            <g>
              <line x1={m.left} x2={m.left + plotW} y1={y(base)} y2={y(base)} className="price-base" />
              {baseLabel && (
                <text x={m.left + 4} y={y(base) - 4} className="viz-tick">
                  {baseLabel}
                </text>
              )}
            </g>
          )}
          <path d={area} fill={`url(#${gradient})`} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {h && hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + plotH} className="price-crosshair" />
              <circle cx={x(hover)} cy={y(h[1])} r={4} fill={color} className="price-dot" />
            </g>
          )}
        </svg>
      )}
      {h && (
        <div className="viz-tooltip" style={{ left: tipLeft, top: 0, minWidth: 0 }}>
          <div className="viz-tooltip-title">{formatTime(h[0])}</div>
          <div className="viz-tooltip-row">
            <i className="viz-linekey" style={{ background: color }} />
            <b className="num">{formatValue(h[1])}</b>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tiny trend line for list rows (no axes; the row carries the numbers). */
export function Sparkline({ points, base, color, width = 72, height = 30 }: { points: Point[]; base?: number | null; color: string; width?: number; height?: number }) {
  if (points.length < 2) return <svg width={width} height={height} aria-hidden />;
  const values = points.map((p) => p[1]);
  if (base != null) values.push(base);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const px = (i: number) => 1 + (i / (points.length - 1)) * (width - 2);
  const py = (v: number) => 2 + (1 - (v - lo) / span) * (height - 4);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(p[1]).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} aria-hidden className="sparkline">
      {base != null && <line x1={0} x2={width} y1={py(base)} y2={py(base)} className="price-base" />}
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
