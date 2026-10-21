import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Hono, type Context } from 'hono';
import {
  grossMinor,
  microsToString,
  priceFromAmount,
  priceSchema,
  stockSymbolSchema,
  symbolRenameSchema,
  toMicros,
  tradeSchema,
  type InvestDto,
  type PriceSyncDto,
  type TradeDto,
} from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { securities, trades, transactions, transactionTags } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { recalcOps } from '../lib/balances.ts';
import { chunkIds, inChunks } from '../lib/chunks.ts';
import { body, fail, notFound } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { heldMicros, positions, toHoldings, type TradeRow } from '../lib/invest.ts';
import { accountCurrency, currenciesOf, ownAccount, runBatch } from '../lib/ledger.ts';
import { fetchQuotes, FetchBudget } from '../lib/markets.ts';
import { alertTriggerOps, storeQuoteOps } from '../lib/prices.ts';
import { insertLegOps } from './transactions.ts';

type C = Context<AppBindings>;
type Row = typeof trades.$inferSelect;
type TradeInput = ReturnType<typeof tradeSchema.parse>;

/**
 * Symbols refreshed per sync, and outgoing fetches allowed (retries and ticker suggestions
 * included). Workers Free allows 50 subrequests per request and D1 queries count too, so 40
 * fetches leave room for the ~8 queries around them. Larger portfolios are covered over several
 * clicks: the stalest prices are refreshed first.
 */
export const MAX_SYNC = 30;
const FETCH_BUDGET = 40;

const tradeDto = (t: Row): TradeDto => ({
  id: t.id,
  accountId: t.accountId,
  cashAccountId: t.cashAccountId,
  symbol: t.symbol,
  side: t.side,
  quantity: microsToString(t.quantityMicros),
  price: microsToString(t.priceMicros),
  amount: t.amount,
  fee: t.fee,
  currency: t.currency,
  tradeDate: t.tradeDate,
  transactionId: t.transactionId,
  note: t.note,
});

async function userTrades(db: DB, userId: string): Promise<Row[]> {
  return db.select().from(trades).where(eq(trades.userId, userId)).orderBy(asc(trades.tradeDate), asc(trades.createdAt));
}

export async function investDto(db: DB, userId: string): Promise<InvestDto> {
  const list = await userTrades(db, userId);
  const symbols = [...new Set(list.map((t) => t.symbol))];
  const prices = await inChunks(symbols, (part) => db.select().from(securities).where(inArray(securities.symbol, part)));
  const all = toHoldings(positions(list as TradeRow[]), prices);
  const open = all.filter((h) => h.quantity !== '0');
  const sum = (f: (h: (typeof open)[number]) => number | null) => open.reduce((a, h) => a + (f(h) ?? 0), 0);
  return {
    currency: 'USD',
    holdings: open,
    closed: all.filter((h) => h.quantity === '0'),
    trades: [...list].reverse().map(tradeDto),
    totals: {
      marketValue: sum((h) => h.marketValue),
      costBasis: sum((h) => h.costBasis),
      unrealized: sum((h) => h.unrealized),
      realized: all.reduce((a, h) => a + h.realized, 0),
    },
  };
}

/** Validate a trade request and work out quantity/price/amount and the optional cash leg. */
async function planTrade(c: C, input: TradeInput, editingId?: string) {
  const { db } = c.var.deps;
  const userId = c.var.user.id;
  const quantityMicros = toMicros(input.quantity);
  const priceMicros = input.price ? toMicros(input.price) : priceFromAmount(input.amount!, quantityMicros);
  const amount = input.amount ?? grossMinor(quantityMicros, priceMicros);
  // Shares live in an investment account, whose value is cash + market value (in its USD balance).
  const account = await ownAccount(db, userId, input.accountId);
  if (account.type !== 'investment') fail(400, `${account.name} is not an investment account`, 'NOT_INVESTMENT_ACCOUNT');
  if (!(await currenciesOf(db, account.id)).includes('USD')) fail(400, `${account.name} does not hold USD`, 'CURRENCY_NOT_HELD');
  if (input.side === 'sell') {
    const held = heldMicros((await userTrades(db, userId)) as TradeRow[], account.id, input.symbol, editingId);
    if (BigInt(quantityMicros) > held) fail(400, `only ${microsToString(Number(held))} ${input.symbol} held`, 'OVERSELL');
  }
  // The money moves in a separate account (often a bank or the broker's cash account).
  const cashAccount = input.cashAccountId ? await ownAccount(db, userId, input.cashAccountId) : null;
  const cash = cashAccount ? { account: cashAccount, currency: await accountCurrency(db, cashAccount, 'USD') } : null;
  return { quantityMicros, priceMicros, amount, account, cash };
}

/** Cash leg in the cash account: a buy pays amount + fee, a sell receives amount − fee. */
function cashLeg(c: C, input: TradeInput, plan: Awaited<ReturnType<typeof planTrade>>) {
  if (!plan.cash) return { rows: [], ops: [] as BatchItem<'sqlite'>[] };
  const signed = input.side === 'buy' ? -(plan.amount + input.fee) : plan.amount - input.fee;
  return insertLegOps(
    c.var.deps.db,
    c.var.user.id,
    [
      {
        role: 'main',
        type: 'trade',
        accountId: plan.cash.account.id,
        currency: plan.cash.currency,
        cardId: null,
        categoryId: null,
        amount: signed,
        occurredAt: input.tradeDate,
        counterparty: `${input.side === 'buy' ? 'BUY' : 'SELL'} ${input.symbol} × ${input.quantity}`,
        note: input.note ?? null,
        extra: {},
      },
    ],
    [],
    c.var.deps.now(),
  );
}

/** Statements removing a trade's cash leg (and refreshing the cached balance). */
async function dropCashLeg(db: DB, userId: string, transactionId: string | null): Promise<BatchItem<'sqlite'>[]> {
  if (!transactionId) return [];
  const [tx] = await db.select().from(transactions).where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)));
  if (!tx) return [];
  return [
    db.delete(transactionTags).where(eq(transactionTags.transactionId, tx.id)),
    db.delete(transactions).where(eq(transactions.id, tx.id)),
    ...recalcOps(db, [{ accountId: tx.accountId, currency: tx.currency }]),
  ];
}

async function ownTrade(db: DB, userId: string, id: string) {
  const [r] = await db.select().from(trades).where(and(eq(trades.id, id), eq(trades.userId, userId)));
  return r ?? notFound('trade');
}

export const investRoutes = new Hono<AppBindings>()
  .get('/', async (c) => c.json(await investDto(c.var.deps.db, c.var.user.id)))

  .post('/trades', async (c) => {
    const input = await body(c, tradeSchema);
    const { db, now } = c.var.deps;
    const plan = await planTrade(c, input);
    const leg = cashLeg(c, input, plan);
    const t = now();
    await runBatch(db, [
      db.insert(securities).values({ symbol: input.symbol, updatedAt: t }).onConflictDoNothing(),
      ...leg.ops,
      db.insert(trades).values({
        id: newId(),
        userId: c.var.user.id,
        accountId: plan.account.id,
        cashAccountId: plan.cash?.account.id ?? null,
        symbol: input.symbol,
        side: input.side,
        quantityMicros: plan.quantityMicros,
        priceMicros: plan.priceMicros,
        amount: plan.amount,
        fee: input.fee,
        currency: 'USD',
        tradeDate: input.tradeDate,
        transactionId: leg.rows[0]?.id ?? null,
        note: input.note ?? null,
        createdAt: t,
        updatedAt: t,
      }),
    ]);
    return c.json(await investDto(db, c.var.user.id), 201);
  })

  .put('/trades/:id', async (c) => {
    const input = await body(c, tradeSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownTrade(db, userId, c.req.param('id'));
    const plan = await planTrade(c, input, cur.id);
    const leg = cashLeg(c, input, plan);
    await runBatch(db, [
      ...(await dropCashLeg(db, userId, cur.transactionId)),
      db.insert(securities).values({ symbol: input.symbol, updatedAt: now() }).onConflictDoNothing(),
      ...leg.ops,
      db
        .update(trades)
        .set({
          accountId: plan.account.id,
          cashAccountId: plan.cash?.account.id ?? null,
          symbol: input.symbol,
          side: input.side,
          quantityMicros: plan.quantityMicros,
          priceMicros: plan.priceMicros,
          amount: plan.amount,
          fee: input.fee,
          tradeDate: input.tradeDate,
          transactionId: leg.rows[0]?.id ?? null,
          note: input.note ?? null,
          updatedAt: now(),
        })
        .where(and(eq(trades.id, cur.id), eq(trades.userId, userId))),
    ]);
    return c.json(await investDto(db, userId));
  })

  .delete('/trades/:id', async (c) => {
    const { db } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownTrade(db, userId, c.req.param('id'));
    await runBatch(db, [...(await dropCashLeg(db, userId, cur.transactionId)), db.delete(trades).where(eq(trades.id, cur.id))]);
    return c.json(await investDto(db, userId));
  })

  /** Fetch the latest prices of the symbols currently held. */
  .post('/prices/sync', async (c) => {
    const { db, env, now } = c.var.deps;
    const userId = c.var.user.id;
    const before = await investDto(db, userId);
    // Oldest (or missing) prices first.
    const stale = [...new Map(before.holdings.map((h) => [h.symbol, h.priceAt ?? 0])).entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s);
    const symbols = stale.slice(0, MAX_SYNC);
    const f = c.var.deps.fetch ?? fetch;
    const batch = await fetchQuotes(f, symbols, { finnhubKey: env.FINNHUB_API_KEY, budget: new FetchBudget(FETCH_BUDGET) });
    const t = now();
    const ok = batch.quotes;
    // New prices may reach price alerts (their email goes out with the next notification run).
    const alerts = await alertTriggerOps(db, ok, t);
    await runBatch(db, [...storeQuoteOps(db, ok, t), ...alerts.ops]);
    const result: PriceSyncDto = {
      ...(await investDto(db, userId)),
      updated: ok.length,
      failed: batch.failed,
      remaining: stale.length - symbols.length + batch.skipped.length,
    };
    return c.json(result);
  })

  /** Correct a ticker on every trade (e.g. APPL → AAPL); positions under the new symbol merge. */
  .post('/symbols/:symbol/rename', async (c) => {
    const from = stockSymbolSchema.parse(c.req.param('symbol'));
    const { to } = await body(c, symbolRenameSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const list = await db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.symbol, from)));
    if (list.length === 0) notFound('symbol');
    if (from !== to) {
      const txIds = list.map((x) => x.transactionId).filter((x): x is string => !!x);
      const t = now();
      await runBatch(db, [
        db.insert(securities).values({ symbol: to, updatedAt: t }).onConflictDoNothing(),
        db.update(trades).set({ symbol: to, updatedAt: t }).where(and(eq(trades.userId, userId), eq(trades.symbol, from))),
        // The cash legs are titled "BUY APPL × 2".
        ...chunkIds(txIds).map((ids) =>
          db
            .update(transactions)
            .set({ counterparty: sql`replace(${transactions.counterparty}, ${` ${from} `}, ${` ${to} `})`, updatedAt: t })
            .where(and(eq(transactions.userId, userId), inArray(transactions.id, ids))),
        ),
      ]);
    }
    return c.json(await investDto(db, userId));
  })

  /** Set a price by hand (e.g. when the quote source is unavailable). */
  .put('/prices/:symbol', async (c) => {
    const symbol = stockSymbolSchema.parse(c.req.param('symbol'));
    const { price } = await body(c, priceSchema);
    const { db, now } = c.var.deps;
    const t = now();
    const priceMicros = toMicros(price);
    await db
      .insert(securities)
      .values({ symbol, priceMicros, priceAt: t, source: 'manual', updatedAt: t })
      .onConflictDoUpdate({ target: securities.symbol, set: { priceMicros, priceAt: t, source: 'manual', updatedAt: t } });
    return c.json(await investDto(db, c.var.user.id));
  });
