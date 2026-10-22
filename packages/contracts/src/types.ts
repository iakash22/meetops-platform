/**
 * Light entry: `@meetops/contracts/types`. It holds TypeScript types (erased at compile time) plus plain `as const`
 * constants (enum value arrays, error codes, TTLs, endpoint paths, REDACT_KEYS). It has **no runtime TypeBox import**,
 * so bundles such as `apps/extension` stay small. Import schemas for validation from the main entry instead.
 */
export * from './constants.js';
export type * from './index.js';
