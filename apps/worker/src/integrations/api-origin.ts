/** Fallback for INTEGRATIONS_API_ORIGIN (the local API), used only when NODE_ENV is exactly development or test. */
export const DEV_INTEGRATIONS_API_ORIGIN = 'http://localhost:4000';

/** Startup error for a missing or unusable INTEGRATIONS_API_ORIGIN. Names the key only. */
export class IntegrationsApiOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationsApiOriginError';
  }
}

/** Exactly `development` or `test` (no trimming or case folding): everything else is treated as production. */
export function isLocalNodeEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/**
 * Public API origin the OAuth redirect URIs are built from (they must match what the API registered with the
 * provider). Fails closed: unless NODE_ENV is exactly `development` or `test`, it is required and must be a bare
 * https origin, with no localhost default. That covers production and also staging, `prod`, `Production`, an unset
 * NODE_ENV or any other value, so a misconfigured deploy fails at startup instead of building localhost redirect
 * URIs. Only development and test fall back to the local API.
 */
export function integrationsApiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.INTEGRATIONS_API_ORIGIN?.trim().replace(/\/+$/, '');
  if (isLocalNodeEnv(env.NODE_ENV)) return raw || DEV_INTEGRATIONS_API_ORIGIN;
  if (!raw)
    throw new IntegrationsApiOriginError(
      'INTEGRATIONS_API_ORIGIN is required when NODE_ENV=production (or any NODE_ENV other than development/test): ' +
        'set it to the public https origin of the API (for example https://api.example.com); there is no ' +
        'localhost default outside development and test',
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
      'INTEGRATIONS_API_ORIGIN must use https outside NODE_ENV=development/test',
    );
  if (url.origin !== raw)
    throw new IntegrationsApiOriginError(
      'INTEGRATIONS_API_ORIGIN must be a bare origin (scheme://host[:port], no path, query or credentials)',
    );
  return url.origin;
}
