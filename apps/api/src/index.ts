import { pathToFileURL } from 'node:url';
import { createServer } from './server.js';
import { printStartupBanner } from './shared/startup-banner.js';

export { createServer } from './server.js';
export type { ModuleDeps } from './modules/index.js';

/** Bootstrap only when executed directly (node dist/index.js); importing has no side effects. */
export async function start() {
  // Plain console so progress shows even before Fastify logger is ready (tsx cold start can take 30–90s+).
  console.log('[api] loading modules…');
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';
  const app = createServer();
  console.log(`[api] binding ${host}:${port}…`);
  try {
    const address = await app.listen({ port, host });
    app.log.info({ address }, 'API server started');

    // Probe the same readiness checks as GET /ready (database SELECT 1, redis PING).
    let ready = true;
    let checks: Record<string, string> = {};
    try {
      const res = await app.inject({ method: 'GET', url: '/ready' });
      const body = res.json() as {
        status?: string;
        checks?: Record<string, string>;
      };
      checks = body.checks ?? {};
      ready = res.statusCode === 200 && body.status !== 'not_ready';
    } catch (err) {
      ready = false;
      app.log.warn({ err }, 'startup readiness probe failed');
    }

    printStartupBanner({
      address: typeof address === 'string' ? address : `http://${host}:${port}`,
      nodeEnv: process.env.NODE_ENV,
      webBaseUrl: process.env.WEB_BASE_URL,
      version: '0.0.0',
      ready,
      checks,
      env: process.env,
    });

    app.log.info(
      {
        startup: {
          address,
          ready,
          checks,
          mediaStorage: process.env.MEDIA_STORAGE_ENABLED,
          authMailQueue: process.env.AUTH_MAIL_QUEUE ?? 'inline',
          desktopAuth: process.env.DESKTOP_AUTH_ENABLED === 'true',
        },
      },
      'MeetOps API startup banner',
    );

    // Graceful shutdown: app.close() runs the onClose hooks that disconnect Prisma and quit Redis.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        app.log.info({ signal }, 'Shutting down API server');
        app.close().then(
          () => process.exit(0),
          (err: unknown) => {
            app.log.error({ err }, 'Error during shutdown');
            process.exit(1);
          },
        );
      });
    }
  } catch (err) {
    app.log.error({ err }, 'Failed to start API server');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start();
}
