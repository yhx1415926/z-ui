import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { csrfGuard, requireAuth } from './auth/middleware.ts';
import type { AppBindings, Deps } from './env.ts';
import { accountRoutes } from './routes/accounts.ts';
import { authRoutes } from './routes/auth.ts';
import { billRoutes } from './routes/bills.ts';
import { cardRoutes } from './routes/cards.ts';
import { categoryRoutes, tagRoutes } from './routes/categories.ts';
import { configRoutes } from './routes/config.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { fxRoutes } from './routes/fx.ts';
import { institutionRoutes } from './routes/institutions.ts';
import { investRoutes } from './routes/invest.ts';
import { notifyRoutes } from './routes/notify.ts';
import { reminderRoutes } from './routes/reminders.ts';
import { setupRoutes } from './routes/setup.ts';
import { statementRoutes } from './routes/statements.ts';
import { statsRoutes } from './routes/stats.ts';
import { transactionRoutes } from './routes/transactions.ts';
import { watchRoutes } from './routes/watch.ts';

export interface AppOptions {
  /** Runtime-specific client IP lookup (socket address on Node, CF-Connecting-IP on Workers). */
  clientIp: (c: Context) => string | null;
  /** Serves the built SPA for non-API paths (production). */
  staticHandler?: MiddlewareHandler;
}

/** Every route group that requires a signed-in user. Also used by the auth-coverage test. */
export const PROTECTED_MOUNTS = {
  '/config': configRoutes,
  '/dashboard': dashboardRoutes,
  '/institutions': institutionRoutes,
  '/accounts': accountRoutes,
  '/cards': cardRoutes,
  '/categories': categoryRoutes,
  '/tags': tagRoutes,
  '/transactions': transactionRoutes,
  '/bills': billRoutes,
  '/statements': statementRoutes,
  '/reminders': reminderRoutes,
  '/stats': statsRoutes,
  '/fx': fxRoutes,
  '/invest': investRoutes,
  '/watch': watchRoutes,
  '/notify': notifyRoutes,
} as const;

export function createApp(deps: Deps, opts: AppOptions) {
  const api = new Hono<AppBindings>();
  api.use('*', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'request too large', code: 'TOO_LARGE' }, 413) }));
  api.use('*', csrfGuard);
  // /auth and /setup handle their own public vs. signed-in routes.
  api.route('/auth', authRoutes);
  api.route('/setup', setupRoutes);
  for (const [path, routes] of Object.entries(PROTECTED_MOUNTS)) {
    api.use(`${path}/*`, requireAuth);
    api.route(path, routes);
  }
  api.get('/health', (c) => c.json({ ok: true }));
  api.notFound((c) => c.json({ error: 'not found', code: 'NOT_FOUND' }, 404));

  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    c.set('ip', opts.clientIp(c));
    await next();
  });
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // antd injects <style> tags at runtime (CSS-in-JS).
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      strictTransportSecurity: deps.env.COOKIE_SECURE ? 'max-age=31536000; includeSubDomains' : false,
      xFrameOptions: 'DENY',
      referrerPolicy: 'same-origin',
      crossOriginOpenerPolicy: 'same-origin',
    }),
  );
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.route('/api', api);
  if (opts.staticHandler) app.use('*', opts.staticHandler);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error('[api] unhandled error', err);
    return c.json({ error: 'internal error', code: 'INTERNAL' }, 500);
  });
  return app;
}

export type App = ReturnType<typeof createApp>;
