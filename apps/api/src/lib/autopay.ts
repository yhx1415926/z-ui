import { and, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { addDays, currencyDecimals, maskPan, pairRate, type StatementDto } from '@z-ui/shared';
import { accountCurrencies, accounts, cards, creditStatements, institutions, transactions } from '../db/schema.ts';
import type { Deps } from '../env.ts';
import { today } from '../routes/bills.ts';
import { convert, ratesMap } from '../routes/fx.ts';
import { statementDtos } from '../routes/statements.ts';
import { legRows } from '../routes/transactions.ts';
import type { DB } from '../db/client.ts';
import { pairsOf, recalcOps } from './balances.ts';
import { runBatch } from './ledger.ts';

/**
 * Credit cards with a bound repayment account (cards.autopay_*): on the due date the bank debits
 * that account, so the repayment transfer is recorded by itself — by the daily cron on Cloudflare,
 * and whenever the statements or reminders are loaded. Each statement is handled once
 * (credit_statements.autopay_at); deleting the recorded transfer does not bring it back.
 */

type CardRow = typeof cards.$inferSelect;

export interface AutopayPlan {
  statement: StatementDto;
  card: CardRow;
  cardName: string;
  /** Account debited (null: it no longer exists). */
  accountId: string | null;
  accountName: string;
  /** Debited from the account, in `currency`; null when no FX rate converts the statement's currency. */
  currency: string;
  needed: number | null;
  /** Credited to the card, in the statement's currency. */
  amount: number;
  /** The account's current balance in `currency`. */
  balance: number;
  /** Statement currency per 1 unit of `currency` (cross-currency repayments). */
  marketRate: number | null;
}

export const cardName = (c: Pick<CardRow, 'nickname' | 'last4'>) => c.nickname ?? maskPan(c.last4);

/** "Institution · Account" labels for emails and reminders. */
export async function accountLabels(db: DB, userId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: accounts.id, name: accounts.name, inst: institutions.name })
    .from(accounts)
    .innerJoin(institutions, eq(institutions.id, accounts.institutionId))
    .where(and(eq(accounts.userId, userId), inArray(accounts.id, ids)));
  return new Map(rows.map((r) => [r.id, `${r.inst} · ${r.name}`]));
}

/** Statements of autopay cards due by `dueBy` (and not before the card's autopay start) that are not handled yet. */
export async function autopayPlans(deps: Deps, userId: string, dueBy: string): Promise<AutopayPlan[]> {
  const { db } = deps;
  const cardRows = await db
    .select()
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.funding, 'credit'), eq(cards.archived, false), isNotNull(cards.autopayAccountId)));
  if (cardRows.length === 0) return [];
  const earliest = cardRows.map((c) => c.autopaySince ?? dueBy).sort()[0]!;
  const stRows = await db
    .select()
    .from(creditStatements)
    .where(
      and(
        eq(creditStatements.userId, userId),
        inArray(
          creditStatements.cardId,
          cardRows.map((c) => c.id),
        ),
        isNull(creditStatements.autopayAt),
        gte(creditStatements.dueDate, earliest),
        lte(creditStatements.dueDate, dueBy),
      ),
    );
  const due = stRows.filter((s) => s.dueDate >= (cardRows.find((c) => c.id === s.cardId)!.autopaySince ?? dueBy));
  if (due.length === 0) return [];
  const accountIds = [...new Set(cardRows.map((c) => c.autopayAccountId!))];
  const [dtos, labels, held, rates] = await Promise.all([
    statementDtos(deps, userId, due),
    accountLabels(db, userId, accountIds),
    db.select().from(accountCurrencies).where(and(eq(accountCurrencies.userId, userId), inArray(accountCurrencies.accountId, accountIds))),
    ratesMap(db),
  ]);
  const decimals = (c: string) => currencyDecimals(deps.config.get(), c);
  return dtos.map((st) => {
    const card = cardRows.find((c) => c.id === st.cardId)!;
    const accountId = labels.has(card.autopayAccountId!) ? card.autopayAccountId! : null;
    const mine = held.filter((h) => h.accountId === accountId).sort((a, b) => a.sort - b.sort);
    // Debit the statement's currency when the account holds it, else its primary currency.
    const currency = card.autopayCurrency ?? (mine.some((h) => h.currency === st.currency) ? st.currency : (mine[0]?.currency ?? st.currency));
    // Minimum payment mode pays what is left of the minimum (the whole remainder if none was entered).
    const amount =
      card.autopayMode === 'min' && st.minPayment !== null ? Math.max(0, Math.min(st.remaining, st.minPayment - st.paidAmount)) : st.remaining;
    const needed = currency === st.currency ? amount : convert(amount, st.currency, currency, rates, decimals);
    return {
      statement: st,
      card,
      cardName: cardName(card),
      accountId,
      accountName: accountId ? labels.get(accountId)! : '',
      currency,
      needed,
      amount,
      balance: mine.find((h) => h.currency === currency)?.balance ?? 0,
      marketRate: currency === st.currency ? null : pairRate((x) => rates.get(x), currency, st.currency),
    };
  });
}

export interface AutopayDone extends AutopayPlan {
  transactionId: string;
}

/** Record the repayments due today or earlier. */
export async function runAutopay(deps: Deps, userId: string): Promise<AutopayDone[]> {
  const { db } = deps;
  const done: AutopayDone[] = [];
  for (const p of await autopayPlans(deps, userId, today(deps))) {
    // No account or no FX rate: the statement stays unpaid (reminder + email) until repaid by hand.
    if (!p.accountId || p.needed === null) continue;
    const t = deps.now();
    const st = p.statement;
    const ops: BatchItem<'sqlite'>[] = [
      db.update(creditStatements).set({ autopayAt: t }).where(and(eq(creditStatements.id, st.id), isNull(creditStatements.autopayAt))),
    ];
    let transactionId = '';
    if (p.amount > 0) {
      const common = { cardId: null, categoryId: null, counterparty: null, note: '自动还款', extra: {}, occurredAt: st.dueDate, type: 'transfer' as const, marketRate: p.marketRate };
      const rows = legRows(
        userId,
        [
          { ...common, role: 'from', accountId: p.accountId, currency: p.currency, amount: -p.needed },
          { ...common, role: 'to', accountId: st.accountId, currency: st.currency, amount: p.amount },
        ],
        t,
        { statementId: st.id, statementLeg: 'to' },
      );
      // Fixed ids: if two runs race, the second batch fails on the primary key and rolls back.
      rows[0]!.id = `autopay-${st.id}-out`;
      rows[1]!.id = `autopay-${st.id}-in`;
      transactionId = rows[0]!.id;
      ops.push(db.insert(transactions).values(rows), ...recalcOps(db, pairsOf(rows)));
    }
    try {
      await runBatch(db, ops);
    } catch (e) {
      if (/unique|constraint/i.test(String((e as Error)?.message ?? e))) continue; // the other run recorded it
      throw e;
    }
    if (p.amount > 0) done.push({ ...p, transactionId });
  }
  return done;
}

/** Autopay statements due within `days` whose account does not hold enough to cover them. */
export async function autopayShortfalls(deps: Deps, userId: string, days: number): Promise<AutopayPlan[]> {
  const t = today(deps);
  const list = await autopayPlans(deps, userId, addDays(t, days));
  return list.filter((p) => p.statement.dueDate >= t && p.amount > 0 && p.accountId && p.needed !== null && p.balance < p.needed);
}

export interface AutopayRecent {
  statementId: string;
  cardName: string;
  accountName: string;
  dueDate: string;
  /** Credited to the card / debited from the account. */
  amount: number;
  currency: string;
  paid: number;
  paidCurrency: string;
}

/** Repayments recorded automatically in the last `days` (still present), for the "done" mails. */
export async function recentAutopays(deps: Deps, userId: string, days: number): Promise<AutopayRecent[]> {
  const { db } = deps;
  const sts = await db
    .select({ s: creditStatements, c: cards })
    .from(creditStatements)
    .innerJoin(cards, eq(cards.id, creditStatements.cardId))
    .where(and(eq(creditStatements.userId, userId), gte(creditStatements.autopayAt, deps.now() - days * 86_400_000)));
  if (sts.length === 0) return [];
  const legs = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), inArray(transactions.id, sts.flatMap(({ s }) => [`autopay-${s.id}-out`, `autopay-${s.id}-in`]))));
  const labels = await accountLabels(db, userId, [...new Set(legs.map((l) => l.accountId))]);
  return sts.flatMap(({ s, c }) => {
    const out = legs.find((l) => l.id === `autopay-${s.id}-out`);
    const into = legs.find((l) => l.id === `autopay-${s.id}-in`);
    if (!out || !into) return [];
    return [
      {
        statementId: s.id,
        cardName: cardName(c),
        accountName: labels.get(out.accountId) ?? '',
        dueDate: s.dueDate,
        amount: into.amount,
        currency: into.currency,
        paid: -out.amount,
        paidCurrency: out.currency,
      },
    ];
  });
}
