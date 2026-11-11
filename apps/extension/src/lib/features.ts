/**
 * Build-time feature flags (`import.meta.env.WXT_FEATURE_<X>`, defined in wxt.config.ts).
 *
 * Most flags default to off; only the literal strings `true` / `1` (or a boolean true) turn one on.
 * `WXT_FEATURE_HTTP_UPLOAD` is the exception: when unset it is on in development builds and off in
 * production builds and in tests (see httpUploadEnabled).
 */
export function flagEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/** Explicit off: boolean false or the strings `false` / `0`. */
export function flagDisabled(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === 'false' || v === '0';
}

type Env = Record<string, string | boolean | undefined>;

function isTestEnv(env: Env): boolean {
  if (env.VITEST === true || env.VITEST === 'true') return true;
  if (env.NODE_ENV === 'test') return true;
  return String(env.MODE ?? '') === 'test';
}

function isDevEnv(env: Env): boolean {
  if (env.DEV === true || env.DEV === 'true') return true;
  return String(env.MODE ?? '') === 'development';
}

/**
 * WXT_FEATURE_HTTP_UPLOAD: use HttpUploadClient instead of StubUploadClient.
 *
 * Resolution:
 * - explicit `true` / `1` → on in every mode
 * - explicit `false` / `0` → off in every mode
 * - unset / empty:
 *   - tests (`MODE=test`, `VITEST`, `NODE_ENV=test`) → off (StubUploadClient, deterministic)
 *   - development builds (`wxt`, `wxt build --mode development`) → on
 *   - production builds (`wxt build`) → off (same as before this default)
 * - any other value → off
 */
export function httpUploadEnabled(env: Env = import.meta.env): boolean {
  const raw = env.WXT_FEATURE_HTTP_UPLOAD;
  if (flagEnabled(raw)) return true;
  if (flagDisabled(raw)) return false;
  if (typeof raw === 'string' && raw.trim() !== '') return false;
  if (isTestEnv(env)) return false;
  return isDevEnv(env);
}

/**
 * WXT_FEATURE_DIRECT_UPLOAD: upload a finished recording as one file through `POST /orgs/:org/uploads` (DirectUploadClient)
 * while the chunked recording-session routes are not served. Requires a paired token.
 */
export function directUploadEnabled(env: Env = import.meta.env): boolean {
  return flagEnabled(env.WXT_FEATURE_DIRECT_UPLOAD);
}
