import { z } from 'zod';
import { CARD_BRANDS, CARD_FORMS, CARD_FUNDING, CARD_STATUSES, LIMIT_PERIODS } from './card.ts';
import { isIsoDate } from './date.ts';
import {
  ACCOUNT_TYPES,
  ALERT_DIRECTIONS,
  AUTOPAY_MODES,
  BILL_KINDS,
  CARD_THEMES,
  CATEGORY_KINDS,
  INSTITUTION_TYPES,
  PAST_POLICIES,
  ROLES,
  TRANSACTION_TYPES,
} from './enums.ts';
import { RECURRENCE_FREQS } from './recurrence.ts';

/** Request bodies shared by the API (validation) and the web app (forms). */

export const idSchema = z.string().min(1).max(40);
export const isoDateSchema = z.string().refine(isIsoDate, 'invalid date (YYYY-MM-DD)');
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/);
export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/);
/** Integer amount in minor units. */
export const minorSchema = z.number().int().refine(Number.isSafeInteger, 'amount too large');
export const positiveMinorSchema = minorSchema.refine((n) => n > 0, 'amount must be positive');
export const extraSchema = z.record(z.string(), z.unknown());

const name = z.string().trim().min(1).max(64);
const optText = (max: number) => z.string().trim().max(max).nullish();
const color = z.string().max(32).nullish();

// ---------------------------------------------------------------- auth

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.-]{3,32}$/, '3–32 letters, digits, _ . -');
export const passwordSchema = z.string().min(10, 'at least 10 characters').max(256);
export const totpCodeSchema = z.string().regex(/^\d{6}$/, '6 digits');

export const loginSchema = z
  .object({
    username: z.string().trim().toLowerCase().min(1).max(64),
    password: z.string().min(1).max(256),
    totp: totpCodeSchema.optional(),
    recoveryCode: z.string().trim().max(32).optional(),
  })
  .refine((v) => v.totp || v.recoveryCode, { message: 'TOTP code or recovery code required' });

export const inviteCreateSchema = z.object({
  role: z.enum(ROLES).default('member'),
  note: optText(100),
  expiresInHours: z.number().int().min(1).max(168).default(72),
});

export const inviteBeginSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(32),
  password: passwordSchema,
});

export const totpConfirmSchema = z.object({ code: totpCodeSchema });

/** Profile picture: a small image data URL made in the browser (≈ 192 px), or null for initials. */
export const avatarSchema = z
  .string()
  .max(200_000, 'image too large')
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, 'PNG, JPEG or WebP data URL');

export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  avatar: avatarSchema.nullable().optional(),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const userPatchSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  displayName: z.string().trim().min(1).max(32).optional(),
});

export const passkeyRenameSchema = z.object({ name: z.string().trim().min(1).max(64) });

// ---------------------------------------------------------------- ledger

export const institutionSchema = z.object({
  name,
  country: countryCodeSchema,
  type: z.enum(INSTITUTION_TYPES),
  color,
  website: optText(200),
  note: optText(2000),
  extra: extraSchema.optional(),
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
});
export const institutionPatchSchema = institutionSchema.partial();

/**
 * One currency held by an account. openingBalance is the balance at the end of balanceDate:
 * transactions dated after it change the balance, earlier ones (and that day's) do not.
 * Without a date every transaction counts.
 */
export const accountCurrencySchema = z.object({
  currency: currencyCodeSchema,
  openingBalance: minorSchema.default(0),
  balanceDate: isoDateSchema.nullish(),
  /** Count this balance in the dashboard totals. */
  includeInTotal: z.boolean().default(true),
});

const accountCurrencies = z
  .array(accountCurrencySchema)
  .min(1, 'at least one currency')
  .max(30)
  .refine((list) => new Set(list.map((c) => c.currency)).size === list.length, 'duplicate currency');

export const accountSchema = z.object({
  institutionId: idSchema,
  name,
  type: z.enum(ACCOUNT_TYPES),
  /** Multi-currency accounts list several; the first one is the primary currency. */
  currencies: accountCurrencies,
  openingDate: isoDateSchema,
  creditLimit: minorSchema.refine((n) => n >= 0).nullish(),
  numberLast4: z.string().regex(/^\d{4}$/).nullish(),
  note: optText(2000),
  extra: extraSchema.optional(),
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
});
export const accountPatchSchema = accountSchema.partial();

const dayOfMonth = z.number().int().min(1).max(31).nullish();

const cardFields = {
  accountId: idSchema,
  form: z.enum(CARD_FORMS).default('physical'),
  /** A virtual card issued under a physical card. */
  parentCardId: idSchema.nullish(),
  status: z.enum(CARD_STATUSES).default('active'),
  /** Spending limit in the account's primary currency (minor units). */
  spendLimit: minorSchema.refine((n) => n > 0, 'must be positive').nullish(),
  limitPeriod: z.enum(LIMIT_PERIODS).nullish(),
  singleUse: z.boolean().default(false),
  /** Merchant the card is locked to, e.g. "Netflix". */
  merchant: optText(64),
  nickname: optText(64),
  /** Full card number. Encrypted at rest; only BIN + last 4 are stored in clear. */
  pan: z.string().max(32).nullish(),
  bin: z.string().regex(/^\d{6}$/, '6 digits').nullish(),
  /** Public BIN record looked up by the browser when the card was entered. */
  binInfo: z
    .object({
      bin: z.string().regex(/^\d{6}$/),
      scheme: z.string().max(60).optional(),
      type: z.string().max(60).optional(),
      level: z.string().max(80).optional(),
      issuer: z.string().max(160).optional(),
      country: z.string().max(4).optional(),
      countryName: z.string().max(80).optional(),
      phone: z.string().max(60).optional(),
      url: z.string().max(200).optional(),
      /** Date the public record was last confirmed by its source. */
      seen: z.string().max(10).optional(),
      /** library = from the public BIN list; manual = corrected by hand. */
      source: z.enum(['library', 'manual']).optional(),
    })
    .nullish(),
  last4: z.string().regex(/^\d{4}$/).nullish(),
  brand: z.enum(CARD_BRANDS).optional(),
  funding: z.enum(CARD_FUNDING),
  expMonth: z.number().int().min(1).max(12).nullish(),
  expYear: z.number().int().min(2000).max(2100).nullish(),
  holderName: optText(64),
  statementDay: dayOfMonth,
  dueDay: dayOfMonth,
  /** Credit cards: account the bank debits on the due date (null = no automatic repayment). */
  autopayAccountId: idSchema.nullish(),
  /** Currency debited from that account (default: the statement's if held, else its primary). */
  autopayCurrency: currencyCodeSchema.nullish(),
  autopayMode: z.enum(AUTOPAY_MODES).nullish(),
  theme: z.enum(CARD_THEMES).default('midnight'),
  note: optText(2000),
  extra: extraSchema.optional(),
  archived: z.boolean().optional(),
};
export const cardSchema = z
  .object(cardFields)
  .refine((v) => (v.pan && v.pan.trim()) || v.last4, { message: 'card number or last 4 digits required', path: ['last4'] });
export const cardPatchSchema = z.object(cardFields).partial();

export const categorySchema = z.object({
  kind: z.enum(CATEGORY_KINDS),
  name: z.string().trim().min(1).max(32),
  parentId: idSchema.nullish(),
  icon: z.string().max(32).nullish(),
  color,
  sort: z.number().int().optional(),
  archived: z.boolean().optional(),
});
export const categoryPatchSchema = categorySchema.partial();

export const tagSchema = z.object({ name: z.string().trim().min(1).max(32), color });
export const tagPatchSchema = tagSchema.partial();

const txCommon = {
  occurredAt: isoDateSchema,
  note: optText(2000),
  counterparty: optText(128),
  tagIds: z.array(idSchema).max(20).optional(),
  extra: extraSchema.optional(),
};

export const transactionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.enum(['income', 'expense']),
      accountId: idSchema,
      /** One of the account's currencies; defaults to its primary currency. */
      currency: currencyCodeSchema.nullish(),
      cardId: idSchema.nullish(),
      categoryId: idSchema.nullish(),
      /**
       * Positive; the sign is derived from the type. What the account actually paid/received.
       * May be left out for a foreign-currency charge: it is then converted from the original
       * amount with the current FX rates.
       */
      amount: positiveMinorSchema.nullish(),
      /** Foreign-currency charge, e.g. USD 20.00 paid from a CNY-only wallet. */
      originalCurrency: currencyCodeSchema.nullish(),
      originalAmount: positiveMinorSchema.nullish(),
      ...txCommon,
    })
    .refine((v) => v.amount || (v.originalAmount && v.originalCurrency), { message: 'amount required', path: ['amount'] }),
  z.object({
    type: z.literal('adjustment'),
    accountId: idSchema,
    currency: currencyCodeSchema.nullish(),
    /** Signed correction. */
    amount: minorSchema.refine((n) => n !== 0, 'amount must not be zero'),
    ...txCommon,
  }),
  z.object({
    type: z.literal('transfer'),
    fromAccountId: idSchema,
    toAccountId: idSchema,
    /** Currencies of each side (default: each account's primary). The same account may
     *  appear on both sides when converting between two of its currencies. */
    fromCurrency: currencyCodeSchema.nullish(),
    toCurrency: currencyCodeSchema.nullish(),
    /** Amount leaving the source account (source currency). */
    amount: positiveMinorSchema,
    /**
     * Amount arriving (destination currency). For a cross-currency transfer left out, it is
     * converted with the current FX rates.
     */
    toAmount: positiveMinorSchema.nullish(),
    categoryId: idSchema.nullish(),
    ...txCommon,
  }),
]);
export type TransactionInput = z.infer<typeof transactionSchema>;

export const transactionQuerySchema = z.object({
  accountId: idSchema.optional(),
  institutionId: idSchema.optional(),
  cardId: idSchema.optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  currency: currencyCodeSchema.optional(),
  categoryId: idSchema.optional(),
  tagId: idSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  q: z.string().trim().max(100).optional(),
  /** "1": include transactions tagged "hidden" (left out of the list by default). */
  hidden: z.enum(['0', '1']).optional(),
  /** "1": include stock-trade cash legs (left out unless filtering by that type). */
  trades: z.enum(['0', '1']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const billFields = {
  name,
  kind: z.enum(BILL_KINDS),
  amount: positiveMinorSchema,
  currency: currencyCodeSchema,
  accountId: idSchema.nullish(),
  cardId: idSchema.nullish(),
  categoryId: idSchema.nullish(),
  /** Subscriptions only. */
  freq: z.enum(RECURRENCE_FREQS).nullish(),
  interval: z.number().int().min(1).max(24).default(1),
  /** First due date (subscription) or the due date (one-time bill). */
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullish(),
  remindDaysBefore: z.number().int().min(0).max(60).default(3),
  active: z.boolean().default(true),
  note: optText(2000),
};
export const billSchema = z
  .object({ ...billFields, pastPolicy: z.enum(PAST_POLICIES).default('record') })
  .refine((b) => b.kind === 'once' || !!b.freq, { message: 'subscriptions need a frequency', path: ['freq'] });
export const billPatchSchema = z.object(billFields).partial();

export const payOccurrenceSchema = z.object({
  accountId: idSchema.nullish(),
  /** Currency of the account debited (one of its currencies). */
  currency: currencyCodeSchema.nullish(),
  cardId: idSchema.nullish(),
  /** Amount charged in `currency`; when that differs from the bill's and this is left out, the current FX rate is used. */
  amount: positiveMinorSchema.nullish(),
  occurredAt: isoDateSchema.nullish(),
  note: optText(2000),
});

export const statementSchema = z.object({
  cardId: idSchema,
  /** Defaults to the card account's primary currency (dual-currency cards have one statement per currency). */
  currency: currencyCodeSchema.nullish(),
  periodStart: isoDateSchema.nullish(),
  periodEnd: isoDateSchema.nullish(),
  statementDate: isoDateSchema,
  dueDate: isoDateSchema,
  /** Amount owed for this statement, entered from the bank statement. */
  statementAmount: minorSchema.refine((n) => n >= 0, 'must be ≥ 0'),
  minPayment: minorSchema.refine((n) => n >= 0, 'must be ≥ 0').nullish(),
  note: optText(2000),
});
export const statementPatchSchema = statementSchema.partial();

export const repaySchema = z.object({
  fromAccountId: idSchema,
  fromCurrency: currencyCodeSchema.nullish(),
  amount: positiveMinorSchema,
  toAmount: positiveMinorSchema.nullish(),
  occurredAt: isoDateSchema,
  note: optText(2000),
});

export const statsQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  currency: currencyCodeSchema.optional(),
  institutionId: idSchema.optional(),
  accountId: idSchema.optional(),
  /** Count realized stock gains/losses as income/expense (USD). On unless "0". */
  invest: z.enum(['0', '1']).optional(),
  /** Without `currency`: convert everything to this currency (default: the app's). */
  convertTo: currencyCodeSchema.optional(),
});

/** Decimal string with up to 6 fraction digits, e.g. "12.5" shares or "187.2345" dollars. */
export const decimal6Schema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'number with up to 6 decimals')
  .refine((s) => Number(s) > 0, 'must be positive');

export const stockSymbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.-]{0,9}$/, 'ticker like AAPL or BRK.B');

export const tradeSchema = z
  .object({
    symbol: stockSymbolSchema,
    side: z.enum(['buy', 'sell']),
    quantity: decimal6Schema,
    /** Price per share — or give the total amount instead and the price is derived. */
    price: decimal6Schema.nullish(),
    amount: positiveMinorSchema.nullish(),
    fee: minorSchema.refine((n) => n >= 0, 'must be ≥ 0').default(0),
    tradeDate: isoDateSchema,
    /** Investment account (type "investment", holding USD) the shares belong to. */
    accountId: idSchema,
    /** Account the money is paid from / into (holding USD); omit to record no cash movement. */
    cashAccountId: idSchema.nullish(),
    note: optText(2000),
  })
  .refine((t) => t.price || t.amount, { message: 'price or amount required', path: ['price'] });

export const priceSchema = z.object({ price: decimal6Schema });

export const watchAddSchema = z.object({ symbol: stockSymbolSchema });
/** New watchlist order (symbols not listed keep their place after these). */
export const watchOrderSchema = z.object({ symbols: z.array(stockSymbolSchema).max(200) });

export const priceAlertSchema = z.object({
  symbol: stockSymbolSchema,
  direction: z.enum(ALERT_DIRECTIONS),
  /** Target price in USD, up to 6 decimals. */
  target: decimal6Schema,
  note: optText(200),
});
export const priceAlertPatchSchema = priceAlertSchema.partial().extend({
  /** true re-arms a triggered alert. */
  active: z.boolean().optional(),
});

/** Correct a ticker on every trade, e.g. APPL → AAPL. */
export const symbolRenameSchema = z.object({ to: stockSymbolSchema });

export const dashboardQuerySchema = z.object({
  /** Currency the net worth is converted to (defaults to the app's default currency). */
  currency: currencyCodeSchema.optional(),
});
export const fxRateSchema = z.object({ perUsd: z.number().positive().finite() });

export const dismissReminderSchema = z.object({ key: z.string().min(1).max(200) });

export const configSaveSchema = z.object({
  config: z.unknown(),
  message: z.string().trim().max(200).optional(),
});
