import { Type, type Static } from '@sinclair/typebox';
import { Membership, Organization, Paginated, Role } from '@meetops/contracts';

export const InvitableRole = Type.Union([Type.Literal('admin'), Type.Literal('member'), Type.Literal('viewer')]);

export const OrganizationWithRole = Type.Object({ organization: Organization, role: Role });
export const OrganizationList = Paginated(OrganizationWithRole);

export const CreateOrganizationBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 200 }) },
  { additionalProperties: false }
);
export const SwitchOrganizationBody = Type.Object(
  { organizationId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false }
);
export const CreateInvitationBody = Type.Object(
  { email: Type.String({ format: 'email', maxLength: 320 }), role: InvitableRole },
  { additionalProperties: false }
);
export const AcceptInvitationBody = Type.Object(
  { token: Type.String({ minLength: 32, maxLength: 512 }) },
  { additionalProperties: false }
);
export const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
export const InvitationParams = Type.Object({
  id: Type.String({ format: 'uuid' }),
  invitationId: Type.String({ format: 'uuid' })
});

export const InvitationDto = Type.Object(
  {
    id: Type.String(),
    organizationId: Type.String(),
    email: Type.String(),
    role: InvitableRole,
    status: Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('revoked')]),
    expiresAt: Type.String({ format: 'date-time' })
  },
  { additionalProperties: false }
);

export const MemberParams = Type.Object({ id: Type.String({ format: 'uuid' }), userId: Type.String({ format: 'uuid' }) });
export const ChangeRoleBody = Type.Object({ role: Role }, { additionalProperties: false });
export const MemberList = Type.Object({ items: Type.Array(Membership) });
export type MemberParamsT = Static<typeof MemberParams>;
export type ChangeRoleBodyT = Static<typeof ChangeRoleBody>;

export type CreateOrganizationBodyT = Static<typeof CreateOrganizationBody>;
export type SwitchOrganizationBodyT = Static<typeof SwitchOrganizationBody>;
export type CreateInvitationBodyT = Static<typeof CreateInvitationBody>;
export type AcceptInvitationBodyT = Static<typeof AcceptInvitationBody>;
export type IdParamsT = Static<typeof IdParams>;
export type InvitationParamsT = Static<typeof InvitationParams>;
