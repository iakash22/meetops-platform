import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthService } from '../../auth/application/auth.service.js';
import type { AuthMailer } from '../../auth/domain/mailer.js';
import { ErrorBody } from '../../auth/http/schemas.js';
import { makeGuards, requestMeta, type HttpSecurityConfig } from '../../auth/http/security.js';
import { registerDomainErrorHandler } from '../../../shared/http-errors.js';
import { DomainError } from '../../../shared/domain-error.js';
import type { OrganizationService } from '../application/organization.service.js';
import { InvitationError } from '../domain/invitation.js';
import { toInvitationDto as invDto, toOrganizationDto as orgDto } from './mappers.js';
import {
  AcceptInvitationBody,
  CreateInvitationBody,
  CreateOrganizationBody,
  IdParams,
  InvitationDto,
  InvitationParams,
  OrganizationList,
  OrganizationWithRole,
  SwitchOrganizationBody,
  type AcceptInvitationBodyT,
  type CreateInvitationBodyT,
  type CreateOrganizationBodyT,
  type IdParamsT,
  type InvitationParamsT,
  type SwitchOrganizationBodyT
} from './schemas.js';

export interface OrganizationsPluginOptions {
  auth: AuthService;
  organizations: OrganizationService;
  mailer: AuthMailer;
  security: HttpSecurityConfig;
}


export async function organizationRoutes(app: FastifyInstance, opts: OrganizationsPluginOptions) {
  registerDomainErrorHandler(app);
  const { auth, organizations: orgs, security } = opts;
  const g = makeGuards(auth, security);
  app.addHook('onRequest', g.mutationGuard);
  const orgTags = ['organizations'];
  const invTags = ['invitations'];
  const authErr = { 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 429: ErrorBody };

  const rotateInto = async (
    request: Parameters<typeof g.requireSession>[0],
    reply: FastifyReply,
    organizationId: string
  ) => {
    const ctx = request.auth!;
    const r = await auth.rotate(ctx.session, ctx.user, organizationId, requestMeta(request));
    g.setSessionCookie(reply, r);
    g.issueCsrfForSession(reply, r.session.id);
  };

  app.post<{ Body: CreateOrganizationBodyT }>(
    '/orgs',
    {
      schema: {
        tags: orgTags,
        summary: 'Create organization',
        description:
          'Caller becomes owner; the session is rotated with the new org active.',
        body: CreateOrganizationBody,
        response: { 201: OrganizationWithRole, ...authErr }
      }
    },
    async (request, reply) => {
      const { user } = await g.requireSession(request);
      const r = await orgs.create({ name: request.body.name, userId: user.id });
      await rotateInto(request, reply, r.organization.id);
      return reply.status(201).send({ organization: orgDto(r.organization), role: r.membership.role });
    }
  );

  app.get(
    '/orgs',
    {
      schema: {
        tags: orgTags,
        summary: 'List my organizations',
        description: 'Organizations the caller is a member of, with their role.',
        response: { 200: OrganizationList, ...authErr }
      }
    },
    async (request) => {
      const { user } = await g.requireSession(request);
      const items = (await orgs.listForUser(user.id)).map((x) => ({ organization: orgDto(x.organization), role: x.role }));
      return { items, nextCursor: null };
    }
  );

  app.get<{ Params: IdParamsT }>(
    '/orgs/:id',
    {
      schema: {
        tags: orgTags,
        summary: 'Get organization',
        description: '404 for unknown orgs and orgs the caller is not a member of.',
        params: IdParams,
        response: { 200: OrganizationWithRole, ...authErr }
      }
    },
    async (request) => {
      const { user } = await g.requireSession(request);
      const r = await orgs.switchActive({ organizationId: request.params.id, userId: user.id });
      return { organization: orgDto(r.organization), role: r.role };
    }
  );

  app.post<{ Body: SwitchOrganizationBodyT }>(
    '/orgs/switch',
    {
      schema: {
        tags: orgTags,
        summary: 'Switch active organization',
        description:
          'Requires membership (404 otherwise). Rotates the session with the new active org.',
        body: SwitchOrganizationBody,
        response: { 200: OrganizationWithRole, ...authErr }
      }
    },
    async (request, reply) => {
      const { user } = await g.requireSession(request);
      const r = await orgs.switchActive({ organizationId: request.body.organizationId, userId: user.id });
      await rotateInto(request, reply, r.organization.id);
      return { organization: orgDto(r.organization), role: r.role };
    }
  );

  app.post<{ Params: IdParamsT; Body: CreateInvitationBodyT }>(
    '/orgs/:id/invitations',
    {
      schema: {
        tags: invTags,
        summary: 'Invite a member',
        description:
          'Owner/admin only (CASL). Same response whether or not the address has an account; re-inviting replaces a pending invite. The token is only emailed.',
        params: IdParams,
        body: CreateInvitationBody,
        response: { 201: InvitationDto, 400: ErrorBody, ...authErr }
      }
    },
    async (request, reply) => {
      const { user } = await g.requireSession(request);
      const ctx = await orgs.resolveTenant(request.params.id, user.id);
      const r = await orgs.invite(ctx, request.body);
      const org = await orgs.switchActive({ organizationId: ctx.organizationId, userId: user.id });
      await opts.mailer.sendInvitation(r.invitation.email, { organizationName: org.organization.name, token: r.token });
      return reply.status(201).send(invDto(r.invitation));
    }
  );

  app.post<{ Params: InvitationParamsT }>(
    '/orgs/:id/invitations/:invitationId/revoke',
    {
      schema: {
        tags: invTags,
        summary: 'Revoke invitation',
        description: 'Owner/admin only (CASL). Only pending invitations can be revoked.',
        params: InvitationParams,
        response: { 200: InvitationDto, 409: ErrorBody, 410: ErrorBody, ...authErr }
      }
    },
    async (request) => {
      const { user } = await g.requireSession(request);
      const ctx = await orgs.resolveTenant(request.params.id, user.id);
      return invDto(await orgs.revokeInvitation(ctx, request.params.invitationId));
    }
  );

  app.post<{ Body: AcceptInvitationBodyT }>(
    '/invitations/accept',
    {
      schema: {
        tags: invTags,
        summary: 'Accept invitation',
        description:
          "Must be logged in as the invited email. Unknown, expired, revoked, used or mismatched invitations all return the same 404.",
        body: AcceptInvitationBody,
        response: { 200: OrganizationWithRole, ...authErr }
      }
    },
    async (request) => {
      const { user } = await g.requireSession(request);
      try {
        const r = await orgs.acceptInvitation({
          token: request.body.token,
          userId: user.id,
          email: user.email,
          ip: request.ip ?? null
        });
        return { organization: orgDto(r.organization), role: r.membership.role };
      } catch (err) {
        if (err instanceof InvitationError) throw new DomainError('NOT_FOUND', 'Invitation not found', 404);
        throw err;
      }
    }
  );
}
