import { and, eq, gte, isNotNull, lte } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  addDays,
  currencyDecimals,
  daysInMonth,
  decimalToMinor,
  diffDays,
  dismissReminderSchema,
  dueTextZh,
  formatMoney,
  fromParts,
  maskPan,
  microsToString,
  nextDayOfMonth,
  todayIso,
  type ReminderDto,
  type ReminderKind,
} from '@z-ui/shared';
import { accountCurrencies, accounts, billOccurrences, bills, cards, creditStatements, institutions, priceAlerts, reminderDismissals, securities } from '../db/schema.ts';
import type { AppBindings, Deps } from '../env.ts';
import { autopayShortfalls, runAutopay } from '../lib/autopay.ts';
import { body } from '../lib/http.ts';
import { syncOccurrences, today } from './bills.ts';
import { statementDtos } from './statements.ts';

/** A reminder plus the formatted values the email templates use. */
export type ReminderItem = ReminderDto & { vars: Record<string, string | number> };

/** Money as it appears in emails: "¥1,234.50" with the configured symbol. */
export function moneyFormatter(deps: Deps) {
  const cfg = deps.config.get();
  return (minor: number, currency: string) =>
    formatMoney(minor, currency, currencyDecimals(cfg, currency), { locale: 'zh-CN', symbol: cfg.currencies.find((c) => c.code === currency)?.symbol });
}

/** Triggered price alerts stay in the bell for two weeks. */
const ALERT_DAYS = 14;

/**
 * In-app reminders, computed on request from bills, statements and cards:
 *  - bill occurrences that are pending
 *  - statements with an unpaid remainder
 *  - credit card due days with no statement entered yet
 *  - cards about to expire
 *  - credit accounts over their limit
 *  - automatic repayments the bound account cannot cover
 *  - price alerts that fired
 * `kinds` limits the work to some of them; `horizonDays` looks further ahead than the config.
 */
export async function reminderItems(deps: Deps, userId: string, opts: { kinds?: ReminderKind[]; horizonDays?: number } = {}): Promise<ReminderItem[]> {
  const { db } = deps;
  const want = (k: ReminderKind) => !opts.kinds || opts.kinds.includes(k);
  const cfg = deps.config.get().reminders;
  const money = moneyFormatter(deps);
  const t = today(deps);
  const lookahead = Math.max(cfg.lookaheadDays, opts.horizonDays ?? 0);
  const horizon = addDays(t, lookahead);

  const out: ReminderItem[] = [];
  const push = (r: Omit<ReminderItem, 'daysLeft' | 'severity'>, soonDays: number) => {
    const daysLeft = diffDays(r.date, t);
    out.push({ ...r, daysLeft, severity: daysLeft < 0 ? 'overdue' : daysLeft <= soonDays ? 'soon' : 'upcoming' });
  };

  if (want('bill')) {
    await syncOccurrences(deps, userId, horizon);
    const occ = await db
      .select({ o: billOccurrences, b: bills })
      .from(billOccurrences)
      .innerJoin(bills, eq(bills.id, billOccurrences.billId))
      .where(and(eq(billOccurrences.userId, userId), eq(billOccurrences.status, 'pending'), lte(billOccurrences.dueDate, horizon)));
    for (const { o, b } of occ) {
      const vars = { bill: b.name, amount: money(o.amount, b.currency), dueDate: o.dueDate, daysLeft: diffDays(o.dueDate, t), daysOverdue: Math.max(0, diffDays(t, o.dueDate)) };
      push({ key: `bill:${o.id}`, kind: 'bill', title: b.name, date: o.dueDate, amount: o.amount, currency: b.currency, refId: o.id, vars }, b.remindDaysBefore);
    }
  }

  const needCards = want('statement') || want('card_due') || want('card_expiry');
  const cardRows = needCards ? await db.select().from(cards).where(and(eq(cards.userId, userId), eq(cards.archived, false))) : [];
  const cardName = (id: string) => {
    const cd = cardRows.find((x) => x.id === id);
    return cd ? (cd.nickname ?? maskPan(cd.last4)) : '';
  };
  const stRows =
    want('statement') || want('card_due')
      ? await db
          .select()
          .from(creditStatements)
          .where(and(eq(creditStatements.userId, userId), lte(creditStatements.dueDate, horizon), gte(creditStatements.dueDate, addDays(t, -120))))
      : [];
  if (want('statement')) {
    for (const s of await statementDtos(deps, userId, stRows)) {
      if (s.remaining <= 0) continue;
      const daysLeft = diffDays(s.dueDate, t);
      const autopay = !!cardRows.find((x) => x.id === s.cardId)?.autopayAccountId && !s.autopayAt;
      const vars = { card: cardName(s.cardId), amount: money(s.remaining, s.currency), dueDate: s.dueDate, daysLeft, dueText: dueTextZh(daysLeft), autopay: autopay ? 1 : 0 };
      push(
        { key: `statement:${s.id}`, kind: 'statement', title: cardName(s.cardId), date: s.dueDate, amount: s.remaining, currency: s.currency, refId: s.id, vars },
        cfg.defaultDaysBefore,
      );
    }
  }

  for (const cd of cardRows) {
    if (want('card_due') && cd.funding === 'credit' && cd.dueDay) {
      const due = nextDayOfMonth(t, cd.dueDay);
      // Banks shift due dates around weekends/holidays, so a statement within ±5 days counts.
      const entered = stRows.some((s) => s.cardId === cd.id && Math.abs(diffDays(s.dueDate, due)) <= 5);
      if (due <= horizon && !entered) {
        const vars = { card: cd.nickname ?? maskPan(cd.last4), dueDate: due };
        push(
          { key: `card_due:${cd.id}:${due}`, kind: 'card_due', title: vars.card, date: due, amount: null, currency: null, refId: cd.id, vars },
          cfg.defaultDaysBefore,
        );
      }
    }
    if (want('card_expiry') && cd.expMonth && cd.expYear) {
      const expiry = fromParts(cd.expYear, cd.expMonth, daysInMonth(cd.expYear, cd.expMonth));
      const window = Math.max(cfg.cardExpiryDays, opts.horizonDays ?? 0);
      if (diffDays(expiry, t) <= window && diffDays(expiry, t) >= -31) {
        const vars = { card: cd.nickname ?? maskPan(cd.last4), expiry: `${String(cd.expMonth).padStart(2, '0')}/${cd.expYear}`, daysLeft: diffDays(expiry, t) };
        push(
          { key: `card_expiry:${cd.id}:${cd.expYear}-${cd.expMonth}`, kind: 'card_expiry', title: vars.card, date: expiry, amount: null, currency: null, refId: cd.id, vars },
          cfg.cardExpiryDays,
        );
      }
    }
  }

  // Credit accounts owing more than their limit (primary currency). Keyed per day: dismissing
  // hides it until tomorrow, and it comes back while the account is still over the limit.
  if (want('over_limit')) {
    const credit = await db
      .select({ a: accounts, inst: institutions.name, balance: accountCurrencies.balance })
      .from(accounts)
      .innerJoin(accountCurrencies, and(eq(accountCurrencies.accountId, accounts.id), eq(accountCurrencies.currency, accounts.currency)))
      .innerJoin(institutions, eq(institutions.id, accounts.institutionId))
      .where(and(eq(accounts.userId, userId), eq(accounts.type, 'credit'), eq(accounts.archived, false), isNotNull(accounts.creditLimit)));
    for (const { a, inst, balance } of credit) {
      const owed = -balance;
      if (!a.creditLimit || owed <= a.creditLimit) continue;
      out.push({
        key: `over_limit:${a.id}:${t}`,
        kind: 'over_limit',
        title: a.name,
        date: t,
        daysLeft: 0,
        amount: owed - a.creditLimit,
        currency: a.currency,
        refId: a.id,
        severity: 'overdue',
        vars: { account: `${inst} · ${a.name}`, owed: money(owed, a.currency), limit: money(a.creditLimit, a.currency), over: money(owed - a.creditLimit, a.currency) },
      });
    }
  }

  // The bound account cannot cover an automatic repayment due soon.
  if (want('autopay_low')) {
    for (const p of await autopayShortfalls(deps, userId, lookahead)) {
      const st = p.statement;
      const vars = {
        card: p.cardName,
        account: p.accountName,
        balance: money(p.balance, p.currency),
        needed: money(p.needed!, p.currency),
        dueDate: st.dueDate,
        daysLeft: diffDays(st.dueDate, t),
      };
      push(
        { key: `autopay_low:${st.id}`, kind: 'autopay_low', title: p.cardName, date: st.dueDate, amount: p.needed! - p.balance, currency: p.currency, refId: st.id, vars },
        cfg.defaultDaysBefore,
      );
    }
  }

  if (want('price_alert')) {
    const fired = await db
      .select({ a: priceAlerts, name: securities.name })
      .from(priceAlerts)
      .leftJoin(securities, eq(securities.symbol, priceAlerts.symbol))
      .where(and(eq(priceAlerts.userId, userId), isNotNull(priceAlerts.triggeredAt), gte(priceAlerts.triggeredAt, deps.now() - ALERT_DAYS * 86_400_000)));
    for (const { a, name } of fired) {
      const price = a.triggeredPriceMicros !== null ? microsToString(a.triggeredPriceMicros) : null;
      const target = microsToString(a.targetMicros);
      const usd = (s: string) => money(decimalToMinor(s), 'USD');
      const date = todayIso(new Date(a.triggeredAt!));
      out.push({
        key: `price_alert:${a.id}:${a.triggeredAt}`,
        kind: 'price_alert',
        title: `${a.symbol} ${a.direction === 'above' ? '≥' : '≤'} ${usd(target)}`,
        date,
        daysLeft: diffDays(date, t),
        amount: price ? decimalToMinor(price) : null,
        currency: price ? 'USD' : null,
        refId: a.symbol,
        severity: 'soon',
        vars: {
          symbol: a.symbol,
          name: name ?? a.symbol,
          price: price ? usd(price) : '',
          target: usd(target),
          direction: a.direction === 'above' ? '涨到' : '跌到',
          time: new Date(a.triggeredAt!).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
        },
      });
    }
  }

  const dismissed = new Set(
    (await db.select({ key: reminderDismissals.key }).from(reminderDismissals).where(eq(reminderDismissals.userId, userId))).map((d) => d.key),
  );
  return out.filter((r) => !dismissed.has(r.key)).sort((a, b) => a.date.localeCompare(b.date));
}

export async function computeReminders(deps: Deps, userId: string): Promise<ReminderDto[]> {
  return (await reminderItems(deps, userId)).map(({ vars: _v, ...r }) => r);
}

export const reminderRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    // Repayments due by now are recorded first, so they don't show up as unpaid.
    await runAutopay(c.var.deps, c.var.user.id);
    return c.json(await computeReminders(c.var.deps, c.var.user.id));
  })

  .post('/dismiss', async (c) => {
    const { key } = await body(c, dismissReminderSchema);
    await c.var.deps.db
      .insert(reminderDismissals)
      .values({ userId: c.var.user.id, key, dismissedAt: c.var.deps.now() })
      .onConflictDoNothing();
    return c.json({ ok: true });
  });
