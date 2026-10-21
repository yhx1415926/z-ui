import { BellOutlined, CloseOutlined, DeleteOutlined, HolderOutlined, PlusOutlined, RedoOutlined, StarFilled, StarOutlined, SyncOutlined, TableOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Drawer, Empty, Grid, Input, InputNumber, Popconfirm, Segmented, Space, Table, Tag, Tooltip } from 'antd';
import { useMemo, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CHART_RANGES,
  RANGE_SERIES,
  type AlertDirection,
  type ChartDto,
  type ChartRange,
  type PriceAlertDto,
  type QuoteProblem,
  type WatchItemDto,
  type WatchSyncDto,
} from '@z-ui/shared';
import { del, patch, post, put } from '../api/client.ts';
import { useAction, useAlerts, useChart, useWatchlist } from '../api/hooks.ts';
import { useLocale, useMoney } from '../lib/format.ts';
import { PriceChart, Sparkline, type Point } from './PriceChart.tsx';

const UP = 'var(--income)';
const DOWN = 'var(--expense)';
const SYMBOL = /^[A-Za-z][A-Za-z0-9.-]{0,9}$/;
const RANGE_KEY = 'zui-chart-range';
const DAYS: Partial<Record<ChartRange, number>> = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '2Y': 731, '10Y': 3653 };

function readRange(): ChartRange {
  try {
    const v = localStorage.getItem(RANGE_KEY) as ChartRange | null;
    return v && CHART_RANGES.includes(v) ? v : '1D';
  } catch {
    return '1D';
  }
}

function useUsd() {
  const money = useMoney();
  return (n: number, signed = false) => money(Math.round(n * 100), 'USD', { signDisplay: signed ? 'exceptZero' : 'auto' });
}

/** Points of one chart range, cut from its stored series, and the value its change is measured from. */
function rangeData(chart: ChartDto | undefined, range: ChartRange): { points: Point[]; base: number | null; series: ChartDto['series'][number] | undefined } {
  const series = chart?.series.find((s) => s.series === RANGE_SERIES[range]);
  if (!series || series.points.length === 0) return { points: [], base: null, series };
  const last = series.points[series.points.length - 1]![0];
  const days = DAYS[range];
  const from = range === 'YTD' ? Date.UTC(new Date(last * 1000).getUTCFullYear(), 0, 1) / 1000 : days ? last - days * 86_400 : -Infinity;
  const points = series.points.filter((p) => p[0] >= from);
  const base = range === '1D' ? (series.prevClose ?? points[0]?.[1] ?? null) : (points[0]?.[1] ?? null);
  return { points, base, series };
}

/** Day change of a watchlist row, from the last synced price and previous close. */
function dayChange(w: Pick<WatchItemDto, 'price' | 'prevClose'>) {
  if (!w.price || !w.prevClose) return null;
  const p = Number(w.price);
  const prev = Number(w.prevClose);
  return { abs: p - prev, pct: prev ? (p / prev - 1) * 100 : 0 };
}

function ChangePill({ abs, pct, mode, onClick }: { abs: number; pct: number; mode: 'pct' | 'abs'; onClick?: () => void }) {
  const usd = useUsd();
  const cls = abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat';
  return (
    <button
      type="button"
      className={`change-pill ${cls}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      {mode === 'pct' ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : usd(abs, true)}
    </button>
  );
}

function useTimeFormats() {
  const locale = useLocale();
  return useMemo(() => {
    const et = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: 'America/New_York', hourCycle: 'h23', ...o });
    const time = et({ hour: '2-digit', minute: '2-digit' });
    const md = et({ month: '2-digit', day: '2-digit' });
    const ym = et({ year: 'numeric', month: '2-digit' });
    const y = et({ year: 'numeric' });
    const date = et({ year: 'numeric', month: '2-digit', day: '2-digit' });
    const full = et({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const at = (t: number) => new Date(t * 1000);
    return {
      tick: (range: ChartRange) => (t: number) =>
        (range === '1D' ? time : range === '1W' || DAYS[range] || range === 'YTD' ? md : range === '2Y' || range === '5Y' ? ym : y).format(at(t)),
      tip: (range: ChartRange) => (t: number) => (range === '1D' || range === '1W' ? `${full.format(at(t))} ET` : date.format(at(t))),
      when: (ms: number) => `${full.format(new Date(ms))} ET`,
    };
  }, [locale]);
}

// ---------------------------------------------------------------- detail

function AlertsBox({ symbol, price }: { symbol: string; price: number | null }) {
  const { t } = useTranslation();
  const usd = useUsd();
  const fmt = useTimeFormats();
  const { data: all = [] } = useAlerts();
  const alerts = all.filter((a) => a.symbol === symbol);
  const [direction, setDirection] = useState<AlertDirection>('above');
  const [target, setTarget] = useState<string | null>(null);
  const opts = { success: false as const, invalidate: ['alerts', 'watch', 'reminders'] };
  const add = useAction(async () => {
    await post<PriceAlertDto[]>('/watch/alerts', { symbol, direction, target });
    setTarget(null);
  }, opts);
  const rearm = useAction((a: PriceAlertDto) => patch(`/watch/alerts/${a.id}`, { active: true }), opts);
  const remove = useAction((a: PriceAlertDto) => del(`/watch/alerts/${a.id}`), opts);
  // Already past the target: it would fire on the next price update.
  const already = target && price !== null ? (direction === 'above' ? price >= Number(target) : price <= Number(target)) : false;

  return (
    <div className="watch-alerts">
      <div className="watch-section-title">
        <BellOutlined /> {t('watch.alerts')}
      </div>
      <Space.Compact block>
        <Segmented<AlertDirection>
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'above', label: t('watch.above') },
            { value: 'below', label: t('watch.below') },
          ]}
        />
        <InputNumber<string>
          stringMode
          min="0"
          precision={2}
          prefix="$"
          value={target}
          onChange={setTarget}
          placeholder={price !== null ? price.toFixed(2) : undefined}
          style={{ flex: 1 }}
          onPressEnter={() => target && add.mutate(undefined)}
          aria-label={t('watch.target')}
        />
        <Button type="primary" icon={<PlusOutlined />} disabled={!target || Number(target) <= 0} loading={add.isPending} onClick={() => add.mutate(undefined)}>
          {t('common.add')}
        </Button>
      </Space.Compact>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {already ? t('watch.alreadyPast') : t('watch.alertHint')}
      </div>
      {alerts.map((a) => (
        <div key={a.id} className="row-item" style={{ padding: '8px 0' }}>
          <div className="row-main">
            <div className="row-title num">
              {a.direction === 'above' ? '≥' : '≤'} {usd(Number(a.target))}
              {a.note ? <span className="muted"> · {a.note}</span> : null}
            </div>
            <div className="row-sub">
              {a.active ? (
                <Tag color="blue">{t('watch.armed')}</Tag>
              ) : a.triggeredAt ? (
                <span>
                  <Tag color="gold">{t('watch.fired')}</Tag>
                  {fmt.when(a.triggeredAt)} · {a.triggeredPrice ? usd(Number(a.triggeredPrice)) : ''}
                </span>
              ) : (
                <Tag>{t('watch.off')}</Tag>
              )}
            </div>
          </div>
          <Space size={0}>
            {!a.active && (
              <Tooltip title={t('watch.rearm')}>
                <Button type="text" size="small" icon={<RedoOutlined />} aria-label={t('watch.rearm')} onClick={() => rearm.mutate(a)} />
              </Tooltip>
            )}
            <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => remove.mutate(a)}>
              <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={t('common.delete')} />
            </Popconfirm>
          </Space>
        </div>
      ))}
    </div>
  );
}

function SymbolDetail({ symbol, item, inList, onClose }: { symbol: string; item?: WatchItemDto; inList: boolean; onClose?: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const usd = useUsd();
  const fmt = useTimeFormats();
  const { data: chart, isLoading } = useChart(symbol);
  const [range, setRangeState] = useState<ChartRange>(readRange);
  const [table, setTable] = useState(false);
  const setRange = (r: ChartRange) => {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* this visit only */
    }
  };

  const sync = useAction(() => post<ChartDto & { failed: string[] }>(`/watch/chart/${symbol}/sync`), { success: false, invalidate: ['watch', 'alerts', 'invest'] });
  const add = useAction(() => post('/watch', { symbol }), { success: t('watch.added'), invalidate: ['watch'] });
  const remove = useAction(() => del(`/watch/${symbol}`), { success: false, invalidate: ['watch'] });

  const { points, base, series } = rangeData(chart, range);
  const priceStr = chart?.price ?? item?.price ?? null;
  const price = priceStr !== null ? Number(priceStr) : null;
  // 1D compares the latest price with the previous close; longer ranges the first point with the last.
  const end = range === '1D' && price !== null ? price : (points[points.length - 1]?.[1] ?? null);
  const change = end !== null && base !== null ? { abs: end - base, pct: base ? (end / base - 1) * 100 : 0 } : null;
  const color = change && change.abs < 0 ? DOWN : UP;
  const values = points.map((p) => p[1]);
  const year = chart?.series.find((s) => s.series === '1y')?.points.map((p) => p[1]) ?? [];
  const stats = [
    { k: 'high', v: values.length ? usd(Math.max(...values)) : '—' },
    { k: 'low', v: values.length ? usd(Math.min(...values)) : '—' },
    { k: 'prevClose', v: item?.prevClose ? usd(Number(item.prevClose)) : chart?.series[0]?.series === '1d' && chart.series[0].prevClose ? usd(chart.series[0].prevClose) : '—' },
    { k: 'high52', v: year.length ? usd(Math.max(...year)) : '—' },
    { k: 'low52', v: year.length ? usd(Math.min(...year)) : '—' },
    { k: 'priceAt', v: chart?.priceAt ? fmt.when(chart.priceAt) : '—' },
  ];

  return (
    <div className="watch-detail">
      <div className="watch-detail-head">
        <div style={{ minWidth: 0 }}>
          <div className="watch-detail-symbol">{symbol}</div>
          <div className="muted ellipsis">{chart?.name ?? item?.name ?? ''}</div>
        </div>
        <Space size={4} wrap style={{ justifyContent: 'flex-end' }}>
          <Tooltip title={inList ? t('watch.remove') : t('watch.add')}>
            <Button
              type="text"
              icon={inList ? <StarFilled style={{ color: 'var(--ant-color-warning)' }} /> : <StarOutlined />}
              aria-label={inList ? t('watch.remove') : t('watch.add')}
              onClick={() => (inList ? remove.mutate(undefined) : add.mutate(undefined))}
            />
          </Tooltip>
          <Button
            icon={<SyncOutlined spin={sync.isPending} />}
            loading={sync.isPending}
            onClick={() =>
              sync.mutate(undefined, {
                onSuccess: (r) => {
                  qc.setQueryData(['chart', symbol], r);
                  if (r.failed.length) void message.warning(t('watch.chartPartial', { list: r.failed.join(', ') }));
                  else void message.success(t('watch.chartSynced'));
                },
              })
            }
          >
            {t('watch.syncChart')}
          </Button>
          {onClose && <Button type="text" icon={<CloseOutlined />} aria-label={t('common.close')} onClick={onClose} />}
        </Space>
      </div>

      <div className="watch-price">
        <span className="watch-price-value num">{price !== null ? usd(price) : '—'}</span>
        {change && (
          <span className={`num ${change.abs > 0 ? 'income' : change.abs < 0 ? 'expense' : ''}`} style={{ fontWeight: 600 }}>
            {usd(change.abs, true)} ({change.pct > 0 ? '+' : ''}
            {change.pct.toFixed(2)}%)
          </span>
        )}
        <span className="muted">{t(`watch.rangeLabel.${range}`)}</span>
      </div>

      <div className="watch-ranges">
        <Segmented<ChartRange> size="small" value={range} onChange={setRange} options={CHART_RANGES.map((r) => ({ value: r, label: t(`watch.ranges.${r}`) }))} />
        <Tooltip title={t('watch.table')}>
          <Button type={table ? 'primary' : 'text'} size="small" icon={<TableOutlined />} aria-label={t('watch.table')} aria-pressed={table} onClick={() => setTable(!table)} />
        </Tooltip>
      </div>

      {points.length > 1 ? (
        table ? (
          <Table<Point>
            size="small"
            rowKey={(p) => p[0]}
            dataSource={[...points].reverse()}
            pagination={{ pageSize: 10, size: 'small', showSizeChanger: false }}
            columns={[
              { title: t('common.date'), key: 't', render: (_, p) => <span className="num">{fmt.tip(range)(p[0])}</span> },
              { title: t('watch.close'), key: 'c', align: 'right', render: (_, p) => <span className="num">{usd(p[1])}</span> },
            ]}
          />
        ) : (
          <PriceChart
            points={points}
            base={range === '1D' ? base : null}
            baseLabel={t('watch.prevClose')}
            color={color}
            formatValue={(v) => usd(v)}
            formatAxis={(v) => v.toFixed(v >= 1000 ? 0 : 2)}
            formatTime={fmt.tip(range)}
            formatTick={fmt.tick(range)}
            label={`${symbol} ${t(`watch.ranges.${range}`)}`}
          />
        )
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ padding: '48px 0' }}
          description={isLoading ? '…' : series ? t('watch.noPoints') : t('watch.noChart')}
        >
          {!isLoading && (
            <Button type="primary" icon={<SyncOutlined />} loading={sync.isPending} onClick={() => sync.mutate(undefined, { onSuccess: (r) => qc.setQueryData(['chart', symbol], r) })}>
              {t('watch.syncChart')}
            </Button>
          )}
        </Empty>
      )}
      {series && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t('watch.syncedAt', { time: new Date(series.syncedAt).toLocaleString() })}</div>}

      <div className="watch-stats">
        {stats.map((s) => (
          <div key={s.k}>
            <div className="muted">{t(`watch.stats.${s.k}`)}</div>
            <div className="num">{s.v}</div>
          </div>
        ))}
      </div>

      <AlertsBox symbol={symbol} price={price} />
    </div>
  );
}

// ---------------------------------------------------------------- list

export function WatchPanel({ symbol, onSymbol, held }: { symbol: string | null; onSymbol: (s: string | null) => void; held: Set<string> }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const screens = Grid.useBreakpoint();
  const usd = useUsd();
  const { data: items = [], isLoading } = useWatchlist();
  const [mode, setMode] = useState<'pct' | 'abs'>('pct');
  const [adding, setAdding] = useState('');
  const [problems, setProblems] = useState<QuoteProblem[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);

  const add = useAction((s: string) => post<WatchItemDto[]>('/watch', { symbol: s }), { success: false, invalidate: ['watch'] });
  const remove = useAction((s: string) => del<WatchItemDto[]>(`/watch/${s}`), { success: false, invalidate: ['watch'] });
  const sync = useAction(() => post<WatchSyncDto>('/watch/sync'), { success: false, invalidate: ['watch', 'alerts', 'invest', 'reminders'] });
  const order = useAction((symbols: string[]) => put<WatchItemDto[]>('/watch/order', { symbols }), { success: false, invalidate: ['watch'] });

  const submitAdd = () => {
    const s = adding.trim().toUpperCase();
    if (!SYMBOL.test(s)) return void message.warning(t('watch.badSymbol'));
    add.mutate(s, { onSuccess: () => (setAdding(''), onSymbol(s)) });
  };
  const fixSymbol = (p: QuoteProblem) => {
    if (!p.suggestion) return;
    add.mutate(p.suggestion, {
      onSuccess: () => {
        remove.mutate(p.symbol);
        setProblems((list) => list.filter((x) => x.symbol !== p.symbol));
        if (symbol === p.symbol) onSymbol(p.suggestion);
      },
    });
  };
  const drop = (e: DragEvent, target: string) => {
    e.preventDefault();
    if (!dragging || dragging === target) return;
    const list = items.map((x) => x.symbol).filter((s) => s !== dragging);
    list.splice(list.indexOf(target), 0, dragging);
    qc.setQueryData<WatchItemDto[]>(['watch'], (old) => list.map((s) => old!.find((x) => x.symbol === s)!));
    order.mutate(list);
    setDragging(null);
  };

  const lastSync = items.reduce((m, x) => Math.max(m, x.priceAt ?? 0), 0);
  const selected = symbol ? items.find((x) => x.symbol === symbol) : undefined;
  const detail = symbol ? <SymbolDetail key={symbol} symbol={symbol} item={selected} inList={!!selected} onClose={screens.lg ? undefined : () => onSymbol(null)} /> : null;

  const list = (
    <Card
      className="watch-list-card"
      styles={{ body: { padding: 0 } }}
      title={
        <Space.Compact block>
          <Input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onPressEnter={submitAdd}
            placeholder={t('watch.addPlaceholder')}
            maxLength={10}
            aria-label={t('watch.add')}
          />
          <Button icon={<PlusOutlined />} onClick={submitAdd} loading={add.isPending} aria-label={t('watch.add')} />
        </Space.Compact>
      }
      extra={
        <Tooltip title={lastSync ? t('watch.lastSync', { time: new Date(lastSync).toLocaleString() }) : t('watch.neverSynced')}>
          <Button
            icon={<SyncOutlined spin={sync.isPending} />}
            loading={sync.isPending}
            disabled={!items.length}
            onClick={() =>
              sync.mutate(undefined, {
                onSuccess: (r) => {
                  setProblems(r.failed);
                  qc.setQueryData(['watch'], r.items);
                  void qc.invalidateQueries({ queryKey: ['chart'] });
                  if (r.updated || !r.failed.length) void message.success(t('invest.synced', { n: r.updated }));
                  if (r.remaining) void message.info(t('watch.syncMore', { n: r.remaining }));
                },
              })
            }
          >
            {t('watch.sync')}
          </Button>
        </Tooltip>
      }
    >
      {problems.length > 0 && (
        <Alert
          type="warning"
          banner
          closable
          onClose={() => setProblems([])}
          message={problems.map((p) => (
            <div key={p.symbol} className="quote-problem">
              <b>{p.symbol}</b> <span className="muted">{p.reason === 'not_found' ? t('invest.notFound') : t('invest.tempError')}</span>{' '}
              {p.suggestion && (
                <Button size="small" type="link" onClick={() => fixSymbol(p)}>
                  {t('invest.useSuggestion', { symbol: p.suggestion })}
                </Button>
              )}
            </div>
          ))}
        />
      )}
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isLoading ? '…' : t('watch.empty')} style={{ padding: '32px 0' }} />
      ) : (
        <div role="list">
          {items.map((w) => {
            const ch = dayChange(w);
            return (
              <div
                key={w.symbol}
                role="listitem"
                className={`watch-row ${symbol === w.symbol ? 'active' : ''} ${dragging === w.symbol ? 'dragging' : ''}`}
                draggable
                onDragStart={() => setDragging(w.symbol)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => drop(e, w.symbol)}
                onClick={() => onSymbol(w.symbol)}
                onKeyDown={(e) => e.key === 'Enter' && onSymbol(w.symbol)}
                tabIndex={0}
              >
                <HolderOutlined className="watch-grip" aria-hidden />
                <div className="watch-name">
                  <div className="watch-symbol">
                    {w.symbol}
                    {held.has(w.symbol) && <span className="watch-badge">{t('watch.held')}</span>}
                    {w.alerts > 0 && <BellOutlined className="muted" style={{ fontSize: 12, marginInlineStart: 6 }} aria-label={t('watch.alerts')} />}
                  </div>
                  <div className="muted ellipsis" style={{ fontSize: 12 }}>
                    {w.name ?? '—'}
                  </div>
                </div>
                <Sparkline points={w.spark} base={w.prevClose ? Number(w.prevClose) : null} color={ch && ch.abs < 0 ? DOWN : UP} />
                <div className="watch-quote">
                  <div className="num" style={{ fontWeight: 600 }}>{w.price ? usd(Number(w.price)) : '—'}</div>
                  {ch ? (
                    <ChangePill
                      abs={ch.abs}
                      pct={ch.pct}
                      mode={mode}
                      onClick={() => {
                        setMode(mode === 'pct' ? 'abs' : 'pct');
                      }}
                    />
                  ) : (
                    <span className="change-pill flat">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );

  if (screens.lg) {
    return (
      <div className="watch-layout">
        {list}
        <Card className="watch-detail-card">{detail ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('watch.pick')} style={{ padding: '64px 0' }} />}</Card>
      </div>
    );
  }
  return (
    <>
      {list}
      <Drawer open={!!symbol} onClose={() => onSymbol(null)} placement="bottom" size="large" closable={false} styles={{ body: { padding: 16 } }} destroyOnHidden>
        {detail}
      </Drawer>
    </>
  );
}
