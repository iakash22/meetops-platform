/** Dev-only fallback for INTEGRATIONS_API_ORIGIN (the local API). Never used under NODE_ENV=production. */
export const DEV_INTEGRATIONS_API_ORIGIN = 'http://localhost:4000';

/** Startup error for a missing or unusable INTEGRATIONS_API_ORIGIN. Names the key only. */
export class IntegrationsApiOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationsApiOriginError';
  }
}

/**
 * Public API origin the OAuth redirect URIs are built from (they must match what the API registered with the
 * provider). Under NODE_ENV=production it is required and must be a bare https origin; there is no localhost
 * default, so a misconfigured worker fails at startup instead of refreshing against the wrong redirect URI.
 * Outside production an unset value falls back to the local API.
 */
export function integrationsApiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.INTEGRATIONS_API_ORIGIN?.trim().replace(/\/+$/, '');
  const production = env.NODE_ENV?.trim() === 'production';
  if (!production) return raw || DEV_INTEGRATIONS_API_ORIGIN;
  if (!raw)
    throw new IntegrationsApiOriginError(
      'INTEGRATIONS_API_ORIGIN is required when NODE_ENV=production: set it to the public https origin of the API ' +
        '(for example https://api.example.com); there is no localhost default in production',
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IntegrationsApiOriginError(
      'INTEGRATIONS_API_ORIGIN must be an absolute https origin such as https://api.example.com',
    );
  }
  if (url.protocol !== 'https:')
    throw new IntegrationsApiOriginError(
      'INTEGRATIONS_API_ORIGIN must use https when NODE_ENV=production',
    );
  if (url.origin !== raw)
    throw new IntegrationsApiOriginError(
      'INTEGRATIONS_API_ORIGIN must be a bare origin (scheme://host[:port], no path, query or credentials)',
    );
  return url.origin;
}
