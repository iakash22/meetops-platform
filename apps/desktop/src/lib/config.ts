/** API base URL (display-only; desktop sign-in is not wired to the API yet). */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

/**
 * Mocked desktop sign-in (in-memory, no server, no tokens). ADR-012 is not signed off, so the real
 * system-browser + PKCE flow does not exist yet. HARD-OFF outside dev: no env var can enable it in a
 * production build. In dev, `VITE_DESKTOP_MOCK_AUTH=false` turns it off.
 */
export function isMockAuthEnabled(env: ImportMetaEnv = import.meta.env): boolean {
  if (!env.DEV) return false;
  return env.VITE_DESKTOP_MOCK_AUTH !== 'false';
}

/**
 * ADR-012 browser sign-in (system browser + PKCE + loopback, tokens in the OS keychain on the Rust side). Off by
 * default: it only turns on inside the Tauri shell with `VITE_DESKTOP_BROWSER_AUTH=true`, once ADR-012 is signed off
 * and the Rust auth commands ship.
 */
export function isBrowserAuthEnabled(
  env: ImportMetaEnv = import.meta.env,
  inTauri: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
): boolean {
  return inTauri && env.VITE_DESKTOP_BROWSER_AUTH === 'true';
}
