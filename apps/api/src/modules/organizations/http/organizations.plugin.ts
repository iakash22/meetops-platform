import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { Membership } from '@meetops/contracts';
import type { AuthService } from '../../auth/application/auth.service.js';
import { ErrorBody } from '../../auth/http/schemas.js';
import { makeGuards, requestMeta, type HttpSecurityConfig } from '../../auth/http/security.js';
import { registerDomainErrorHandler } from '../../../shared/http-errors.js';
import type { RouteLimiter } from '../../../shared/rate-limits.js';
import { DomainError } from '../../../shared/domain-error.js';
import type { OrganizationService } from '../application/organization.service.js';
import { InvitationError } from '../domain/invitation.js';
import {
  toInvitationDto as invDto,
  toMembershipDto as memberDto,
  toOrganizationDto as orgDto,
  toOrganizationMemberDto,
} from './mappers.js';
import { paginate } from '../../../shared/pagination.js';
import {
  AcceptInvitationBody,
  ChangeRoleBody,
  MemberList,
  MemberParams,
  type ChangeRoleBodyT,
  type MemberParamsT,
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
  type CursorPageQueryT,
  CursorPageQuery,
  type IdParamsT,
  type InvitationParamsT,
  type SwitchOrganizationBodyT,
} from './schemas.js';

export interface OrganizationsPluginOptions {
  auth: AuthService;
  organizations: OrganizationService;
  security: HttpSecurityConfig;
  /** ROUTE_RATE_LIMITS.orgCreate (POST /orgs). Omitted: unmetered (tests that mount the plugin alone). */
  routeLimits?: RouteLimiter;
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
    organizationId: string | null,
    reason: 'org_switch' | 'role_changed' | 'member_removed' = 'org_switch',
  ) => {
    const ctx = request.auth!;
    const r = await auth.rotate(
      ctx.session,
      ctx.user,
      organizationId,
      requestMeta(request),
      reason,
    );
    // Null: a concurrent rotation of the same session by this client won; its response carries the new cookie.
    if (!r) return;
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
          'Caller becomes owner; the session is rotated with the new org active. Requires a verified email (403 otherwise).',
        body: CreateOrganizationBody,
        response: { 201: OrganizationWithRole, ...authErr },
      },
    },
    async (request, reply) => {
      const { user } = await g.requireSession(request);
      await opts.routeLimits?.charge('orgCreate', { userId: user.id });
      const r = await orgs.create({ name: request.body.name, userId: user.id });
      await rotateInto(request, reply, r.organization.id);
      return reply
        .status(201)
        .send({ organization: orgDto(r.organization), role: r.membership.role });
    },
  );

  app.get<{ Querystring: CursorPageQueryT }>(
    '/orgs',
    {
      schema: {
        tags: orgTags,
        summary: 'List my organizations',
        description: 'Organizations the caller is a member of, with their role. Cursor page.',
        querystring: CursorPageQuery,
        response: { 200: OrganizationList, ...authErr },
      },
    },
    async (request) => {
      const { user } = await g.requireSession(request);
      const items = (await orgs.listForUser(user.id)).map((x) => ({
        organization: orgDto(x.organization),
        role: x.role,
      }));
      return paginate(items, request.query);
    },
  );

  app.get<{ Params: IdParamsT }>(
    '/orgs/:organizationId',
    {
      schema: {
        tags: orgTags,
        summary: 'Get organization',
        description: '404 for unknown orgs and orgs the caller is not a member of.',
        params: IdParams,
        response: { 200: OrganizationWithRole, ...authErr },
      },
    },
    async (request) => {
      const { user } = await g.requireSession(request);
      const r = await orgs.switchActive({
        organizationId: request.params.organizationId,
        userId: user.id,
      });
      return { organization: orgDto(r.organization), role: r.role };
    },
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
        response: { 200: OrganizationWithRole, ...authErr },
      },
    },
    async (request, reply) => {
      const { user } = await g.requireSession(request);
      const r = await orgs.switchActive({
        organizationId: request.body.organizationId,
        userId: user.id,
      });
      await rotateInto(request, reply, r.organization.id);
      return { organization: orgDto(r.organization), role: r.role };
    },
  );

  app.post<{ Params: IdParamsT; Body: CreateInvitationBodyT }>(
    '/orgs/:organizationId/invitations',
    {
      schema: {
        tags: invTags,
        summary: 'Invite a member',
        description:
          'Owner/admin only (CASL). Same response whether or not the address has an account; re-inviting replaces a pending invite. The token is only emailed. 409 CONFLICT if the address belongs to an active member of this org.',
        params: IdParams,
        body: CreateInvitationBody,
        response: { 201: InvitationDto, 400: ErrorBody, 409: ErrorBody, ...authErr },
      },
    },
    async (request, reply) => {
      const session = await g.requireSession(request);
      // ADR-021 OQ-9: inviting an admin needs a fresh step-up (owners cannot be invited, InvitableRole).
      if (request.body.role === 'admin') auth.requireStepUp(session);
      const ctx = await orgs.resolveTenant(request.params.organizationId, session.user.id);
      const r = await orgs.invite(ctx, request.body);
      return reply.status(201).send(invDto(r.invitation));
    },
  );

  app.post<{ Params: InvitationParamsT }>(
    '/orgs/:organizationId/invitations/:invitationId/revoke',
    {
      schema: {
        tags: invTags,
        summary: 'Revoke invitation',
        description: 'Owner/admin only (CASL). Only pending invitations can be revoked.',
        params: InvitationParams,
        response: { 200: InvitationDto, 409: ErrorBody, ...authErr },
      },
    },
    async (request) => {
      const { user } = await g.requireSession(request);
      const ctx = await orgs.resolveTenant(request.params.organizationId, user.id);
      return invDto(await orgs.revokeInvitation(ctx, request.params.invitationId));
    },
  );

  app.post<{ Body: AcceptInvitationBodyT }>(
    '/invitations/accept',
    {
      schema: {
        tags: invTags,
        summary: 'Accept invitation',
        description:
          'Must be logged in as the invited email, with a verified email address (403 otherwise). Unknown, expired, revoked, used or mismatched invitations all return the same 404. 409 CONFLICT if the user is already an active member (the invitation stays pending and no role changes).',
        body: AcceptInvitationBody,
        response: { 200: OrganizationWithRole, 409: ErrorBody, ...authErr },
      },
    },
    async (request) => {
      const { user } = await g.requireSession(request);
      await orgs.requireVerifiedEmail(user.id);
      try {
        const r = await orgs.acceptInvitation({
          token: request.body.token,
          userId: user.id,
          email: user.email,
          // ADR-014 client IP (TRUST_PROXY allowlist / pinned Cloudflare edge), not the proxy's socket address.
          ip: requestMeta(request).ip,
        });
        return { organization: orgDto(r.organization), role: r.membership.role };
      } catch (err) {
        if (err instanceof InvitationError)
          throw new DomainError('NOT_FOUND', 'Invitation not found', 404);
        throw err;
      }
    },
  );

  const memberTags = ['members'];

  app.get<{ Params: IdParamsT; Querystring: CursorPageQueryT }>(
    '/orgs/:organizationId/members',
    {
      schema: {
        tags: memberTags,
        summary: 'List members',
        description:
          'Cursor page. `user.email` is included only when the caller is an owner or admin.',
        params: IdParams,
        querystring: CursorPageQuery,
        response: { 200: MemberList, ...authErr },
      },
    },
    async (request) => {
      const { user } = await g.requireSession(request);
      const ctx = await orgs.resolveTenant(request.params.organizationId, user.id);
      const all = (await orgs.listMembersWithUsers(ctx)).map((x) =>
        toOrganizationMemberDto(x.membership, x.user, ctx.role),
      );
      return paginate(all, request.query);
    },
  );

  app.patch<{ Params: MemberParamsT; Body: ChangeRoleBodyT }>(
    '/orgs/:organizationId/members/:userId',
    {
      schema: {
        tags: memberTags,
        summary: 'Change a member role',
        description:
          "Owner: any change. Admin: only member/viewer targets, to member/viewer. Nobody else (403). Demoting the last owner returns 409 CONFLICT with reason LAST_OWNER. The target's sessions are revoked; changing your own role rotates your session.",
        params: MemberParams,
        body: ChangeRoleBody,
        response: { 200: Membership, 400: ErrorBody, 409: ErrorBody, ...authErr },
      },
    },
    async (request, reply) => {
      const session = await g.requireSession(request);
      // ADR-021 Decision 4: role changes need a fresh step-up.
      auth.requireStepUp(session);
      const { user } = session;
      const ctx = await orgs.resolveTenant(request.params.organizationId, user.id);
      const m = await orgs.changeRole(ctx, request.params.userId, request.body.role);
      if (request.params.userId === user.id)
        await rotateInto(request, reply, ctx.organizationId, 'role_changed');
      return memberDto(m);
    },
  );

  app.delete<{ Params: MemberParamsT }>(
    '/orgs/:organizationId/members/:userId',
    {
      schema: {
        tags: memberTags,
        summary: 'Remove a member (or leave)',
        description:
          "Owner removes anyone; admin removes members/viewers; anyone may leave. Removing the last owner returns 409 CONFLICT with reason LAST_OWNER. The removed user's sessions are revoked.",
        params: MemberParams,
        response: { 204: Type.Null(), 409: ErrorBody, ...authErr },
      },
    },
    async (request, reply) => {
      const session = await g.requireSession(request);
      const { user } = session;
      // ADR-021 OQ-9: removing someone else needs a fresh step-up; leaving an org yourself does not.
      if (request.params.userId !== user.id) auth.requireStepUp(session);
      const ctx = await orgs.resolveTenant(request.params.organizationId, user.id);
      await orgs.removeMember(ctx, request.params.userId);
      if (request.params.userId === user.id)
        await rotateInto(request, reply, null, 'member_removed');
      return reply.status(204).send();
    },
  );
}
