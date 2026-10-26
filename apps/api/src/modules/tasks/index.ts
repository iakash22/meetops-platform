import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_LIMIT,
  CursorPageQuery,
  ExtractedTask,
  ListTasksQuery,
  Task,
  TaskPriority,
} from '@meetops/contracts';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { isRelaxedEnv, MissingProductionDependencyError, type ModuleDeps } from '../index.js';
import { DirectoryAccess } from '../directory/access.js';
import { toDirectoryError } from '../directory/errors.js';
import { directoryErrors, directoryWriteErrors } from '../directory/http/route-kit.js';
import { ExtractedTaskNotFoundError, ExtractedTaskReviewedError } from './errors.js';
import { InMemoryTasks } from './in-memory.repository.js';
import { PrismaTasks } from './prisma.repository.js';
import {
  ExtractedTaskAlreadyReviewed,
  ExtractedTaskMissing,
  type TaskRepositories,
} from './ports.js';

/**
 * Paths the web task-review UI (PR #174) builds against. Contracts define the DTOs and ListTasksQuery but no path
 * constants; move these into @meetops/contracts with the next contracts minor.
 */
export const TASK_PATHS = {
  tasks: '/orgs/:organizationId/tasks',
  extractedTasks: '/orgs/:organizationId/extracted-tasks',
  accept: '/orgs/:organizationId/extracted-tasks/:extractedTaskId/accept',
  dismiss: '/orgs/:organizationId/extracted-tasks/:extractedTaskId/dismiss',
} as const;

const Uuid = Type.String({ format: 'uuid' });
const OrgParams = Type.Object({ organizationId: Uuid }, { additionalProperties: false });
const ReviewParams = Type.Object(
  { organizationId: Uuid, extractedTaskId: Uuid },
  { additionalProperties: false },
);
const ExtractedQuery = Type.Object(
  { ...CursorPageQuery.properties, meetingId: Type.Optional(Uuid) },
  { additionalProperties: false },
);
/** Body of accept: the reviewer's (possibly edited) values. The LLM hints are never copied server-side. */
export const AcceptExtractedTaskBody = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    priority: TaskPriority,
    description: Type.Optional(Type.String({ maxLength: 10_000 })),
    dueAt: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);

/**
 * ListTasksQuery as served: contracts put `default` on `limit` inside the anyOf variants, which Ajv strict mode rejects
 * ("default is ignored"). Same schema minus those defaults; the handler applies DEFAULT_PAGE_LIMIT. Contracts follow-up.
 */
export const ListTasksQuerySchema = (() => {
  const s = JSON.parse(JSON.stringify(ListTasksQuery)) as {
    anyOf: { properties: { limit: { default?: unknown } } }[];
  };
  for (const v of s.anyOf) delete v.properties.limit.default;
  return s as unknown as typeof ListTasksQuery;
})();

type OrgP = { organizationId: string };
type ReviewP = { organizationId: string; extractedTaskId: string };

export type TasksModuleDeps = ModuleDeps & { tasks?: TaskRepositories };

export function selectTaskRepositories(
  deps: TasksModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): TaskRepositories {
  if (deps.tasks) return deps.tasks;
  if (deps.db) return new PrismaTasks(deps.db);
  if (!isRelaxedEnv(nodeEnv)) throw new MissingProductionDependencyError(['tasks']);
  return new InMemoryTasks();
}

function translate(e: unknown): unknown {
  if (e instanceof ExtractedTaskMissing) return new ExtractedTaskNotFoundError();
  if (e instanceof ExtractedTaskAlreadyReviewed) return new ExtractedTaskReviewedError();
  return toDirectoryError(e);
}
/** Takes a thunk so synchronous repository throws are translated too. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw translate(e);
  }
}

/**
 * Phase 4: tasks and the human review of AI-extracted tasks. Order on every route: session (401) -> active org +
 * membership (404) -> CASL on `Task` (403; review = create Task) -> repository (404/409).
 */
export default async function tasksModule(
  app: FastifyInstance,
  opts: { auth: AuthService; organizations: OrganizationService; deps: TasksModuleDeps },
) {
  const { auth, organizations, deps } = opts;
  const repo = selectTaskRepositories(deps);
  registerDomainErrorHandler(app);
  const g = makeGuards(auth, deps.security);
  const access = new DirectoryAccess(organizations, deps.audit);
  const caller = async (request: Parameters<typeof g.requireSession>[0], organizationId: string) =>
    access.caller(await g.requireSession(request), organizationId, requestMeta(request));

  app.get<{ Params: OrgP; Querystring: ListTasksQuery }>(
    TASK_PATHS.tasks,
    {
      schema: {
        tags: ['tasks'],
        summary: 'List tasks',
        params: OrgParams,
        querystring: ListTasksQuerySchema,
        response: { 200: CursorPage(Task), ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      organizations.authorize(c.ctx, 'read', 'Task');
      const q = request.query;
      const status =
        q.status === undefined ? undefined : Array.isArray(q.status) ? q.status : [q.status];
      return call(() =>
        repo.listTasks(c.ctx.organizationId, {
          cursor: q.cursor,
          limit: q.limit ?? DEFAULT_PAGE_LIMIT,
          status,
          priority: q.priority,
          projectId: q.projectId,
          meetingId: q.meetingId,
          assigneeId: 'assigneeId' in q ? q.assigneeId : undefined,
          unassigned: 'unassigned' in q ? q.unassigned : undefined,
          dueBefore: q.dueBefore ? new Date(q.dueBefore) : undefined,
          dueAfter: q.dueAfter ? new Date(q.dueAfter) : undefined,
          q: q.q,
        }),
      );
    },
  );

  app.get<{ Params: OrgP; Querystring: { meetingId?: string; cursor?: string; limit?: number } }>(
    TASK_PATHS.extractedTasks,
    {
      schema: {
        tags: ['tasks'],
        summary: 'List AI-extracted tasks awaiting review',
        description:
          'Only pending_review items, oldest first. assigneeHint/dueHint are UNTRUSTED LLM output (display only).',
        params: OrgParams,
        querystring: ExtractedQuery,
        response: { 200: CursorPage(ExtractedTask), ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      organizations.authorize(c.ctx, 'read', 'Task');
      const q = request.query;
      return call(() =>
        repo.listPendingExtracted(c.ctx.organizationId, {
          meetingId: q.meetingId,
          cursor: q.cursor,
          limit: q.limit ?? DEFAULT_PAGE_LIMIT,
        }),
      );
    },
  );

  app.post<{
    Params: ReviewP;
    Body: { title: string; priority: Task['priority']; description?: string; dueAt?: string };
  }>(
    TASK_PATHS.accept,
    {
      schema: {
        tags: ['tasks'],
        summary: 'Accept an extracted task, creating a Task',
        params: ReviewParams,
        body: AcceptExtractedTaskBody,
        response: { 201: Task, ...directoryWriteErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      organizations.authorize(c.ctx, 'create', 'Task');
      const b = request.body;
      const task = await call(() =>
        repo.accept(c.ctx.organizationId, {
          extractedTaskId: request.params.extractedTaskId,
          reviewerId: c.ctx.userId,
          title: b.title,
          priority: b.priority,
          description: b.description,
          dueAt: b.dueAt ? new Date(b.dueAt) : undefined,
        }),
      );
      await access.record(c, {
        action: 'extracted_task.accept',
        targetType: 'extracted_task',
        targetId: request.params.extractedTaskId,
        metadata: { taskId: task.id },
      });
      return reply.code(201).send(task);
    },
  );

  app.post<{ Params: ReviewP }>(
    TASK_PATHS.dismiss,
    {
      schema: {
        tags: ['tasks'],
        summary: 'Dismiss an extracted task',
        params: ReviewParams,
        response: { 204: Type.Null(), ...directoryWriteErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      organizations.authorize(c.ctx, 'create', 'Task');
      await call(() =>
        repo.dismiss(c.ctx.organizationId, {
          extractedTaskId: request.params.extractedTaskId,
          reviewerId: c.ctx.userId,
        }),
      );
      await access.record(c, {
        action: 'extracted_task.dismiss',
        targetType: 'extracted_task',
        targetId: request.params.extractedTaskId,
      });
      return reply.code(204).send();
    },
  );
}
