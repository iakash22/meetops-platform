import { resolvePrivacyUrl } from './privacy-url';

export function PrivacyPolicyLink({
  url,
  webOrigin,
  className = 'mo-privacy-link',
}: {
  url?: string | undefined;
  webOrigin?: string | undefined;
  className?: string;
}) {
  const href = resolvePrivacyUrl(
    url ?? (import.meta.env as { WXT_PRIVACY_URL?: string }).WXT_PRIVACY_URL,
    webOrigin ?? (import.meta.env as { WXT_WEB_ORIGIN?: string }).WXT_WEB_ORIGIN,
  );
  if (!href) return null;
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      Privacy Policy
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
