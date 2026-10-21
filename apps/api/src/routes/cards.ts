import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  binOf,
  cardPatchSchema,
  cardSchema,
  checkPan,
  detectBrand,
  last4Of,
  monthStart,
  normalizePan,
  todayIso,
  type CardBrand,
  type CardDto,
} from '@z-ui/shared';
import { requireStepUp } from '../auth/middleware.ts';
import type { DB } from '../db/client.ts';
import { accounts, cards, creditStatements, transactions } from '../db/schema.ts';
import type { AppBindings, Deps } from '../env.ts';
import { audit } from '../lib/audit.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import { inChunks } from '../lib/chunks.ts';
import { body, fail } from '../lib/http.ts';
import { newId } from '../lib/id.ts';
import { accountCurrency, applyExtra, defined, ownAccount, ownCard, runBatch } from '../lib/ledger.ts';
import { today } from './bills.ts';

type Row = typeof cards.$inferSelect;

const panContext = (cardId: string) => `card:${cardId}:pan`;
const cvvContext = (cardId: string) => `card:${cardId}:cvv`;

/**
 * Card DTOs with `spent` filled for cards that have a monthly or total limit: expenses paid
 * with the card in the account's primary currency (this month / all time).
 */
async function toDtos(db: DB, userId: string, rows: Row[], now: number): Promise<CardDto[]> {
  const limited = rows.filter((r) => r.spendLimit && (r.limitPeriod === 'month' || r.limitPeriod === 'total'));
  const spent = new Map<string, number>();
  if (limited.length) {
    const month = monthStart(todayIso(new Date(now)));
    const sums = await inChunks(limited.map((r) => r.id), (part) =>
      db
      .select({
        cardId: transactions.cardId,
        month: sql<number>`coalesce(sum(case when ${transactions.occurredAt} >= ${month} then -${transactions.amount} else 0 end), 0)`,
        total: sql<number>`coalesce(sum(-${transactions.amount}), 0)`,
      })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.type, 'expense'),
          eq(transactions.currency, accounts.currency),
          inArray(transactions.cardId, part),
        ),
      )
      .groupBy(transactions.cardId));
    for (const r of limited) {
      const s = sums.find((x) => x.cardId === r.id);
      spent.set(r.id, Number((r.limitPeriod === 'month' ? s?.month : s?.total) ?? 0));
    }
  }
  return rows.map((r) => {
    const { userId: _u, panEnc, cvvEnc, ...rest } = r;
    return {
      ...rest,
      hasCvv: cvvEnc !== null,
      brand: r.brand as CardBrand,
      theme: r.theme as CardDto['theme'],
      binInfo: (r.binInfo as CardDto['binInfo']) ?? null,
      hasPan: panEnc !== null,
      spent: spent.get(r.id) ?? null,
    };
  });
}

/** Validate a full card number and derive what is stored in clear (BIN, last 4, brand). */
async function panFields(deps: Deps, cardId: string, rawPan: string) {
  const pan = normalizePan(rawPan);
  const check = checkPan(pan);
  if (!check.ok) {
    const msg = { format: 'card number must be digits', length: 'card number has the wrong length', luhn: 'card number failed the checksum' };
    fail(400, msg[check.reason!], 'BAD_PAN');
  }
  return {
    panEnc: await encryptField(deps.env.APP_ENC_KEY, pan, panContext(cardId)),
    bin: binOf(pan),
    last4: last4Of(pan),
    brand: check.brand,
  };
}

/** A virtual card's parent must be another card of the same user (not itself, not a virtual card). */
async function checkParent(db: DB, userId: string, parentId: string | null | undefined, selfId?: string) {
  if (!parentId) return null;
  if (parentId === selfId) fail(400, 'a card cannot be its own parent', 'BAD_PARENT');
  const parent = await ownCard(db, userId, parentId);
  if (parent.form === 'virtual') fail(400, 'virtual cards cannot have virtual children', 'BAD_PARENT');
  return parent.id;
}

type AutopayInput = { autopayAccountId?: string | null; autopayCurrency?: string | null; autopayMode?: 'full' | 'min' | null };

/**
 * Automatic repayment of a credit card: the account the bank debits on the due date. Only
 * statements due from the day it is set up (autopaySince) are repaid automatically, so turning it
 * on never pays old, already overdue statements behind your back.
 */
async function autopayFields(deps: Deps, userId: string, card: { funding: string; accountId: string }, input: AutopayInput, cur: Row | null) {
  const accountId = input.autopayAccountId !== undefined ? input.autopayAccountId : (cur?.autopayAccountId ?? null);
  if (card.funding !== 'credit' || !accountId) return { autopayAccountId: null, autopayCurrency: null, autopayMode: null, autopaySince: null };
  if (accountId === card.accountId) fail(400, 'repay from another account than the card’s own', 'AUTOPAY_SAME_ACCOUNT');
  const account = await ownAccount(deps.db, userId, accountId);
  const requested = input.autopayCurrency !== undefined ? input.autopayCurrency : (cur?.autopayCurrency ?? null);
  return {
    autopayAccountId: account.id,
    // null: the statement's currency when the account holds it, else the account's primary one.
    autopayCurrency: requested ? await accountCurrency(deps.db, account, requested) : null,
    autopayMode: input.autopayMode ?? cur?.autopayMode ?? 'full',
    autopaySince: cur?.autopayAccountId === account.id && cur.autopaySince ? cur.autopaySince : today(deps),
  };
}

export const cardRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const accountId = c.req.query('accountId');
    const where = accountId
      ? and(eq(cards.userId, c.var.user.id), eq(cards.accountId, accountId))
      : eq(cards.userId, c.var.user.id);
    const rows = await c.var.deps.db.select().from(cards).where(where).orderBy(asc(cards.createdAt));
    return c.json(await toDtos(c.var.deps.db, c.var.user.id, rows, c.var.deps.now()));
  })

  .post('/', async (c) => {
    const input = await body(c, cardSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    await ownAccount(db, userId, input.accountId);
    const id = newId();
    const parentCardId = input.form === 'virtual' ? await checkParent(db, userId, input.parentCardId) : null;
    const t = now();
    const fromPan = input.pan?.trim() ? await panFields(c.var.deps, id, input.pan) : null;
    const autopay = await autopayFields(c.var.deps, userId, input, input, null);
    const row: Row = {
      id,
      userId,
      accountId: input.accountId,
      form: input.form,
      parentCardId,
      status: input.status,
      spendLimit: input.spendLimit ?? null,
      limitPeriod: input.spendLimit ? (input.limitPeriod ?? 'month') : null,
      singleUse: input.singleUse,
      merchant: input.merchant ?? null,
      // Only keep the BIN record when it matches the stored BIN.
      binInfo: input.binInfo && input.binInfo.bin === (fromPan?.bin ?? input.bin) ? input.binInfo : null,
      nickname: input.nickname ?? null,
      brand: fromPan?.brand ?? input.brand ?? (input.bin ? detectBrand(input.bin) : 'other'),
      funding: input.funding,
      bin: fromPan?.bin ?? input.bin ?? null,
      last4: fromPan?.last4 ?? input.last4!,
      panEnc: fromPan?.panEnc ?? null,
      cvvEnc: input.cvv ? await encryptField(c.var.deps.env.APP_ENC_KEY, input.cvv, cvvContext(id)) : null,
      expMonth: input.expMonth ?? null,
      expYear: input.expYear ?? null,
      holderName: input.holderName ?? null,
      statementDay: input.statementDay ?? null,
      dueDay: input.dueDay ?? null,
      ...autopay,
      theme: input.theme,
      note: input.note ?? null,
      extra: applyExtra(c.var.deps, 'card', {}, input.extra),
      archived: input.archived ?? false,
      createdAt: t,
      updatedAt: t,
    };
    await db.insert(cards).values(row);
    const [dto] = await toDtos(db, userId, [row], t);
    return c.json(dto!, 201);
  })

  .patch('/:id', async (c) => {
    const input = await body(c, cardPatchSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownCard(db, userId, c.req.param('id'));
    if (input.accountId) await ownAccount(db, userId, input.accountId);
    const { pan, cvv, extra, last4, parentCardId, binInfo, autopayAccountId, autopayCurrency, autopayMode, ...fields } = input;
    // cvv: digits → replace; null/"" → forget; undefined → unchanged.
    const cvvUpdate = cvv === undefined ? {} : { cvvEnc: cvv ? await encryptField(c.var.deps.env.APP_ENC_KEY, cvv, cvvContext(cur.id)) : null };
    const autopay = await autopayFields(
      c.var.deps,
      userId,
      { funding: input.funding ?? cur.funding, accountId: input.accountId ?? cur.accountId },
      { autopayAccountId, autopayCurrency, autopayMode },
      cur,
    );
    const form = input.form ?? cur.form;
    // pan: string → replace; null/"" → forget the stored number (keep last 4); undefined → unchanged.
    const panUpdate =
      pan === undefined ? {} : pan && pan.trim() ? await panFields(c.var.deps, cur.id, pan) : { panEnc: null };
    const parentUpdate =
      form === 'physical'
        ? { parentCardId: null }
        : parentCardId === undefined
          ? {}
          : { parentCardId: await checkParent(db, userId, parentCardId, cur.id) };
    // The public BIN record is only kept while it describes the card's current BIN.
    const nextBin = (panUpdate as { bin?: string }).bin ?? (fields.bin !== undefined ? fields.bin : cur.bin);
    const info = binInfo !== undefined ? binInfo : (cur.binInfo as Record<string, string> | null);
    const binInfoUpdate = { binInfo: info && info.bin === nextBin ? info : null };
    const limitUpdate =
      input.spendLimit === null ? { limitPeriod: null } : input.spendLimit && !input.limitPeriod && !cur.limitPeriod ? { limitPeriod: 'month' as const } : {};
    const [row] = await db
      .update(cards)
      .set({
        ...defined(fields),
        ...(last4 ? { last4 } : {}),
        ...panUpdate,
        ...cvvUpdate,
        ...parentUpdate,
        ...binInfoUpdate,
        ...limitUpdate,
        ...autopay,
        ...(extra !== undefined && { extra: applyExtra(c.var.deps, 'card', cur.extra, extra) }),
        updatedAt: now(),
      })
      .where(and(eq(cards.id, cur.id), eq(cards.userId, userId)))
      .returning();
    const [dto] = await toDtos(db, userId, [row!], now());
    return c.json(dto!);
  })

  .delete('/:id', async (c) => {
    const { db } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await ownCard(db, userId, c.req.param('id'));
    const [tx] = await db.select({ n: count() }).from(transactions).where(eq(transactions.cardId, cur.id));
    const [st] = await db.select({ n: count() }).from(creditStatements).where(eq(creditStatements.cardId, cur.id));
    if ((tx?.n ?? 0) > 0 || (st?.n ?? 0) > 0) {
      fail(409, 'card has transactions or statements — archive it instead', 'HAS_CHILDREN');
    }
    await runBatch(db, [
      // Virtual cards issued under this one stay, detached from it.
      db.update(cards).set({ parentCardId: null }).where(and(eq(cards.userId, userId), eq(cards.parentCardId, cur.id))),
      db.delete(cards).where(and(eq(cards.id, cur.id), eq(cards.userId, userId))),
    ]);
    return c.json({ ok: true });
  })

  /** Full card number. Requires a passkey/TOTP verification in the last 5 minutes; audited. */
  .post('/:id/reveal', requireStepUp, async (c) => {
    const cur = await ownCard(c.var.deps.db, c.var.user.id, c.req.param('id'));
    if (!cur.panEnc) fail(404, 'no card number stored', 'NO_PAN');
    const pan = await decryptField(c.var.deps.env.APP_ENC_KEY, cur.panEnc, panContext(cur.id));
    await audit(c, 'card.reveal', { card: cur.id, last4: cur.last4 });
    c.header('Cache-Control', 'no-store');
    return c.json({ pan });
  })

  /** Security code, asked for when the card is turned over. Same protection as the number; audited. */
  .post('/:id/cvv', requireStepUp, async (c) => {
    const cur = await ownCard(c.var.deps.db, c.var.user.id, c.req.param('id'));
    if (!cur.cvvEnc) fail(404, 'no security code stored', 'NO_CVV');
    const cvv = await decryptField(c.var.deps.env.APP_ENC_KEY, cur.cvvEnc, cvvContext(cur.id));
    await audit(c, 'card.reveal_cvv', { card: cur.id, last4: cur.last4 });
    c.header('Cache-Control', 'no-store');
    return c.json({ cvv });
  });
