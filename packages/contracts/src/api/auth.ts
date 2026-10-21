import { Type, type Static } from '@sinclair/typebox';
import { IsoDateTime } from '../common.js';
import { Membership, Organization, User } from '../domain/org.js';

const Email = Type.String({ format: 'email', maxLength: 320 });
const Password = Type.String({ minLength: 8, maxLength: 128 });

export const LoginRequest = Type.Object({ email: Email, password: Password });
export type LoginRequest = Static<typeof LoginRequest>;

export const SignupRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  email: Email,
  password: Password,
});
export type SignupRequest = Static<typeof SignupRequest>;

export const ForgotPasswordRequest = Type.Object({ email: Email });
export type ForgotPasswordRequest = Static<typeof ForgotPasswordRequest>;

/** Returned by login/signup/session endpoints. */
export const AuthSession = Type.Object({
  user: User,
  accessToken: Type.String({ minLength: 1 }),
  expiresAt: Type.Optional(IsoDateTime),
  organizations: Type.Array(Organization),
  memberships: Type.Optional(Type.Array(Membership)),
});
export type AuthSession = Static<typeof AuthSession>;
