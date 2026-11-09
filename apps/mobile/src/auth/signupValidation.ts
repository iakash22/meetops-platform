import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_POLICY_MESSAGE,
  isAcceptablePassword,
  type SignupRequest,
} from '@meetops/contracts';

import { EMAIL_MAX_LENGTH } from './validation';

/** Limits mirror `SignupRequest` in `@meetops/contracts`. */
export const NAME_MAX_LENGTH = 200;
export { PASSWORD_MIN_LENGTH };

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
  else if (password.length > PASSWORD_MAX_LENGTH) errors.password = 'Password is too long.';
  else if (!isAcceptablePassword(password)) errors.password = PASSWORD_POLICY_MESSAGE;

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    request: { name, email, password },
  };
}

export type PasswordStrength = 'too-short' | 'weak' | 'fair' | 'strong';

/** Advisory meter. The enforced rule is {@link isAcceptablePassword}. */
export function passwordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too-short';
  if (!isAcceptablePassword(password)) return 'weak';
  const mixedCase = /[a-z]/.test(password) && /[A-Z]/.test(password);
  return mixedCase && password.length >= 12 ? 'strong' : 'fair';
}
