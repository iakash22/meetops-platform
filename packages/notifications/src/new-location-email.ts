/**
 * ADR-014 `auth.new_location_signin` email. City/country are third-party GeoIP text (contracts GeoName already rejects
 * control/CRLF/bidi characters and `<`, `>`), and are still HTML-escaped here; the subject never contains them (header
 * injection). No IP address. The link goes to the signed-in sessions page: revoking there needs an authenticated
 * session + CSRF. There is no one-click token and no session id in the URL.
 */
export interface NewLocationEmailInput {
  webBaseUrl: string;
  geoCity: string | null;
  geoCountry: string | null;
  reason: 'new_region' | 'new_country';
}

export const NEW_LOCATION_EMAIL_SUBJECT = 'New sign-in to your MeetOps account';
export const SESSIONS_PAGE_PATH = '/settings/sessions';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
/** Plain text: drop anything that could break lines or direction even if upstream validation regressed. */
const UNSAFE_PLAIN_CLASS =
  '[\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069]';
// eslint-disable-next-line no-control-regex -- intentional: strip control characters
const UNSAFE_PLAIN = new RegExp(UNSAFE_PLAIN_CLASS, 'g');
const plain = (s: string) => s.replace(UNSAFE_PLAIN, ' ');

export function sessionsPageUrl(webBaseUrl: string): string {
  const u = new URL(SESSIONS_PAGE_PATH, webBaseUrl);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost')
    throw new Error('webBaseUrl must be https');
  return u.toString();
}

export function renderNewLocationEmail(i: NewLocationEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const where =
    [i.geoCity, i.geoCountry].filter((v): v is string => !!v).join(', ') || 'a new location';
  const url = sessionsPageUrl(i.webBaseUrl);
  const kind = i.reason === 'new_country' ? 'a country' : 'a region';
  const text = [
    `Your account was just signed in from ${kind} we have not seen for you before: ${plain(where)} (approximate).`,
    '',
    `If this was not you, sign in and revoke the session: ${url}`,
    '',
    'IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0.',
  ].join('\n');
  const html =
    `<p>Your account was just signed in from ${kind} we have not seen for you before: ` +
    `<strong>${escapeHtml(where)}</strong> (approximate).</p>` +
    `<p>If this was not you, <a href="${escapeHtml(url)}">sign in and revoke the session</a>.</p>` +
    `<p style="font-size:12px;color:#666">IP geolocation by <a href="https://db-ip.com">DB-IP</a>, CC BY 4.0.</p>`;
  return { subject: NEW_LOCATION_EMAIL_SUBJECT, text, html };
}
