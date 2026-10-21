import { and, asc, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Hono } from 'hono';
import {
  CHART_SERIES,
  microsToString,
  priceAlertPatchSchema,
  priceAlertSchema,
  stockSymbolSchema,
  toMicros,
  watchAddSchema,
  watchOrderSchema,
  type ChartDto,
  type ChartSeries,
  type PriceAlertDto,
  type QuoteProblem,
  type WatchItemDto,
  type WatchSyncDto,
} from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { priceAlerts, priceSeries, securities, watchlist } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { chunkIds, inChunks } from '../lib/chunks.ts';
import { body, fail, notFound } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { runBatch } from '../lib/ledger.ts';
import { fetchChart, fetchIntradayBatch, FetchBudget, QuoteError, type ChartFetch } from '../lib/markets.ts';
import { alertTriggerOps, storeQuoteOps } from '../lib/prices.ts';

/**
 * Watchlist with Apple-Stocks-style charts, and price alerts. Prices and histories are fetched only
 * when the user presses sync (the alerts are also checked by the cron, see lib/cron.ts).
 */

/** Same limits as the holdings sync: 30 symbols, 40 fetches (Workers Free: 50 subrequests). */
const MAX_SYNC = 30;
const FETCH_BUDGET = 40;
const MAX_WATCH = 100;
/** Sparkline resolution on the list. */
const SPARK_POINTS = 60;

const str = (m: number | null | undefined) => (m === null || m === undefined ? null : microsToString(m));

/** Every n-th point (and always the last) so the list stays light. */
function thin(points: [number, number][], n: number): [number, number][] {
  if (points.length <= n) return points;
  const step = points.length / n;
  const out: [number, number][] = [];
  for (let i = 0; i < n - 1; i++) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

export async function watchItems(db: DB, userId: string): Promise<WatchItemDto[]> {
  const rows = await db
    .select({ w: watchlist, s: securities })
    .from(watchlist)
    .leftJoin(securities, eq(securities.symbol, watchlist.symbol))
    .where(eq(watchlist.userId, userId))
    .orderBy(asc(watchlist.sort), asc(watchlist.createdAt));
  if (rows.length === 0) return [];
  const symbols = rows.map((r) => r.w.symbol);
  const [spark, alerts] = await Promise.all([
    inChunks(symbols, (part) => db.select().from(priceSeries).where(and(eq(priceSeries.series, '1d'), inArray(priceSeries.symbol, part)))),
    db
      .select({ symbol: priceAlerts.symbol, n: count() })
      .from(priceAlerts)
      .where(and(eq(priceAlerts.userId, userId), eq(priceAlerts.active, true)))
      .groupBy(priceAlerts.symbol),
  ]);
  return rows.map(({ w, s }) => ({
    symbol: w.symbol,
    name: s?.name ?? null,
    price: str(s?.priceMicros),
    priceAt: s?.priceAt ?? null,
    prevClose: str(s?.prevCloseMicros),
    spark: thin(spark.find((x) => x.symbol === w.symbol)?.points ?? [], SPARK_POINTS),
    alerts: alerts.find((a) => a.symbol === w.symbol)?.n ?? 0,
  }));
}

async function chartDto(db: DB, symbol: string): Promise<ChartDto> {
  const [[sec], rows] = await Promise.all([
    db.select().from(securities).where(eq(securities.symbol, symbol)),
    db.select().from(priceSeries).where(eq(priceSeries.symbol, symbol)),
  ]);
  return {
    symbol,
    name: sec?.name ?? null,
    price: str(sec?.priceMicros),
    priceAt: sec?.priceAt ?? null,
    series: CHART_SERIES.flatMap((k) => {
      const r = rows.find((x) => x.series === k);
      return r ? [{ series: k, points: r.points, prevClose: r.prevCloseMicros === null ? null : r.prevCloseMicros / 1e6, syncedAt: r.syncedAt }] : [];
    }),
  };
}

/** Store fetched histories (replacing the previous copy of each). */
function seriesOps(db: DB, symbol: string, list: { series: ChartSeries; chart: ChartFetch }[], t: number): BatchItem<'sqlite'>[] {
  return list.map(({ series, chart }) =>
    db
      .insert(priceSeries)
      .values({ symbol, series, points: chart.points, prevCloseMicros: chart.prevClose ? toMicros(chart.prevClose.toFixed(6)) : null, syncedAt: t })
      .onConflictDoUpdate({
        target: [priceSeries.symbol, priceSeries.series],
        set: { points: sql`excluded.points`, prevCloseMicros: sql`excluded.prev_close_micros`, syncedAt: sql`excluded.synced_at` },
      }),
  );
}

const alertDto = (a: typeof priceAlerts.$inferSelect): PriceAlertDto => ({
  id: a.id,
  symbol: a.symbol,
  direction: a.direction,
  target: microsToString(a.targetMicros),
  active: a.active,
  triggeredAt: a.triggeredAt,
  triggeredPrice: str(a.triggeredPriceMicros),
  note: a.note,
  createdAt: a.createdAt,
});

async function userAlerts(db: DB, userId: string) {
  return (await db.select().from(priceAlerts).where(eq(priceAlerts.userId, userId)).orderBy(desc(priceAlerts.createdAt))).map(alertDto);
}

async function ownAlert(db: DB, userId: string, id: string) {
  const [r] = await db.select().from(priceAlerts).where(and(eq(priceAlerts.id, id), eq(priceAlerts.userId, userId)));
  return r ?? notFound('alert');
}

export const watchRoutes = new Hono<AppBindings>()
  .get('/', async (c) => c.json(await watchItems(c.var.deps.db, c.var.user.id)))

  .post('/', async (c) => {
    const { symbol } = await body(c, watchAddSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const [n] = await db.select({ n: count(), last: max(watchlist.sort) }).from(watchlist).where(eq(watchlist.userId, userId));
    if ((n?.n ?? 0) >= MAX_WATCH) fail(400, `at most ${MAX_WATCH} symbols`, 'WATCH_FULL');
    const t = now();
    await runBatch(db, [
      db.insert(securities).values({ symbol, updatedAt: t }).onConflictDoNothing(),
      db
        .insert(watchlist)
        .values({ userId, symbol, sort: (n?.last ?? -1) + 1, createdAt: t })
        .onConflictDoNothing(),
    ]);
    return c.json(await watchItems(db, userId), 201);
  })

  .put('/order', async (c) => {
    const { symbols } = await body(c, watchOrderSchema);
    const { db } = c.var.deps;
    const userId = c.var.user.id;
    const indexed = symbols.map((symbol, i) => ({ symbol, i }));
    // 3 parameters per symbol (case pair + IN list) + 1 → 30 per statement.
    await runBatch(
      db,
      chunkIds(indexed, 30).map((part) =>
        db
          .update(watchlist)
          .set({ sort: sql`case ${watchlist.symbol} ${sql.join(part.map((x) => sql`when ${x.symbol} then ${x.i}`), sql` `)} else ${watchlist.sort} end` })
          .where(and(eq(watchlist.userId, userId), inArray(watchlist.symbol, part.map((x) => x.symbol)))),
      ),
    );
    return c.json(await watchItems(db, userId));
  })

  .delete('/:symbol', async (c) => {
    const symbol = stockSymbolSchema.parse(c.req.param('symbol'));
    const { db } = c.var.deps;
    await db.delete(watchlist).where(and(eq(watchlist.userId, c.var.user.id), eq(watchlist.symbol, symbol)));
    return c.json(await watchItems(db, c.var.user.id));
  })

  /** Latest price, previous close and today's intraday chart of the watchlist (stalest first). */
  .post('/sync', async (c) => {
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const list = await db
      .select({ symbol: watchlist.symbol, at: securities.priceAt })
      .from(watchlist)
      .leftJoin(securities, eq(securities.symbol, watchlist.symbol))
      .where(eq(watchlist.userId, userId));
    const stale = list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map((x) => x.symbol);
    const symbols = stale.slice(0, MAX_SYNC);
    const batch = await fetchIntradayBatch(c.var.deps.fetch ?? fetch, symbols, new FetchBudget(FETCH_BUDGET));
    const t = now();
    const quotes = batch.charts.map((x) => x.quote);
    const alerts = await alertTriggerOps(db, quotes, t);
    await runBatch(db, [
      ...storeQuoteOps(db, quotes, t),
      ...batch.charts.flatMap((x) => seriesOps(db, x.symbol, [{ series: '1d', chart: x }], t)),
      ...alerts.ops,
    ]);
    const result: WatchSyncDto = {
      items: await watchItems(db, userId),
      updated: batch.charts.length,
      failed: batch.failed as QuoteProblem[],
      remaining: stale.length - symbols.length + batch.skipped.length,
    };
    return c.json(result);
  })

  .get('/chart/:symbol', async (c) => c.json(await chartDto(c.var.deps.db, stockSymbolSchema.parse(c.req.param('symbol')))))

  /** Fetch every history of one symbol (5 requests), so all chart ranges are available. */
  .post('/chart/:symbol/sync', async (c) => {
    const symbol = stockSymbolSchema.parse(c.req.param('symbol'));
    const { db, now } = c.var.deps;
    const f = c.var.deps.fetch ?? fetch;
    const budget = new FetchBudget(10);
    const res = await Promise.allSettled(CHART_SERIES.map((series) => fetchChart(f, symbol, series, budget)));
    const got = res.flatMap((r, i) => (r.status === 'fulfilled' ? [{ series: CHART_SERIES[i]!, chart: r.value }] : []));
    if (got.length === 0) {
      const e = (res[0] as PromiseRejectedResult).reason;
      if (e instanceof QuoteError && e.reason === 'not_found') fail(404, `unknown symbol ${symbol}`, 'UNKNOWN_SYMBOL');
      fail(502, String((e as Error)?.message ?? e), 'UPSTREAM');
    }
    const t = now();
    // The intraday fetch carries the freshest quote and the previous close.
    const quote = (got.find((x) => x.series === '1d') ?? got[0]!).chart.quote;
    const alerts = await alertTriggerOps(db, [quote], t);
    await runBatch(db, [...storeQuoteOps(db, [quote], t), ...seriesOps(db, symbol, got, t), ...alerts.ops]);
    return c.json({ ...(await chartDto(db, symbol)), failed: CHART_SERIES.filter((s) => !got.some((x) => x.series === s)) });
  })

  .get('/alerts', async (c) => c.json(await userAlerts(c.var.deps.db, c.var.user.id)))

  .post('/alerts', async (c) => {
    const input = await body(c, priceAlertSchema);
    const { db, now } = c.var.deps;
    const t = now();
    await runBatch(db, [
      db.insert(securities).values({ symbol: input.symbol, updatedAt: t }).onConflictDoNothing(),
      db.insert(priceAlerts).values({
        id: newId(),
        userId: c.var.user.id,
        symbol: input.symbol,
        direction: input.direction,
        targetMicros: toMicros(input.target),
        active: true,
        note: input.note ?? null,
        createdAt: t,
        updatedAt: t,
      }),
    ]);
    return c.json(await userAlerts(db, c.var.user.id), 201);
  })

  /** Edit or re-arm an alert: changing the target or direction (or active: true) arms it again. */
  .patch('/alerts/:id', async (c) => {
    const input = await body(c, priceAlertPatchSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownAlert(db, userId, c.req.param('id'));
    const target = input.target !== undefined ? toMicros(input.target) : cur.targetMicros;
    const direction = input.direction ?? cur.direction;
    const rearm = input.active === true || (input.active === undefined && (target !== cur.targetMicros || direction !== cur.direction));
    await db
      .update(priceAlerts)
      .set({
        symbol: input.symbol ?? cur.symbol,
        direction,
        targetMicros: target,
        note: input.note !== undefined ? (input.note ?? null) : cur.note,
        ...(rearm ? { active: true, triggeredAt: null, triggeredPriceMicros: null } : input.active === false ? { active: false } : {}),
        updatedAt: now(),
      })
      .where(and(eq(priceAlerts.id, cur.id), eq(priceAlerts.userId, userId)));
    return c.json(await userAlerts(db, userId));
  })

  .delete('/alerts/:id', async (c) => {
    const { db } = c.var.deps;
    const cur = await ownAlert(db, c.var.user.id, c.req.param('id'));
    await db.delete(priceAlerts).where(eq(priceAlerts.id, cur.id));
    return c.json(await userAlerts(db, c.var.user.id));
  });
