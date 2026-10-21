import { and, asc, count, eq, inArray, or, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Hono } from 'hono';
import { accountPatchSchema, accountSchema, type AccountCurrencyDto, type AccountDto, type InvestDto } from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { accountCurrencies, accounts, cards, trades, transactions } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { recalcAccountOps, recalcUserOps } from '../lib/balances.ts';
import { chunkRows, inChunks } from '../lib/chunks.ts';
import { body, fail, notFound } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { applyExtra, assertCurrency, defined, ownAccount, ownInstitution, runBatch } from '../lib/ledger.ts';
import { investDto } from './invest.ts';

type Row = typeof accounts.$inferSelect;

/** Stocks held per account, from the positions (market value only for priced symbols). */
function holdingsByAccount(invest: InvestDto) {
  const map = new Map<string, NonNullable<AccountDto['investment']>>();
  for (const h of invest.holdings) {
    if (!h.accountId) continue;
    const v = map.get(h.accountId) ?? { marketValue: 0, costBasis: 0, unrealized: 0, positions: 0, unpriced: 0 };
    v.positions++;
    v.costBasis += h.costBasis;
    if (h.marketValue === null) v.unpriced++;
    else {
      v.marketValue += h.marketValue;
      v.unrealized += h.unrealized ?? 0;
    }
    map.set(h.accountId, v);
  }
  return map;
}

/**
 * Accounts with one balance per currency held:
 * balance = opening balance of that currency + Σ signed transactions in that currency
 * (read from the cache in account_currencies — see lib/balances.ts).
 * Accounts holding stocks add their market value to the USD balance (cash + market value).
 */
export async function listAccountsWithBalance(db: DB, userId: string, extra?: SQL, invest?: Promise<InvestDto>): Promise<AccountDto[]> {
  const rows = await db
    .select()
    .from(accounts)
    .where(extra ? and(eq(accounts.userId, userId), extra) : eq(accounts.userId, userId))
    .orderBy(asc(accounts.sort), asc(accounts.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [curRows, cardCounts, inv] = await Promise.all([
    inChunks(ids, (part) => db.select().from(accountCurrencies).where(inArray(accountCurrencies.accountId, part)).orderBy(asc(accountCurrencies.sort))),
    inChunks(ids, (part) =>
      db
        .select({ accountId: cards.accountId, n: count() })
        .from(cards)
        .where(and(eq(cards.userId, userId), inArray(cards.accountId, part)))
        .groupBy(cards.accountId),
    ),
    invest ?? investDto(db, userId),
  ]);
  curRows.sort((a, b) => a.sort - b.sort);
  const held = holdingsByAccount(inv);
  const payers = new Set(inv.trades.map((x) => x.cashAccountId).filter(Boolean));
  return rows.map((r) => {
    const investment = held.get(r.id) ?? null;
    const currencies: AccountCurrencyDto[] = curRows
      .filter((c) => c.accountId === r.id)
      .map((c) => ({
        currency: c.currency,
        openingBalance: c.openingBalance,
        balanceDate: c.balanceDate,
        includeInTotal: c.includeInTotal,
        balance: c.balance + (investment && c.currency === 'USD' ? investment.marketValue : 0),
        transactionCount: c.txCount,
      }));
    // Credit usage: what is owed in the primary currency against the limit.
    const primary = curRows.find((c) => c.accountId === r.id && c.currency === r.currency);
    const used = Math.max(0, -(primary?.balance ?? 0));
    const creditUsage =
      r.type === 'credit' && r.creditLimit && r.creditLimit > 0
        ? { used, limit: r.creditLimit, percent: Math.round((used / r.creditLimit) * 1000) / 10, over: used > r.creditLimit }
        : null;
    const { userId: _u, ...rest } = r;
    return {
      ...rest,
      currencies,
      transactionCount: currencies.reduce((a, x) => a + x.transactionCount, 0),
      cardCount: cardCounts.find((x) => x.accountId === r.id)?.n ?? 0,
      investment,
      creditUsage,
      stockCash: payers.has(r.id),
    };
  });
}

export const accountRoutes = new Hono<AppBindings>()
  /** Repair: recompute all cached balances from the transactions. */
  .post('/recalc', async (c) => {
    await runBatch(c.var.deps.db, recalcUserOps(c.var.deps.db, c.var.user.id));
    return c.json({ ok: true });
  })

  .get('/', async (c) => {
    const inst = c.req.query('institutionId');
    return c.json(
      await listAccountsWithBalance(c.var.deps.db, c.var.user.id, inst ? eq(accounts.institutionId, inst) : undefined),
    );
  })

  .get('/:id', async (c) => {
    const [a] = await listAccountsWithBalance(c.var.deps.db, c.var.user.id, eq(accounts.id, c.req.param('id')));
    return c.json(a ?? notFound('account'));
  })

  .post('/', async (c) => {
    const input = await body(c, accountSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    await ownInstitution(db, userId, input.institutionId);
    for (const cur of input.currencies) assertCurrency(c.var.deps, cur.currency);
    const t = now();
    const row: Row = {
      id: newId(),
      userId,
      institutionId: input.institutionId,
      name: input.name,
      type: input.type,
      currency: input.currencies[0]!.currency,
      openingDate: input.openingDate,
      creditLimit: input.creditLimit ?? null,
      numberLast4: input.numberLast4 ?? null,
      note: input.note ?? null,
      extra: applyExtra(c.var.deps, 'account', {}, input.extra),
      sort: input.sort ?? 0,
      archived: input.archived ?? false,
      createdAt: t,
      updatedAt: t,
    };
    await runBatch(db, [
      db.insert(accounts).values(row),
      ...chunkRows(input.currencies.map((cur, i) => ({ ...cur, balanceDate: cur.balanceDate ?? null, accountId: row.id, userId, balance: cur.openingBalance, txCount: 0, sort: i }))).map((part) =>
        db.insert(accountCurrencies).values(part),
      ),
    ]);
    const [a] = await listAccountsWithBalance(db, userId, eq(accounts.id, row.id));
    return c.json(a!, 201);
  })

  .patch('/:id', async (c) => {
    const input = await body(c, accountPatchSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownAccount(db, userId, c.req.param('id'));
    if (input.institutionId) await ownInstitution(db, userId, input.institutionId);
    const { extra, currencies, ...fields } = input;
    const ops: BatchItem<'sqlite'>[] = [];

    if (currencies) {
      for (const x of currencies) assertCurrency(c.var.deps, x.currency);
      // A currency that already has transactions cannot be removed from the account.
      const keep = new Set(currencies.map((x) => x.currency));
      const used = await db
        .select({ currency: transactions.currency })
        .from(transactions)
        .where(eq(transactions.accountId, cur.id))
        .groupBy(transactions.currency);
      const blocked = used.map((u) => u.currency).filter((x) => !keep.has(x));
      if (blocked.length) fail(409, `cannot remove ${blocked.join(', ')}: it has transactions`, 'CURRENCY_IN_USE', blocked);
      ops.push(
        db.delete(accountCurrencies).where(eq(accountCurrencies.accountId, cur.id)),
        ...chunkRows(currencies.map((x, i) => ({ ...x, balanceDate: x.balanceDate ?? null, accountId: cur.id, userId, sort: i }))).map((part) => db.insert(accountCurrencies).values(part)),
        ...recalcAccountOps(db, cur.id),
      );
    }
    ops.push(
      db
        .update(accounts)
        .set({
          ...defined(fields),
          ...(currencies && { currency: currencies[0]!.currency }),
          ...(extra !== undefined && { extra: applyExtra(c.var.deps, 'account', cur.extra, extra) }),
          updatedAt: now(),
        })
        .where(and(eq(accounts.id, cur.id), eq(accounts.userId, userId))),
    );
    await runBatch(db, ops);
    const [a] = await listAccountsWithBalance(db, userId, eq(accounts.id, cur.id));
    return c.json(a!);
  })

  .delete('/:id', async (c) => {
    const { db } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownAccount(db, userId, c.req.param('id'));
    const [tx] = await db.select({ n: count() }).from(transactions).where(eq(transactions.accountId, cur.id));
    const [cd] = await db.select({ n: count() }).from(cards).where(eq(cards.accountId, cur.id));
    const [tr] = await db
      .select({ n: count() })
      .from(trades)
      .where(and(eq(trades.userId, userId), or(eq(trades.accountId, cur.id), eq(trades.cashAccountId, cur.id))));
    if ((tx?.n ?? 0) > 0 || (cd?.n ?? 0) > 0 || (tr?.n ?? 0) > 0) {
      fail(409, 'account has transactions, cards or stock trades — archive it instead', 'HAS_CHILDREN');
    }
    await runBatch(db, [
      // Credit cards repaid automatically from this account stop doing so.
      db
        .update(cards)
        .set({ autopayAccountId: null, autopayCurrency: null, autopayMode: null, autopaySince: null })
        .where(and(eq(cards.userId, userId), eq(cards.autopayAccountId, cur.id))),
      db.delete(accountCurrencies).where(eq(accountCurrencies.accountId, cur.id)),
      db.delete(accounts).where(and(eq(accounts.id, cur.id), eq(accounts.userId, userId))),
    ]);
    return c.json({ ok: true });
  });
