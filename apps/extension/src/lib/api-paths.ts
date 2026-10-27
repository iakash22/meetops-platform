import { RECORDING_SESSION_PATHS } from '@meetops/contracts/types';

/**
 * API route templates used by the extension, all from @meetops/contracts. RECORDING_SESSION_ROUTES aliases the
 * contracts 0.8.0 RECORDING_SESSION_PATHS; test/contract-paths.test.ts pins it to the API.
 */
export const RECORDING_SESSION_ROUTES = RECORDING_SESSION_PATHS;

/** Fills `:param` segments, URL-encoding each value. Throws on a missing param instead of sending a broken path. */
export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_whole, key: string) => {
    const v = params[key];
    if (v === undefined) throw new Error(`Missing path param ${key}`);
    return encodeURIComponent(v);
  });
}
