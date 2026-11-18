/**
 * Legal page URLs come from build env (VITE_TERMS_URL / VITE_PRIVACY_URL).
 * Only absolute https URLs or same-origin paths are accepted, so we never
 * render a javascript: or http:// link.
 */
export function isSafeLegalUrl(u: string | undefined): u is string {
  return !!u && /^(https:\/\/|\/)/.test(u);
}

/** Production-build warning when the Privacy Policy URL is missing or unsafe. */
export function missingPrivacyUrlWarning(privacyUrl: string | undefined): string | undefined {
  if (isSafeLegalUrl(privacyUrl)) return undefined;
  return '[web] VITE_PRIVACY_URL is not set; the Privacy Policy link will be omitted from this production build.';
}
