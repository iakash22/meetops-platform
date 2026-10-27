import { pathToFileURL } from 'node:url';
import { loadRealtimeConfig } from './config.js';
import { createRealtimeLogger, createRealtimeServer } from './server.js';

export * from './config.js';
export * from './events.js';
export * from './server.js';
export * from './handshake.js';
export * from './control-events.js';

async function main(): Promise<void> {
  const log = createRealtimeLogger();
  const config = loadRealtimeConfig();
  // ADR-011: real, read-only session verification (BE-6) and an org-scoped meeting lookup under RLS.
  // denyAllVerifier stays exported for tests only.
  const { verifySession } = await import('@meetops/session-verifier');
  const { createPrismaMeetingAccess } = await import('./meeting-access.js');
  const { app } = await createRealtimeServer({
    config,
    verifySession,
    canAccessMeeting: createPrismaMeetingAccess(),
    logger: true,
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
