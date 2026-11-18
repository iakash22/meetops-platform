/**
 * Legal page URLs come from build env (VITE_TERMS_URL / VITE_PRIVACY_URL).
 * Only absolute https URLs or same-origin paths are accepted, so we never
 * render a javascript:, http://, or protocol-relative (//) link.
 */
export function isSafeLegalUrl(u: string | undefined): u is string {
  if (!u) return false;
  if (u.startsWith('https://')) return true;
  // Same-origin path only. Reject protocol-relative "//host/..." values.
  return u.startsWith('/') && !u.startsWith('//');
}

/** Production-build warning when the Privacy Policy URL is missing or unsafe. */
export function missingPrivacyUrlWarning(privacyUrl: string | undefined): string | undefined {
  if (isSafeLegalUrl(privacyUrl)) return undefined;
  if (privacyUrl) {
    return '[web] VITE_PRIVACY_URL is unsafe; the Privacy Policy link will be omitted from this production build.';
  }
  return '[web] VITE_PRIVACY_URL is not set; the Privacy Policy link will be omitted from this production build.';
}
