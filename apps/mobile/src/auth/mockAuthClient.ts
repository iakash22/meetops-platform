import type { Organization, Role, User } from '@meetops/contracts';

import {
  AuthClientError,
  type AuthClient,
  type LoginCredentials,
  type LoginResult,
  type MobileAuthSession,
  type MobileAuthTokens,
  type SwitchOrganizationResult,
} from './types';

/**
 * In-process mock of the (not yet specified) mobile bearer auth API. It mimics ADR-005 A1.2 behaviour so the app's
 * session logic is exercised realistically: opaque tokens, short access TTL, rotating refresh tokens, reuse
 * detection that revokes the family, and a hard family lifetime. NOT for production: there is no network and no
 * real credential check unless `accounts` is given.
 */
export interface MockAccount {
  email: string;
  password: string;
  user: User;
  organizations: Organization[];
  role: Role;
}

export interface MockAuthClientOptions {
  /** Known accounts. Ignored when `acceptAnyCredentials` is true. */
  accounts?: MockAccount[];
  /** Demo mode: any syntactically valid email/password signs in as a generated demo user. */
  acceptAnyCredentials?: boolean;
  accessTtlSeconds?: number;
  refreshFamilyLifetimeSeconds?: number;
  /** Simulated latency in ms (0 in tests). */
  latencyMs?: number;
  now?: () => number;
}

export const DEMO_ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000a1';
export const DEMO_SECOND_ORGANIZATION_ID = '00000000-0000-4000-8000-0000000000a2';
const DEMO_USER_ID = '00000000-0000-4000-8000-0000000000b1';
const EPOCH = '2026-01-01T00:00:00.000Z';

export function demoAccount(email: string, password: string): MockAccount {
  return {
    email,
    password,
    role: 'member',
    user: { id: DEMO_USER_ID, email, name: 'Demo User', createdAt: EPOCH, updatedAt: EPOCH },
    organizations: [
      {
        id: DEMO_ORGANIZATION_ID,
        name: 'Demo Organization',
        slug: 'demo-org',
        createdAt: EPOCH,
        updatedAt: EPOCH,
      },
      {
        id: DEMO_SECOND_ORGANIZATION_ID,
        name: 'Second Org',
        slug: 'second-org',
        createdAt: EPOCH,
        updatedAt: EPOCH,
      },
    ],
  };
}

interface Family {
  account: MockAccount;
  organizationId: string;
  createdAt: number;
  currentRefresh: string;
  consumed: Set<string>;
  revoked: boolean;
}

export function createMockAuthClient(options: MockAuthClientOptions = {}): AuthClient {
  const {
    accounts = [],
    acceptAnyCredentials = false,
    accessTtlSeconds = 900,
    refreshFamilyLifetimeSeconds = 30 * 24 * 3600,
    latencyMs = 0,
    now = () => Date.now(),
  } = options;

  let counter = 0;
  // Mock-only opaque values. Real tokens come from the server (>=256-bit random, ADR-005 A1.2).
  const opaque = (kind: string) =>
    `mock_${kind}_${(++counter).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const families: Family[] = [];
  const accessTokens = new Map<string, { family: Family; expiresAt: number }>();

  const delay = () =>
    latencyMs > 0 ? new Promise<void>((r) => setTimeout(r, latencyMs)) : Promise.resolve();

  const issue = (family: Family): MobileAuthTokens => {
    const t = now();
    const accessToken = opaque('at');
    const expiresAt = t + accessTtlSeconds * 1000;
    accessTokens.set(accessToken, { family, expiresAt });
    family.currentRefresh = opaque('rt');
    return {
      tokenType: 'Bearer',
      accessToken,
      expiresAt: new Date(expiresAt).toISOString(),
      refreshToken: family.currentRefresh,
      refreshExpiresAt: new Date(
        family.createdAt + refreshFamilyLifetimeSeconds * 1000,
      ).toISOString(),
      organizationId: family.organizationId,
    };
  };

  const toSession = (family: Family): MobileAuthSession => ({
    user: family.account.user,
    activeOrganizationId: family.organizationId,
    role: family.account.role,
    organizations: family.account.organizations,
  });

  const revoke = (family: Family) => {
    family.revoked = true;
    for (const [token, entry] of accessTokens)
      if (entry.family === family) accessTokens.delete(token);
  };

  const findAccount = ({ email, password }: LoginCredentials): MockAccount | undefined => {
    if (acceptAnyCredentials) return demoAccount(email, password);
    const match = accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    return match && match.password === password ? match : undefined;
  };

  return {
    async login(credentials): Promise<LoginResult> {
      await delay();
      const account = findAccount(credentials);
      // Same error for unknown email and wrong password: no account enumeration.
      if (!account) throw new AuthClientError('AUTH_FAILED', 'Invalid email or password.');
      const organizationId = account.organizations[0]?.id;
      if (!organizationId) throw new AuthClientError('FORBIDDEN', 'No organization membership.');
      const family: Family = {
        account,
        organizationId,
        createdAt: now(),
        currentRefresh: '',
        consumed: new Set(),
        revoked: false,
      };
      families.push(family);
      const tokens = issue(family);
      return { tokens, session: toSession(family) };
    },

    async getSession(accessToken) {
      await delay();
      const entry = accessTokens.get(accessToken);
      if (!entry || entry.family.revoked || entry.expiresAt <= now())
        throw new AuthClientError('UNAUTHENTICATED');
      return toSession(entry.family);
    },

    async refresh(refreshToken) {
      await delay();
      const reused = families.find((f) => f.consumed.has(refreshToken));
      if (reused) {
        revoke(reused);
        throw new AuthClientError('UNAUTHENTICATED', 'Refresh token reuse detected.');
      }
      const family = families.find((f) => f.currentRefresh === refreshToken);
      if (!family || family.revoked) throw new AuthClientError('UNAUTHENTICATED');
      if (now() >= family.createdAt + refreshFamilyLifetimeSeconds * 1000) {
        revoke(family);
        throw new AuthClientError('UNAUTHENTICATED', 'Session expired.');
      }
      family.consumed.add(refreshToken);
      return issue(family);
    },

    async switchOrganization(accessToken, organizationId): Promise<SwitchOrganizationResult> {
      await delay();
      const entry = accessTokens.get(accessToken);
      if (!entry || entry.family.revoked || entry.expiresAt <= now())
        throw new AuthClientError('UNAUTHENTICATED');
      const { account } = entry.family;
      const organization = account.organizations.find((o) => o.id === organizationId);
      // Same as the API: unknown org and non-member org are both NOT_FOUND (no existence leak).
      if (!organization) throw new AuthClientError('NOT_FOUND');
      revoke(entry.family);
      const family: Family = {
        account,
        organizationId,
        createdAt: now(),
        currentRefresh: '',
        consumed: new Set(),
        revoked: false,
      };
      families.push(family);
      return { organization, role: account.role, tokens: issue(family) };
    },

    async logout(refreshToken) {
      await delay();
      const family = families.find(
        (f) => f.currentRefresh === refreshToken || f.consumed.has(refreshToken),
      );
      if (family) revoke(family);
    },
  };
}
