import { Type, type Static } from '@sinclair/typebox';
import { Organization, Paginated, Role } from '../../../shared/contracts/index.js';

export const InvitableRole = Type.Union([Type.Literal('admin'), Type.Literal('member'), Type.Literal('viewer')]);

export const OrganizationWithRole = Type.Object({ organization: Organization, role: Role });
export const OrganizationList = Paginated(OrganizationWithRole);

export const CreateOrganizationBody = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 200 }) },
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
export const InvitationParams = Type.Object({
  id: Type.String({ minLength: 1 }),
  invitationId: Type.String({ minLength: 1 })
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

export type CreateOrganizationBodyT = Static<typeof CreateOrganizationBody>;
export type SwitchOrganizationBodyT = Static<typeof SwitchOrganizationBody>;
export type CreateInvitationBodyT = Static<typeof CreateInvitationBody>;
export type AcceptInvitationBodyT = Static<typeof AcceptInvitationBody>;
export type IdParamsT = Static<typeof IdParams>;
export type InvitationParamsT = Static<typeof InvitationParams>;
