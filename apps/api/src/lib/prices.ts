import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { toMicros } from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { priceAlerts, securities } from '../db/schema.ts';
import { chunkIds, chunkRows, inChunks } from './chunks.ts';
import type { StockQuote } from './markets.ts';

const micros = (n: number) => toMicros(n.toFixed(6));

/** Upsert fetched quotes into `securities` (keeps a known name when the source has none). */
export function storeQuoteOps(db: DB, quotes: StockQuote[], t: number): BatchItem<'sqlite'>[] {
  const rows = quotes.map((q) => ({
    symbol: q.symbol,
    name: q.name,
    currency: 'USD',
    priceMicros: micros(q.price),
    priceAt: Math.round(q.at),
    prevCloseMicros: q.prevClose ? micros(q.prevClose) : null,
    source: q.source,
    updatedAt: t,
  }));
  return chunkRows(rows).map((part) =>
    db
      .insert(securities)
      .values(part)
      .onConflictDoUpdate({
        target: securities.symbol,
        set: {
          name: sql`coalesce(excluded.name, ${securities.name})`,
          priceMicros: sql`excluded.price_micros`,
          priceAt: sql`excluded.price_at`,
          prevCloseMicros: sql`coalesce(excluded.prev_close_micros, ${securities.prevCloseMicros})`,
          source: sql`excluded.source`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  );
}

/**
 * Price alerts reached by these quotes: they fire once (active → false) and remember when and at
 * which price; the email goes out with the next notification run.
 */
export async function alertTriggerOps(db: DB, quotes: Pick<StockQuote, 'symbol' | 'price'>[], t: number): Promise<{ ops: BatchItem<'sqlite'>[]; fired: number }> {
  if (quotes.length === 0) return { ops: [], fired: 0 };
  const price = new Map(quotes.map((q) => [q.symbol, micros(q.price)]));
  const active = await inChunks([...price.keys()], (part) =>
    db.select().from(priceAlerts).where(and(eq(priceAlerts.active, true), inArray(priceAlerts.symbol, part))),
  );
  const hits = active.filter((a) => {
    const p = price.get(a.symbol)!;
    return a.direction === 'above' ? p >= a.targetMicros : p <= a.targetMicros;
  });
  // Grouped by price: one statement per symbol.
  const bySymbol = new Map<string, string[]>();
  for (const a of hits) bySymbol.set(a.symbol, [...(bySymbol.get(a.symbol) ?? []), a.id]);
  const ops = [...bySymbol].flatMap(([symbol, ids]) =>
    chunkIds(ids).map((part) =>
      db
        .update(priceAlerts)
        .set({ active: false, triggeredAt: t, triggeredPriceMicros: price.get(symbol)!, updatedAt: t })
        .where(and(inArray(priceAlerts.id, part), eq(priceAlerts.active, true))),
    ),
  );
  return { ops, fired: hits.length };
}
