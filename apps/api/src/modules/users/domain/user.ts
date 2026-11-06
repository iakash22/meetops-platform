export type UserId = string;

export interface User {
  id: UserId;
  email: string;
  name: string | null;
  passwordHash: string;
  emailVerifiedAt: Date | null;
  /** Google OIDC subject. Absent or null for password-only accounts. */
  googleSub?: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Public projection of a user. Never includes the password hash. */
export interface PublicUser {
  id: UserId;
  email: string;
  name: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
