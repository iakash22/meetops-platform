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
  } catch (err) {
    app.log.error({ err }, 'Failed to start API server');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start();
}
