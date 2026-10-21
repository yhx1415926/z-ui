import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { priceAlerts, users } from '../db/schema.ts';
import type { Deps } from '../env.ts';
import { runAutopay } from './autopay.ts';
import { runBatch } from './ledger.ts';
import { fetchQuotes, FetchBudget } from './markets.ts';
import { runNotifications } from './notify.ts';
import { alertTriggerOps, storeQuoteOps } from './prices.ts';

/**
 * Scheduled jobs (Cloudflare Cron Triggers, see wrangler.jsonc; a timer in node.ts locally).
 * Each run is one Worker invocation with the same limits as a request (≤ 50 subrequests).
 */

/** Every day 01:00 UTC (09:00 in China): automatic repayments, then the notification mails. */
export const DAILY_CRON = '0 1 * * *';
/** Every 30 minutes while US markets are open (UTC, covers both EST and EDT), weekdays. */
export const PRICE_CRON = '*/30 13-21 * * 1-5';

/** Symbols with active alerts checked per run, and fetches allowed (retries included). */
const MAX_ALERT_SYMBOLS = 25;
const ALERT_FETCHES = 30;

export async function runDaily(deps: Deps) {
  const list = await deps.db.select({ id: users.id }).from(users).where(eq(users.status, 'active'));
  for (const u of list) {
    await runAutopay(deps, u.id);
    await runNotifications(deps, u.id);
  }
}

/** Fetch the symbols that have active price alerts, fire the ones reached, and mail them. */
export async function runPriceWatch(deps: Deps) {
  const { db } = deps;
  const active = await db.selectDistinct({ symbol: priceAlerts.symbol }).from(priceAlerts).where(eq(priceAlerts.active, true));
  const symbols = active.map((a) => a.symbol).slice(0, MAX_ALERT_SYMBOLS);
  if (symbols.length) {
    const batch = await fetchQuotes(deps.fetch ?? fetch, symbols, { finnhubKey: deps.env.FINNHUB_API_KEY, budget: new FetchBudget(ALERT_FETCHES) });
    const t = deps.now();
    const fired = await alertTriggerOps(db, batch.quotes, t);
    await runBatch(db, [...storeQuoteOps(db, batch.quotes, t), ...fired.ops]);
  }
  // Mail alerts fired now or by a manual sync since the last run (each is mailed once).
  const recent = await db
    .selectDistinct({ userId: priceAlerts.userId })
    .from(priceAlerts)
    .where(and(isNotNull(priceAlerts.triggeredAt), gte(priceAlerts.triggeredAt, deps.now() - 86_400_000)));
  for (const u of recent) await runNotifications(deps, u.userId, { kinds: ['price_alert'], max: 5 });
}

export async function runScheduled(deps: Deps, cron: string) {
  if (cron === PRICE_CRON) await runPriceWatch(deps);
  else await runDaily(deps);
}
