import { Type, type Static } from '@sinclair/typebox';

export const RoleSchema = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
  Type.Literal('viewer')
]);
export const InvitableRole = Type.Union([Type.Literal('admin'), Type.Literal('member'), Type.Literal('viewer')]);

export const OrganizationDto = Type.Object({
  id: Type.String(),
  name: Type.String(),
  slug: Type.String(),
  createdAt: Type.String({ format: 'date-time' })
});

export const OrganizationWithRole = Type.Object({ organization: OrganizationDto, role: RoleSchema });

export const CreateOrganizationBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false }
);
export const SwitchOrganizationBody = Type.Object(
  { organizationId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);
export const CreateInvitationBody = Type.Object(
  { email: Type.String({ format: 'email', maxLength: 320 }), role: InvitableRole },
  { additionalProperties: false }
);
export const AcceptInvitationBody = Type.Object(
  { token: Type.String({ minLength: 16, maxLength: 256 }) },
  { additionalProperties: false }
);
export const IdParams = Type.Object({ id: Type.String({ minLength: 1 }) });

export const InvitationDto = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  email: Type.String(),
  role: InvitableRole,
  status: Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('revoked')]),
  expiresAt: Type.String({ format: 'date-time' })
});

export type CreateOrganizationBodyT = Static<typeof CreateOrganizationBody>;
export type SwitchOrganizationBodyT = Static<typeof SwitchOrganizationBody>;
export type CreateInvitationBodyT = Static<typeof CreateInvitationBody>;
export type AcceptInvitationBodyT = Static<typeof AcceptInvitationBody>;
export type IdParamsT = Static<typeof IdParams>;
