/** API base URL (display-only; desktop sign-in is not wired to the API yet). */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * Mocked desktop sign-in (in-memory, no server, no tokens). ADR-012 is Proposed, not signed off, so the real
 * system-browser + PKCE flow does not exist yet. The mock is ON in dev/test and OFF in production builds unless
 * `VITE_DESKTOP_MOCK_AUTH=true` is set explicitly. `VITE_DESKTOP_MOCK_AUTH=false` forces it off everywhere.
 */
export function isMockAuthEnabled(env: ImportMetaEnv = import.meta.env): boolean {
  if (env.VITE_DESKTOP_MOCK_AUTH === 'true') return true;
  if (env.VITE_DESKTOP_MOCK_AUTH === 'false') return false;
  return env.DEV === true;
}
