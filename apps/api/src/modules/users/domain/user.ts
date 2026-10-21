export type UserId = string;

export interface User {
  id: UserId;
  email: string;
  name: string | null;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Public projection of a user. Never includes the password hash. */
export interface PublicUser {
  id: UserId;
  email: string;
  name: string | null;
  createdAt: Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}
