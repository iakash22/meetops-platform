import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

export const Role = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
  Type.Literal('viewer'),
]);
export type Role = Static<typeof Role>;
export { ROLES } from '../constants.js';

export const Organization = Type.Object(
  {
    id: Id,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    slug: Type.String({ pattern: '^[a-z0-9-]{2,64}$' }),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { additionalProperties: false },
);
export type Organization = Static<typeof Organization>;

export const User = Type.Object({
  id: Id,
  email: Type.String({ format: 'email' }),
  name: Type.Optional(Type.String({ maxLength: 200 })),
  avatarUrl: Type.Optional(Type.String({ format: 'uri', pattern: '^https://', maxLength: 2048 })),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** 0.7.0: when the email was verified; null while unverified. Returned by GET /auth/session. */
  emailVerifiedAt: Type.Optional(Type.Union([IsoDateTime, Type.Null()])),
});
export type User = Static<typeof User>;

export const Membership = Type.Object({
  id: Id,
  organizationId: Id,
  userId: Id,
  role: Role,
  createdAt: IsoDateTime,
});
export type Membership = Static<typeof Membership>;

/**
 * Loose project shape used by early web mocks. v0.4.0: the directory routes return `ProjectDto` (strict, with `key`,
 * `status` and `teamId`); prefer it for new code.
 */
export const Project = Type.Object({
  id: Id,
  organizationId: Id,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String()),
  archivedAt: Type.Optional(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Project = Static<typeof Project>;
