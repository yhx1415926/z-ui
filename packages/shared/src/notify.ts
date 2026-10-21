import { z } from 'zod';
import type { NotifyRule, NotifySettings } from './api-types.ts';
import { NOTIFY_KINDS, type NotifyKind } from './enums.ts';

/**
 * Email notifications: which events send a mail, and the text of each mail. Templates use
 * {{variable}} placeholders; unknown names are left as typed so mistakes stay visible.
 */

/** Variables every template can use. */
export const COMMON_VARS = ['app', 'today', 'link'] as const;

/** Extra variables per rule (shown next to the template editor). */
export const NOTIFY_VARS: Record<NotifyKind, readonly string[]> = {
  autopay_low: ['card', 'account', 'balance', 'needed', 'dueDate', 'daysLeft'],
  autopay_done: ['card', 'account', 'amount', 'paid', 'dueDate'],
  price_alert: ['symbol', 'name', 'price', 'target', 'direction', 'time'],
  bill_due: ['bill', 'amount', 'dueDate', 'daysLeft'],
  bill_overdue: ['bill', 'amount', 'dueDate', 'daysOverdue'],
  statement_due: ['card', 'amount', 'dueDate', 'daysLeft', 'dueText'],
  over_limit: ['account', 'owed', 'limit', 'over'],
  card_expiry: ['card', 'expiry', 'daysLeft'],
};

/** Rules that look ahead a number of days (the others fire when the event happens). */
export const NOTIFY_HAS_DAYS: Record<NotifyKind, boolean> = {
  autopay_low: true,
  autopay_done: false,
  price_alert: false,
  bill_due: true,
  bill_overdue: false,
  statement_due: true,
  over_limit: false,
  card_expiry: true,
};

const FOOTER = '\n\n—— {{app}} · {{link}}';

export const DEFAULT_RULES: Record<NotifyKind, NotifyRule> = {
  autopay_low: {
    enabled: true,
    daysBefore: 3,
    subject: '【{{app}}】{{card}} 自动还款账户余额不足',
    body: '{{card}} 的账单将在 {{dueDate}}（{{daysLeft}} 天后）自动还款 {{needed}}。\n还款账户「{{account}}」当前余额 {{balance}}，不够还款，请及时转入。' + FOOTER,
  },
  autopay_done: {
    enabled: false,
    daysBefore: 0,
    subject: '【{{app}}】{{card}} 已自动还款 {{amount}}',
    body: '已从「{{account}}」扣款 {{paid}}，归还 {{card}} 在 {{dueDate}} 到期的账单 {{amount}}。' + FOOTER,
  },
  price_alert: {
    enabled: true,
    daysBefore: 0,
    subject: '【{{app}}】{{symbol}} 已{{direction}} {{target}}',
    body: '{{symbol}}（{{name}}）最新价 {{price}}，已{{direction}}你设定的 {{target}}。\n行情时间：{{time}}\n\n这个提醒已自动关闭，可以在「投资 → 自选」里重新开启。' + FOOTER,
  },
  bill_due: {
    enabled: false,
    daysBefore: 1,
    subject: '【{{app}}】{{bill}} 将于 {{dueDate}} 扣款 {{amount}}',
    body: '账单「{{bill}}」{{amount}} 将在 {{dueDate}}（{{daysLeft}} 天后）到期。' + FOOTER,
  },
  bill_overdue: {
    enabled: true,
    daysBefore: 0,
    subject: '【{{app}}】{{bill}} 已到期未付',
    body: '账单「{{bill}}」{{amount}} 在 {{dueDate}} 到期，至今还没有标记为已付（已过 {{daysOverdue}} 天）。' + FOOTER,
  },
  statement_due: {
    enabled: true,
    daysBefore: 3,
    subject: '【{{app}}】{{card}} 账单待还 {{amount}}',
    body: '{{card}} 的信用卡账单 {{dueDate}} 到期，还有 {{amount}} 未还（{{dueText}}）。' + FOOTER,
  },
  over_limit: {
    enabled: false,
    daysBefore: 0,
    subject: '【{{app}}】{{account}} 已超出信用额度',
    body: '「{{account}}」目前欠款 {{owed}}，信用额度 {{limit}}，已超出 {{over}}。' + FOOTER,
  },
  card_expiry: {
    enabled: false,
    daysBefore: 30,
    subject: '【{{app}}】{{card}} 即将过期',
    body: '{{card}} 将在 {{expiry}} 过期（{{daysLeft}} 天后），记得更新绑定这张卡的订阅和自动扣款。' + FOOTER,
  },
};

export const DEFAULT_NOTIFY: NotifySettings = { enabled: false, to: '', from: '', fromName: 'Z-UI', rules: DEFAULT_RULES };

const email = z.string().trim().max(254).regex(/^$|^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, 'invalid email address');

const ruleSchema = (kind: NotifyKind) =>
  z
    .object({
      enabled: z.boolean(),
      daysBefore: z.number().int().min(0).max(60),
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(4000),
    })
    .default(DEFAULT_RULES[kind]);

/** Stored settings; rules added in later versions get their defaults. */
export const notifySettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    to: email.default(''),
    from: email.default(''),
    fromName: z.string().trim().max(64).default('Z-UI'),
    rules: z
      .object(Object.fromEntries(NOTIFY_KINDS.map((k) => [k, ruleSchema(k)])) as Record<NotifyKind, ReturnType<typeof ruleSchema>>)
      .default(DEFAULT_RULES),
  })
  .refine((s) => !s.enabled || (s.to && s.from), { message: 'sender and recipient are required', path: ['to'] });

/** Fill {{name}} placeholders (spaces inside the braces are allowed). */
export function renderTemplate(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (m, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? m : String(v);
  });
}

/** "还剩 3 天" / "今天到期" / "已逾期 2 天". */
export function dueTextZh(daysLeft: number): string {
  return daysLeft > 0 ? `还剩 ${daysLeft} 天` : daysLeft === 0 ? '今天到期' : `已逾期 ${-daysLeft} 天`;
}
