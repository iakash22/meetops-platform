export {
  ExtensionAuthService,
  type ExtensionAuthLog,
  type ExtensionRevoker,
  EXTENSION_LIMITS,
  PAIRING_CODE_TTL_MS,
} from './application/extension-auth.service.js';
export { extensionAuthRoutes } from './http/extension-auth.routes.js';
export { makeExtensionBearerGuard } from './http/bearer-guard.js';
export type { ExtensionTokenRepository } from './domain/extension-token.js';
export { InMemoryExtensionTokenRepository } from './infrastructure/in-memory-extension-token.repository.js';
export { RedisExtensionTokenRepository } from './infrastructure/redis-extension-token.repository.js';
export { DurableExtensionTokenRepository } from './infrastructure/durable-extension-token.repository.js';
