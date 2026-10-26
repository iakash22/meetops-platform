/**
 * Build-time feature flags (`import.meta.env.WXT_FEATURE_<X>`, defined in wxt.config.ts). Every flag defaults to off;
 * only the literal strings `true` / `1` (or a boolean true) turn one on.
 */
export function flagEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === 'true' || v === '1';
}

type Env = Record<string, string | boolean | undefined>;

/** WXT_FEATURE_HTTP_UPLOAD: use HttpUploadClient instead of the default StubUploadClient. */
export function httpUploadEnabled(env: Env = import.meta.env): boolean {
  return flagEnabled(env.WXT_FEATURE_HTTP_UPLOAD);
}

/**
 * WXT_FEATURE_DIRECT_UPLOAD: upload a finished recording as one file through `POST /orgs/:org/uploads` (DirectUploadClient)
 * while the chunked recording-session routes are not served. Requires a paired token.
 */
export function directUploadEnabled(env: Env = import.meta.env): boolean {
  return flagEnabled(env.WXT_FEATURE_DIRECT_UPLOAD);
}
