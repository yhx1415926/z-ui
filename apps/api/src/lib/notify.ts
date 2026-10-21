import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  DEFAULT_NOTIFY,
  NOTIFY_KINDS,
  notifySettingsSchema,
  renderTemplate,
  type NotificationLogDto,
  type NotifyKind,
  type NotifySettings,
  type ReminderKind,
} from '@z-ui/shared';
import type { DB } from '../db/client.ts';
import { notificationLog, settings } from '../db/schema.ts';
import type { Deps } from '../env.ts';
import { today } from '../routes/bills.ts';
import { moneyFormatter, reminderItems } from '../routes/reminders.ts';
import { recentAutopays } from './autopay.ts';
import { chunkRows, inChunks } from './chunks.ts';
import { newId } from './id.ts';
import { mailError } from './mail.ts';
import { runBatch } from './ledger.ts';

/**
 * Email notifications. Each rule the user switched on turns matching reminders into events; an
 * event has a key and is mailed once (notification_log). Failed sends are retried on the next run.
 */

const settingsKey = (userId: string) => `notify:${userId}`;
/** Mails per run: keeps a run within Workers Free's 50 subrequests (the rest go out next run). */
export const MAX_SEND = 8;
/** Overdue bills/statements older than this are not mailed (no flood when a rule is switched on). */
const OVERDUE_WINDOW = 30;
/** Repayments recorded in this many days get their "done" mail (whoever triggered them). */
const AUTOPAY_DONE_DAYS = 3;
/** When a run has more than MAX_SEND mails, these go first. */
const PRIORITY: NotifyKind[] = ['autopay_low', 'autopay_done', 'price_alert', 'statement_due', 'bill_overdue', 'over_limit', 'bill_due', 'card_expiry'];
const LOG_DAYS = 180;

export async function loadNotifySettings(db: DB, userId: string): Promise<NotifySettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, settingsKey(userId)));
  if (!row) return DEFAULT_NOTIFY;
  const r = notifySettingsSchema.safeParse(row.value);
  return r.success ? r.data : DEFAULT_NOTIFY;
}

export async function saveNotifySettings(db: DB, userId: string, value: NotifySettings, t: number) {
  await db
    .insert(settings)
    .values({ key: settingsKey(userId), value, updatedAt: t })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: t } });
}

export async function notifyLog(db: DB, userId: string, limit = 30): Promise<NotificationLogDto[]> {
  const rows = await db.select().from(notificationLog).where(eq(notificationLog.userId, userId)).orderBy(desc(notificationLog.sentAt)).limit(limit);
  return rows.map(({ userId: _u, ...r }) => r);
}

export interface NotifyEvent {
  key: string;
  kind: NotifyKind;
  vars: Record<string, string | number>;
}

/** What the enabled rules would mail right now (before de-duplication). */
export async function collectEvents(deps: Deps, userId: string, s: NotifySettings, opts: { kinds?: NotifyKind[] } = {}): Promise<NotifyEvent[]> {
  const on = (k: NotifyKind) => s.rules[k].enabled && (!opts.kinds || opts.kinds.includes(k));
  const days = (k: NotifyKind) => s.rules[k].daysBefore;
  const kinds: ReminderKind[] = [];
  if (on('bill_due') || on('bill_overdue')) kinds.push('bill');
  if (on('statement_due')) kinds.push('statement');
  if (on('over_limit')) kinds.push('over_limit');
  if (on('card_expiry')) kinds.push('card_expiry');
  if (on('autopay_low')) kinds.push('autopay_low');
  if (on('price_alert')) kinds.push('price_alert');
  const horizonDays = Math.max(0, ...NOTIFY_KINDS.filter(on).map(days));
  const items = kinds.length ? await reminderItems(deps, userId, { kinds, horizonDays }) : [];

  const events: NotifyEvent[] = [];
  const add = (key: string, kind: NotifyKind, vars: NotifyEvent['vars']) => events.push({ key, kind, vars });
  for (const r of items) {
    const recent = r.daysLeft >= -OVERDUE_WINDOW;
    switch (r.kind) {
      case 'bill':
        if (r.daysLeft < 0) {
          if (on('bill_overdue') && recent) add(`bill_overdue:${r.refId}`, 'bill_overdue', r.vars);
        } else if (on('bill_due') && r.daysLeft <= days('bill_due')) add(`bill_due:${r.refId}`, 'bill_due', r.vars);
        break;
      case 'statement':
        // Cards repaid automatically only mail when the repayment did not happen (overdue).
        if (r.daysLeft < 0) {
          if (recent) add(`statement_due:${r.refId}:overdue`, 'statement_due', r.vars);
        } else if (!r.vars.autopay && r.daysLeft <= days('statement_due')) add(`statement_due:${r.refId}:soon`, 'statement_due', r.vars);
        break;
      case 'over_limit':
        add(r.key, 'over_limit', r.vars);
        break;
      case 'card_expiry':
        if (r.daysLeft <= days('card_expiry')) add(r.key, 'card_expiry', r.vars);
        break;
      case 'autopay_low':
        if (r.daysLeft <= days('autopay_low')) add(r.key, 'autopay_low', r.vars);
        break;
      case 'price_alert':
        add(r.key, 'price_alert', r.vars);
        break;
    }
  }
  if (on('autopay_done')) {
    const money = moneyFormatter(deps);
    for (const p of await recentAutopays(deps, userId, AUTOPAY_DONE_DAYS)) {
      add(`autopay_done:${p.statementId}`, 'autopay_done', {
        card: p.cardName,
        account: p.accountName,
        amount: money(p.amount, p.currency),
        paid: money(p.paid, p.paidCurrency),
        dueDate: p.dueDate,
      });
    }
  }
  return events.sort((x, y) => PRIORITY.indexOf(x.kind) - PRIORITY.indexOf(y.kind));
}

/** Variables every template can use. */
function commonVars(deps: Deps) {
  return { app: deps.config.get().app.name, today: today(deps), link: deps.env.ORIGINS[0] ?? '' };
}

export function renderEvent(deps: Deps, s: NotifySettings, e: NotifyEvent) {
  const vars = { ...commonVars(deps), ...e.vars };
  const rule = s.rules[e.kind];
  return {
    // Header injection guard: a subject is one line.
    subject: renderTemplate(rule.subject, vars).replace(/[\r\n]+/g, ' ').slice(0, 250),
    text: renderTemplate(rule.body, vars),
  };
}

export interface NotifyResult {
  events: number;
  sent: number;
  failed: number;
}

/** Mail the events not mailed yet (at most `max`), and log every attempt. */
export async function runNotifications(
  deps: Deps,
  userId: string,
  opts: { kinds?: NotifyKind[]; max?: number } = {},
): Promise<NotifyResult> {
  const none = { events: 0, sent: 0, failed: 0 };
  const { db, mailer } = deps;
  if (!mailer) return none;
  const s = await loadNotifySettings(db, userId);
  if (!s.enabled || !s.to || !s.from) return none;
  const events = await collectEvents(deps, userId, s, opts);
  if (events.length === 0) return none;

  const done = new Set(
    (
      await inChunks(
        events.map((e) => e.key),
        (part) =>
          db
            .select({ key: notificationLog.key })
            .from(notificationLog)
            .where(and(eq(notificationLog.userId, userId), eq(notificationLog.ok, true), inArray(notificationLog.key, part))),
      )
    ).map((r) => r.key),
  );
  const todo = [...new Map(events.filter((e) => !done.has(e.key)).map((e) => [e.key, e])).values()].slice(0, opts.max ?? MAX_SEND);
  const t = deps.now();
  const logs = await Promise.all(
    todo.map(async (e) => {
      const { subject, text } = renderEvent(deps, s, e);
      let error: string | null = null;
      try {
        await mailer({ from: s.from, fromName: s.fromName, to: s.to, subject, text });
      } catch (err) {
        error = mailError(err);
      }
      return { id: newId(t), userId, key: e.key, kind: e.kind, subject, ok: error === null, error, sentAt: t };
    }),
  );
  await runBatch(db, [
    ...chunkRows(logs).map((part) =>
      db
        .insert(notificationLog)
        .values(part)
        .onConflictDoUpdate({
          target: [notificationLog.userId, notificationLog.key],
          set: { subject: sql`excluded.subject`, ok: sql`excluded.ok`, error: sql`excluded.error`, sentAt: sql`excluded.sent_at` },
        }),
    ),
    db.delete(notificationLog).where(and(eq(notificationLog.userId, userId), lt(notificationLog.sentAt, t - LOG_DAYS * 86_400_000))),
  ]);
  const sent = logs.filter((l) => l.ok).length;
  return { events: events.length, sent, failed: logs.length - sent };
}

/** A test mail with the saved sender and recipient. */
export async function sendTestMail(deps: Deps, userId: string) {
  const s = await loadNotifySettings(deps.db, userId);
  if (!deps.mailer) return { ok: false, error: 'MAIL_NOT_CONFIGURED' };
  if (!s.to || !s.from) return { ok: false, error: 'MAIL_ADDRESS_MISSING' };
  const vars = commonVars(deps);
  try {
    await deps.mailer({
      from: s.from,
      fromName: s.fromName,
      to: s.to,
      subject: renderTemplate('【{{app}}】测试邮件', vars),
      text: renderTemplate('这是一封来自 {{app}} 的测试邮件，收到说明邮件通知已经配置好了。\n\n{{today}} · {{link}}', vars),
    });
    return { ok: true as const };
  } catch (e) {
    return { ok: false, error: mailError(e) };
  }
}
