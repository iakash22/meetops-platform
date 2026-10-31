/** Pure guards for the opt-in GitHub App e2e (unit-tested in e2e-guard.test.ts). */

const THROWAWAY_SEGMENTS = new Set(['e2e', 'throwaway']);

/**
 * True when `owner/repo` is safe to write to: the repo name starts or ends with a whole `e2e`/`throwaway`
 * segment (split on - _ .), e.g. `e2e-foo`, `foo-e2e`, `throwaway-bar`; or the repo is in the allowlist.
 * A middle segment (`prod-e2e-svc`) or a substring (`prode2e`) does not count.
 */
export function isThrowawayRepo(fullName: string, allowlistCsv = ''): boolean {
  const lower = fullName.trim().toLowerCase();
  const allow = allowlistCsv
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (allow.includes(lower)) return true;
  const parts = lower.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const segs = parts[1].split(/[-_.]/).filter(Boolean);
  if (segs.length === 0) return false;
  return THROWAWAY_SEGMENTS.has(segs[0]!) || THROWAWAY_SEGMENTS.has(segs[segs.length - 1]!);
}

/** Key source: the PEM file by default; the inline env PEM only with MEETOPS_GITHUB_E2E_USE_ENV_KEY=1. */
export function selectKeySource(
  env: Record<string, string | undefined>,
): { kind: 'file'; path: string } | { kind: 'env' } | null {
  if (env.MEETOPS_GITHUB_E2E_USE_ENV_KEY === '1')
    return env.GITHUB_APP_PRIVATE_KEY ? { kind: 'env' } : null;
  return env.GITHUB_APP_PRIVATE_KEY_FILE
    ? { kind: 'file', path: env.GITHUB_APP_PRIVATE_KEY_FILE }
    : null;
}
