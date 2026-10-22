import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime, SafeDisplayText } from '../common.js';
import { Organization, Role } from '../domain/org.js';
import { CursorPage } from './pagination.js';

const strict = { additionalProperties: false } as const;

/**
 * POST /orgs (session cookie + `x-csrf-token`). The caller becomes `owner`, and the session is rotated with the new org
 * active. The server derives `slug`; the client sends only `name`.
 *
 * `name` uses the shared SafeDisplayText charset (same as `deviceLabel`: no control, HTML-significant or bidi/format
 * characters), 1-200 characters, and must not be whitespace-only or have leading or trailing whitespace. A schema
 * cannot trim, so clients MUST trim the name before sending.
 */
export const CreateOrganizationRequest = Type.Object({ name: SafeDisplayText({ maxLength: 200, trimmed: true }) }, strict);
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

/**
 * https only, with no userinfo: the authority may not contain `@`, `\\` or whitespace, and the path may not contain
 * `\\` or whitespace.
 */
export const HttpsAvatarUrl = Type.String({
  format: 'uri',
  pattern: '^https://[^/@\\\\\\s]+(/[^\\s\\\\]*)?$',
  maxLength: 2048,
});

/**
 * Public user fields shown in member lists. No credentials or verification state.
 *
 * **Email visibility (RBAC):** `email` is optional. The API MUST include it only when the viewer's role in the org is
 * `owner` or `admin`, and MUST omit it for `member` and `viewer` viewers.
 */
export const UserSummary = Type.Object(
  {
    id: Id,
    email: Type.Optional(Type.String({ format: 'email' })),
    name: Type.Optional(Type.String({ maxLength: 200 })),
    avatarUrl: Type.Optional(HttpsAvatarUrl),
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
