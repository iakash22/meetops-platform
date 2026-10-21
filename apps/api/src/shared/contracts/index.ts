/**
 * TEMPORARY MIRROR of @meetops/contracts from PR #17 (feat/core-contracts, unmerged).
 * Shapes are copied verbatim for the pieces apps/api uses. Delete this file and import
 * from '@meetops/contracts' once PR #17 merges. Do not add API-specific types here.
 */
import { Type, type Static, type TSchema } from '@sinclair/typebox';

// common.ts
export const Id = Type.String({ minLength: 1, description: 'Opaque entity id (cuid/uuid)' });
export const IsoDateTime = Type.String({ format: 'date-time' });

// api/errors.ts
export const ApiErrorCode = Type.Union([
  Type.Literal('BAD_REQUEST'),
  Type.Literal('VALIDATION_FAILED'),
  Type.Literal('UNAUTHENTICATED'),
  Type.Literal('FORBIDDEN'),
  Type.Literal('NOT_FOUND'),
  Type.Literal('CONFLICT'),
  Type.Literal('RATE_LIMITED'),
  Type.Literal('PROVIDER_UNAVAILABLE'),
  Type.Literal('INTERNAL')
]);
export type ApiErrorCode = Static<typeof ApiErrorCode>;
export const ApiErrorEnvelope = Type.Object({
  error: Type.Object({
    code: ApiErrorCode,
    message: Type.String(),
    requestId: Type.Optional(Type.String()),
    details: Type.Optional(Type.Array(Type.Object({ path: Type.String(), message: Type.String() })))
  })
});
export type ApiErrorEnvelope = Static<typeof ApiErrorEnvelope>;

// api/pagination.ts
export const CursorPage = <T extends TSchema>(item: T) =>
  Type.Object({ items: Type.Array(item), nextCursor: Type.Union([Type.String(), Type.Null()]) });
export type CursorPage<T> = { items: T[]; nextCursor: string | null };
export const Paginated = CursorPage;
export type Paginated<T> = CursorPage<T>;

// domain/org.ts
export const Role = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
  Type.Literal('viewer')
]);
export type Role = Static<typeof Role>;
export const Organization = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  slug: Type.String({ pattern: '^[a-z0-9-]{2,64}$' }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime
});
export type Organization = Static<typeof Organization>;
export const User = Type.Object({
  id: Id,
  email: Type.String({ format: 'email' }),
  name: Type.Optional(Type.String({ maxLength: 200 })),
  avatarUrl: Type.Optional(Type.String()),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime
});
export type User = Static<typeof User>;
export const Membership = Type.Object({
  id: Id,
  organizationId: Id,
  userId: Id,
  role: Role,
  createdAt: IsoDateTime
});
export type Membership = Static<typeof Membership>;

// api/auth.ts (requests). AuthSession is intentionally NOT mirrored: it carries
// `accessToken`, which conflicts with auth-session-spec (cookie-only sessions).
const Email = Type.String({ format: 'email', maxLength: 320 });
export const LoginRequest = Type.Object({ email: Email, password: Type.String({ minLength: 8, maxLength: 128 }) });
export const SignupRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  email: Email,
  password: Type.String({ minLength: 8, maxLength: 128 })
});
export const ForgotPasswordRequest = Type.Object({ email: Email });
