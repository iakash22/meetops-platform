import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { AuthService } from '../../auth/application/auth.service.js';
import { requireAuth } from '../../auth/http/auth.plugin.js';
import { ErrorBody } from '../../auth/http/schemas.js';
import { registerDomainErrorHandler } from '../../../shared/http-errors.js';
import type { OrganizationService } from '../application/organization.service.js';
import type { Organization } from '../domain/organization.js';
import type { Invitation } from '../domain/invitation.js';
import {
  AcceptInvitationBody,
  CreateInvitationBody,
  CreateOrganizationBody,
  IdParams,
  InvitationDto,
  OrganizationWithRole,
  SwitchOrganizationBody,
  type AcceptInvitationBodyT,
  type CreateInvitationBodyT,
  type CreateOrganizationBodyT,
  type IdParamsT,
  type SwitchOrganizationBodyT
} from './schemas.js';

export interface OrganizationsPluginOptions {
  auth: AuthService;
  organizations: OrganizationService;
}

const orgDto = (o: Organization) => ({ id: o.id, name: o.name, slug: o.slug, createdAt: o.createdAt.toISOString() });
const invDto = (i: Invitation) => ({
  id: i.id,
  organizationId: i.organizationId,
  email: i.email,
  role: i.role,
  status: i.status,
  expiresAt: i.expiresAt.toISOString()
});

export async function organizationRoutes(app: FastifyInstance, opts: OrganizationsPluginOptions) {
  registerDomainErrorHandler(app);
  app.addHook('preHandler', requireAuth(opts.auth));
  const orgTags = ['organizations'];
  const invTags = ['invitations'];
  const authErr = { 401: ErrorBody, 403: ErrorBody };

  app.post<{ Body: CreateOrganizationBodyT }>(
    '/organizations',
    {
      schema: {
        tags: orgTags,
        summary: 'Create organization',
        description: 'Creates an organization; the caller becomes owner and it becomes the active org.',
        body: CreateOrganizationBody,
        response: { 201: OrganizationWithRole, ...authErr }
      }
    },
    async (request, reply) => {
      const { user, session } = request.auth!;
      const r = await opts.organizations.create({ name: request.body.name, userId: user.id, sessionId: session.id });
      return reply.status(201).send({ organization: orgDto(r.organization), role: r.membership.role });
    }
  );

  app.get(
    '/organizations',
    {
      schema: {
        tags: orgTags,
        summary: 'List my organizations',
        description: 'Organizations the caller is a member of, with their role.',
        response: { 200: Type.Array(OrganizationWithRole), ...authErr }
      }
    },
    async (request) => {
      const list = await opts.organizations.listForUser(request.auth!.user.id);
      return list.map((x) => ({ organization: orgDto(x.organization), role: x.role }));
    }
  );

  app.post<{ Body: SwitchOrganizationBodyT }>(
    '/organizations/switch',
    {
      schema: {
        tags: orgTags,
        summary: 'Switch active organization',
        description: 'Sets the active organization on the current session. Requires membership.',
        body: SwitchOrganizationBody,
        response: { 200: OrganizationWithRole, 404: ErrorBody, ...authErr }
      }
    },
    async (request) => {
      const { user, session } = request.auth!;
      const r = await opts.organizations.switchActive({
        organizationId: request.body.organizationId,
        userId: user.id,
        sessionId: session.id
      });
      return { organization: orgDto(r.organization), role: r.membership.role };
    }
  );

  app.post<{ Params: IdParamsT; Body: CreateInvitationBodyT }>(
    '/organizations/:id/invitations',
    {
      schema: {
        tags: invTags,
        summary: 'Invite a member',
        description: 'Owner/admin only. The invitation token is delivered out of band and never returned or logged.',
        params: IdParams,
        body: CreateInvitationBody,
        response: { 201: InvitationDto, ...authErr }
      }
    },
    async (request, reply) => {
      const r = await opts.organizations.invite({
        organizationId: request.params.id,
        actorUserId: request.auth!.user.id,
        email: request.body.email,
        role: request.body.role
      });
      // TODO(notifications): hand r.token to the email/notification module.
      return reply.status(201).send(invDto(r.invitation));
    }
  );

  app.post<{ Body: AcceptInvitationBodyT }>(
    '/invitations/accept',
    {
      schema: {
        tags: invTags,
        summary: 'Accept invitation',
        description: 'Accepts a pending, unexpired invitation addressed to the caller\'s email.',
        body: AcceptInvitationBody,
        response: { 200: OrganizationWithRole, 404: ErrorBody, 409: ErrorBody, 410: ErrorBody, ...authErr }
      }
    },
    async (request) => {
      const { user } = request.auth!;
      const r = await opts.organizations.acceptInvitation({ token: request.body.token, userId: user.id, email: user.email });
      const orgs = await opts.organizations.listForUser(user.id);
      const org = orgs.find((o) => o.organization.id === r.invitation.organizationId)!;
      return { organization: orgDto(org.organization), role: r.membership.role };
    }
  );

  app.post<{ Params: IdParamsT }>(
    '/invitations/:id/revoke',
    {
      schema: {
        tags: invTags,
        summary: 'Revoke invitation',
        description: 'Owner/admin only. Only pending invitations can be revoked.',
        params: IdParams,
        response: { 200: InvitationDto, 404: ErrorBody, 409: ErrorBody, 410: ErrorBody, ...authErr }
      }
    },
    async (request) => {
      const inv = await opts.organizations.revokeInvitation({
        invitationId: request.params.id,
        actorUserId: request.auth!.user.id
      });
      return invDto(inv);
    }
  );
}
