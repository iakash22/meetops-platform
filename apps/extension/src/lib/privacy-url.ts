/**
 * Privacy Policy URL from WXT_PRIVACY_URL. Absolute https URLs are used as-is;
 * same-origin paths are resolved against WXT_WEB_ORIGIN so the link opens on
 * the web app. Other schemes (javascript:, http://) and protocol-relative\n * (//) values are rejected.
 */
export function isSafePrivacyUrl(u: string | undefined): u is string {
  if (!u) return false;
  if (u.startsWith('https://')) return true;
  // Same-origin path only. Reject protocol-relative "//host/..." values.
  return u.startsWith('/') && !u.startsWith('//');
}

export function resolvePrivacyUrl(
  raw: string | undefined,
  webOrigin: string | undefined,
): string | undefined {
  if (!isSafePrivacyUrl(raw)) return undefined;
  if (raw.startsWith('/')) {
    const origin = (webOrigin ?? '').replace(/\/$/, '');
    if (!origin) return undefined;
    return `${origin}${raw}`;
  }
  return raw;
}

/** Production-build warning when the Privacy Policy URL is missing or unsafe. */
export function missingPrivacyUrlWarning(raw: string | undefined): string | undefined {
  if (isSafePrivacyUrl(raw)) return undefined;
  if (raw) {
    return '[extension] WXT_PRIVACY_URL is unsafe; the Privacy Policy link will be omitted from this production build.';
  }
  return '[extension] WXT_PRIVACY_URL is not set; the Privacy Policy link will be omitted from this production build.';
}
