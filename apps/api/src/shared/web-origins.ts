/**
 * P9 R7: parse WEB_ORIGINS once at boot. Every entry must be an exact `scheme://host[:port]` origin: no `*`,
 * `null`, path, query, fragment, credentials or trailing junk, and only `https:` when `requireHttps` (production).
 * Mirrors the realtime REALTIME_CORS_ORIGINS validator.
 */
export class InvalidWebOriginsError extends Error {
  constructor(detail: string) {
    super(`WEB_ORIGINS ${detail}`);
    this.name = 'InvalidWebOriginsError';
  }
}

export function parseWebOrigins(raw: string, opts: { requireHttps: boolean }): string[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (entry.includes('*')) throw new InvalidWebOriginsError(`must not contain '*': ${entry}`);
    if (entry.toLowerCase() === 'null') throw new InvalidWebOriginsError('must not contain null');
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new InvalidWebOriginsError(`has an invalid origin: ${entry}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new InvalidWebOriginsError(`must use http(s): ${entry}`);
    if (opts.requireHttps && url.protocol !== 'https:')
      throw new InvalidWebOriginsError(`must use https:// in production: ${entry}`);
    // url.origin drops path/query/fragment/credentials, so any of those (or a trailing slash) make it differ.
    if (url.origin !== entry)
      throw new InvalidWebOriginsError(
        `entries must be exact origins like https://app.example.com (no path, query, trailing slash or credentials): ${entry}`,
      );
  }
  return entries;
}
