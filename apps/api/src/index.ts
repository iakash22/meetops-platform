import { pathToFileURL } from 'node:url';
import { createServer } from './server.js';

export { createServer } from './server.js';
export type { ModuleDeps } from './modules/index.js';

/** Bootstrap only when executed directly (node dist/index.js); importing has no side effects. */
export async function start() {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';
  const app = createServer();
  try {
    const address = await app.listen({ port, host });
    app.log.info({ address }, 'API server started');
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
