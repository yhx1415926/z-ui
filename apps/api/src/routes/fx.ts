import { asc, eq, max, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { currencyCodeSchema, currencyDecimals, fxRateSchema, type FxDto } from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { fxRates } from '../db/schema.ts';
import type { AppBindings, Deps } from '../env.ts';
import { chunkRows } from '../lib/chunks.ts';
import { body, fail } from '../lib/http.ts';
import { fetchFxRates } from '../lib/markets.ts';

export async function fxDto(db: DB): Promise<FxDto> {
  const [rows, [last]] = await Promise.all([
    db.select().from(fxRates).orderBy(asc(fxRates.currency)),
    // "Last sync" means the last fetch from the API; hand-typed rates don't count.
    db.select({ t: max(fxRates.updatedAt) }).from(fxRates).where(ne(fxRates.source, 'manual')),
  ]);
  return { rates: rows, syncedAt: last?.t ?? null };
}

/** Convert minor units between currencies using units-per-USD rates (null if a rate is missing). */
export function convert(amount: number, from: string, to: string, perUsd: Map<string, number>, decimals: (c: string) => number): number | null {
  if (from === to) return amount;
  // Rates are USD-based, so USD itself is always 1.
  const a = from === 'USD' ? 1 : perUsd.get(from);
  const b = to === 'USD' ? 1 : perUsd.get(to);
  if (!a || !b) return null;
  const major = amount / 10 ** decimals(from);
  return Math.round((major / a) * b * 10 ** decimals(to));
}

/** Units per USD of every stored currency. */
export async function ratesMap(db: DB): Promise<Map<string, number>> {
  return new Map((await db.select({ currency: fxRates.currency, perUsd: fxRates.perUsd }).from(fxRates)).map((r) => [r.currency, r.perUsd]));
}

/**
 * Convert with the last synced rates, for amounts the user left blank (a foreign-currency charge
 * paid from another currency). Without a rate the request fails with `code`, asking for the amount.
 */
export async function convertNow(deps: Deps, amount: number, from: string, to: string, code: string, rates?: Map<string, number>): Promise<number> {
  const out = convert(amount, from, to, rates ?? (await ratesMap(deps.db)), (c) => currencyDecimals(deps.config.get(), c));
  if (out === null || out <= 0) fail(400, `no ${from}/${to} exchange rate — sync the rates or enter the ${to} amount`, code);
  return out;
}

/** Exchange rates, synced on demand (button) from a public API, or typed in by hand. */
export const fxRoutes = new Hono<AppBindings>()
  .get('/', async (c) => c.json(await fxDto(c.var.deps.db)))

  .post('/sync', async (c) => {
    const { db, config, now } = c.var.deps;
    let quote;
    try {
      quote = await fetchFxRates(c.var.deps.fetch ?? fetch);
    } catch (e) {
      fail(502, (e as Error).message, 'UPSTREAM');
    }
    // Only the currencies configured in the app (plus USD) are stored.
    const wanted = new Set(['USD', ...config.get().currencies.map((x) => x.code)]);
    const t = now();
    const rows = [...wanted]
      .filter((code) => quote.perUsd[code])
      .map((code) => ({ currency: code, perUsd: quote.perUsd[code]!, asOf: quote.asOf, source: quote.source, updatedAt: t }));
    for (const part of chunkRows(rows)) {
      await db
        .insert(fxRates)
        .values(part)
        .onConflictDoUpdate({
          target: fxRates.currency,
          set: { perUsd: sql`excluded.per_usd`, asOf: sql`excluded.as_of`, source: sql`excluded.source`, updatedAt: sql`excluded.updated_at` },
        });
    }
    const missing = [...wanted].filter((code) => !quote.perUsd[code]);
    return c.json({ ...(await fxDto(db)), missing });
  })

  .put('/:currency', async (c) => {
    const currency = currencyCodeSchema.parse(c.req.param('currency'));
    const { perUsd } = await body(c, fxRateSchema);
    const { db, now } = c.var.deps;
    const t = now();
    const asOf = new Date(t).toISOString().slice(0, 10);
    await db
      .insert(fxRates)
      .values({ currency, perUsd, asOf, source: 'manual', updatedAt: t })
      .onConflictDoUpdate({ target: fxRates.currency, set: { perUsd, asOf, source: 'manual', updatedAt: t } });
    return c.json(await fxDto(db));
  })

  .delete('/:currency', async (c) => {
    await c.var.deps.db.delete(fxRates).where(eq(fxRates.currency, c.req.param('currency')));
    return c.json(await fxDto(c.var.deps.db));
  });
