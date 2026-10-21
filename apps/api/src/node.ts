import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Context, MiddlewareHandler } from 'hono';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { DEFAULT_CONFIG } from './config/defaults.ts';
import { DbConfigStore } from './config/store.ts';
import { openLibsql } from './db/client.ts';
import { readEnv, type Deps } from './env.ts';
import { runDaily, runPriceWatch } from './lib/cron.ts';

/** Local (Node) entry point: SQLite file via libsql, config file + git, optional built SPA. */

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Load .env from the repo root. On a fresh install (no .env, no database yet) it is created
 * from .env.example with new random secrets. If a database already exists, a missing .env is
 * an error: a new APP_ENC_KEY could not decrypt the card numbers already stored.
 */
export function loadDotEnv() {
  const file = resolve(REPO_ROOT, '.env');
  if (!existsSync(file) && !process.env.APP_ENC_KEY) {
    const url = process.env.DATABASE_URL;
    const dbFile = url ? (url.startsWith('file:') ? url.slice(5) : null) : resolve(REPO_ROOT, 'data/z-ui.db');
    if (dbFile && existsSync(dbFile)) {
      throw new Error(
        `${file} is missing but the database ${dbFile} already exists.\n` +
          'Restore .env (APP_ENC_KEY, SESSION_PEPPER) from your backup — new keys would make stored card numbers and passwords unusable.',
      );
    }
    const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const template = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8')
      .replace(/^APP_ENC_KEY=.*$/m, `APP_ENC_KEY=${secret()}`)
      .replace(/^SESSION_PEPPER=.*$/m, `SESSION_PEPPER=${secret()}`);
    writeFileSync(file, template, { mode: 0o600 });
    console.warn(`[env] created ${file} with new random secrets — back up APP_ENC_KEY somewhere safe.`);
  }
  if (existsSync(file)) process.loadEnvFile(file);
}

export function defaultDbUrl() {
  const dir = resolve(REPO_ROOT, 'data');
  mkdirSync(dir, { recursive: true });
  return `file:${resolve(dir, 'z-ui.db')}`;
}

function clientIp(trustProxy: boolean) {
  return (c: Context): string | null => {
    if (trustProxy) {
      const fwd = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (fwd) return fwd;
    }
    try {
      return getConnInfo(c).remote.address ?? null;
    } catch {
      return null;
    }
  };
}

/** Serve apps/web/dist with SPA fallback to index.html. */
function spa(distDir: string): MiddlewareHandler {
  const isFile = (p: string) => {
    try {
      return statSync(join(distDir, p)).isFile();
    } catch {
      return false;
    }
  };
  return serveStatic({
    root: relative(process.cwd(), distDir) || '.',
    // Unknown paths are client-side routes: answer with index.html.
    rewriteRequestPath: (p) => (isFile(p) ? p : '/index.html'),
  });
}

/**
 * Stand-in for the Cloudflare Cron Triggers: the daily job (automatic repayments; no mails
 * locally) once per local day, and price alerts every 30 minutes while US markets are open.
 */
function localCron(deps: Deps) {
  let lastDay = '';
  const tick = async () => {
    const now = new Date();
    const day = now.toDateString();
    if (day !== lastDay) {
      lastDay = day;
      await runDaily(deps);
    }
    const h = now.getUTCHours();
    if (now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && h >= 13 && h <= 21) await runPriceWatch(deps);
  };
  const run = () => void tick().catch((e) => console.error('[cron]', e));
  setTimeout(run, 5_000).unref();
  setInterval(run, 30 * 60_000).unref();
}

export async function main() {
  loadDotEnv();
  const env = readEnv(process.env);
  const production = process.env.NODE_ENV === 'production';
  const db = await openLibsql(process.env.DATABASE_URL ?? defaultDbUrl());
  const config = new DbConfigStore(db, DEFAULT_CONFIG);
  await config.load();

  const distDir = resolve(REPO_ROOT, 'apps/web/dist');
  const staticHandler = production && existsSync(distDir) ? spa(distDir) : undefined;
  if (production && !staticHandler) console.warn('[api] apps/web/dist not found — run `npm run build` first');

  const deps: Deps = { db, env, config, now: Date.now };
  const app = createApp(deps, { clientIp: clientIp(env.TRUST_PROXY), staticHandler });
  localCron(deps);
  const port = Number(process.env.PORT ?? 8787);
  // Listen on loopback only by default; expose deliberately (HOST=0.0.0.0) behind HTTPS.
  const hostname = process.env.HOST ?? '127.0.0.1';
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.info(`[api] listening on http://${hostname}:${info.port}${staticHandler ? ' (serving web/dist)' : ''}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
