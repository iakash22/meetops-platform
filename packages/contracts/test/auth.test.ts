import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AuthSession,
  CsrfResponse,
  ForgotPasswordRequest,
  GetAuthSessionResponse,
  LoginRequest,
  Paginated,
  Project,
  SignupRequest,
  type Paginated as PaginatedT,
} from '../src/index.js';

const now = '2026-10-21T17:00:00.000Z';
const pw = 'correct-horse-battery';
const session = {
  user: { id: 'u1', email: 'a@b.co', name: 'Akash', createdAt: now, updatedAt: now },
  csrfToken: 'c'.repeat(32),
  activeOrganizationId: 'o1',
  role: 'admin',
  organizations: [{ id: 'o1', name: 'Acme', slug: 'acme', createdAt: now, updatedAt: now }],
};

describe('auth requests', () => {
  it('enforces password length 12..128 and valid email', () => {
    expect(Value.Check(LoginRequest, { email: 'a@b.co', password: pw })).toBe(true);
    expect(Value.Check(LoginRequest, { email: 'a@b.co', password: 'elevenchars' })).toBe(false);
    expect(Value.Check(LoginRequest, { email: 'a@b.co', password: 'x'.repeat(129) })).toBe(false);
    expect(Value.Check(LoginRequest, { email: 'nope', password: pw })).toBe(false);
  });
  it('rejects unknown properties on every request', () => {
    expect(Value.Check(LoginRequest, { email: 'a@b.co', password: pw, role: 'owner' })).toBe(false);
    expect(Value.Check(SignupRequest, { name: 'A', email: 'a@b.co', password: pw, isAdmin: true })).toBe(false);
    expect(Value.Check(ForgotPasswordRequest, { email: 'a@b.co', redirect: 'https://evil' })).toBe(false);
  });
  it('requires a name on signup', () => {
    expect(Value.Check(SignupRequest, { name: 'Akash', email: 'a@b.co', password: pw })).toBe(true);
    expect(Value.Check(SignupRequest, { email: 'a@b.co', password: pw })).toBe(false);
  });
});

describe('auth session', () => {
  it('has csrfToken, active org and role, and no accessToken', () => {
    expect(Value.Check(AuthSession, session)).toBe(true);
    expect(Object.keys(AuthSession.properties)).not.toContain('accessToken');
    const noOrg: Record<string, unknown> = { ...session };
    delete noOrg.activeOrganizationId;
    expect(Value.Check(AuthSession, noOrg)).toBe(false);
    expect(Value.Check(AuthSession, { ...session, role: 'root' })).toBe(false);
  });
  it('GetAuthSessionResponse carries no token material', () => {
    expect(Object.keys(GetAuthSessionResponse.properties)).not.toContain('csrfToken');
    const rest: Record<string, unknown> = { ...session };
    delete rest.csrfToken;
    expect(Value.Check(GetAuthSessionResponse, rest)).toBe(true);
  });
  it('CsrfResponse', () => {
    expect(Value.Check(CsrfResponse, { csrfToken: 'c'.repeat(32) })).toBe(true);
    expect(Value.Check(CsrfResponse, { csrfToken: 'short' })).toBe(false);
  });
});

describe('Paginated<T>', () => {
  it('builds a cursor page schema for any item', () => {
    const S = Paginated(Project);
    const page: PaginatedT<{ id: string }> = { items: [{ id: 'p1' }], nextCursor: null };
    expect(page.items).toHaveLength(1);
    expect(Value.Check(S, { items: [], nextCursor: 'c2' })).toBe(true);
    expect(Value.Check(S, { items: [{ bad: true }], nextCursor: null })).toBe(false);
  });
});
