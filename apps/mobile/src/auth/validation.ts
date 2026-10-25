import type { LoginCredentials } from './types';

/** Limits mirror `LoginRequest` in `@meetops/contracts` (email max 320, password 1..128). */
export const EMAIL_MAX_LENGTH = 320;
export const PASSWORD_MAX_LENGTH = 128;

// Deliberately loose: the server is the authority. This only catches obvious typos before a round trip.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LoginFieldErrors {
  email?: string;
  password?: string;
}

export function validateLogin(input: { email: string; password: string }): {
  ok: boolean;
  errors: LoginFieldErrors;
  credentials: LoginCredentials;
} {
  const email = input.email.trim();
  const { password } = input;
  const errors: LoginFieldErrors = {};

  if (email.length === 0) errors.email = 'Enter your email address.';
  else if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email))
    errors.email = 'Enter a valid email address.';

  // Login accepts any non-empty password so the password policy is not revealed (see contracts LoginPassword).
  if (password.length === 0) errors.password = 'Enter your password.';
  else if (password.length > PASSWORD_MAX_LENGTH) errors.password = 'Password is too long.';

  return { ok: Object.keys(errors).length === 0, errors, credentials: { email, password } };
}
