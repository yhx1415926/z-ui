import { and, count, desc, eq, gte, inArray, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Hono, type Context } from 'hono';
import {
  HIDDEN_TAG,
  transactionQuerySchema,
  transactionSchema,
  type CurrencySums,
  type TransactionDto,
  type TransactionInput,
} from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { accounts, billOccurrences, tags, transactions, transactionTags } from '../db/schema.ts';
import type { AppBindings } from '../env.ts';
import { pairsOf, recalcOps } from '../lib/balances.ts';
import { inChunks } from '../lib/chunks.ts';
import { body, fail, notFound, query } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { accountCurrency, applyExtra, assertCurrency, assertOwnTags, ownAccount, ownCard, ownCategory, runBatch } from '../lib/ledger.ts';
import { convertNow } from './fx.ts';

export type TxRow = typeof transactions.$inferSelect;
type C = Context<AppBindings>;

/** Row content derived from a request, before ids/timestamps are attached. */
type Leg = Pick<TxRow, 'accountId' | 'cardId' | 'type' | 'amount' | 'currency' | 'occurredAt' | 'categoryId' | 'counterparty' | 'note' | 'extra'> &
  Partial<Pick<TxRow, 'originalAmount' | 'originalCurrency'>> & {
    role: 'main' | 'from' | 'to';
  };

export async function toDtos(db: DB, userId: string, rows: TxRow[]): Promise<TransactionDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const groups = [...new Set(rows.map((r) => r.transferGroupId).filter((g): g is string => !!g))];
  const [tagRows, legRows] = await Promise.all([
    inChunks(ids, (part) => db.select().from(transactionTags).where(inArray(transactionTags.transactionId, part))),
    inChunks(groups, (part) =>
      db
        .select({ id: transactions.id, g: transactions.transferGroupId, accountId: transactions.accountId, amount: transactions.amount, currency: transactions.currency })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), inArray(transactions.transferGroupId, part))),
    ),
  ]);
  const tagsOf = new Map<string, string[]>();
  for (const t of tagRows) tagsOf.set(t.transactionId, [...(tagsOf.get(t.transactionId) ?? []), t.tagId]);
  return rows.map((r) => {
    const other = r.transferGroupId ? legRows.find((l) => l.g === r.transferGroupId && l.id !== r.id) : undefined;
    const { userId: _u, ...rest } = r;
    return {
      ...rest,
      counterpartAccountId: other?.accountId ?? null,
      counterpartAmount: other?.amount ?? null,
      counterpartCurrency: other?.currency ?? null,
      tagIds: tagsOf.get(r.id) ?? [],
    };
  });
}

/** Validate a request against the user's accounts/cards/categories and turn it into legs. */
export async function planLegs(c: C, input: TransactionInput, storedExtra: Record<string, unknown>): Promise<Leg[]> {
  const { db } = c.var.deps;
  const userId = c.var.user.id;
  const extra = applyExtra(c.var.deps, 'transaction', storedExtra, input.extra);
  // Set explicitly so an edit that drops the foreign amount clears it.
  const common = { occurredAt: input.occurredAt, note: input.note ?? null, counterparty: input.counterparty ?? null, extra, originalAmount: null, originalCurrency: null };

  if (input.type === 'transfer') {
    const from = await ownAccount(db, userId, input.fromAccountId);
    const to = await ownAccount(db, userId, input.toAccountId);
    const fromCurrency = await accountCurrency(db, from, input.fromCurrency);
    const toCurrency = await accountCurrency(db, to, input.toCurrency);
    // Same account is allowed when exchanging between two of its currencies.
    if (from.id === to.id && fromCurrency === toCurrency) fail(400, 'cannot transfer to the same account and currency', 'SAME_ACCOUNT');
    let toAmount = input.toAmount ?? null;
    if (fromCurrency === toCurrency) {
      if (toAmount !== null && toAmount !== input.amount) {
        fail(400, 'same-currency transfers must have equal amounts (record fees separately)', 'AMOUNT_MISMATCH');
      }
      toAmount = input.amount;
    } else if (toAmount === null) {
      // Left blank: what arrives at the current rate.
      toAmount = await convertNow(c.var.deps, input.amount, fromCurrency, toCurrency, 'TO_AMOUNT_REQUIRED');
    }
    const categoryId = input.categoryId ? (await ownCategory(db, userId, input.categoryId)).id : null;
    return [
      { ...common, role: 'from', type: 'transfer', accountId: from.id, currency: fromCurrency, cardId: null, categoryId, amount: -input.amount },
      { ...common, role: 'to', type: 'transfer', accountId: to.id, currency: toCurrency, cardId: null, categoryId, amount: toAmount },
    ];
  }

  const acc = await ownAccount(db, userId, input.accountId);
  const currency = await accountCurrency(db, acc, input.currency);
  if (input.type === 'adjustment') {
    return [{ ...common, role: 'main', type: 'adjustment', accountId: acc.id, currency, cardId: null, categoryId: null, amount: input.amount }];
  }
  let cardId: string | null = null;
  if (input.cardId) {
    const card = await ownCard(db, userId, input.cardId);
    if (card.accountId !== acc.id) fail(400, 'card does not belong to this account', 'CARD_ACCOUNT');
    cardId = card.id;
  }
  let categoryId: string | null = null;
  if (input.categoryId) {
    const cat = await ownCategory(db, userId, input.categoryId);
    if (cat.kind !== input.type) fail(400, `category is not an ${input.type} category`, 'CATEGORY_KIND');
    categoryId = cat.id;
  }
  // A charge in another currency (e.g. USD paid from a CNY-only wallet): keep what the merchant
  // billed; the account's own amount is what was actually paid, or the current-rate conversion.
  let paid = input.amount ?? null;
  let original: { originalAmount: number; originalCurrency: string } | null = null;
  if (input.originalCurrency && input.originalAmount) {
    if (input.originalCurrency === currency) paid ??= input.originalAmount;
    else {
      assertCurrency(c.var.deps, input.originalCurrency);
      original = { originalAmount: input.originalAmount, originalCurrency: input.originalCurrency };
      paid ??= await convertNow(c.var.deps, input.originalAmount, input.originalCurrency, currency, 'AMOUNT_REQUIRED');
    }
  }
  if (!paid) fail(400, 'amount required', 'AMOUNT_REQUIRED');
  const amount = input.type === 'income' ? paid : -paid;
  return [{ ...common, ...original, role: 'main', type: input.type, accountId: acc.id, currency, cardId, categoryId, amount }];
}

function legToValues(leg: Leg) {
  const { role: _r, ...v } = leg;
  return v;
}

/** Transactions tagged "hidden" (any case), as a non-correlated subquery on the tag index. */
export const hiddenTxIds = (userId: string) =>
  sql`(select ${transactionTags.transactionId} from ${transactionTags} where ${transactionTags.tagId} in (select ${tags.id} from ${tags} where ${tags.userId} = ${userId} and lower(${tags.name}) = ${HIDDEN_TAG}))`;

/** What the transactions list shows by default: no stock-trade cash legs, nothing tagged hidden. */
export const listedTx = (userId: string) => and(ne(transactions.type, 'trade'), notInArray(transactions.id, hiddenTxIds(userId)))!;

function buildWhere(userId: string, q: ReturnType<typeof transactionQuerySchema.parse>): SQL {
  const conds: SQL[] = [eq(transactions.userId, userId)];
  // Cash legs of stock trades belong to the investments page (and the account's own ledger).
  if (!q.type && q.trades !== '1') conds.push(ne(transactions.type, 'trade'));
  if (q.hidden !== '1') conds.push(notInArray(transactions.id, hiddenTxIds(userId)));
  if (q.accountId) conds.push(eq(transactions.accountId, q.accountId));
  if (q.cardId) conds.push(eq(transactions.cardId, q.cardId));
  if (q.type) conds.push(eq(transactions.type, q.type));
  if (q.currency) conds.push(eq(transactions.currency, q.currency));
  if (q.categoryId) conds.push(eq(transactions.categoryId, q.categoryId));
  if (q.from) conds.push(gte(transactions.occurredAt, q.from));
  if (q.to) conds.push(lte(transactions.occurredAt, q.to));
  if (q.institutionId) {
    conds.push(
      inArray(
        transactions.accountId,
        sql`(select ${accounts.id} from ${accounts} where ${accounts.institutionId} = ${q.institutionId} and ${accounts.userId} = ${userId})`,
      ),
    );
  }
  if (q.tagId) {
    conds.push(
      inArray(
        transactions.id,
        sql`(select ${transactionTags.transactionId} from ${transactionTags} where ${transactionTags.tagId} = ${q.tagId})`,
      ),
    );
  }
  if (q.q) {
    const pattern = `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conds.push(
      or(
        sql`${transactions.note} like ${pattern} escape '\\'`,
        sql`${transactions.counterparty} like ${pattern} escape '\\'`,
      )!,
    );
  }
  return and(...conds)!;
}

/** Income/expense sums per currency for a set of transactions (transfers excluded). */
export async function sumsByCurrency(db: DB, where: SQL): Promise<CurrencySums[]> {
  const rows = await db
    .select({
      currency: transactions.currency,
      income: sql<number>`coalesce(sum(case when ${transactions.type} = 'income' then ${transactions.amount} else 0 end), 0)`,
      expense: sql<number>`coalesce(sum(case when ${transactions.type} = 'expense' then -${transactions.amount} else 0 end), 0)`,
    })
    .from(transactions)
    .where(where)
    .groupBy(transactions.currency);
  return rows
    .map((r) => ({ currency: r.currency, income: Number(r.income), expense: Number(r.expense) }))
    .filter((r) => r.income !== 0 || r.expense !== 0);
}

async function legsOf(db: DB, userId: string, id: string): Promise<TxRow[]> {
  const [cur] = await db.select().from(transactions).where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
  if (!cur) notFound('transaction');
  if (!cur.transferGroupId) return [cur];
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.transferGroupId, cur.transferGroupId)));
}

/** Insert legs (plus tags) as one atomic batch; returns the inserted rows. */
type LegLinks = { billOccurrenceId?: string | null; statementId?: string | null; statementLeg?: 'from' | 'to' };

/** Transaction rows for the legs of one entry (a transfer's two legs share a group id). */
export function legRows(userId: string, legs: Leg[], now: number, links: LegLinks = {}): TxRow[] {
  const group = legs.length > 1 ? newId() : null;
  return legs.map((leg) => ({
    ...legToValues(leg),
    originalAmount: leg.originalAmount ?? null,
    originalCurrency: leg.originalCurrency ?? null,
    id: newId(),
    userId,
    transferGroupId: group,
    billOccurrenceId: leg.role !== 'to' ? (links.billOccurrenceId ?? null) : null,
    statementId: links.statementLeg && leg.role === links.statementLeg ? (links.statementId ?? null) : null,
    createdAt: now,
    updatedAt: now,
  }));
}

export function insertLegOps(db: DB, userId: string, legs: Leg[], tagIds: string[], now: number, links: LegLinks = {}) {
  const rows = legRows(userId, legs, now, links);
  const ops: BatchItem<'sqlite'>[] = [db.insert(transactions).values(rows)];
  const tagValues = rows.flatMap((r) => tagIds.map((tagId) => ({ transactionId: r.id, tagId })));
  if (tagValues.length) ops.push(db.insert(transactionTags).values(tagValues));
  ops.push(...recalcOps(db, pairsOf(rows)));
  return { rows, ops };
}

export const transactionRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const q = query(c, transactionQuerySchema);
    const { db } = c.var.deps;
    const where = buildWhere(c.var.user.id, q);
    const [rows, [total], sums] = await Promise.all([
      db
        .select()
        .from(transactions)
        .where(where)
        .orderBy(desc(transactions.occurredAt), desc(transactions.createdAt), desc(transactions.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      db.select({ n: count() }).from(transactions).where(where),
      sumsByCurrency(db, where),
    ]);
    return c.json({ items: await toDtos(db, c.var.user.id, rows), total: total?.n ?? 0, page: q.page, pageSize: q.pageSize, sums });
  })

  .get('/:id', async (c) => {
    const { db } = c.var.deps;
    const legs = await legsOf(db, c.var.user.id, c.req.param('id'));
    const [dto] = await toDtos(db, c.var.user.id, legs.filter((l) => l.id === c.req.param('id')));
    return c.json(dto!);
  })

  .post('/', async (c) => {
    const input = await body(c, transactionSchema);
    const { db, now } = c.var.deps;
    const legs = await planLegs(c, input, {});
    const tagIds = await assertOwnTags(db, c.var.user.id, input.tagIds);
    const { rows, ops } = insertLegOps(db, c.var.user.id, legs, tagIds, now());
    await runBatch(db, ops);
    const [dto] = await toDtos(db, c.var.user.id, rows.slice(0, 1));
    return c.json(dto!, 201);
  })

  /**
   * Full replace. Ids are kept where possible (so bill/statement links survive): a transfer
   * keeps both leg ids; switching between transfer and non-transfer keeps the edited row's id.
   */
  .put('/:id', async (c) => {
    const input = await body(c, transactionSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const id = c.req.param('id');
    const old = await legsOf(db, userId, id);
    const edited = old.find((l) => l.id === id)!;
    if (edited.type === 'trade') fail(409, 'edit stock trades on the investments page', 'TRADE_TX');
    const legs = await planLegs(c, input, edited.extra);
    const tagIds = await assertOwnTags(db, userId, input.tagIds);
    const t = now();

    // Assign ids to the new legs.
    const ids = new Map<Leg, string>();
    if (legs.length === 2 && old.length === 2) {
      ids.set(legs[0]!, old.find((l) => l.amount < 0)!.id);
      ids.set(legs[1]!, old.find((l) => l.amount >= 0)!.id);
    } else {
      ids.set(legs[0]!, edited.id);
      if (legs[1]) ids.set(legs[1], newId());
    }
    const group = legs.length === 2 ? (edited.transferGroupId ?? newId()) : null;
    const keepIds = new Set(ids.values());
    const oldIds = new Set(old.map((l) => l.id));

    const ops: BatchItem<'sqlite'>[] = [db.delete(transactionTags).where(inArray(transactionTags.transactionId, [...oldIds]))];
    const removed = [...oldIds].filter((x) => !keepIds.has(x));
    if (removed.length) {
      ops.push(
        db.update(billOccurrences).set({ status: 'pending', transactionId: null, updatedAt: t }).where(inArray(billOccurrences.transactionId, removed)),
        db.delete(transactions).where(and(eq(transactions.userId, userId), inArray(transactions.id, removed))),
      );
    }
    for (const leg of legs) {
      const legId = ids.get(leg)!;
      const values = { ...legToValues(leg), transferGroupId: group, updatedAt: t };
      if (oldIds.has(legId)) {
        ops.push(db.update(transactions).set(values).where(and(eq(transactions.id, legId), eq(transactions.userId, userId))));
      } else {
        ops.push(db.insert(transactions).values({ ...values, id: legId, userId, billOccurrenceId: null, statementId: null, createdAt: t }));
      }
    }
    const tagValues = [...keepIds].flatMap((txId) => tagIds.map((tagId) => ({ transactionId: txId, tagId })));
    if (tagValues.length) ops.push(db.insert(transactionTags).values(tagValues));
    ops.push(...recalcOps(db, [...pairsOf(old), ...pairsOf(legs)]));
    await runBatch(db, ops);

    const [row] = await db.select().from(transactions).where(eq(transactions.id, edited.id));
    const [dto] = await toDtos(db, userId, [row!]);
    return c.json(dto!);
  })

  .delete('/:id', async (c) => {
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const legs = await legsOf(db, userId, c.req.param('id'));
    if (legs.some((l) => l.type === 'trade')) fail(409, 'delete stock trades on the investments page', 'TRADE_TX');
    const ids = legs.map((l) => l.id);
    await runBatch(db, [
      db.update(billOccurrences).set({ status: 'pending', transactionId: null, updatedAt: now() }).where(inArray(billOccurrences.transactionId, ids)),
      db.delete(transactionTags).where(inArray(transactionTags.transactionId, ids)),
      db.delete(transactions).where(and(eq(transactions.userId, userId), inArray(transactions.id, ids))),
      ...recalcOps(db, pairsOf(legs)),
    ]);
    return c.json({ ok: true, deleted: ids.length });
  });
