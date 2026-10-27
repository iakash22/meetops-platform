# Phase 6 notes

## A1.5 log redaction at any depth (feat/redact-keys-any-depth)

- pino `redact.paths` (fast-redact) cannot do arbitrary depth: `*` matches one level, so `*.token` misses `a.b.token`
  (pinned by a test in packages/logger). `@meetops/logger` now runs a key walker (`redactDeep`) from
  `formatters.log`, and on child bindings (pino skips `formatters.bindings` for children, so `child()` is wrapped).
- Defaults: keys matched case-insensitively; value replaced with `***redacted***`; maxDepth 10 and 2000 nodes per log
  call (beyond either: `[Truncated]`); cycles become `[Circular]`. Walks plain objects, arrays and Errors only; other
  class instances (Fastify req/reply, Dates, Buffers) are left to pino serializers, and the fast-redact header paths
  stay as the backstop for serialized headers.
- `@meetops/logger` does not depend on contracts (that would change the lockfile). Its `DEFAULT_REDACT_KEYS` is a
  superset of contracts `REDACT_KEYS` (asserted in apps/api/test/log-redaction.test.ts), and api, worker and realtime
  pass `REDACT_KEYS` via the new `redactKeys` option. Realtime's Fastify now uses the redacting logger
  (`loggerInstance`) instead of `logger: true`; the worker uses `apps/worker/src/logger.ts`.
