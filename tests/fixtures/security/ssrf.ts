/**
 * SSRF payloads from docs/12-security/test-cases.md §3 (SS-01..SS-32, PR #4).
 *
 * Usage (e.g. AI provider registry / webhook / integration URL validators):
 *   import { ssrfUrlPayloads } from '../fixtures/security/ssrf.js';
 *   it.each(ssrfUrlPayloads)('$id rejects $url', ({ url }) => expect(() => validate(url)).toThrow());
 *
 * `kind: 'url'` entries are static strings any validator must reject before connecting.
 * `kind: 'scenario'` entries need a test server, DNS or TLS setup and have no static URL.
 * `ALLOWED_HOST` stands in for a host on the allowlist; swap it in with `withAllowedHost()`.
 */
export const ALLOWED_HOST = 'allowed.example';

export type SsrfCategory =
  | 'private-ipv4'
  | 'loopback'
  | 'ip-encoding'
  | 'metadata'
  | 'ipv6'
  | 'dns'
  | 'redirect'
  | 'scheme'
  | 'host-confusion'
  | 'port'
  | 'resource-limits'
  | 'tls'
  | 'config';

export type SsrfPayload =
  | { id: string; kind: 'url'; category: SsrfCategory; urls: readonly string[]; note: string }
  | { id: string; kind: 'scenario'; category: SsrfCategory; description: string; note: string };

const A = ALLOWED_HOST;

export const ssrfPayloads: readonly SsrfPayload[] = [
  {
    id: 'SS-01',
    kind: 'url',
    category: 'private-ipv4',
    urls: ['https://10.0.0.1/'],
    note: 'Private 10/8',
  },
  {
    id: 'SS-02',
    kind: 'url',
    category: 'private-ipv4',
    urls: ['https://172.16.0.1/', 'https://172.31.255.255/'],
    note: 'Private 172.16/12',
  },
  {
    id: 'SS-03',
    kind: 'url',
    category: 'private-ipv4',
    urls: ['https://192.168.1.1/'],
    note: 'Private 192.168/16',
  },
  {
    id: 'SS-04',
    kind: 'url',
    category: 'private-ipv4',
    urls: ['https://100.64.0.1/'],
    note: 'CGNAT',
  },
  {
    id: 'SS-05',
    kind: 'url',
    category: 'loopback',
    urls: ['https://127.0.0.1/', 'https://127.1/', 'https://127.255.255.254/'],
    note: 'Loopback',
  },
  {
    id: 'SS-06',
    kind: 'url',
    category: 'ip-encoding',
    urls: ['https://2130706433/'],
    note: 'Decimal 127.0.0.1',
  },
  {
    id: 'SS-07',
    kind: 'url',
    category: 'ip-encoding',
    urls: ['https://0177.0.0.1/'],
    note: 'Octal',
  },
  {
    id: 'SS-08',
    kind: 'url',
    category: 'ip-encoding',
    urls: ['https://0x7f.0x0.0x0.0x1/', 'https://0x7f000001/'],
    note: 'Hex',
  },
  {
    id: 'SS-09',
    kind: 'url',
    category: 'loopback',
    urls: ['https://0.0.0.0/', 'https://0/'],
    note: 'Unspecified',
  },
  {
    id: 'SS-10',
    kind: 'url',
    category: 'metadata',
    urls: ['https://169.254.169.254/latest/meta-data/'],
    note: 'Cloud metadata',
  },
  {
    id: 'SS-11',
    kind: 'url',
    category: 'metadata',
    urls: ['https://metadata.google.internal/'],
    note: 'GCP metadata hostname',
  },
  { id: 'SS-12', kind: 'url', category: 'ipv6', urls: ['https://[::1]/'], note: 'IPv6 loopback' },
  {
    id: 'SS-13',
    kind: 'url',
    category: 'ipv6',
    urls: ['https://[fc00::1]/', 'https://[fd12:3456::1]/'],
    note: 'IPv6 ULA',
  },
  {
    id: 'SS-14',
    kind: 'url',
    category: 'ipv6',
    urls: ['https://[fe80::1]/'],
    note: 'IPv6 link-local',
  },
  {
    id: 'SS-15',
    kind: 'url',
    category: 'ipv6',
    urls: ['https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/'],
    note: 'IPv4-mapped',
  },
  {
    id: 'SS-16',
    kind: 'url',
    category: 'metadata',
    urls: ['https://[fd00:ec2::254]/'],
    note: 'AWS IPv6 metadata',
  },
  {
    id: 'SS-17',
    kind: 'url',
    category: 'dns',
    urls: ['https://localtest.me/'],
    note: 'DNS resolves to internal (127.0.0.1)',
  },
  {
    id: 'SS-18',
    kind: 'scenario',
    category: 'dns',
    description: 'DNS rebinding domain (TTL 0, first public then 127.0.0.1)',
    note: 'Pinned first-validated IP, or rejected; never reaches internal',
  },
  {
    id: 'SS-19',
    kind: 'scenario',
    category: 'redirect',
    description: 'Allowed host returns 302 Location: http://169.254.169.254/',
    note: 'Redirect not followed, or re-validated and rejected',
  },
  {
    id: 'SS-20',
    kind: 'scenario',
    category: 'redirect',
    description: 'Redirect chain > 3 hops',
    note: 'Rejected',
  },
  {
    id: 'SS-21',
    kind: 'url',
    category: 'scheme',
    urls: [`http://api.${A}/`],
    note: 'Non-HTTPS rejected',
  },
  {
    id: 'SS-22',
    kind: 'url',
    category: 'scheme',
    urls: ['file:///etc/passwd'],
    note: 'Scheme rejected',
  },
  {
    id: 'SS-23',
    kind: 'url',
    category: 'scheme',
    urls: ['gopher://127.0.0.1:6379/_INFO'],
    note: 'Scheme rejected',
  },
  {
    id: 'SS-24',
    kind: 'url',
    category: 'scheme',
    urls: [
      'ftp://127.0.0.1/',
      'dict://127.0.0.1:11211/',
      'ldap://127.0.0.1/',
      'data:text/plain,hello',
    ],
    note: 'Scheme rejected',
  },
  {
    id: 'SS-25',
    kind: 'url',
    category: 'host-confusion',
    urls: [`https://${A}@evil.example/`],
    note: 'Userinfo rejected; host is evil.example',
  },
  {
    id: 'SS-26',
    kind: 'url',
    category: 'host-confusion',
    urls: [`https://evil.example#@${A}`, `https://${A}.evil.example/`],
    note: 'Not on allowlist',
  },
  {
    id: 'SS-27',
    kind: 'url',
    category: 'host-confusion',
    urls: [`https://${A.toUpperCase()}./`, 'https://xn--llowed-9ua.example/'],
    note: 'Normalized; only exact allowlisted host passes',
  },
  {
    id: 'SS-28',
    kind: 'url',
    category: 'port',
    urls: [`https://${A}:6379/`],
    note: 'Rejected unless port allowlisted',
  },
  {
    id: 'SS-29',
    kind: 'scenario',
    category: 'resource-limits',
    description: 'Oversized response (> cap, e.g. 50 MB) from test server',
    note: 'Aborted at cap; job fails cleanly; memory bounded',
  },
  {
    id: 'SS-30',
    kind: 'scenario',
    category: 'resource-limits',
    description: 'Slow response (slowloris, 1 byte / 10 s)',
    note: 'Aborted at timeout',
  },
  {
    id: 'SS-31',
    kind: 'scenario',
    category: 'tls',
    description: 'TLS with invalid/self-signed cert',
    note: 'Rejected',
  },
  {
    id: 'SS-32',
    kind: 'scenario',
    category: 'config',
    description: 'Arbitrary URL in provider config by admin',
    note: 'Rejected: only registry provider ids accepted',
  },
];

/** Flattened static URL payloads, one row per URL, ready for `it.each`. */
export const ssrfUrlPayloads: readonly { id: string; url: string; category: SsrfCategory }[] =
  ssrfPayloads.flatMap((p) =>
    p.kind === 'url' ? p.urls.map((url) => ({ id: p.id, url, category: p.category })) : [],
  );

/** Payloads that need a harness (test server, DNS, TLS) rather than a static URL. */
export const ssrfScenarios = ssrfPayloads.filter(
  (p): p is Extract<SsrfPayload, { kind: 'scenario' }> => p.kind === 'scenario',
);

/** Replace the placeholder allowlisted host with the one the validator under test allows. */
export function withAllowedHost(url: string, host: string): string {
  return url
    .split(ALLOWED_HOST)
    .join(host)
    .split(ALLOWED_HOST.toUpperCase())
    .join(host.toUpperCase());
}
