import { pathToFileURL } from 'node:url';
import { createLogger } from '@meetops/logger';
import { loadRealtimeConfig } from './config.js';
import { createRealtimeServer, denyAllVerifier } from './server.js';

export * from './config.js';
export * from './events.js';
export * from './server.js';

async function main(): Promise<void> {
  const log = createLogger({ name: 'realtime' });
  const config = loadRealtimeConfig();
  // TODO: replace placeholders with real session verification and meeting ownership lookup.
  const { app } = await createRealtimeServer({
    config,
    verifySession: denyAllVerifier,
    canAccessMeeting: () => false,
    logger: true
  });
  await app.listen({ host: config.host, port: config.port });
  log.info({ port: config.port, redis: Boolean(config.redisUrl) }, 'realtime listening');
  const stop = () => void app.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
