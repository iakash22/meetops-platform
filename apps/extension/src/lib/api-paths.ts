/**
 * API route templates used by the extension. Upload and extension-auth paths come from @meetops/contracts.
 * Contracts 0.7.0 export no recording-session constant, so RECORDING_SESSION_ROUTES mirrors the API media module
 * (apps/api RECORDING_SESSION_PATHS); test/contract-paths.test.ts pins it to the API.
 */
export const RECORDING_SESSION_ROUTES = {
  init: '/orgs/:organizationId/recording-sessions',
  chunks: '/recording-sessions/:sessionId/chunks',
  complete: '/recording-sessions/:sessionId/complete',
  abort: '/recording-sessions/:sessionId/abort',
} as const;

/** Fills `:param` segments, URL-encoding each value. Throws on a missing param instead of sending a broken path. */
export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_whole, key: string) => {
    const v = params[key];
    if (v === undefined) throw new Error(`Missing path param ${key}`);
    return encodeURIComponent(v);
  });
}
