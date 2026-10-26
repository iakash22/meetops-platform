import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { EmployeeService } from '../employees/application/employee.service.js';
import { employeeRoutes } from '../employees/http/employees.routes.js';
import { TeamService } from '../teams/application/team.service.js';
import { teamRoutes } from '../teams/http/teams.routes.js';
import { ProjectService } from '../projects/application/project.service.js';
import { projectRoutes } from '../projects/http/projects.routes.js';
import { isRelaxedEnv, MissingProductionDependencyError, type ModuleDeps } from '../index.js';
import { DirectoryAccess } from './access.js';
import { InMemoryDirectory } from './in-memory.repositories.js';
import { createPrismaDirectory } from './prisma.repositories.js';
import type { DirectoryRepositories } from './ports.js';
import type { ResolveCaller } from './http/route-kit.js';

/** `deps.directory` lets tests and composition roots inject repositories (it wins over every default). */
export type DirectoryModuleDeps = ModuleDeps & { directory?: DirectoryRepositories };

export interface DirectoryPluginOptions {
  auth: AuthService;
  organizations: OrganizationService;
  deps: DirectoryModuleDeps;
}

/**
 * Repositories for the directory routes: injected > DB-2 Prisma repositories when a database client is
 * configured (`deps.db`) > in-memory (development/test only). Anywhere else the process refuses to start
 * rather than silently keep directory data in memory.
 */
export function selectDirectoryRepositories(
  deps: DirectoryModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): DirectoryRepositories {
  if (deps.directory) return deps.directory;
  if (deps.db) return createPrismaDirectory(deps.db);
  if (!isRelaxedEnv(nodeEnv)) throw new MissingProductionDependencyError(['directory']);
  return new InMemoryDirectory(() => deps.clock.now());
}

/**
 * BE-3 directory module: employees, teams (+ members) and projects under `/orgs/:organizationId/...`
 * (contracts v0.4.0 DIRECTORY_PATHS). Registered from modules/index.ts with a single line.
 */
export default async function directoryModule(app: FastifyInstance, opts: DirectoryPluginOptions) {
  const { auth, organizations, deps } = opts;
  const repos = selectDirectoryRepositories(deps);
  registerDomainErrorHandler(app);
  const g = makeGuards(auth, deps.security);
  app.addHook('onRequest', g.mutationGuard);

  const access = new DirectoryAccess(organizations, deps.audit);
  const caller: ResolveCaller = async (request, organizationId) =>
    access.caller(await g.requireSession(request), organizationId, requestMeta(request));

  const employees = new EmployeeService(repos.employees, access);
  const teams = new TeamService(repos, access);
  const projects = new ProjectService(repos, access);

  await app.register(employeeRoutes, { employees, access, caller });
  await app.register(teamRoutes, { teams, access, caller });
  await app.register(projectRoutes, { projects, caller });
}
