import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

export const Role = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
  Type.Literal('viewer'),
]);
export type Role = Static<typeof Role>;
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const satisfies readonly Role[];

export const Organization = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  slug: Type.String({ pattern: '^[a-z0-9-]{2,64}$' }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Organization = Static<typeof Organization>;

export const User = Type.Object({
  id: Id,
  email: Type.String({ format: 'email' }),
  name: Type.Optional(Type.String({ maxLength: 200 })),
  avatarUrl: Type.Optional(Type.String({ format: 'uri', pattern: '^https://', maxLength: 2048 })),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
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
