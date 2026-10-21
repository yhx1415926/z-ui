import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '@z-ui/shared';
import { MIGRATIONS_DIR, openLibsql } from '../src/db/client.ts';
import { cards } from '../src/db/schema.ts';
import { MAX_SUBREQUESTS } from '../src/lib/chunks.ts';
import { runDaily, runPriceWatch } from '../src/lib/cron.ts';
import type { MailMessage } from '../src/lib/mail.ts';
import { buildMime } from '../src/lib/mail.ts';
import { client, login, makeUser, setup, type TestEnv } from './helpers.ts';

let t: TestEnv;
type C = ReturnType<typeof client>;
const DAY = 86_400_000;

async function bank(c: C, name = 'Bank', country = 'CN') {
  return (await c.post('/api/institutions', { name, country, type: 'bank' })).json.id as string;
}

async function account(c: C, institutionId: string, currencies: { currency: string; openingBalance?: number }[], type = 'checking', name?: string) {
  const r = await c.post('/api/accounts', { institutionId, name: name ?? currencies.map((x) => x.currency).join('/'), type, currencies, openingDate: '2026-01-01' });
  expect(r.status).toBe(201);
  return r.json;
}

const bal = async (c: C, id: string, cur: string) => (await c.get(`/api/accounts/${id}`)).json.currencies.find((x: any) => x.currency === cur)?.balance;

function mockFetch(routes: Record<string, unknown | ((url: string) => unknown)>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response('not found', { status: 404 });
    const body = typeof hit[1] === 'function' ? (hit[1] as (u: string) => unknown)(url) : hit[1];
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** Yahoo chart API stand-in: a flat-ish history ending at the given price (unknown symbols: empty result). */
function yahoo(prices: Record<string, number>) {
  const sizes: Record<string, number> = { '1d': 78, '5d': 65, '1y': 252, '5y': 260, max: 300 };
  return (url: string) => {
    const u = new URL(url);
    const symbol = decodeURIComponent(u.pathname.split('/chart/')[1]!);
    const price = prices[symbol];
    if (price === undefined) return { chart: { result: [] } };
    const n = u.searchParams.get('interval') === '1d' && u.searchParams.get('range') === '1d' ? 1 : sizes[u.searchParams.get('range')!]!;
    const timestamp = Array.from({ length: n }, (_, i) => 1792000000 + i * 300);
    const close = timestamp.map((_, i) => (i === 3 ? null : price - (n - 1 - i) * 0.01));
    return {
      chart: {
        result: [
          {
            // Like Yahoo: previousClose only on one-day ranges; chartPreviousClose = close before the range.
            meta: {
              regularMarketPrice: price,
              regularMarketTime: 1792000000,
              ...(u.searchParams.get('range') === '1d' ? { previousClose: price - 1, chartPreviousClose: price - 1 } : { chartPreviousClose: price - 2 }),
              longName: `${symbol} Inc.`,
            },
            timestamp,
            indicators: { quote: [{ close }] },
          },
        ],
      },
    };
  };
}

/** Collects mails; counts each send as a subrequest like the Worker binding would. */
function fakeMailer(env: TestEnv) {
  const sent: MailMessage[] = [];
  env.deps.mailer = async (m) => {
    env.budget.used++;
    sent.push(m);
  };
  return sent;
}

async function enableMail(env: TestEnv, u: Awaited<ReturnType<typeof makeUser>>, c: C, rules: Record<string, unknown> = {}) {
  env.advance(30_000);
  expect((await c.post('/api/auth/step-up/totp', { code: u.code() })).status).toBe(200);
  const r = await c.put('/api/notify', { enabled: true, to: 'me@gmail.com', from: 'z-ui@example.com', fromName: 'Z-UI', rules: { ...DEFAULT_RULES, ...rules } });
  expect(r.status).toBe(200);
}

beforeEach(async () => {
  t = await setup();
});
afterEach(() => t.cleanup());

// ---------------------------------------------------------------- migration

describe('migration 0004', () => {
  it('adds the new tables and columns without touching existing rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zui-mig-'));
    try {
      const old = join(dir, 'migrations');
      mkdirSync(join(old, 'meta'), { recursive: true });
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 3);
      writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => /^000[0-3]_/.test(f))) copyFileSync(join(MIGRATIONS_DIR, f), join(old, f));

      const url = `file:${join(dir, 'old.db')}`;
      const raw = createClient({ url });
      await migrate(drizzle(raw), { migrationsFolder: old });
      await raw.executeMultiple(`
        INSERT INTO users (id, username, display_name, role, status, webauthn_user_id, totp_enabled, created_at, updated_at) VALUES ('u1','alice','Alice','admin','active','w',0,0,0);
        INSERT INTO institutions (id, user_id, name, country, type, extra, sort, archived, created_at, updated_at) VALUES ('i1','u1','CMB','CN','bank','{}',0,0,0,0);
        INSERT INTO accounts (id, user_id, institution_id, name, type, currency, opening_date, extra, sort, archived, created_at, updated_at) VALUES ('a1','u1','i1','Debit','checking','CNY','2026-01-01','{}',0,0,0,0);
        INSERT INTO account_currencies (account_id, user_id, currency, opening_balance, balance_date, include_in_total, sort, balance, tx_count) VALUES ('a1','u1','CNY',100000,'2026-09-30',1,0,99000,1);
        INSERT INTO cards (id, user_id, account_id, form, status, single_use, brand, funding, last4, theme, extra, archived, due_day, created_at, updated_at) VALUES ('c1','u1','a1','physical','active',0,'visa','credit','4242','midnight','{}',0,20,0,0);
        INSERT INTO credit_statements (id, user_id, card_id, currency, statement_date, due_date, statement_amount, created_at, updated_at) VALUES ('s1','u1','c1','CNY','2026-10-01','2026-10-20',5000,0,0);
        INSERT INTO transactions (id, user_id, account_id, type, amount, currency, occurred_at, extra, created_at, updated_at) VALUES ('t1','u1','a1','expense',-1000,'CNY','2026-10-01','{}',0,0);
        INSERT INTO securities (symbol, price_micros, price_at, source, currency, updated_at) VALUES ('AAPL', 200000000, 0, 'manual', 'USD', 0);
        INSERT INTO settings (key, value, updated_at) VALUES ('app-config', '{"x":1}', 0);
      `);
      raw.close();

      await openLibsql(url); // applies 0004
      const check = createClient({ url });
      const q = async (s: string) => (await check.execute(s)).rows;
      expect(await q('SELECT id, amount, currency, original_amount, original_currency FROM transactions')).toEqual([
        expect.objectContaining({ id: 't1', amount: -1000, currency: 'CNY', original_amount: null, original_currency: null }),
      ]);
      expect((await q('SELECT balance, opening_balance, balance_date FROM account_currencies'))[0]).toMatchObject({ balance: 99000, opening_balance: 100000, balance_date: '2026-09-30' });
      expect((await q('SELECT autopay_account_id, autopay_since, due_day FROM cards'))[0]).toMatchObject({ autopay_account_id: null, autopay_since: null, due_day: 20 });
      expect((await q('SELECT statement_amount, autopay_at FROM credit_statements'))[0]).toMatchObject({ statement_amount: 5000, autopay_at: null });
      expect((await q('SELECT price_micros, prev_close_micros FROM securities'))[0]).toMatchObject({ price_micros: 200000000, prev_close_micros: null });
      expect((await q("SELECT value FROM settings WHERE key = 'app-config'"))[0]).toMatchObject({ value: '{"x":1}' });
      for (const table of ['watchlist', 'price_series', 'price_alerts', 'notification_log']) expect(await q(`SELECT count(*) AS n FROM ${table}`)).toEqual([expect.objectContaining({ n: 0 })]);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- foreign-currency charges

describe('foreign-currency charges', () => {
  it('books a USD charge on a CNY-only wallet at the current rate unless the paid amount is given', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    await a.put('/api/fx/CNY', { perUsd: 7.2 });
    const alipay = await account(a, await bank(a, 'Alipay'), [{ currency: 'CNY', openingBalance: 100000 }], 'ewallet');
    const charge = (b: Record<string, unknown>) => a.post('/api/transactions', { type: 'expense', accountId: alipay.id, occurredAt: '2026-10-10', ...b });

    const auto = await charge({ originalCurrency: 'USD', originalAmount: 2000 });
    expect(auto.status).toBe(201);
    expect(auto.json).toMatchObject({ amount: -14400, currency: 'CNY', originalAmount: 2000, originalCurrency: 'USD' });
    const typed = await charge({ originalCurrency: 'USD', originalAmount: 2000, amount: 14520 });
    expect(typed.json).toMatchObject({ amount: -14520, originalAmount: 2000, originalCurrency: 'USD' });
    // Same currency as the account: just an ordinary expense.
    expect((await charge({ originalCurrency: 'CNY', originalAmount: 500 })).json).toMatchObject({ amount: -500, originalAmount: null, originalCurrency: null });

    // Editing it into a plain expense forgets the original amount.
    const edited = await a.put(`/api/transactions/${typed.json.id}`, { type: 'expense', accountId: alipay.id, amount: 100, occurredAt: '2026-10-10' });
    expect(edited.json).toMatchObject({ amount: -100, originalAmount: null, originalCurrency: null });
    expect(await bal(a, alipay.id, 'CNY')).toBe(100000 - 14400 - 500 - 100);
    expect((await a.get('/api/transactions')).json.items.find((x: any) => x.id === auto.json.id)).toMatchObject({ originalAmount: 2000, originalCurrency: 'USD' });

    // Without a rate the paid amount must be typed; an amount or an original is always needed.
    await a.del('/api/fx/CNY');
    expect((await charge({ originalCurrency: 'USD', originalAmount: 2000 })).json.code).toBe('AMOUNT_REQUIRED');
    expect((await charge({})).status).toBe(400);
    expect((await charge({ originalCurrency: 'XXX', originalAmount: 1, amount: 1 })).json.code).toBe('UNKNOWN_CURRENCY');
  });

  it('fills the received amount of a transfer and pays a USD bill from a CNY wallet', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    await a.put('/api/fx/CNY', { perUsd: 7.2 });
    const inst = await bank(a);
    const usd = await account(a, inst, [{ currency: 'USD', openingBalance: 100000 }]);
    const wallet = await account(a, inst, [{ currency: 'CNY', openingBalance: 0 }], 'ewallet');

    const tr = await a.post('/api/transactions', { type: 'transfer', fromAccountId: usd.id, toAccountId: wallet.id, amount: 10000, occurredAt: '2026-10-10' });
    expect(tr.status).toBe(201);
    expect(tr.json).toMatchObject({ amount: -10000, counterpartAmount: 72000, counterpartCurrency: 'CNY' });

    const bill = await a.post('/api/bills', { name: 'ChatGPT', kind: 'subscription', amount: 2000, currency: 'USD', accountId: wallet.id, freq: 'monthly', startDate: '2026-10-15', pastPolicy: 'pending' });
    const occ = (await a.get(`/api/bills/occurrences?billId=${bill.json.id}`)).json[0];
    const paid = await a.post(`/api/bills/occurrences/${occ.id}/pay`, {});
    expect(paid.json.transaction).toMatchObject({ amount: -14400, currency: 'CNY', originalAmount: 2000, originalCurrency: 'USD', counterparty: 'ChatGPT' });
    expect(await bal(a, wallet.id, 'CNY')).toBe(72000 - 14400);
  });
});

// ---------------------------------------------------------------- automatic repayment

async function creditCard(c: C, inst: string, currency: string, extra: Record<string, unknown> = {}) {
  const acc = await account(c, inst, [{ currency, openingBalance: 0 }], 'credit', `Credit ${currency}`);
  const card = await c.post('/api/cards', { accountId: acc.id, last4: '8888', funding: 'credit', dueDay: 15, nickname: 'Visa', ...extra });
  expect(card.status).toBe(201);
  return { acc, card: card.json };
}

describe('automatic credit card repayment', () => {
  it('repays the statement from the bound account on the due date, once', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const inst = await bank(a);
    const debit = await account(a, inst, [{ currency: 'CNY', openingBalance: 500000 }]);
    const { acc: credit, card } = await creditCard(a, inst, 'CNY', { autopayAccountId: debit.id });
    expect(card).toMatchObject({ autopayAccountId: debit.id, autopayMode: 'full', autopayCurrency: null, autopaySince: '2026-10-15' });

    const st = (b: Record<string, unknown>) => a.post('/api/statements', { cardId: card.id, statementDate: '2026-10-01', ...b }).then((r) => r.json);
    const old = await st({ dueDate: '2026-10-10', statementDate: '2026-09-25', statementAmount: 30000 }); // due before autopay was set up
    const now = await st({ dueDate: '2026-10-15', statementAmount: 120000 });
    const later = await st({ dueDate: '2026-11-15', statementDate: '2026-11-01', statementAmount: 5000 });

    const list = (await a.get('/api/statements')).json;
    const byId = (id: string) => list.find((s: any) => s.id === id);
    expect(byId(now.id)).toMatchObject({ status: 'paid', paidAmount: 120000 });
    expect(byId(now.id).autopayAt).toBe(t.clock.t);
    expect(byId(old.id)).toMatchObject({ status: 'unpaid', autopayAt: null });
    expect(byId(later.id)).toMatchObject({ status: 'unpaid', autopayAt: null });
    expect(await bal(a, debit.id, 'CNY')).toBe(500000 - 120000);
    expect(await bal(a, credit.id, 'CNY')).toBe(120000);

    // Loading again records nothing more; deleting the transfer does not bring it back.
    await a.get('/api/reminders');
    await a.get('/api/statements');
    expect(await bal(a, debit.id, 'CNY')).toBe(380000);
    const tx = (await a.get(`/api/transactions?accountId=${debit.id}`)).json.items;
    expect(tx).toEqual([expect.objectContaining({ type: 'transfer', amount: -120000, note: '自动还款', occurredAt: '2026-10-15' })]);
    expect((await a.del(`/api/transactions/${tx[0].id}`)).status).toBe(200);
    expect((await a.get('/api/statements')).json.find((s: any) => s.id === now.id)).toMatchObject({ status: 'unpaid', remaining: 120000 });
    expect(await bal(a, debit.id, 'CNY')).toBe(500000);
  });

  it('pays the minimum, converts currencies and warns when the account is short', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    await a.put('/api/fx/CNY', { perUsd: 7.2 });
    const inst = await bank(a);
    const wallet = await account(a, inst, [{ currency: 'CNY', openingBalance: 50000 }], 'ewallet', 'Alipay');
    const { card } = await creditCard(a, inst, 'USD', { autopayAccountId: wallet.id });
    const st = (await a.post('/api/statements', { cardId: card.id, statementDate: '2026-10-01', dueDate: '2026-10-18', statementAmount: 20000, minPayment: 2500 })).json;

    // $200 = ¥1,440 but the wallet holds ¥500.
    const low = (await a.get('/api/reminders')).json.filter((r: any) => r.kind === 'autopay_low');
    expect(low).toEqual([expect.objectContaining({ title: 'Visa', amount: 144000 - 50000, currency: 'CNY', date: '2026-10-18', daysLeft: 3 })]);

    // Minimum payment: $25 = ¥180 is covered.
    expect((await a.patch(`/api/cards/${card.id}`, { autopayMode: 'min' })).json).toMatchObject({ autopayMode: 'min', autopaySince: '2026-10-15' });
    expect((await a.get('/api/reminders')).json.some((r: any) => r.kind === 'autopay_low')).toBe(false);

    t.advance(3 * DAY);
    const after = (await a.get('/api/statements')).json.find((s: any) => s.id === st.id);
    expect(after).toMatchObject({ status: 'partial', paidAmount: 2500, remaining: 17500 });
    expect(await bal(a, wallet.id, 'CNY')).toBe(50000 - 18000);
  });

  it('validates the binding and forgets it for debit cards', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    const inst = await bank(a);
    const debit = await account(a, inst, [{ currency: 'CNY', openingBalance: 0 }]);
    const { acc, card } = await creditCard(a, inst, 'CNY');
    expect((await a.patch(`/api/cards/${card.id}`, { autopayAccountId: acc.id })).json.code).toBe('AUTOPAY_SAME_ACCOUNT');
    expect((await a.patch(`/api/cards/${card.id}`, { autopayAccountId: debit.id, autopayCurrency: 'USD' })).json.code).toBe('CURRENCY_NOT_HELD');
    expect((await a.patch(`/api/cards/${card.id}`, { autopayAccountId: debit.id })).json.autopayAccountId).toBe(debit.id);
    // Unrelated edits keep it (and its start date).
    t.advance(DAY);
    expect((await a.patch(`/api/cards/${card.id}`, { nickname: 'X' })).json).toMatchObject({ autopayAccountId: debit.id, autopaySince: '2026-10-15' });
    expect((await a.patch(`/api/cards/${card.id}`, { autopayAccountId: null })).json).toMatchObject({ autopayAccountId: null, autopayMode: null, autopaySince: null });
    const debitCard = await a.post('/api/cards', { accountId: debit.id, last4: '1111', funding: 'debit', autopayAccountId: acc.id });
    expect(debitCard.json.autopayAccountId).toBeNull();
  });
});

// ---------------------------------------------------------------- email notifications

describe('email notifications', () => {
  it('mails each enabled event once, with the saved templates, and retries failures', async () => {
    const sent = fakeMailer(t);
    const u = await makeUser(t, 'alice');
    const a = await login(t, u);
    const initial = (await a.get('/api/notify')).json;
    expect(initial).toMatchObject({ mailer: true, settings: { enabled: false, to: '' }, log: [] });

    // Changing where mails go needs a recent verification (signing in counts for 5 minutes).
    const body = { ...initial.settings, enabled: true, to: 'me@gmail.com', from: 'z-ui@example.com' };
    t.advance(6 * 60_000);
    expect((await a.put('/api/notify', body)).json.code).toBe('STEP_UP_REQUIRED');
    expect((await a.put('/api/notify', { ...initial.settings, fromName: 'Ledger' })).status).toBe(200); // templates etc. don't
    await enableMail(t, u, a, { bill_overdue: { ...DEFAULT_RULES.bill_overdue, subject: '逾期：{{bill}} {{amount}} {{nope}}' } });
    expect((await a.put('/api/notify', { ...body, to: 'not-an-email' })).status).toBe(400);

    const inst = await bank(a);
    await a.post('/api/bills', { name: 'Netflix', kind: 'once', amount: 9900, currency: 'USD', startDate: '2026-10-14', pastPolicy: 'pending' });
    const { card } = await creditCard(a, inst, 'CNY');
    await a.post('/api/statements', { cardId: card.id, statementDate: '2026-10-01', dueDate: '2026-10-17', statementAmount: 50000 });

    const run = await a.post('/api/notify/run');
    expect(run.json).toMatchObject({ sent: 2, failed: 0, autopaid: 0 });
    expect(sent.map((m) => m.subject).sort()).toEqual(['【Z-UI】Visa 账单待还 ¥500.00', '逾期：Netflix $99.00 {{nope}}']);
    expect(sent[0]).toMatchObject({ to: 'me@gmail.com', from: 'z-ui@example.com', fromName: 'Z-UI' });
    expect(sent.find((m) => m.subject.startsWith('【Z-UI】Visa'))!.text).toContain('2026-10-17 到期，还有 ¥500.00 未还（还剩 2 天）');

    // Once per event.
    expect((await a.post('/api/notify/run')).json.sent).toBe(0);

    // A failed send is logged with Cloudflare's error code and retried next time.
    t.deps.mailer = async () => {
      throw Object.assign(new Error('sender not verified'), { code: 'E_SENDER_NOT_VERIFIED' });
    };
    await a.post('/api/bills', { name: 'iCloud', kind: 'once', amount: 299, currency: 'USD', startDate: '2026-10-13', pastPolicy: 'pending' });
    expect((await a.post('/api/notify/run')).json).toMatchObject({ sent: 0, failed: 1 });
    expect((await a.get('/api/notify')).json.log[0]).toMatchObject({ ok: false, error: 'E_SENDER_NOT_VERIFIED: sender not verified', kind: 'bill_overdue' });
    const again = fakeMailer(t);
    expect((await a.post('/api/notify/run')).json).toMatchObject({ sent: 1, failed: 0 });
    expect(again[0]!.subject).toContain('iCloud');
    expect((await a.get('/api/notify')).json.log.filter((l: any) => l.ok)).toHaveLength(3);

    expect((await a.post('/api/notify/test')).status).toBe(200);
    expect(again[1]).toMatchObject({ subject: '【Z-UI】测试邮件' });
  });

  it('sends nothing while switched off or without a mailer', async () => {
    const u = await makeUser(t, 'alice');
    const a = await login(t, u);
    await a.post('/api/bills', { name: 'Netflix', kind: 'once', amount: 9900, currency: 'USD', startDate: '2026-10-14', pastPolicy: 'pending' });
    expect((await a.post('/api/notify/run')).json.sent).toBe(0);
    expect((await a.post('/api/notify/test')).json.code).toBe('MAIL_NOT_CONFIGURED');
    const sent = fakeMailer(t);
    expect((await a.post('/api/notify/run')).json.sent).toBe(0); // not enabled yet
    expect(sent).toHaveLength(0);
  });

  it('caps a run at 8 mails within the Workers Free budget', async () => {
    const sent = fakeMailer(t);
    const u = await makeUser(t, 'alice');
    const a = await login(t, u);
    await enableMail(t, u, a, { bill_due: { ...DEFAULT_RULES.bill_due, enabled: true, daysBefore: 30 } });
    for (let i = 0; i < 20; i++) await a.post('/api/bills', { name: `Bill ${i}`, kind: 'once', amount: 100 + i, currency: 'USD', startDate: i % 2 ? '2026-10-10' : '2026-10-30', pastPolicy: 'pending' });
    expect((await a.post('/api/notify/run')).json).toMatchObject({ events: 20, sent: 8 });
    expect(t.budget.used).toBeLessThanOrEqual(MAX_SUBREQUESTS);
    await a.post('/api/notify/run');
    await a.post('/api/notify/run');
    expect(sent).toHaveLength(20);
    expect(new Set(sent.map((m) => m.subject)).size).toBe(20);
  });

  it('builds a valid UTF-8 MIME message for the raw API', () => {
    const mime = buildMime({ from: 'z@example.com', fromName: 'Z-UI', to: 'me@gmail.com', subject: '【Z-UI】测试', text: '你好\n第二行' }, new Date(Date.UTC(2026, 9, 15)), 'abc');
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('Message-ID: <abc@example.com>');
    expect(mime).toContain('From: Z-UI <z@example.com>');
    const b64 = mime.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)))).toBe('你好\r\n第二行');
  });
});

// ---------------------------------------------------------------- watchlist, charts, alerts

describe('watchlist, charts and price alerts', () => {
  it('syncs the watchlist and the charts by hand', async () => {
    t.deps.fetch = mockFetch({
      'https://query1.finance.yahoo.com/v8/finance/chart/': yahoo({ AAPL: 230, MSFT: 410 }),
      'https://query1.finance.yahoo.com/v1/finance/search': { quotes: [{ symbol: 'AAPL', quoteType: 'EQUITY' }] },
    });
    const a = await login(t, await makeUser(t, 'alice'));
    for (const symbol of ['aapl', 'MSFT', 'APPL']) expect((await a.post('/api/watch', { symbol })).status).toBe(201);
    expect((await a.get('/api/watch')).json.map((x: any) => [x.symbol, x.price])).toEqual([
      ['AAPL', null],
      ['MSFT', null],
      ['APPL', null],
    ]);

    const sync = await a.post('/api/watch/sync');
    expect(sync.json).toMatchObject({ updated: 2, remaining: 0, failed: [{ symbol: 'APPL', reason: 'not_found', suggestion: 'AAPL' }] });
    const aapl = sync.json.items.find((x: any) => x.symbol === 'AAPL');
    expect(aapl).toMatchObject({ price: '230', prevClose: '229', name: 'AAPL Inc.' });
    expect(aapl.spark.length).toBeGreaterThan(30);
    expect(aapl.spark.length).toBeLessThanOrEqual(60);

    expect((await a.put('/api/watch/order', { symbols: ['MSFT', 'APPL', 'AAPL'] })).json.map((x: any) => x.symbol)).toEqual(['MSFT', 'APPL', 'AAPL']);
    expect((await a.del('/api/watch/APPL')).json.map((x: any) => x.symbol)).toEqual(['MSFT', 'AAPL']);

    expect((await a.get('/api/watch/chart/AAPL')).json.series.map((s: any) => s.series)).toEqual(['1d']);
    const chart = await a.post('/api/watch/chart/AAPL/sync');
    expect(chart.json.failed).toEqual([]);
    expect(chart.json.series.map((s: any) => [s.series, s.points.length])).toEqual([
      ['1d', 77],
      ['5d', 64],
      ['1y', 251],
      ['5y', 259],
      ['max', 299],
    ]);
    expect(chart.json.series[0]).toMatchObject({ prevClose: 229 });
    expect(chart.json.series[2]).toMatchObject({ prevClose: 228 });
    // The day's change still compares with yesterday's close, not the 1Y chart's start.
    expect((await a.get('/api/watch')).json.find((x: any) => x.symbol === 'AAPL')).toMatchObject({ prevClose: '229' });
    expect((await a.post('/api/watch/chart/NOPE/sync')).json.code).toBe('UNKNOWN_SYMBOL');
  });

  it('fires a price alert once and mails it from the cron', async () => {
    const prices = { AAPL: 205 };
    let fetches = 0;
    const route = yahoo(prices);
    t.deps.fetch = mockFetch({ 'https://query1.finance.yahoo.com/v8/finance/chart/': (u: string) => (fetches++, route(u)) });
    const sent = fakeMailer(t);
    const u = await makeUser(t, 'alice');
    const a = await login(t, u);
    await enableMail(t, u, a);
    await a.post('/api/watch/alerts', { symbol: 'AAPL', direction: 'above', target: '210' });
    const alerts = (await a.post('/api/watch/alerts', { symbol: 'aapl', direction: 'below', target: '150', note: 'buy' })).json;
    expect(alerts).toHaveLength(2);

    await runPriceWatch(t.deps);
    expect(fetches).toBe(1); // one symbol, both alerts
    expect(sent).toHaveLength(0);

    prices.AAPL = 215;
    await runPriceWatch(t.deps);
    expect(sent.map((m) => m.subject)).toEqual(['【Z-UI】AAPL 已涨到 $210.00']);
    expect(sent[0]!.text).toContain('AAPL（AAPL Inc.）最新价 $215.00');
    const list = (await a.get('/api/watch/alerts')).json;
    expect(list.find((x: any) => x.direction === 'above')).toMatchObject({ active: false, triggeredPrice: '215' });
    expect(list.find((x: any) => x.direction === 'below')).toMatchObject({ active: true, triggeredAt: null });
    expect((await a.get('/api/reminders')).json.find((r: any) => r.kind === 'price_alert')).toMatchObject({ title: 'AAPL ≥ $210.00', amount: 21500, currency: 'USD' });

    // Fired alerts don't fire (or mail) again until re-armed.
    await runPriceWatch(t.deps);
    expect(sent).toHaveLength(1);
    const above = list.find((x: any) => x.direction === 'above');
    expect((await a.patch(`/api/watch/alerts/${above.id}`, { active: true })).json.find((x: any) => x.id === above.id)).toMatchObject({ active: true, triggeredAt: null });

    // A manual sync can fire it too; the next cron run mails it.
    t.advance(60_000);
    await a.post('/api/watch', { symbol: 'AAPL' });
    await a.post('/api/watch/sync');
    expect((await a.get('/api/watch/alerts')).json.find((x: any) => x.id === above.id).active).toBe(false);
    prices.AAPL = 100; // now also below 150: fires the other one
    await runPriceWatch(t.deps);
    expect(sent.map((m) => m.subject)).toEqual(['【Z-UI】AAPL 已涨到 $210.00', expect.stringMatching(/AAPL 已(涨|跌)到/), expect.stringMatching(/AAPL 已(涨|跌)到/)]);
  });
});

// ---------------------------------------------------------------- cron

describe('daily cron', () => {
  it('records automatic repayments and mails them within the Workers Free budget', async () => {
    const sent = fakeMailer(t);
    const u = await makeUser(t, 'alice');
    const a = await login(t, u);
    await enableMail(t, u, a, { autopay_done: { ...DEFAULT_RULES.autopay_done, enabled: true }, bill_due: { ...DEFAULT_RULES.bill_due, enabled: true } });
    const inst = await bank(a);
    const debit = await account(a, inst, [{ currency: 'CNY', openingBalance: 500000 }], 'checking', 'Debit');
    const { card } = await creditCard(a, inst, 'CNY', { autopayAccountId: debit.id });
    for (let i = 0; i < 3; i++) {
      const { card: other } = await creditCard(a, inst, 'CNY', { autopayAccountId: debit.id });
      await a.post('/api/statements', { cardId: other.id, statementDate: '2026-10-01', dueDate: '2026-10-15', statementAmount: 1000 + i });
    }
    await a.post('/api/statements', { cardId: card.id, statementDate: '2026-10-01', dueDate: '2026-10-15', statementAmount: 120000 });
    for (let i = 0; i < 10; i++) await a.post('/api/bills', { name: `Sub ${i}`, kind: 'subscription', amount: 100, currency: 'USD', freq: 'monthly', startDate: '2026-10-16', pastPolicy: 'pending' });

    t.budget.used = 0;
    await runDaily(t.deps);
    expect(t.budget.used).toBeLessThanOrEqual(MAX_SUBREQUESTS);
    expect(await bal(a, debit.id, 'CNY')).toBe(500000 - 120000 - 1000 - 1001 - 1002);
    expect(sent.filter((m) => m.subject.includes('已自动还款'))).toHaveLength(4);
    expect(sent.find((m) => m.subject.includes('¥1,200.00'))!.text).toContain('已从「Bank · Debit」扣款 ¥1,200.00');
    expect(sent).toHaveLength(8); // capped; the bill reminders follow on the next run
    await runDaily(t.deps);
    expect(sent).toHaveLength(14);
    expect(await bal(a, debit.id, 'CNY')).toBe(500000 - 120000 - 3003);
  });
});

// ---------------------------------------------------------------- security code (CVV / CVN / PIN)

describe('card security code', () => {
  it('is stored encrypted and only revealed after a fresh verification', async () => {
    const u = await makeUser(t, 'alice');
    const a = await login(t, u);
    const acc = await account(a, await bank(a), [{ currency: 'CNY', openingBalance: 0 }]);
    const card = (await a.post('/api/cards', { accountId: acc.id, last4: '4242', funding: 'debit', cvv: '123' })).json;
    expect(card.hasCvv).toBe(true);
    // Never part of a listing or a card payload.
    const list = await a.get('/api/cards');
    expect(JSON.stringify(list.json)).not.toMatch(/"cvv|cvvEnc|"123"/);
    const [stored] = await t.db.select({ enc: cards.cvvEnc }).from(cards);
    expect(stored!.enc).toBeTruthy();
    expect(stored!.enc).not.toContain('123');

    t.advance(6 * 60_000); // past the 5 minutes a sign-in counts as verification
    expect((await a.post(`/api/cards/${card.id}/cvv`)).json.code).toBe('STEP_UP_REQUIRED');
    t.advance(30_000);
    await a.post('/api/auth/step-up/totp', { code: u.code() });
    expect((await a.post(`/api/cards/${card.id}/cvv`)).json).toEqual({ cvv: '123' });
    expect((await a.get('/api/auth/audit')).json.some((e: any) => e.action === 'card.reveal_cvv')).toBe(true);

    // A 6-digit PIN is accepted the same way; omitted keeps it; empty forgets it.
    expect((await a.patch(`/api/cards/${card.id}`, { cvv: '654321' })).json.hasCvv).toBe(true);
    expect((await a.patch(`/api/cards/${card.id}`, { nickname: 'x' })).json.hasCvv).toBe(true);
    expect((await a.post(`/api/cards/${card.id}/cvv`)).json.cvv).toBe('654321');
    expect((await a.patch(`/api/cards/${card.id}`, { cvv: '12345' })).status).toBe(400);
    expect((await a.patch(`/api/cards/${card.id}`, { cvv: '' })).json.hasCvv).toBe(false);
    expect((await a.post(`/api/cards/${card.id}/cvv`)).json.code).toBe('NO_CVV');
  });
});

// ---------------------------------------------------------------- transfer fees & exchange loss

describe('transfer fees and market rates', () => {
  it('books a same-currency transfer fee as an expense of the source account', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    await a.post('/api/categories', { kind: 'expense', name: '银行手续费' });
    const inst = await bank(a);
    const from = await account(a, inst, [{ currency: 'CNY', openingBalance: 100000 }], 'checking', 'From');
    const to = await account(a, inst, [{ currency: 'CNY', openingBalance: 0 }], 'checking', 'To');
    const tr = await a.post('/api/transactions', { type: 'transfer', fromAccountId: from.id, toAccountId: to.id, amount: 50000, fee: 500, occurredAt: '2026-10-10' });
    expect(tr.status).toBe(201);
    expect(tr.json).toMatchObject({ amount: -50000, fee: 500, feeCurrency: 'CNY', counterpartAmount: 50000 });
    expect(await bal(a, from.id, 'CNY')).toBe(100000 - 50000 - 500);
    expect(await bal(a, to.id, 'CNY')).toBe(50000);

    const items = (await a.get('/api/transactions')).json.items;
    const feeRow = items.find((x: any) => x.type === 'expense');
    expect(feeRow).toMatchObject({ amount: -500, counterparty: '转账手续费', feeOf: tr.json.transferGroupId, feeParentId: tr.json.id });
    expect(feeRow.categoryId).toBeTruthy();
    // The fee is spending; the transfer itself is not.
    expect((await a.get('/api/stats?from=2026-10-01&to=2026-10-31&currency=CNY')).json.totals).toMatchObject({ expense: 500, income: 0 });

    // Editing through the fee row edits the transfer; dropping the fee removes its row.
    const edited = await a.put(`/api/transactions/${feeRow.id}`, { type: 'transfer', fromAccountId: from.id, toAccountId: to.id, amount: 40000, fee: 300, occurredAt: '2026-10-10' });
    expect(edited.json).toMatchObject({ id: tr.json.id, amount: -40000, fee: 300 });
    expect((await a.get('/api/transactions')).json.items.find((x: any) => x.type === 'expense').id).toBe(feeRow.id);
    await a.put(`/api/transactions/${tr.json.id}`, { type: 'transfer', fromAccountId: from.id, toAccountId: to.id, amount: 40000, occurredAt: '2026-10-10' });
    expect((await a.get('/api/transactions')).json.items.map((x: any) => x.type)).toEqual(['transfer', 'transfer']);
    expect(await bal(a, from.id, 'CNY')).toBe(60000);

    // Deleting the transfer takes its fee along.
    await a.put(`/api/transactions/${tr.json.id}`, { type: 'transfer', fromAccountId: from.id, toAccountId: to.id, amount: 40000, fee: 100, occurredAt: '2026-10-10' });
    expect((await a.del(`/api/transactions/${tr.json.id}`)).json.deleted).toBe(3);
    expect(await bal(a, from.id, 'CNY')).toBe(100000);
    expect((await a.get('/api/transactions')).json.total).toBe(0);
  });

  it('remembers the market rate of an exchange, also across edits', async () => {
    const a = await login(t, await makeUser(t, 'alice'));
    await a.put('/api/fx/CNY', { perUsd: 7.2 });
    const inst = await bank(a);
    const usd = await account(a, inst, [{ currency: 'USD', openingBalance: 100000 }]);
    const cny = await account(a, inst, [{ currency: 'CNY', openingBalance: 100000 }]);
    const tr = await a.post('/api/transactions', { type: 'transfer', fromAccountId: usd.id, toAccountId: cny.id, amount: 10000, toAmount: 71500, occurredAt: '2026-10-10' });
    expect(tr.json.marketRate).toBeCloseTo(7.2);
    const charge = await a.post('/api/transactions', { type: 'expense', accountId: cny.id, originalCurrency: 'USD', originalAmount: 2000, amount: 14520, occurredAt: '2026-10-10' });
    expect(charge.json.marketRate).toBeCloseTo(7.2);
    const same = await a.post('/api/transactions', { type: 'expense', accountId: cny.id, amount: 100, occurredAt: '2026-10-10' });
    expect(same.json.marketRate).toBeNull();

    // Rates move; editing the note keeps the rate the entry was recorded with.
    await a.put('/api/fx/CNY', { perUsd: 7.0 });
    const note = await a.put(`/api/transactions/${charge.json.id}`, { type: 'expense', accountId: cny.id, originalCurrency: 'USD', originalAmount: 2000, amount: 14520, note: 'x', occurredAt: '2026-10-10' });
    expect(note.json.marketRate).toBeCloseTo(7.2);
    const legs = (await a.get('/api/transactions')).json.items.filter((x: any) => x.type === 'transfer');
    expect(legs.map((l: any) => l.marketRate)).toEqual([expect.closeTo(7.2), expect.closeTo(7.2)]);
    // Another original currency: re-rated now (EUR has no rate → null, the paid amount was given).
    const eur = await a.put(`/api/transactions/${charge.json.id}`, { type: 'expense', accountId: cny.id, originalCurrency: 'EUR', originalAmount: 2000, amount: 15000, occurredAt: '2026-10-10' });
    expect(eur.json.marketRate).toBeNull();
  });

  it('computes the exchange loss against the market', async () => {
    const { fxLoss } = await import('@z-ui/shared');
    // Paid ¥145.20 for $20.00 at 7.2 → ¥1.20 more than the market (0.83 %).
    const paid = fxLoss({ a: 2000, aDecimals: 2, b: 14520, bDecimals: 2, rate: 7.2, paying: true })!;
    expect(paid.loss).toBe(120);
    expect(paid.pct).toBeCloseTo(0.833, 2);
    // Sent $100, received ¥715 at 7.2 → ¥5 less than the market.
    expect(fxLoss({ a: 10000, aDecimals: 2, b: 71500, bDecimals: 2, rate: 7.2, paying: false })!.loss).toBe(500);
    // JPY has no decimals; a better-than-market rate is a gain (negative loss).
    expect(fxLoss({ a: 10000, aDecimals: 2, b: 15100, bDecimals: 0, rate: 150, paying: false })!.loss).toBe(-100);
  });
});

describe('migration 0005', () => {
  it('adds the security code, fee link and market rate columns empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zui-mig-'));
    try {
      const old = join(dir, 'migrations');
      mkdirSync(join(old, 'meta'), { recursive: true });
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 4);
      writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
      for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => /^000[0-4]_/.test(f))) copyFileSync(join(MIGRATIONS_DIR, f), join(old, f));
      const url = `file:${join(dir, 'old.db')}`;
      const raw = createClient({ url });
      await migrate(drizzle(raw), { migrationsFolder: old });
      await raw.executeMultiple(`
        INSERT INTO users (id, username, display_name, role, status, webauthn_user_id, totp_enabled, created_at, updated_at) VALUES ('u1','alice','Alice','admin','active','w',0,0,0);
        INSERT INTO institutions (id, user_id, name, country, type, extra, sort, archived, created_at, updated_at) VALUES ('i1','u1','CMB','CN','bank','{}',0,0,0,0);
        INSERT INTO accounts (id, user_id, institution_id, name, type, currency, opening_date, extra, sort, archived, created_at, updated_at) VALUES ('a1','u1','i1','Debit','checking','CNY','2026-01-01','{}',0,0,0,0);
        INSERT INTO cards (id, user_id, account_id, form, status, single_use, brand, funding, last4, pan_enc, theme, extra, archived, created_at, updated_at) VALUES ('c1','u1','a1','physical','active',0,'visa','debit','4242','enc','midnight','{}',0,0,0);
        INSERT INTO transactions (id, user_id, account_id, type, amount, currency, occurred_at, original_amount, original_currency, extra, created_at, updated_at) VALUES ('t1','u1','a1','expense',-14520,'CNY','2026-10-01',2000,'USD','{}',0,0);
      `);
      raw.close();
      await openLibsql(url);
      const check = createClient({ url });
      expect((await check.execute('SELECT pan_enc, cvv_enc FROM cards')).rows[0]).toMatchObject({ pan_enc: 'enc', cvv_enc: null });
      expect((await check.execute('SELECT amount, original_amount, market_rate, fee_of FROM transactions')).rows[0]).toMatchObject({ amount: -14520, original_amount: 2000, market_rate: null, fee_of: null });
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
