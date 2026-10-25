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
  confirm?: string;
}

export interface SignupInput {
  name: string;
  email: string;
  password: string;
  confirm: string;
}

export function validateSignup(input: SignupInput): {
  ok: boolean;
  errors: SignupFieldErrors;
  request: SignupRequest;
} {
  const name = input.name.trim();
  const email = input.email.trim();
  const { password, confirm } = input;
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

  if (confirm.length === 0) errors.confirm = 'Confirm your password.';
  else if (confirm !== password) errors.confirm = 'Passwords do not match.';

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    request: { name, email, password },
  };
}
