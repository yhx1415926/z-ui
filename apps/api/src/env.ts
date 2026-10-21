import type { ConfigStore } from './config/store.ts';
import type { DB } from './db/client.ts';
import type * as schema from './db/schema.ts';
import type { Mailer } from './lib/mail.ts';

export interface AppEnv {
  /** 32-byte key (base64) for encrypting card numbers and TOTP secrets. Back it up! */
  APP_ENC_KEY: string;
  /** Server-side secret mixed into password hashes. */
  SESSION_PEPPER: string;
  /** WebAuthn relying-party id: "localhost" locally, your domain in production. */
  RP_ID: string;
  RP_NAME: string;
  /** Allowed browser origins (comma separated), e.g. "http://localhost:5173,http://localhost:8787". */
  ORIGINS: string[];
  /** Send cookies with Secure + __Host- prefix. Must be true behind HTTPS. */
  COOKIE_SECURE: boolean;
  /** Trust X-Forwarded-For / CF-Connecting-IP for the client IP. */
  TRUST_PROXY: boolean;
  /** One-time first-run setup link secret (/setup/<token>); unset disables the setup flow. */
  SETUP_TOKEN?: string;
  /** PBKDF2 cost for new password hashes. Lower on Cloudflare's free plan (10 ms CPU per request). */
  PASSWORD_ITERATIONS: number;
  /** Optional Finnhub API key for stock quotes (falls back to Yahoo Finance without it). */
  FINNHUB_API_KEY?: string;
}

export type UserRow = typeof schema.users.$inferSelect;
export type SessionRow = typeof schema.sessions.$inferSelect;

export interface Deps {
  db: DB;
  env: AppEnv;
  config: ConfigStore;
  now: () => number;
  /** Cheap edge rate limiter (Cloudflare rate limiting binding); false = over the limit. */
  limiter?: (key: string) => Promise<boolean>;
  /** Outbound HTTP (FX rates, stock quotes); replaceable in tests. */
  fetch?: typeof fetch;
  /** Sends notification mails (Cloudflare send_email binding); absent = mail is off. */
  mailer?: Mailer;
}

export type AppBindings = {
  Variables: {
    deps: Deps;
    user: UserRow;
    session: SessionRow;
    ip: string | null;
  };
};

export function readEnv(source: Record<string, string | undefined>): AppEnv {
  const required = (k: string) => {
    const v = source[k];
    if (!v) throw new Error(`Missing required environment variable ${k} — set it in .env at the repository root (template: .env.example)`);
    return v;
  };
  return {
    APP_ENC_KEY: required('APP_ENC_KEY'),
    SESSION_PEPPER: required('SESSION_PEPPER'),
    RP_ID: source.RP_ID || 'localhost',
    RP_NAME: source.RP_NAME || 'Z-UI',
    ORIGINS: (source.ORIGINS || 'http://localhost:5173,http://localhost:8787')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    COOKIE_SECURE: (source.COOKIE_SECURE ?? 'false') === 'true',
    TRUST_PROXY: (source.TRUST_PROXY ?? 'false') === 'true',
    SETUP_TOKEN: source.SETUP_TOKEN || undefined,
    // 50k (~3.5 ms) fits the Workers Free CPU budget; the same default locally keeps exported
    // hashes usable there. Hashes with another cost are rewritten at the next password login.
    PASSWORD_ITERATIONS: Math.min(100_000, Math.max(10_000, Number(source.PASSWORD_ITERATIONS) || 50_000)),
    FINNHUB_API_KEY: source.FINNHUB_API_KEY || undefined,
  };
}
