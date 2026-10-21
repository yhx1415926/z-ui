import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { repaySchema, statementPatchSchema, statementSchema, type StatementDto } from '@z-ui/shared';
import { cards, creditStatements, transactions } from '../db/schema.ts';
import type { AppBindings, Deps } from '../env.ts';
import { body, fail, notFound } from '../lib/http.ts';
import { inChunks } from '../lib/chunks.ts';
import { newId } from '../lib/id.ts';
import { runAutopay } from '../lib/autopay.ts';
import { accountCurrency, defined, ownAccount, ownCard, runBatch } from '../lib/ledger.ts';
import { insertLegOps, planLegs, toDtos } from './transactions.ts';

type Row = typeof creditStatements.$inferSelect;

/**
 * Credit card statements: the amount owed is entered by hand from the bank's statement; the
 * paid amount is the sum of repayment transactions linked to it.
 */
export async function statementDtos(deps: Deps, userId: string, rows: Row[]): Promise<StatementDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [paid, cardRows] = await Promise.all([
    inChunks(ids, (part) =>
      deps.db
        .select({ id: transactions.statementId, currency: transactions.currency, paid: sql<number>`coalesce(sum(${transactions.amount}), 0)` })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), inArray(transactions.statementId, part)))
        .groupBy(transactions.statementId, transactions.currency),
    ),
    deps.db.select({ id: cards.id, accountId: cards.accountId }).from(cards).where(eq(cards.userId, userId)),
  ]);
  return rows.map((r) => {
    const { userId: _u, ...rest } = r;
    const card = cardRows.find((cr) => cr.id === r.cardId);
    // Repayments credited in the statement's own currency.
    const paidAmount = Number(paid.find((p) => p.id === r.id && p.currency === r.currency)?.paid ?? 0);
    const remaining = Math.max(0, r.statementAmount - paidAmount);
    return {
      ...rest,
      accountId: card?.accountId ?? '',
      paidAmount,
      remaining,
      status: remaining === 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid',
    };
  });
}

async function ownStatement(deps: Deps, userId: string, id: string) {
  const [r] = await deps.db
    .select()
    .from(creditStatements)
    .where(and(eq(creditStatements.id, id), eq(creditStatements.userId, userId)));
  return r ?? notFound('statement');
}

export const statementRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    // Automatic repayments due by today are recorded before listing.
    await runAutopay(c.var.deps, c.var.user.id);
    const cardId = c.req.query('cardId');
    const where = cardId
      ? and(eq(creditStatements.userId, c.var.user.id), eq(creditStatements.cardId, cardId))
      : eq(creditStatements.userId, c.var.user.id);
    const rows = await c.var.deps.db.select().from(creditStatements).where(where).orderBy(desc(creditStatements.dueDate)).limit(500);
    return c.json(await statementDtos(c.var.deps, c.var.user.id, rows));
  })

  .post('/', async (c) => {
    const input = await body(c, statementSchema);
    const deps = c.var.deps;
    const userId = c.var.user.id;
    const card = await ownCard(deps.db, userId, input.cardId);
    const currency = await accountCurrency(deps.db, await ownAccount(deps.db, userId, card.accountId), input.currency);
    if (input.dueDate < input.statementDate) fail(400, 'due date is before the statement date', 'BAD_RANGE');
    const t = deps.now();
    const row: Row = {
      id: newId(),
      userId,
      cardId: input.cardId,
      currency,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      statementDate: input.statementDate,
      dueDate: input.dueDate,
      statementAmount: input.statementAmount,
      minPayment: input.minPayment ?? null,
      note: input.note ?? null,
      autopayAt: null,
      createdAt: t,
      updatedAt: t,
    };
    await deps.db.insert(creditStatements).values(row);
    const [dto] = await statementDtos(deps, userId, [row]);
    return c.json(dto!, 201);
  })

  .patch('/:id', async (c) => {
    const input = await body(c, statementPatchSchema);
    const deps = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownStatement(deps, userId, c.req.param('id'));
    const card = await ownCard(deps.db, userId, input.cardId ?? cur.cardId);
    const currency =
      input.currency || input.cardId
        ? await accountCurrency(deps.db, await ownAccount(deps.db, userId, card.accountId), input.currency ?? cur.currency)
        : cur.currency;
    const [row] = await deps.db
      .update(creditStatements)
      .set({ ...defined(input), currency, updatedAt: deps.now() })
      .where(and(eq(creditStatements.id, cur.id), eq(creditStatements.userId, userId)))
      .returning();
    const [dto] = await statementDtos(deps, userId, [row!]);
    return c.json(dto!);
  })

  .delete('/:id', async (c) => {
    const deps = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownStatement(deps, userId, c.req.param('id'));
    await runBatch(deps.db, [
      deps.db.update(transactions).set({ statementId: null }).where(and(eq(transactions.userId, userId), eq(transactions.statementId, cur.id))),
      deps.db.delete(creditStatements).where(and(eq(creditStatements.id, cur.id), eq(creditStatements.userId, userId))),
    ]);
    return c.json({ ok: true });
  })

  /** Record a repayment: a transfer from a funding account into the card's account, linked to this statement. */
  .post('/:id/repay', async (c) => {
    const input = await body(c, repaySchema);
    const deps = c.var.deps;
    const userId = c.var.user.id;
    const st = await ownStatement(deps, userId, c.req.param('id'));
    const card = await ownCard(deps.db, userId, st.cardId);
    await ownAccount(deps.db, userId, input.fromAccountId);
    const legs = await planLegs(
      c,
      {
        type: 'transfer',
        fromAccountId: input.fromAccountId,
        fromCurrency: input.fromCurrency,
        toAccountId: card.accountId,
        toCurrency: st.currency,
        amount: input.amount,
        toAmount: input.toAmount,
        occurredAt: input.occurredAt,
        note: input.note,
        counterparty: null,
      },
      {},
    );
    const { rows, ops } = insertLegOps(deps.db, userId, legs, [], deps.now(), { statementId: st.id, statementLeg: 'to' });
    await runBatch(deps.db, ops);
    const [statement] = await statementDtos(deps, userId, [st]);
    const [transaction] = await toDtos(deps.db, userId, rows.slice(0, 1));
    return c.json({ statement, transaction });
  });
