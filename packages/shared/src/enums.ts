export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const INSTITUTION_TYPES = ['bank', 'ewallet', 'broker', 'crypto', 'other'] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'credit',
  'cash',
  'ewallet',
  'investment',
  'other',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** trade = cash leg of a stock buy/sell, created on the investments page. */
export const TRANSACTION_TYPES = ['income', 'expense', 'transfer', 'adjustment', 'trade'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const CATEGORY_KINDS = ['expense', 'income'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/** One-time bill (single due date) or subscription (recurring). */
export const BILL_KINDS = ['once', 'subscription'] as const;
export type BillKind = (typeof BILL_KINDS)[number];

/**
 * What to do with due dates that are already in the past when a bill is created:
 * record = mark paid and create the expense transactions (history counts in statistics),
 * paid = mark paid without transactions, pending = leave them unpaid.
 */
export const PAST_POLICIES = ['record', 'paid', 'pending'] as const;
export type PastPolicy = (typeof PAST_POLICIES)[number];

export const OCCURRENCE_STATUSES = ['pending', 'paid', 'skipped'] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

export const SESSION_METHODS = ['passkey', 'password_totp', 'recovery', 'setup'] as const;
export type SessionMethod = (typeof SESSION_METHODS)[number];

export const CUSTOM_FIELD_ENTITIES = ['institution', 'account', 'card', 'transaction'] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'select',
  'multiselect',
  'date',
  'boolean',
  'money',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** Card face themes for the Stripe-style card component. */
export const CARD_THEMES = [
  'midnight',
  'ocean',
  'violet',
  'sunset',
  'emerald',
  'graphite',
  'gold',
  'rose',
] as const;
export type CardTheme = (typeof CARD_THEMES)[number];

/** Credit card automatic repayment: the whole statement or its minimum payment. */
export const AUTOPAY_MODES = ['full', 'min'] as const;
export type AutopayMode = (typeof AUTOPAY_MODES)[number];

/** Price alert: fires when the price reaches the target from below (above) or above (below). */
export const ALERT_DIRECTIONS = ['above', 'below'] as const;
export type AlertDirection = (typeof ALERT_DIRECTIONS)[number];

/**
 * Stored price histories (one sync fetches all five): 1d = intraday 5-minute closes,
 * 5d = 30-minute, 1y = daily, 5y = weekly, max = monthly. The chart ranges are cut from them.
 */
export const CHART_SERIES = ['1d', '5d', '1y', '5y', 'max'] as const;
export type ChartSeries = (typeof CHART_SERIES)[number];

/** Chart ranges on the stocks page (Apple Stocks style) and the series each is cut from. */
export const CHART_RANGES = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '5Y', '10Y', 'ALL'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
export const RANGE_SERIES: Record<ChartRange, ChartSeries> = {
  '1D': '1d',
  '1W': '5d',
  '1M': '1y',
  '3M': '1y',
  '6M': '1y',
  YTD: '1y',
  '1Y': '1y',
  '2Y': '5y',
  '5Y': '5y',
  '10Y': 'max',
  ALL: 'max',
};

/** Email notification rules the user can switch on (see notify.ts). */
export const NOTIFY_KINDS = [
  'autopay_low',
  'autopay_done',
  'price_alert',
  'bill_due',
  'bill_overdue',
  'statement_due',
  'over_limit',
  'card_expiry',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
