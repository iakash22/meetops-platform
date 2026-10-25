import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  AddTeamMemberRequest,
  CreateTeamRequest,
  DIRECTORY_PATHS,
  ListTeamMembersQuery,
  ListTeamMembersResponse,
  ListTeamsQuery,
  ListTeamsResponse,
  TeamDto,
  TeamMemberDto,
  TeamMemberParams,
  TeamParams,
  TeamsParams,
  UpdateTeamMemberRequest,
  UpdateTeamRequest,
} from '@meetops/contracts';
import type { DirectoryAccess } from '../../directory/access.js';
import {
  directoryErrors,
  directoryWriteErrors,
  type ResolveCaller,
} from '../../directory/http/route-kit.js';
import type { TeamService } from '../application/team.service.js';
import { toTeamDto, toTeamMemberDto } from './mappers.js';

export interface TeamRoutesOptions {
  teams: TeamService;
  access: DirectoryAccess;
  caller: ResolveCaller;
}

const tags = ['teams'];

export async function teamRoutes(app: FastifyInstance, opts: TeamRoutesOptions) {
  const { teams, access, caller } = opts;

  app.get<{ Params: TeamsParams; Querystring: ListTeamsQuery }>(
    DIRECTORY_PATHS.teams,
    {
      schema: {
        tags,
        summary: 'List teams',
        params: TeamsParams,
        querystring: ListTeamsQuery,
        response: { 200: ListTeamsResponse, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      const { cursor, limit, q } = request.query;
      const page = await teams.list(c, { cursor, limit: limit ?? 25, q });
      return { items: page.items.map(toTeamDto), nextCursor: page.nextCursor };
    },
  );

  app.post<{ Params: TeamsParams; Body: CreateTeamRequest }>(
    DIRECTORY_PATHS.teams,
    {
      schema: {
        tags,
        summary: 'Create team',
        description: 'Owner/admin. 409 CONFLICT when the name is taken in this organization.',
        params: TeamsParams,
        body: CreateTeamRequest,
        response: { 201: TeamDto, ...directoryWriteErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      return reply.code(201).send(toTeamDto(await teams.create(c, request.body)));
    },
  );

  app.get<{ Params: TeamParams }>(
    DIRECTORY_PATHS.team,
    {
      schema: {
        tags,
        summary: 'Get team',
        params: TeamParams,
        response: { 200: TeamDto, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      return toTeamDto(await teams.get(c, request.params.teamId));
    },
  );

  app.patch<{ Params: TeamParams; Body: UpdateTeamRequest }>(
    DIRECTORY_PATHS.team,
    {
      schema: {
        tags,
        summary: 'Update team',
        description: 'Owner/admin. Partial update; `null` clears a field.',
        params: TeamParams,
        body: UpdateTeamRequest,
        response: { 200: TeamDto, ...directoryWriteErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      return toTeamDto(await teams.update(c, request.params.teamId, request.body));
    },
  );

  app.delete<{ Params: TeamParams }>(
    DIRECTORY_PATHS.team,
    {
      schema: {
        tags,
        summary: 'Delete team',
        description: 'Owner/admin. Soft delete; removes its members and unlinks its projects.',
        params: TeamParams,
        response: { 204: Type.Null(), ...directoryErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      await teams.remove(c, request.params.teamId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: TeamParams; Querystring: ListTeamMembersQuery }>(
    DIRECTORY_PATHS.teamMembers,
    {
      schema: {
        tags,
        summary: 'List team members',
        params: TeamParams,
        querystring: ListTeamMembersQuery,
        response: { 200: ListTeamMembersResponse, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      const { cursor, limit, role } = request.query;
      const page = await teams.listMembers(c, request.params.teamId, {
        cursor,
        limit: limit ?? 25,
        role,
      });
      const withEmail = access.canSeeContactDetails(c);
      return {
        items: page.items.map((m) => toTeamMemberDto(m, { withEmail })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post<{ Params: TeamParams; Body: AddTeamMemberRequest }>(
    DIRECTORY_PATHS.teamMembers,
    {
      schema: {
        tags,
        summary: 'Add team member',
        description:
          'Owner/admin. 404 EMPLOYEE_NOT_FOUND / TEAM_NOT_FOUND; 409 TEAM_MEMBER_EXISTS.',
        params: TeamParams,
        body: AddTeamMemberRequest,
        response: { 201: TeamMemberDto, ...directoryWriteErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      const { employeeId, role } = request.body;
      const m = await teams.addMember(c, request.params.teamId, employeeId, role ?? 'member');
      return reply.code(201).send(toTeamMemberDto(m, { withEmail: true }));
    },
  );

  app.patch<{ Params: TeamMemberParams; Body: UpdateTeamMemberRequest }>(
    DIRECTORY_PATHS.teamMember,
    {
      schema: {
        tags,
        summary: 'Change team member role',
        params: TeamMemberParams,
        body: UpdateTeamMemberRequest,
        response: { 200: TeamMemberDto, ...directoryWriteErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      const { teamId, employeeId } = request.params;
      const m = await teams.updateMember(c, teamId, employeeId, request.body.role);
      return toTeamMemberDto(m, { withEmail: true });
    },
  );

  app.delete<{ Params: TeamMemberParams }>(
    DIRECTORY_PATHS.teamMember,
    {
      schema: {
        tags,
        summary: 'Remove team member',
        params: TeamMemberParams,
        response: { 204: Type.Null(), ...directoryErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      await teams.removeMember(c, request.params.teamId, request.params.employeeId);
      return reply.code(204).send();
    },
  );
}
