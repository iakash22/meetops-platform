import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { Organization, Role } from '../domain/org.js';
import { CursorPage } from './pagination.js';

const strict = { additionalProperties: false } as const;

/**
 * POST /orgs (session cookie + `x-csrf-token`). The caller becomes `owner`, and the session is rotated with the new org
 * active. The server derives `slug`; the client sends only `name`.
 */
export const CreateOrganizationRequest = Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }) }, strict);
export type CreateOrganizationRequest = Static<typeof CreateOrganizationRequest>;

/** An organization together with the caller's role in it. */
export const OrganizationWithRole = Type.Object({ organization: Organization, role: Role }, strict);
export type OrganizationWithRole = Static<typeof OrganizationWithRole>;

/** 201 response of POST /orgs: the new organization and the caller's role (always `owner`). */
export const CreateOrganizationResponse = OrganizationWithRole;
export type CreateOrganizationResponse = OrganizationWithRole;

/** GET /orgs: the organizations the caller is a member of, with their role. Cursor page (`nextCursor` null on the last page). */
export const ListOrganizationsResponse = Type.Object(CursorPage(OrganizationWithRole).properties, strict);
export type ListOrganizationsResponse = Static<typeof ListOrganizationsResponse>;

/** Public user fields shown in member lists. No credentials or verification state. */
export const UserSummary = Type.Object(
  {
    id: Id,
    email: Type.String({ format: 'email' }),
    name: Type.Optional(Type.String({ maxLength: 200 })),
    avatarUrl: Type.Optional(Type.String({ format: 'uri', pattern: '^https://', maxLength: 2048 })),
  },
  strict,
);
export type UserSummary = Static<typeof UserSummary>;

/** A member of an organization: the Membership fields plus a `user` summary. `userId` equals `user.id`. */
export const OrganizationMember = Type.Object(
  { id: Id, organizationId: Id, userId: Id, role: Role, createdAt: IsoDateTime, user: UserSummary },
  strict,
);
export type OrganizationMember = Static<typeof OrganizationMember>;

/** GET /orgs/:organizationId/members: cursor page of OrganizationMember. */
export const ListMembersResponse = Type.Object(CursorPage(OrganizationMember).properties, strict);
export type ListMembersResponse = Static<typeof ListMembersResponse>;
