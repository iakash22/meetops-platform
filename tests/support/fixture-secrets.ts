import { randomBytes } from 'node:crypto';

const cache = new Map<string, string>();

/**
 * Per-process random fixture password, stable for one label within a test run.
 * Generated at runtime so no credential-like literal is committed.
 */
export function fixturePassword(label: string): string {
  let value = cache.get(label);
  if (!value) {
    // Letter, digit, and symbol are required by the signup/reset password policy.
    value = `${label}-A1!${randomBytes(9).toString('base64url')}`;
    cache.set(label, value);
  }
  return value;
}
