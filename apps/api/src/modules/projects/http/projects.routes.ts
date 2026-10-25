import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  CreateProjectRequest,
  DIRECTORY_PATHS,
  ListProjectsQuery,
  ListProjectsResponse,
  ProjectDto,
  ProjectParams,
  ProjectsParams,
  UpdateProjectRequest,
} from '@meetops/contracts';
import {
  directoryErrors,
  directoryWriteErrors,
  type ResolveCaller,
} from '../../directory/http/route-kit.js';
import type { ProjectService } from '../application/project.service.js';
import { toProjectDto } from './mappers.js';

export interface ProjectRoutesOptions {
  projects: ProjectService;
  caller: ResolveCaller;
}

const tags = ['projects'];

export async function projectRoutes(app: FastifyInstance, opts: ProjectRoutesOptions) {
  const { projects, caller } = opts;

  app.get<{ Params: ProjectsParams; Querystring: ListProjectsQuery }>(
    DIRECTORY_PATHS.projects,
    {
      schema: {
        tags,
        summary: 'List projects',
        params: ProjectsParams,
        querystring: ListProjectsQuery,
        response: { 200: ListProjectsResponse, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      const { cursor, limit, q, status, teamId } = request.query;
      const page = await projects.list(c, { cursor, limit: limit ?? 25, q, status, teamId });
      return { items: page.items.map(toProjectDto), nextCursor: page.nextCursor };
    },
  );

  app.post<{ Params: ProjectsParams; Body: CreateProjectRequest }>(
    DIRECTORY_PATHS.projects,
    {
      schema: {
        tags,
        summary: 'Create project',
        description:
          'Owner/admin. 409 PROJECT_KEY_TAKEN when the key is used (also by a deleted project); 404 TEAM_NOT_FOUND.',
        params: ProjectsParams,
        body: CreateProjectRequest,
        response: { 201: ProjectDto, ...directoryWriteErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      return reply.code(201).send(toProjectDto(await projects.create(c, request.body)));
    },
  );

  app.get<{ Params: ProjectParams }>(
    DIRECTORY_PATHS.project,
    {
      schema: {
        tags,
        summary: 'Get project',
        params: ProjectParams,
        response: { 200: ProjectDto, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      return toProjectDto(await projects.get(c, request.params.projectId));
    },
  );

  app.patch<{ Params: ProjectParams; Body: UpdateProjectRequest }>(
    DIRECTORY_PATHS.project,
    {
      schema: {
        tags,
        summary: 'Update project',
        description: 'Owner/admin. Partial update; `key` is immutable; `null` clears a field.',
        params: ProjectParams,
        body: UpdateProjectRequest,
        response: { 200: ProjectDto, ...directoryWriteErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      return toProjectDto(await projects.update(c, request.params.projectId, request.body));
    },
  );

  app.delete<{ Params: ProjectParams }>(
    DIRECTORY_PATHS.project,
    {
      schema: {
        tags,
        summary: 'Delete project',
        description: 'Owner/admin. Soft delete; the key stays reserved.',
        params: ProjectParams,
        response: { 204: Type.Null(), ...directoryErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      await projects.remove(c, request.params.projectId);
      return reply.code(204).send();
    },
  );
}
