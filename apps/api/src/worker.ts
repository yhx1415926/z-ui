import { drizzle } from 'drizzle-orm/d1';
import { createApp } from './app.ts';
import { DEFAULT_CONFIG } from './config/defaults.ts';
import { DbConfigStore } from './config/store.ts';
import type { DB } from './db/client.ts';
import * as schema from './db/schema.ts';
import { readEnv, type Deps } from './env.ts';
import { runScheduled } from './lib/cron.ts';
import { buildMime, type Mailer } from './lib/mail.ts';
import { newId } from './lib/id.ts';

/**
 * Cloudflare Workers entry. Static files (the SPA and the BIN lookup files) are served by
 * Workers Static Assets *without* running this code — free and not counted against the daily
 * request quota; only /api/* reaches the Worker (see wrangler.jsonc: run_worker_first).
 * Cron Triggers call scheduled() (automatic repayments, notification mails, price alerts).
 */

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Cloudflare send_email binding (Email Routing / Email Service). */
interface SendEmail {
  send(message: unknown): Promise<unknown>;
}

export interface Env {
  DB: Parameters<typeof drizzle>[0];
  /** Cloudflare rate limiting binding (optional): cheap per-IP throttle for login endpoints. */
  AUTH_LIMITER?: RateLimiter;
  /** Optional: sends the notification mails to your verified address. */
  MAILER?: SendEmail;
  [key: string]: unknown;
}

interface Instance {
  app: ReturnType<typeof createApp>;
  config: DbConfigStore;
  deps: Deps;
}

/**
 * Mail through the send_email binding: the structured message API, falling back to a raw MIME
 * EmailMessage on runtimes that only accept that.
 */
function cloudflareMailer(binding: SendEmail): Mailer {
  return async (m) => {
    try {
      await binding.send({ from: { email: m.from, name: m.fromName }, to: m.to, subject: m.subject, text: m.text });
    } catch (e) {
      // Errors with a code (E_SENDER_NOT_VERIFIED…) come from delivery itself: report them.
      if ((e as { code?: string })?.code) throw e;
      const { EmailMessage } = await import('cloudflare:email');
      await binding.send(new EmailMessage(m.from, m.to, buildMime(m, new Date(), newId())));
    }
  };
}

// One app per isolate; the config is re-read at most once a minute (see DbConfigStore).
let instance: Promise<Instance> | null = null;

async function boot(env: Env): Promise<Instance> {
  // drizzle's D1 driver exposes the same query API as the libsql one used locally.
  const db = drizzle(env.DB, { schema }) as unknown as DB;
  const config = new DbConfigStore(db, DEFAULT_CONFIG);
  await config.load();
  const limiter = env.AUTH_LIMITER;
  const deps: Deps = {
    db,
    env: readEnv({ PASSWORD_ITERATIONS: '50000', COOKIE_SECURE: 'true', TRUST_PROXY: 'true', ...(env as Record<string, string | undefined>) }),
    config,
    now: Date.now,
    limiter: limiter ? async (key) => (await limiter.limit({ key })).success : undefined,
    mailer: env.MAILER ? cloudflareMailer(env.MAILER) : undefined,
  };
  const app = createApp(deps, { clientIp: (c) => c.req.header('cf-connecting-ip') ?? null });
  return { app, config, deps };
}

function getInstance(env: Env) {
  instance ??= boot(env).catch((e) => {
    instance = null;
    throw e;
  });
  return instance;
}

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const { app, config } = await getInstance(env);
    await config.refreshIfStale();
    return app.fetch(request, env, ctx as never);
  },

  async scheduled(controller: { cron: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    const { config, deps } = await getInstance(env);
    await config.refreshIfStale();
    ctx.waitUntil(runScheduled(deps, controller.cron));
  },
};
