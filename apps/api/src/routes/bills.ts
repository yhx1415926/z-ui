import { and, asc, eq, gte, inArray, lt, lte, max, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  addDays,
  billPatchSchema,
  pairRate,
  billSchema,
  isoDateSchema,
  nextOccurrence,
  occurrencesBetween,
  payOccurrenceSchema,
  todayIso,
  type BillDto,
  type BillOccurrenceDto,
} from '@z-ui/shared';
import { accounts, billOccurrences, bills, cards, transactions, transactionTags } from '../db/schema.ts';
import type { AppBindings, Deps } from '../env.ts';
import { recalcOps } from '../lib/balances.ts';
import { chunkIds, chunkRows, inChunks } from '../lib/chunks.ts';
import { body, fail, notFound, query } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { assertCurrency, currenciesOf, defined, ownAccount, ownCard, ownCategory, runBatch } from '../lib/ledger.ts';
import { convertNow, ratesMap } from './fx.ts';
import { insertLegOps, legRows, toDtos } from './transactions.ts';

type BillRow = typeof bills.$inferSelect;
type OccRow = typeof billOccurrences.$inferSelect;
type AccountRow = typeof accounts.$inferSelect;
type CardRow = typeof cards.$inferSelect;

export function today(deps: Deps) {
  return todayIso(new Date(deps.now()));
}

const recurrence = (b: BillRow) => ({ freq: b.freq, interval: b.interval, startDate: b.startDate, endDate: b.endDate });

/** Due dates of a bill within [from, to]: a one-time bill has exactly one. */
function dueDates(b: BillRow, from: string, to: string): string[] {
  if (b.kind === 'once') return b.startDate >= from && b.startDate <= to ? [b.startDate] : [];
  return occurrencesBetween(recurrence(b), from, to);
}

function nextDue(b: BillRow, onOrAfter: string): string | null {
  if (b.kind === 'once') return b.startDate >= onOrAfter ? b.startDate : null;
  return nextOccurrence(recurrence(b), onOrAfter);
}

/**
 * Make sure every due date up to `horizon` has an occurrence row. Generation continues after the
 * latest existing row of each bill (or from its start date when `full`), so history of any
 * length is kept without regenerating it on every request.
 */
export async function syncOccurrences(deps: Deps, userId: string, horizon: string, opts: { billIds?: string[]; full?: boolean } = {}) {
  const { db, now } = deps;
  const where = [eq(bills.userId, userId), eq(bills.active, true)];
  if (opts.billIds) where.push(inArray(bills.id, opts.billIds));
  const active = await db.select().from(bills).where(and(...where));
  if (active.length === 0) return;
  const latest = await inChunks(
    active.map((b) => b.id),
    (part) => db.select({ billId: billOccurrences.billId, last: max(billOccurrences.dueDate) }).from(billOccurrences).where(inArray(billOccurrences.billId, part)).groupBy(billOccurrences.billId),
  );
  const t = now();
  const values = active.flatMap((b) => {
    const last = opts.full ? null : latest.find((l) => l.billId === b.id)?.last;
    return dueDates(b, last ? addDays(last, 1) : b.startDate, horizon).map((dueDate) => ({
      id: newId(),
      userId,
      billId: b.id,
      dueDate,
      amount: b.amount,
      status: 'pending' as const,
      transactionId: null,
      updatedAt: t,
    }));
  });
  // One round trip however long the history is (Workers Free: 50 subrequests per request).
  await runBatch(
    db,
    chunkRows(values).map((part) => db.insert(billOccurrences).values(part).onConflictDoNothing()),
  );
}

/**
 * Due dates one bill may have (history + the next weeks). Recording them all happens in one
 * request, and Workers Free allows ~10 ms CPU: 600 (≈ 11 years weekly, 50 years monthly) keeps
 * that comfortable. Longer schedules are refused — pick a later start date.
 */
export const MAX_OCCURRENCES = 600;

function assertHistoryFits(deps: Deps, b: Pick<BillRow, 'kind' | 'freq' | 'interval' | 'startDate' | 'endDate'>) {
  const n = dueDates(b as BillRow, b.startDate, horizon(deps)).length;
  if (n > MAX_OCCURRENCES) fail(400, `this schedule has ${n} due dates; at most ${MAX_OCCURRENCES} are kept — choose a later start date`, 'HISTORY_TOO_LONG');
}

async function ownBill(deps: Deps, userId: string, id: string) {
  const [r] = await deps.db.select().from(bills).where(and(eq(bills.id, id), eq(bills.userId, userId)));
  return r ?? notFound('bill');
}

async function validateRefs(deps: Deps, userId: string, input: Partial<z.infer<typeof billSchema>>) {
  if (input.currency) assertCurrency(deps, input.currency);
  if (input.accountId) await ownAccount(deps.db, userId, input.accountId);
  if (input.cardId) await ownCard(deps.db, userId, input.cardId);
  if (input.categoryId) {
    const cat = await ownCategory(deps.db, userId, input.categoryId);
    if (cat.kind !== 'expense') fail(400, 'bills need an expense category', 'CATEGORY_KIND');
  }
  if (input.endDate && input.startDate && input.endDate < input.startDate) fail(400, 'end date is before start date', 'BAD_RANGE');
}

/** Next due date: the earliest unpaid one, else the first scheduled date after everything already settled. */
async function billDtos(deps: Deps, userId: string, rows: BillRow[]): Promise<BillDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [pending, latest] = await Promise.all([
    inChunks(ids, (part) =>
      deps.db
        .select({ billId: billOccurrences.billId, dueDate: billOccurrences.dueDate })
        .from(billOccurrences)
        .where(and(eq(billOccurrences.userId, userId), eq(billOccurrences.status, 'pending'), inArray(billOccurrences.billId, part)))
        .orderBy(asc(billOccurrences.dueDate)),
    ),
    inChunks(ids, (part) =>
      deps.db
        .select({ billId: billOccurrences.billId, last: max(billOccurrences.dueDate) })
        .from(billOccurrences)
        .where(inArray(billOccurrences.billId, part))
        .groupBy(billOccurrences.billId),
    ),
  ]);
  pending.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const t = today(deps);
  return rows.map((b) => {
    const { userId: _u, ...rest } = b;
    const firstPending = pending.find((p) => p.billId === b.id)?.dueDate ?? null;
    const last = latest.find((l) => l.billId === b.id)?.last ?? null;
    const after = last && addDays(last, 1) > t ? addDays(last, 1) : t;
    const upcoming = b.kind === 'once' ? (last ? null : nextDue(b, t)) : nextDue(b, after);
    return { ...rest, freq: b.kind === 'once' ? null : b.freq, nextDueDate: b.active ? (firstPending ?? upcoming) : null };
  });
}

async function occurrenceDtos(deps: Deps, userId: string, where: SQL): Promise<BillOccurrenceDto[]> {
  const rows = await deps.db
    .select({ o: billOccurrences, b: bills })
    .from(billOccurrences)
    .innerJoin(bills, eq(bills.id, billOccurrences.billId))
    .where(and(eq(billOccurrences.userId, userId), where))
    .orderBy(asc(billOccurrences.dueDate));
  return rows.map(({ o, b }) => ({
    id: o.id,
    billId: b.id,
    billName: b.name,
    billKind: b.kind,
    dueDate: o.dueDate,
    amount: o.amount,
    currency: b.currency,
    status: o.status,
    transactionId: o.transactionId,
  }));
}

/** The account (and card) a bill is paid from. */
async function paymentSource(deps: Deps, userId: string, b: BillRow, override: { accountId?: string | null; cardId?: string | null } = {}) {
  const cardId = override.cardId === undefined ? b.cardId : override.cardId;
  const card: CardRow | null = cardId ? await ownCard(deps.db, userId, cardId) : null;
  const accountId = card?.accountId ?? override.accountId ?? b.accountId;
  const account: AccountRow | null = accountId ? await ownAccount(deps.db, userId, accountId) : null;
  return { card, account };
}

/** Statements that record an occurrence as paid by an expense transaction. */
function paymentOps(
  deps: Deps,
  userId: string,
  b: BillRow,
  o: OccRow,
  p: { account: AccountRow; card: CardRow | null; currency: string; amount: number; occurredAt: string; note?: string | null; marketRate?: number | null },
) {
  // Paid in another currency than billed: remember what was billed (and the market rate then).
  const original = p.currency !== b.currency ? { originalAmount: o.amount, originalCurrency: b.currency, marketRate: p.marketRate ?? null } : {};
  const t = deps.now();
  const { rows, ops } = insertLegOps(
    deps.db,
    userId,
    [
      {
        role: 'main',
        type: 'expense',
        accountId: p.account.id,
        currency: p.currency,
        cardId: p.card?.id ?? null,
        categoryId: b.categoryId,
        amount: -p.amount,
        occurredAt: p.occurredAt,
        counterparty: b.name,
        note: p.note ?? null,
        extra: {},
        ...original,
      },
    ],
    [],
    t,
    { billOccurrenceId: o.id },
  );
  ops.push(deps.db.update(billOccurrences).set({ status: 'paid', transactionId: rows[0]!.id, updatedAt: t }).where(eq(billOccurrences.id, o.id)));
  return { rows, ops };
}

/**
 * Apply the creation-time policy to due dates already in the past:
 * record → paid with expense transactions (if the bill has an account holding its currency,
 * otherwise falls back to paid); paid → paid without transactions; pending → untouched.
 */
async function applyPastPolicy(deps: Deps, userId: string, b: BillRow, policy: 'record' | 'paid' | 'pending') {
  if (policy === 'pending') return { recorded: 0, markedPaid: 0 };
  const past = await deps.db
    .select()
    .from(billOccurrences)
    .where(and(eq(billOccurrences.billId, b.id), eq(billOccurrences.status, 'pending'), lt(billOccurrences.dueDate, today(deps))));
  if (past.length === 0) return { recorded: 0, markedPaid: 0 };
  const { account, card } = await paymentSource(deps, userId, b);
  const canRecord = policy === 'record' && account && (await currenciesOf(deps.db, account.id)).includes(b.currency);
  if (canRecord) {
    // Set-based, in one batch: multi-row inserts, then each occurrence linked to its
    // transaction, then one balance recompute (not one per payment).
    const t = deps.now();
    const links = past.map((o) => {
      const [tx] = legRows(
        userId,
        [
          {
            role: 'main',
            type: 'expense',
            accountId: account.id,
            currency: b.currency,
            cardId: card?.id ?? null,
            categoryId: b.categoryId,
            amount: -o.amount,
            occurredAt: o.dueDate,
            counterparty: b.name,
            note: null,
            extra: {},
          },
        ],
        t,
        { billOccurrenceId: o.id },
      );
      return { occurrenceId: o.id, tx: tx! };
    });
    const { db } = deps;
    await runBatch(db, [
      ...chunkRows(links.map((l) => l.tx)).map((part) => db.insert(transactions).values(part)),
      // 3 parameters per occurrence (case pair + IN list) + 2 → 30 per statement.
      ...chunkIds(links, 30).map((part) =>
        db
          .update(billOccurrences)
          .set({
            status: 'paid',
            transactionId: sql`case ${billOccurrences.id} ${sql.join(
              part.map((l) => sql`when ${l.occurrenceId} then ${l.tx.id}`),
              sql` `,
            )} end`,
            updatedAt: t,
          })
          .where(inArray(billOccurrences.id, part.map((l) => l.occurrenceId))),
      ),
      ...recalcOps(db, [{ accountId: account.id, currency: b.currency }]),
    ]);
    return { recorded: past.length, markedPaid: 0 };
  }
  await runBatch(
    deps.db,
    chunkIds(past.map((o) => o.id)).map((ids) => deps.db.update(billOccurrences).set({ status: 'paid', updatedAt: deps.now() }).where(inArray(billOccurrences.id, ids))),
  );
  return { recorded: 0, markedPaid: past.length };
}

const horizon = (deps: Deps) => addDays(today(deps), Math.max(62, deps.config.get().reminders.lookaheadDays));

const occQuery = z.object({
  /** Omit for the full history. */
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  billId: z.string().max(40).optional(),
});

export const billRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const rows = await c.var.deps.db.select().from(bills).where(eq(bills.userId, c.var.user.id)).orderBy(asc(bills.createdAt));
    return c.json(await billDtos(c.var.deps, c.var.user.id, rows));
  })

  .post('/', async (c) => {
    const input = await body(c, billSchema);
    const deps = c.var.deps;
    const userId = c.var.user.id;
    await validateRefs(deps, userId, input);
    const t = deps.now();
    const { pastPolicy, ...fields } = input;
    const row: BillRow = {
      id: newId(),
      userId,
      ...fields,
      freq: fields.kind === 'once' ? 'monthly' : (fields.freq ?? 'monthly'),
      interval: fields.kind === 'once' ? 1 : fields.interval,
      accountId: fields.accountId ?? null,
      cardId: fields.cardId ?? null,
      categoryId: fields.categoryId ?? null,
      endDate: fields.kind === 'once' ? null : (fields.endDate ?? null),
      note: fields.note ?? null,
      createdAt: t,
      updatedAt: t,
    };
    assertHistoryFits(deps, row);
    await deps.db.insert(bills).values(row);
    await syncOccurrences(deps, userId, horizon(deps), { billIds: [row.id], full: true });
    const past = await applyPastPolicy(deps, userId, row, pastPolicy);
    const [dto] = await billDtos(deps, userId, [row]);
    return c.json({ ...dto!, past }, 201);
  })

  .patch('/:id', async (c) => {
    const input = await body(c, billPatchSchema);
    const deps = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownBill(deps, userId, c.req.param('id'));
    await validateRefs(deps, userId, { ...input, startDate: input.startDate ?? cur.startDate });
    const kind = input.kind ?? cur.kind;
    const freq = kind === 'once' ? cur.freq : (input.freq ?? cur.freq);
    assertHistoryFits(deps, {
      kind,
      freq,
      interval: kind === 'once' ? 1 : (input.interval ?? cur.interval),
      startDate: input.startDate ?? cur.startDate,
      endDate: kind === 'once' ? null : input.endDate !== undefined ? input.endDate : cur.endDate,
    });
    const [row] = await deps.db
      .update(bills)
      .set({ ...defined(input), freq, ...(kind === 'once' && { endDate: null, interval: 1 }), updatedAt: deps.now() })
      .where(and(eq(bills.id, cur.id), eq(bills.userId, userId)))
      .returning();
    const scheduleChanged = (['kind', 'amount', 'freq', 'interval', 'startDate', 'endDate', 'active'] as const).some(
      (k) => input[k] !== undefined && input[k] !== cur[k],
    );
    if (scheduleChanged) {
      // Unpaid future dates follow the new schedule; paid/skipped history is kept.
      await deps.db
        .delete(billOccurrences)
        .where(and(eq(billOccurrences.billId, cur.id), eq(billOccurrences.status, 'pending'), gte(billOccurrences.dueDate, today(deps))));
      await syncOccurrences(deps, userId, horizon(deps), { billIds: [cur.id], full: true });
    }
    const [dto] = await billDtos(deps, userId, [row!]);
    return c.json(dto!);
  })

  .delete('/:id', async (c) => {
    const deps = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownBill(deps, userId, c.req.param('id'));
    await runBatch(deps.db, [
      // Recorded payments stay as ordinary expenses, detached from the bill.
      deps.db
        .update(transactions)
        .set({ billOccurrenceId: null })
        .where(
          and(
            eq(transactions.userId, userId),
            inArray(transactions.billOccurrenceId, deps.db.select({ id: billOccurrences.id }).from(billOccurrences).where(eq(billOccurrences.billId, cur.id))),
          ),
        ),
      deps.db.delete(billOccurrences).where(eq(billOccurrences.billId, cur.id)),
      deps.db.delete(bills).where(and(eq(bills.id, cur.id), eq(bills.userId, userId))),
    ]);
    return c.json({ ok: true });
  })

  .get('/occurrences', async (c) => {
    const q = query(c, occQuery);
    const deps = c.var.deps;
    const userId = c.var.user.id;
    const to = q.to ?? horizon(deps);
    await syncOccurrences(deps, userId, to);
    const conds = [lte(billOccurrences.dueDate, to)];
    if (q.from) conds.push(gte(billOccurrences.dueDate, q.from));
    if (q.billId) conds.push(eq(billOccurrences.billId, q.billId));
    return c.json(await occurrenceDtos(deps, userId, and(...conds)!));
  })

  /** Mark an occurrence paid by recording the expense transaction. */
  .post('/occurrences/:id/pay', async (c) => {
    const input = await body(c, payOccurrenceSchema);
    const deps = c.var.deps;
    const userId = c.var.user.id;
    const [hit] = await deps.db
      .select({ o: billOccurrences, b: bills })
      .from(billOccurrences)
      .innerJoin(bills, eq(bills.id, billOccurrences.billId))
      .where(and(eq(billOccurrences.id, c.req.param('id')), eq(billOccurrences.userId, userId)));
    if (!hit) notFound('occurrence');
    const { o, b } = hit;
    if (o.status === 'paid') fail(409, 'already paid', 'ALREADY_PAID');

    const { account, card } = await paymentSource(deps, userId, b, { accountId: input.accountId, cardId: input.cardId });
    if (!account) fail(400, 'choose the account or card used to pay', 'ACCOUNT_REQUIRED');
    const held = await currenciesOf(deps.db, account.id);
    const currency = input.currency ?? (held.includes(b.currency) ? b.currency : account.currency);
    if (!held.includes(currency)) fail(400, `${account.name} does not hold ${currency}`, 'CURRENCY_NOT_HELD');
    // Charged in another currency and the amount left blank: convert at the current rate.
    let amount = input.amount ?? (currency === b.currency ? o.amount : null);
    let marketRate: number | null = null;
    if (currency !== b.currency) {
      const rates = await ratesMap(deps.db);
      marketRate = pairRate((x) => rates.get(x), b.currency, currency);
      amount ??= await convertNow(deps, o.amount, b.currency, currency, 'AMOUNT_REQUIRED', rates);
    }
    const t = today(deps);
    const { rows, ops } = paymentOps(deps, userId, b, o, {
      account,
      card,
      currency,
      marketRate,
      amount: amount!,
      occurredAt: input.occurredAt ?? (o.dueDate < t ? o.dueDate : t),
      note: input.note,
    });
    await runBatch(deps.db, ops);
    const [tx] = await toDtos(deps.db, userId, rows);
    return c.json({ transaction: tx });
  })

  .post('/occurrences/:id/skip', async (c) => {
    const { db, now } = c.var.deps;
    const r = await db
      .update(billOccurrences)
      .set({ status: 'skipped', updatedAt: now() })
      .where(and(eq(billOccurrences.id, c.req.param('id')), eq(billOccurrences.userId, c.var.user.id), eq(billOccurrences.status, 'pending')))
      .returning({ id: billOccurrences.id });
    if (!r.length) notFound('pending occurrence');
    return c.json({ ok: true });
  })

  /** Undo pay/skip. Undoing a payment deletes the transaction it created. */
  .post('/occurrences/:id/reset', async (c) => {
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const [o] = await db
      .select()
      .from(billOccurrences)
      .where(and(eq(billOccurrences.id, c.req.param('id')), eq(billOccurrences.userId, userId)));
    if (!o) notFound('occurrence');
    const ops: BatchItem<'sqlite'>[] = [
      db.update(billOccurrences).set({ status: 'pending', transactionId: null, updatedAt: now() }).where(eq(billOccurrences.id, o.id)),
    ];
    if (o.transactionId) {
      const [tx] = await db.select().from(transactions).where(and(eq(transactions.id, o.transactionId), eq(transactions.userId, userId)));
      ops.push(
        db.delete(transactionTags).where(eq(transactionTags.transactionId, o.transactionId)),
        db.delete(transactions).where(and(eq(transactions.id, o.transactionId), eq(transactions.userId, userId))),
        ...(tx ? recalcOps(db, [{ accountId: tx.accountId, currency: tx.currency }]) : []),
      );
    }
    await runBatch(db, ops);
    return c.json({ ok: true });
  });
