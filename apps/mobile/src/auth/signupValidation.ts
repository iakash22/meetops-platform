import type { SignupRequest } from '@meetops/contracts';

import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from './validation';

/** Limits mirror `SignupRequest` in `@meetops/contracts` (name 1..200, email max 320, password 12..128). */
export const NAME_MAX_LENGTH = 200;
export const PASSWORD_MIN_LENGTH = 12;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SignupFieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

export interface SignupInput {
  name: string;
  email: string;
  password: string;
}

export function validateSignup(input: SignupInput): {
  ok: boolean;
  errors: SignupFieldErrors;
  request: SignupRequest;
} {
  const name = input.name.trim();
  const email = input.email.trim();
  const { password } = input;
  const errors: SignupFieldErrors = {};

  if (name.length === 0) errors.name = 'Enter your name.';
  else if (name.length > NAME_MAX_LENGTH)
    errors.name = `Use at most ${NAME_MAX_LENGTH} characters.`;

  if (email.length === 0) errors.email = 'Enter your email address.';
  else if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email))
    errors.email = 'Enter a valid email address.';

  if (password.length === 0) errors.password = 'Create a password.';
  else if (password.length < PASSWORD_MIN_LENGTH)
    errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  else if (password.length > PASSWORD_MAX_LENGTH) errors.password = 'Password is too long.';

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    request: { name, email, password },
  };
}

export type PasswordStrength = 'too-short' | 'weak' | 'fair' | 'strong';

/**
 * Advisory strength meter (docs/references.md section 5). Only length is enforced (12..128, contracts); variety and
 * length beyond the minimum raise the level.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too-short';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const score = classes + (password.length >= 16 ? 1 : 0) + (password.length >= 20 ? 1 : 0);
  if (score >= 4) return 'strong';
  if (score >= 2) return 'fair';
  return 'weak';
}
