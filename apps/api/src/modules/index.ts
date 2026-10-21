import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { AuthService } from './auth/application/auth.service.js';
import { authRoutes } from './auth/http/auth.plugin.js';
import { Argon2PasswordHasher } from './auth/infrastructure/argon2-password-hasher.js';
import { CryptoTokenService, uuidGenerator } from './auth/infrastructure/crypto-token.service.js';
import { InMemorySessionRepository } from './auth/infrastructure/in-memory-session.repository.js';
import type { SessionRepository } from './auth/domain/session.js';
import type { PasswordHasher, TokenService } from './auth/domain/ports.js';
import { InMemoryUserRepository } from './users/infrastructure/in-memory-user.repository.js';
import type { UserRepository } from './users/domain/user.repository.js';
import { OrganizationService } from './organizations/application/organization.service.js';
import { organizationRoutes } from './organizations/http/organizations.plugin.js';
import {
  InMemoryInvitationRepository,
  InMemoryMembershipRepository,
  InMemoryOrganizationRepository
} from './organizations/infrastructure/in-memory.repositories.js';
import type {
  InvitationRepository,
  MembershipRepository,
  OrganizationRepository
} from './organizations/domain/repositories.js';
import { systemClock, type Clock, type IdGenerator } from '../shared/ports.js';

export interface ModuleDeps {
  users: UserRepository;
  sessions: SessionRepository;
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  invitations: InvitationRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  clock: Clock;
  ids: IdGenerator;
  sessionTtlMs: number;
  invitationTtlMs: number;
  cookieSecure: boolean;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Default deps. Repositories are in-memory until the Prisma implementations land.
 * TODO(database): swap for Prisma repositories.
 */
export function defaultModuleDeps(overrides: Partial<ModuleDeps> = {}): ModuleDeps {
  return {
    users: new InMemoryUserRepository(),
    sessions: new InMemorySessionRepository(),
    organizations: new InMemoryOrganizationRepository(),
    memberships: new InMemoryMembershipRepository(),
    invitations: new InMemoryInvitationRepository(),
    hasher: new Argon2PasswordHasher(),
    tokens: new CryptoTokenService(),
    clock: systemClock,
    ids: uuidGenerator,
    sessionTtlMs: 30 * DAY,
    invitationTtlMs: 7 * DAY,
    cookieSecure: process.env.NODE_ENV !== 'development',
    ...overrides
  };
}

export async function registerModules(app: FastifyInstance, deps: ModuleDeps) {
  await app.register(cookie);
  const auth = new AuthService(deps);
  const organizations = new OrganizationService(deps);
  app.decorateRequest('auth', null);
  await app.register(authRoutes, { auth, cookieSecure: deps.cookieSecure, sessionTtlMs: deps.sessionTtlMs });
  await app.register(organizationRoutes, { auth, organizations });
}
