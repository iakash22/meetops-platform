import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AuthSession,
  ForgotPasswordRequest,
  LoginRequest,
  Paginated,
  Project,
  SignupRequest,
  type Paginated as PaginatedT,
} from '../src/index.js';

const now = '2026-10-21T17:00:00.000Z';

describe('auth contracts', () => {
  it('validates login and rejects short passwords / bad emails', () => {
    expect(Value.Check(LoginRequest, { email: 'a@b.co', password: 'hunter2!!' })).toBe(true);
    expect(Value.Check(LoginRequest, { email: 'a@b.co', password: 'short' })).toBe(false);
    expect(Value.Check(LoginRequest, { email: 'nope', password: 'hunter2!!' })).toBe(false);
  });
  it('requires a name on signup', () => {
    expect(Value.Check(SignupRequest, { name: 'Akash', email: 'a@b.co', password: 'hunter2!!' })).toBe(true);
    expect(Value.Check(SignupRequest, { email: 'a@b.co', password: 'hunter2!!' })).toBe(false);
  });
  it('validates forgot-password', () => {
    expect(Value.Check(ForgotPasswordRequest, { email: 'a@b.co' })).toBe(true);
  });
  it('validates an auth session', () => {
    const session = {
      user: { id: 'u1', email: 'a@b.co', name: 'Akash', createdAt: now, updatedAt: now },
      accessToken: 'tok',
      organizations: [{ id: 'o1', name: 'Acme', slug: 'acme', createdAt: now, updatedAt: now }],
    };
    expect(Value.Check(AuthSession, session)).toBe(true);
    expect(Value.Check(AuthSession, { ...session, accessToken: '' })).toBe(false);
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
