import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * One schema for local libsql and Cloudflare D1.
 * - Ids are text (time-sortable random ids, see lib/id.ts).
 * - Timestamps are epoch milliseconds; business dates are "YYYY-MM-DD" text.
 * - Amounts are integer minor units.
 * - Every ledger table carries user_id; all queries are scoped by it.
 */

const ts = (name: string) => integer(name).notNull();
const bool = (name: string) => integer(name, { mode: 'boolean' });
const json = (name: string) =>
  text(name, { mode: 'json' }).$type<Record<string, unknown>>().notNull().default(sql`'{}'`);

// ------------------------------------------------------------------ auth

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  status: text('status', { enum: ['active', 'disabled', 'pending'] }).notNull(),
  passwordHash: text('password_hash'),
  totpSecretEnc: text('totp_secret_enc'),
  totpPendingEnc: text('totp_pending_enc'),
  totpEnabled: bool('totp_enabled').notNull().default(false),
  /** Last accepted TOTP time step, to reject replays of the same code. */
  totpLastStep: integer('totp_last_step'),
  /** Random WebAuthn user handle (base64url). */
  webauthnUserId: text('webauthn_user_id').notNull(),
  /** Profile picture as a small data URL (resized in the browser), or null for initials. */
  avatar: text('avatar'),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
});

export const passkeys = sqliteTable(
  'passkeys',
  {
    id: text('id').primaryKey(), // credential id, base64url
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(), // base64url
    counter: integer('counter').notNull().default(0),
    transports: text('transports', { mode: 'json' }).$type<string[]>(),
    deviceType: text('device_type'),
    backedUp: bool('backed_up').notNull().default(false),
    name: text('name').notNull(),
    createdAt: ts('created_at'),
    lastUsedAt: integer('last_used_at'),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256(token) hex
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    method: text('method', { enum: ['passkey', 'password_totp', 'recovery', 'setup'] }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: ts('created_at'),
    lastSeenAt: ts('last_seen_at'),
    expiresAt: ts('expires_at'),
    absoluteExpiresAt: ts('absolute_expires_at'),
    stepUpAt: integer('step_up_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(), // sha256(token) hex
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  note: text('note'),
  /** User created by the first step of accepting; replaced if the flow restarts. */
  pendingUserId: text('pending_user_id'),
  createdAt: ts('created_at'),
  expiresAt: ts('expires_at'),
  usedAt: integer('used_at'),
  usedBy: text('used_by'),
});

export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: integer('used_at'),
    createdAt: ts('created_at'),
  },
  (t) => [index('recovery_user_idx').on(t.userId)],
);

export const loginAttempts = sqliteTable('login_attempts', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull(),
  windowStart: ts('window_start'),
  lockedUntil: integer('locked_until'),
});

export const authChallenges = sqliteTable('auth_challenges', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  purpose: text('purpose', { enum: ['register', 'login', 'step_up'] }).notNull(),
  challenge: text('challenge').notNull(),
  expiresAt: ts('expires_at'),
});

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id'),
    action: text('action').notNull(),
    detail: text('detail', { mode: 'json' }),
    ip: text('ip'),
    createdAt: ts('created_at'),
  },
  (t) => [index('audit_user_idx').on(t.userId, t.createdAt)],
);

// ------------------------------------------------------------------ ledger

export const institutions = sqliteTable(
  'institutions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    country: text('country').notNull(),
    type: text('type', { enum: ['bank', 'ewallet', 'broker', 'crypto', 'other'] }).notNull(),
    color: text('color'),
    website: text('website'),
    note: text('note'),
    extra: json('extra'),
    sort: integer('sort').notNull().default(0),
    archived: bool('archived').notNull().default(false),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('institutions_user_idx').on(t.userId)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    institutionId: text('institution_id')
      .notNull()
      .references(() => institutions.id),
    name: text('name').notNull(),
    type: text('type', {
      enum: ['checking', 'savings', 'credit', 'cash', 'ewallet', 'investment', 'other'],
    }).notNull(),
    /** Primary currency; all currencies held (with opening balances) are in account_currencies. */
    currency: text('currency').notNull(),
    openingDate: text('opening_date').notNull(),
    creditLimit: integer('credit_limit'),
    numberLast4: text('number_last4'),
    note: text('note'),
    extra: json('extra'),
    sort: integer('sort').notNull().default(0),
    archived: bool('archived').notNull().default(false),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('accounts_user_idx').on(t.userId), index('accounts_inst_idx').on(t.institutionId)],
);

/** Currencies held by an account (multi-currency accounts have several rows). */
export const accountCurrencies = sqliteTable(
  'account_currencies',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull(),
    openingBalance: integer('opening_balance').notNull().default(0),
    /**
     * Date the opening balance was synced (the balance at the end of that day): only transactions
     * dated after it change the balance. Null = every transaction counts.
     */
    balanceDate: text('balance_date'),
    /** Counted in the dashboard totals (net worth). */
    includeInTotal: bool('include_in_total').notNull().default(true),
    /**
     * Cached opening_balance + Σ transactions in this currency, and their count. Recomputed in the
     * same batch as every write that touches the account's transactions (lib/balances.ts), so
     * reading balances never scans the transactions table (D1 bills rows read).
     */
    balance: integer('balance').notNull().default(0),
    txCount: integer('tx_count').notNull().default(0),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.currency] }), index('acc_cur_user_idx').on(t.userId)],
);

export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    form: text('form', { enum: ['physical', 'virtual'] }).notNull().default('physical'),
    /** Virtual card issued under this physical card. */
    parentCardId: text('parent_card_id'),
    status: text('status', { enum: ['active', 'frozen', 'closed'] }).notNull().default('active'),
    spendLimit: integer('spend_limit'),
    limitPeriod: text('limit_period', { enum: ['transaction', 'month', 'total'] }),
    singleUse: bool('single_use').notNull().default(false),
    merchant: text('merchant'),
    /** Public BIN record captured when the card was saved (issuer, country, level…). */
    binInfo: text('bin_info', { mode: 'json' }).$type<Record<string, string>>(),
    nickname: text('nickname'),
    brand: text('brand').notNull(),
    funding: text('funding', { enum: ['credit', 'debit', 'prepaid'] }).notNull(),
    bin: text('bin'),
    last4: text('last4').notNull(),
    /** AES-256-GCM encrypted full card number (lib/crypto.ts). Never returned by list APIs. */
    panEnc: text('pan_enc'),
    /**
     * Encrypted security code: CVV/CVN (3–4 digits) or a 6-digit PIN, not told apart. Only sent
     * to the browser by POST /cards/:id/cvv (signed in, recently verified, card turned over).
     */
    cvvEnc: text('cvv_enc'),
    expMonth: integer('exp_month'),
    expYear: integer('exp_year'),
    holderName: text('holder_name'),
    statementDay: integer('statement_day'),
    dueDay: integer('due_day'),
    theme: text('theme').notNull().default('midnight'),
    note: text('note'),
    extra: json('extra'),
    archived: bool('archived').notNull().default(false),
    /**
     * Credit cards: account the bank debits on the due date (lib/autopay.ts records the
     * repayment), in autopayCurrency; full statement or the minimum payment. Statements due
     * before autopaySince (the day it was set up) are left alone.
     */
    autopayAccountId: text('autopay_account_id'),
    autopayCurrency: text('autopay_currency'),
    autopayMode: text('autopay_mode', { enum: ['full', 'min'] }),
    autopaySince: text('autopay_since'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('cards_user_idx').on(t.userId), index('cards_account_idx').on(t.accountId)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['expense', 'income'] }).notNull(),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    icon: text('icon'),
    color: text('color'),
    sort: integer('sort').notNull().default(0),
    archived: bool('archived').notNull().default(false),
  },
  (t) => [index('categories_user_idx').on(t.userId)],
);

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
  },
  (t) => [uniqueIndex('tags_user_name_uq').on(t.userId, t.name)],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    cardId: text('card_id'),
    /** trade = cash leg of a stock buy/sell (excluded from income/expense statistics). */
    type: text('type', { enum: ['income', 'expense', 'transfer', 'adjustment', 'trade'] }).notNull(),
    /** Signed amount in `currency` (one of the account's currencies). */
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default(''),
    occurredAt: text('occurred_at').notNull(),
    categoryId: text('category_id'),
    counterparty: text('counterparty'),
    note: text('note'),
    /** Both legs of a transfer share this id. */
    transferGroupId: text('transfer_group_id'),
    billOccurrenceId: text('bill_occurrence_id'),
    /** Credit card statement this repayment is applied to. */
    statementId: text('statement_id'),
    /**
     * Foreign-currency charge (e.g. a USD subscription paid from a CNY-only wallet): what the
     * merchant billed. `amount` stays what the account actually paid, in its own currency.
     */
    originalAmount: integer('original_amount'),
    originalCurrency: text('original_currency'),
    /**
     * Synced FX rate when recorded, for the exchange loss: units of the transfer's destination
     * (or the booked) currency per 1 unit of its source (or the original) currency.
     */
    marketRate: real('market_rate'),
    /** Fee expense of a transfer: the transfer's group id (the fee leaves the source account). */
    feeOf: text('fee_of'),
    extra: json('extra'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    index('tx_user_date_idx').on(t.userId, t.occurredAt),
    index('tx_account_idx').on(t.accountId, t.currency),
    index('tx_group_idx').on(t.transferGroupId),
    index('tx_statement_idx').on(t.statementId),
    index('tx_fee_of_idx').on(t.feeOf),
  ],
);

export const transactionTags = sqliteTable(
  'transaction_tags',
  {
    transactionId: text('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.transactionId, t.tagId] }), index('tx_tags_tag_idx').on(t.tagId)],
);

export const bills = sqliteTable(
  'bills',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['once', 'subscription'] }).notNull(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    accountId: text('account_id'),
    cardId: text('card_id'),
    categoryId: text('category_id'),
    /** Subscriptions only (one-time bills keep the default and ignore it). Not nullable so the
     *  migration doesn't have to rebuild the bills table. */
    freq: text('freq', { enum: ['weekly', 'monthly', 'yearly'] }).notNull(),
    interval: integer('interval').notNull().default(1),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    remindDaysBefore: integer('remind_days_before').notNull().default(3),
    active: bool('active').notNull().default(true),
    note: text('note'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('bills_user_idx').on(t.userId)],
);

export const billOccurrences = sqliteTable(
  'bill_occurrences',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    billId: text('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    dueDate: text('due_date').notNull(),
    amount: integer('amount').notNull(),
    status: text('status', { enum: ['pending', 'paid', 'skipped'] }).notNull(),
    transactionId: text('transaction_id'),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('bill_occ_uq').on(t.billId, t.dueDate),
    index('bill_occ_user_idx').on(t.userId, t.dueDate),
  ],
);

export const creditStatements = sqliteTable(
  'credit_statements',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull().default(''),
    periodStart: text('period_start'),
    periodEnd: text('period_end'),
    statementDate: text('statement_date').notNull(),
    dueDate: text('due_date').notNull(),
    statementAmount: integer('statement_amount').notNull(),
    minPayment: integer('min_payment'),
    note: text('note'),
    /** When the automatic repayment ran for this statement (once per statement). */
    autopayAt: integer('autopay_at'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('stmt_user_idx').on(t.userId, t.dueDate), index('stmt_card_idx').on(t.cardId)],
);

export const reminderDismissals = sqliteTable(
  'reminder_dismissals',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    dismissedAt: ts('dismissed_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

// ------------------------------------------------------------------ settings & markets

/** Key/value settings; 'app-config' holds the shared configuration JSON (edited in the UI). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: ts('updated_at'),
});

/** Units of `currency` per 1 USD, synced manually from a public FX API (or typed in). */
export const fxRates = sqliteTable('fx_rates', {
  currency: text('currency').primaryKey(),
  perUsd: real('per_usd').notNull(),
  asOf: text('as_of').notNull(),
  source: text('source').notNull(),
  updatedAt: ts('updated_at'),
});

/** Last known price of a US stock/ETF (price × 1e6), synced manually. */
export const securities = sqliteTable('securities', {
  symbol: text('symbol').primaryKey(),
  name: text('name'),
  currency: text('currency').notNull().default('USD'),
  priceMicros: integer('price_micros'),
  priceAt: integer('price_at'),
  /** Previous session's close, for the day's change on the watchlist. */
  prevCloseMicros: integer('prev_close_micros'),
  source: text('source'),
  updatedAt: ts('updated_at'),
});

/** Stock buys and sells. Quantities and prices are ×1e6 integers (fractional shares). */
export const trades = sqliteTable(
  'trades',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Investment account holding the position (its value includes the market value). */
    accountId: text('account_id'),
    /** Account the money is paid from / into; the cash leg (transactionId) is booked there. */
    cashAccountId: text('cash_account_id'),
    symbol: text('symbol').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    quantityMicros: integer('quantity_micros').notNull(),
    priceMicros: integer('price_micros').notNull(),
    /** Gross amount (quantity × price) in minor units of `currency`. */
    amount: integer('amount').notNull(),
    fee: integer('fee').notNull().default(0),
    currency: text('currency').notNull().default('USD'),
    tradeDate: text('trade_date').notNull(),
    /** Cash leg in cashAccountId, when recorded. */
    transactionId: text('transaction_id'),
    note: text('note'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('trades_user_idx').on(t.userId, t.symbol, t.tradeDate)],
);

/** Symbols on the user's watchlist (stocks page), in display order. */
export const watchlist = sqliteTable(
  'watchlist',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    sort: integer('sort').notNull().default(0),
    createdAt: ts('created_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.symbol] })],
);

/**
 * Price history for the charts, one row per symbol and series (1d = intraday 5 min, 5d = 30 min,
 * 1y = daily, 5y = weekly, max = monthly), synced manually. points = [[unix seconds, close], …].
 */
export const priceSeries = sqliteTable(
  'price_series',
  {
    symbol: text('symbol').notNull(),
    series: text('series', { enum: ['1d', '5d', '1y', '5y', 'max'] }).notNull(),
    points: text('points', { mode: 'json' }).$type<[number, number][]>().notNull(),
    prevCloseMicros: integer('prev_close_micros'),
    syncedAt: ts('synced_at'),
  },
  (t) => [primaryKey({ columns: [t.symbol, t.series] })],
);

/** "Tell me when AAPL goes above/below X". Fires once (active → false, triggered_at set). */
export const priceAlerts = sqliteTable(
  'price_alerts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    direction: text('direction', { enum: ['above', 'below'] }).notNull(),
    targetMicros: integer('target_micros').notNull(),
    active: bool('active').notNull().default(true),
    triggeredAt: integer('triggered_at'),
    triggeredPriceMicros: integer('triggered_price_micros'),
    note: text('note'),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('price_alerts_user_idx').on(t.userId, t.symbol)],
);

/** Emails sent (or attempted) by the notification rules; `key` makes each event send once. */
export const notificationLog = sqliteTable(
  'notification_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    kind: text('kind').notNull(),
    subject: text('subject').notNull(),
    ok: bool('ok').notNull(),
    error: text('error'),
    sentAt: ts('sent_at'),
  },
  (t) => [uniqueIndex('notify_log_key_uq').on(t.userId, t.key), index('notify_log_user_idx').on(t.userId, t.sentAt)],
);
