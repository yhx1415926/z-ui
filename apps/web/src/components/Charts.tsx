import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Small hand-rolled SVG/HTML charts (no chart library: keeps the bundle small).
 * Colors come from the --viz-* tokens in global.css, which have separate light/dark steps.
 * Text always uses text tokens; series color only appears on marks and legend keys.
 */

export interface Series {
  key: string;
  label: string;
  /** CSS color, normally a var(--viz-*) token. */
  color: string;
}

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round the axis maximum up to 1/2/2.5/5 × 10^n and return ~4 ticks. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

/** Column path with a 4px rounded data end and a square baseline. */
function columnPath(x: number, w: number, yTop: number, yBase: number) {
  const h = yBase - yTop;
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${yBase}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBase}Z`;
}

export function Legend({ series, values }: { series: Series[]; values?: Record<string, ReactNode> }) {
  return (
    <div className="viz-legend">
      {series.map((s) => (
        <span key={s.key} className="viz-legend-item">
          <i className="viz-swatch" style={{ background: s.color }} />
          <span>{s.label}</span>
          {values?.[s.key] !== undefined && <b className="num">{values[s.key]}</b>}
        </span>
      ))}
    </div>
  );
}

/**
 * Grouped columns over a category axis (months). One shared tooltip per column group,
 * listing every series; hovering anywhere in the group's band selects it.
 */
export function GroupedColumns<T extends { label: string }>({
  data,
  series,
  value,
  format,
  formatAxis,
  title,
  height = 240,
}: {
  data: T[];
  series: Series[];
  value: (d: T, key: string) => number;
  format: (n: number) => string;
  formatAxis: (n: number) => string;
  title: (d: T) => string;
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const max = useMemo(() => Math.max(0, ...data.flatMap((d) => series.map((s) => value(d, s.key)))), [data, series, value]);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;

  const m = { top: 8, right: 4, bottom: 22, left: 44 };
  const plotW = Math.max(0, width - m.left - m.right);
  const plotH = height - m.top - m.bottom;
  const band = data.length ? plotW / data.length : 0;
  // Bars ≤ 24px, 2px surface gap between neighbours; leftover band is air.
  const barW = Math.max(2, Math.min(24, (band * 0.7 - 2 * (series.length - 1)) / series.length));
  const groupW = barW * series.length + 2 * (series.length - 1);
  const y = (v: number) => m.top + plotH - (Math.max(0, v) / top) * plotH;
  // Thin out month labels so they never collide (~44px each).
  const every = Math.max(1, Math.ceil(44 / Math.max(band, 1)));

  const h = hover !== null ? data[hover] : undefined;
  const tipLeft = hover !== null ? m.left + band * hover + band / 2 : 0;

  return (
    <div ref={ref} className="viz-plot" style={{ height }} onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(' / ')}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-baseline' : 'viz-grid'} />
              <text x={m.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick">
                {formatAxis(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = m.left + band * i + (band - groupW) / 2;
            return (
              <g
                key={d.label}
                tabIndex={0}
                role="graphics-symbol"
                aria-label={`${title(d)}: ${series.map((s) => `${s.label} ${format(value(d, s.key))}`).join(', ')}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="viz-group"
              >
                {/* Hit target: the whole band, taller than the marks. */}
                <rect x={m.left + band * i} y={m.top} width={band} height={plotH} className={hover === i ? 'viz-hit is-active' : 'viz-hit'} />
                {series.map((s, k) => (
                  <path key={s.key} d={columnPath(x0 + k * (barW + 2), barW, y(value(d, s.key)), y(0))} fill={s.color} className="viz-mark" />
                ))}
                {i % every === 0 && (
                  <text x={m.left + band * i + band / 2} y={height - 6} textAnchor="middle" className="viz-tick">
                    {d.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {h && (
        <div className="viz-tooltip" style={{ left: Math.min(Math.max(tipLeft, 80), width - 80), top: 4 }}>
          <div className="viz-tooltip-title">{title(h)}</div>
          {series.map((s) => (
            <div key={s.key} className="viz-tooltip-row">
              <i className="viz-linekey" style={{ background: s.color }} />
              <b className="num">{format(value(h, s.key))}</b>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface RankRow {
  key: string;
  label: ReactNode;
  /** Plain-text label for the accessible name. */
  text: string;
  values: Record<string, number>;
  hint?: string;
}

/**
 * Ranked horizontal bars, value at the tip. With one series the bar length is the share
 * of the largest row; with several, rows hold one thin bar per series.
 */
export function RankBars({
  rows,
  series,
  format,
  total,
  limit = 10,
  otherLabel,
}: {
  rows: RankRow[];
  series: Series[];
  format: (n: number) => string;
  /** Shown as a share next to the value when given (single series). */
  total?: number;
  limit?: number;
  otherLabel: string;
}) {
  const shown = useMemo(() => {
    if (rows.length <= limit) return rows;
    // Never a generated 11th color/row: the tail folds into "other".
    const head = rows.slice(0, limit - 1);
    const rest = rows.slice(limit - 1);
    const values: Record<string, number> = {};
    for (const s of series) values[s.key] = rest.reduce((a, r) => a + (r.values[s.key] ?? 0), 0);
    return [...head, { key: '__other', label: otherLabel, text: otherLabel, values, hint: `${rest.length}` }];
  }, [rows, series, limit, otherLabel]);
  const max = Math.max(1, ...shown.flatMap((r) => series.map((s) => Math.abs(r.values[s.key] ?? 0))));

  return (
    <div className="viz-rank">
      {shown.map((r) => (
        <div
          key={r.key}
          className="viz-rank-row"
          tabIndex={0}
          aria-label={`${r.text}: ${series.map((s) => `${s.label} ${format(r.values[s.key] ?? 0)}`).join(', ')}`}
          title={r.hint}
        >
          <div className="viz-rank-label">{r.label}</div>
          <div className="viz-rank-bars">
            {series.map((s) => {
              const v = r.values[s.key] ?? 0;
              return (
                <div key={s.key} className="viz-rank-line">
                  <div className="viz-rank-track">
                    {v !== 0 && <div className="viz-rank-bar" style={{ width: `${(Math.abs(v) / max) * 100}%`, background: s.color }} />}
                  </div>
                  <span className="viz-rank-value num">
                    {format(v)}
                    {total ? <span className="muted"> · {((v / total) * 100).toFixed(1)}%</span> : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
