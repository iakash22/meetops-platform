/** Plain constants and a regex check: no TypeBox, safe for `@meetops/contracts/types` (UI bundles). */

/** New passwords (signup and reset). Login stays looser so an existing password still signs in. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_POLICY_MESSAGE =
  'Use 8 or more characters with a letter, a number, and a symbol.';
/**
 * 8–128 characters, no newlines, with at least one letter, one digit, and one symbol
 * (anything that is not a letter, digit, or space).
 */
export const PASSWORD_PATTERN = '^(?=.*[A-Za-z])(?=.*\\d)(?=.*[^A-Za-z0-9\\s]).{8,128}$';

const passwordPattern = new RegExp(PASSWORD_PATTERN);

/** True when a new password meets {@link PASSWORD_PATTERN}. */
export function isAcceptablePassword(password: string): boolean {
  return passwordPattern.test(password);
}
