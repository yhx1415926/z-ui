import { Hono } from 'hono';
import { notifySettingsSchema, type NotifyDto, type NotifyRunDto } from '@z-ui/shared';
import { STEP_UP_MS } from '../auth/session.ts';
import type { AppBindings } from '../env.ts';
import { runAutopay } from '../lib/autopay.ts';
import { body, fail } from '../lib/http.ts';
import { loadNotifySettings, notifyLog, runNotifications, saveNotifySettings, sendTestMail } from '../lib/notify.ts';

/** Email notification settings, a test mail, and "check now" (what the daily cron does). */
export const notifyRoutes = new Hono<AppBindings>()
  .get('/', async (c) => {
    const { db, mailer } = c.var.deps;
    const userId = c.var.user.id;
    const [settings, log] = await Promise.all([loadNotifySettings(db, userId), notifyLog(db, userId)]);
    return c.json({ settings, mailer: !!mailer, log } satisfies NotifyDto);
  })

  .put('/', async (c) => {
    const next = await body(c, notifySettingsSchema);
    const { db, now } = c.var.deps;
    const userId = c.var.user.id;
    const cur = await loadNotifySettings(db, userId);
    // Redirecting the mails elsewhere needs a recent passkey/TOTP check, like other security settings.
    if (next.to !== cur.to || next.from !== cur.from) {
      const at = c.var.session.stepUpAt;
      if (!at || now() - at > STEP_UP_MS) fail(403, 'please verify again', 'STEP_UP_REQUIRED');
    }
    await saveNotifySettings(db, userId, next, now());
    return c.json({ settings: next, mailer: !!c.var.deps.mailer, log: await notifyLog(db, userId) } satisfies NotifyDto);
  })

  .post('/test', async (c) => {
    const r = await sendTestMail(c.var.deps, c.var.user.id);
    if (!r.ok) fail(r.error === 'MAIL_NOT_CONFIGURED' || r.error === 'MAIL_ADDRESS_MISSING' ? 400 : 502, r.error, r.error.startsWith('MAIL_') ? r.error : 'MAIL_FAILED');
    return c.json({ ok: true });
  })

  /** Run the daily job for this user now: automatic repayments, then the mails. */
  .post('/run', async (c) => {
    const autopaid = await runAutopay(c.var.deps, c.var.user.id);
    const r = await runNotifications(c.var.deps, c.var.user.id);
    return c.json({ ...r, autopaid: autopaid.length } satisfies NotifyRunDto);
  });
