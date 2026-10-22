import { Type, type Static } from '@sinclair/typebox';
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
