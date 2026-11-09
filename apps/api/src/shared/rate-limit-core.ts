import { DomainError } from './domain-error.js';

/**
 * Platform rate-limit primitives (ADR-001 modular monolith): the port, its two errors and the client-IP key rule.
 * Shared code (guarded-limit.ts, rate-limits.ts, http-errors.ts) depends on this file instead of reaching into the
 * auth or media modules; those modules re-export these names so their existing imports keep working.
 */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

/** Fixed-window counter. Redis adapter in production, in-memory in tests. */
export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export class RateLimitedError extends DomainError {
  constructor(public readonly retryAfterMs: number) {
    super('RATE_LIMITED', 'Too many requests, try again later', 429);
  }
}

/** Retry-After sent when the limiter backend (Redis) is unreachable. */
export const RATE_LIMITER_UNAVAILABLE_RETRY_AFTER_MS = 5_000;

/** The limiter could not be consulted: fail closed (503 + Retry-After), never let the request through unmetered. */
export class RateLimiterUnavailableError extends DomainError {
  constructor(public readonly retryAfterMs: number = RATE_LIMITER_UNAVAILABLE_RETRY_AFTER_MS) {
    super('PROVIDER_UNAVAILABLE', 'Service temporarily unavailable, try again later', 503);
  }
}

/**
 * Backstop for a limiter call that never settles (e.g. a Redis that accepts the connection but never answers).
 * Slightly above the ioredis commandTimeout (REDIS_COMMAND_TIMEOUT_MS) so the client's own timeout normally fires first.
 */
export const RATE_LIMITER_TIMEOUT_MS = 1_500;

/**
 * The client-IP part of a per-IP bucket key (#453 Architecture review, OIDC review N-3). A request without a resolved
 * client IP (requestMeta().ip null) cannot be metered per IP. Pooling all of them into one shared `unknown` bucket
 * would let a single such caller exhaust the budget of every other one, so the request is refused instead: fail
 * closed with 503 + Retry-After, like a limiter outage. Behind the TRUST_PROXY allowlist every real request has an IP.
 */
export function clientIpKey(ip: string | null | undefined): string {
  if (!ip) throw new RateLimiterUnavailableError();
  return ip;
}
