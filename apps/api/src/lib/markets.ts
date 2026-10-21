import type { ChartSeries } from '@z-ui/shared';

/**
 * Manual market-data sync. Everything is fetched only when the user presses "sync", so the
 * free tiers of the APIs (and Cloudflare's 50 subrequests per request) are never a problem.
 * The one exception: symbols with an active price alert are checked by the cron during US
 * market hours (lib/cron.ts).
 */

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; z-ui personal ledger)' };

export interface FxQuote {
  perUsd: Record<string, number>;
  asOf: string;
  source: string;
}

/** USD-based rates: open.er-api.com (160+ currencies, no key), falling back to Frankfurter (ECB). */
export async function fetchFxRates(f: typeof fetch): Promise<FxQuote> {
  const errors: string[] = [];
  try {
    const r = await f('https://open.er-api.com/v6/latest/USD', { headers: UA });
    const j = (await r.json()) as { result?: string; rates?: Record<string, number>; time_last_update_unix?: number };
    if (j.result === 'success' && j.rates) {
      const asOf = new Date((j.time_last_update_unix ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);
      return { perUsd: j.rates, asOf, source: 'exchangerate-api.com' };
    }
    errors.push(`open.er-api: ${j.result ?? r.status}`);
  } catch (e) {
    errors.push(`open.er-api: ${(e as Error).message}`);
  }
  try {
    const r = await f('https://api.frankfurter.dev/v1/latest?base=USD', { headers: UA });
    const j = (await r.json()) as { date?: string; rates?: Record<string, number> };
    if (j.rates) return { perUsd: { USD: 1, ...j.rates }, asOf: j.date ?? new Date().toISOString().slice(0, 10), source: 'frankfurter (ECB)' };
    errors.push(`frankfurter: ${r.status}`);
  } catch (e) {
    errors.push(`frankfurter: ${(e as Error).message}`);
  }
  throw new Error(`FX sync failed — ${errors.join('; ')}`);
}

export interface StockQuote {
  symbol: string;
  price: number;
  /** Previous session's close (the day's change). */
  prevClose: number | null;
  name: string | null;
  at: number;
  source: string;
}

export type QuoteFailure = 'not_found' | 'error' | 'skipped';

export class QuoteError extends Error {
  constructor(
    readonly reason: QuoteFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Outgoing fetches left for this request (Workers Free: 50 subrequests, D1 queries included). */
export class FetchBudget {
  constructor(public left: number) {}
  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
}

const yahooSymbol = (symbol: string) => symbol.replace(/\./g, '-'); // BRK.B → BRK-B

async function finnhubQuote(f: typeof fetch, symbol: string, key: string, budget: FetchBudget): Promise<StockQuote> {
  if (!budget.take()) throw new QuoteError('skipped', 'no budget left');
  let j: { c?: number; pc?: number; t?: number };
  try {
    const r = await f(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    j = (await r.json()) as typeof j;
  } catch (e) {
    throw new QuoteError('error', `finnhub: ${(e as Error).message}`);
  }
  // Finnhub answers unknown tickers with c = 0; Yahoo then decides whether it exists.
  if (!j.c || j.c <= 0) throw new QuoteError('error', 'finnhub: no price');
  return { symbol, price: j.c, prevClose: j.pc || null, name: null, at: (j.t ?? Date.now() / 1000) * 1000, source: 'finnhub' };
}

interface YahooChart {
  chart?: {
    result?:
      | {
          meta?: {
            regularMarketPrice?: number;
            regularMarketTime?: number;
            previousClose?: number;
            chartPreviousClose?: number;
            longName?: string;
            shortName?: string;
          };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[]
      | null;
    error?: { code?: string; description?: string } | null;
  };
}

/** Yahoo's chart API: range + bar size → the latest quote and the closes. */
async function yahooChart(f: typeof fetch, symbol: string, query: string, host: 'query1' | 'query2', budget: FetchBudget) {
  if (!budget.take()) throw new QuoteError('skipped', 'no budget left');
  let r: Response;
  try {
    r = await f(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?${query}`, { headers: UA });
  } catch (e) {
    throw new QuoteError('error', `yahoo: ${(e as Error).message}`);
  }
  const j = (await r.json().catch(() => null)) as YahooChart | null;
  const result = j?.chart?.result?.[0];
  const meta = result?.meta;
  if (meta?.regularMarketPrice) {
    const quote: StockQuote = {
      symbol,
      price: meta.regularMarketPrice,
      // Only a one-day range's chartPreviousClose is the previous session's close.
      prevClose: meta.previousClose ?? (query.startsWith('range=1d&') ? meta.chartPreviousClose : null) ?? null,
      name: meta.longName ?? meta.shortName ?? null,
      at: (meta.regularMarketTime ?? Date.now() / 1000) * 1000,
      source: 'yahoo',
    };
    return { quote, result: result!, chartPrevClose: meta.chartPreviousClose ?? null };
  }
  // 404 "No data found, symbol may be delisted" (or an empty result): the ticker doesn't exist.
  if (r.status === 404 || j?.chart?.error?.code === 'Not Found' || (r.ok && j?.chart?.result?.length === 0)) {
    throw new QuoteError('not_found', `yahoo: ${j?.chart?.error?.description ?? 'unknown symbol'}`);
  }
  throw new QuoteError('error', `yahoo: HTTP ${r.status}`); // 429 / 5xx: try again later
}

async function yahooQuote(f: typeof fetch, symbol: string, host: 'query1' | 'query2', budget: FetchBudget): Promise<StockQuote> {
  return (await yahooChart(f, symbol, 'range=1d&interval=1d', host, budget)).quote;
}

/** Range and bar size of each stored chart series (see CHART_SERIES). */
const SERIES_QUERY: Record<ChartSeries, string> = {
  '1d': 'range=1d&interval=5m',
  '5d': 'range=5d&interval=30m',
  '1y': 'range=1y&interval=1d',
  '5y': 'range=5y&interval=1wk',
  max: 'range=max&interval=1mo',
};

export interface ChartFetch {
  quote: StockQuote;
  /** [unix seconds, close] with 4 decimals; bars without a close are dropped. */
  points: [number, number][];
  /** Close before the first point (the 1D chart's baseline is the previous session's close). */
  prevClose: number | null;
}

/** One price history from Yahoo, retried once on the other host for temporary failures. */
export async function fetchChart(f: typeof fetch, symbol: string, series: ChartSeries, budget: FetchBudget): Promise<ChartFetch> {
  let hit;
  try {
    hit = await yahooChart(f, symbol, SERIES_QUERY[series], 'query1', budget);
  } catch (e) {
    if (!(e instanceof QuoteError) || e.reason !== 'error') throw e;
    hit = await yahooChart(f, symbol, SERIES_QUERY[series], 'query2', budget);
  }
  const ts = hit.result.timestamp ?? [];
  const close = hit.result.indicators?.quote?.[0]?.close ?? [];
  const points: [number, number][] = [];
  ts.forEach((t, i) => {
    const c = close[i];
    if (typeof c === 'number' && Number.isFinite(c)) points.push([t, Math.round(c * 1e4) / 1e4]);
  });
  return { quote: hit.quote, points, prevClose: series === '1d' ? hit.quote.prevClose : hit.chartPrevClose };
}

/** Closest US ticker for a symbol the quote source doesn't know (APPL → AAPL). */
export async function suggestSymbol(f: typeof fetch, query: string, budget: FetchBudget): Promise<string | null> {
  if (!budget.take()) return null;
  try {
    const r = await f(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`, { headers: UA });
    if (!r.ok) return null;
    const j = (await r.json()) as { quotes?: { symbol?: string; quoteType?: string }[] };
    const hit = (j.quotes ?? []).find((q) => q.symbol && ['EQUITY', 'ETF'].includes(q.quoteType ?? '') && /^[A-Z][A-Z0-9-]{0,9}$/.test(q.symbol));
    const sym = hit?.symbol?.replace(/-/g, '.') ?? null;
    return sym && sym !== query ? sym : null;
  } catch {
    return null;
  }
}

export interface QuoteBatch {
  quotes: StockQuote[];
  failed: { symbol: string; reason: 'not_found' | 'error'; suggestion: string | null }[];
  /** Symbols not attempted (over the per-request limits). */
  skipped: string[];
}

/**
 * Prices for many tickers within a fetch budget, in three rounds: first source for each symbol
 * (Finnhub with a key, else Yahoo); then one retry on the other host/source for temporary
 * failures; then a ticker search for up to 5 unknown symbols to suggest a correction.
 */
export async function fetchQuotes(f: typeof fetch, symbols: string[], opts: { finnhubKey?: string; budget: FetchBudget }): Promise<QuoteBatch> {
  const { finnhubKey, budget } = opts;
  const out: QuoteBatch = { quotes: [], failed: [], skipped: [] };
  const errors = new Map<string, QuoteError>();
  const round = async (list: string[], get: (s: string) => Promise<StockQuote>) => {
    const res = await Promise.allSettled(list.map(get));
    res.forEach((r, i) => {
      const s = list[i]!;
      if (r.status === 'fulfilled') {
        out.quotes.push(r.value);
        errors.delete(s);
      } else errors.set(s, r.reason instanceof QuoteError ? r.reason : new QuoteError('error', String(r.reason)));
    });
  };
  await round(symbols, (s) => (finnhubKey ? finnhubQuote(f, s, finnhubKey, budget) : yahooQuote(f, s, 'query1', budget)));
  const retry = [...errors].filter(([, e]) => e.reason === 'error').map(([s]) => s);
  await round(retry, (s) => yahooQuote(f, s, finnhubKey ? 'query1' : 'query2', budget));

  const unknown = [...errors].filter(([, e]) => e.reason === 'not_found').map(([s]) => s);
  const suggestions = new Map<string, string | null>();
  await Promise.all(unknown.slice(0, 5).map(async (s) => suggestions.set(s, await suggestSymbol(f, s, budget))));
  for (const [symbol, e] of errors) {
    if (e.reason === 'skipped') out.skipped.push(symbol);
    else out.failed.push({ symbol, reason: e.reason, suggestion: suggestions.get(symbol) ?? null });
  }
  return out;
}

export interface IntradayBatch {
  charts: (ChartFetch & { symbol: string })[];
  failed: QuoteBatch['failed'];
  skipped: string[];
}

/** Watchlist sync: today's intraday chart (with the quote and previous close) for each symbol. */
export async function fetchIntradayBatch(f: typeof fetch, symbols: string[], budget: FetchBudget): Promise<IntradayBatch> {
  const out: IntradayBatch = { charts: [], failed: [], skipped: [] };
  const res = await Promise.allSettled(symbols.map((s) => fetchChart(f, s, '1d', budget)));
  const unknown: string[] = [];
  const errors: string[] = [];
  res.forEach((r, i) => {
    const symbol = symbols[i]!;
    if (r.status === 'fulfilled') out.charts.push({ ...r.value, symbol });
    else {
      const reason = r.reason instanceof QuoteError ? r.reason.reason : 'error';
      if (reason === 'skipped') out.skipped.push(symbol);
      else if (reason === 'not_found') unknown.push(symbol);
      else errors.push(symbol);
    }
  });
  const suggestions = await Promise.all(unknown.slice(0, 5).map((s) => suggestSymbol(f, s, budget)));
  out.failed.push(
    ...unknown.map((symbol, i) => ({ symbol, reason: 'not_found' as const, suggestion: suggestions[i] ?? null })),
    ...errors.map((symbol) => ({ symbol, reason: 'error' as const, suggestion: null })),
  );
  return out;
}
