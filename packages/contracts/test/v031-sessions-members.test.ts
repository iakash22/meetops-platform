import { describe, it, expect, expectTypeOf } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ListMembersResponse,
  ListSessionsResponse,
  OrganizationMember,
  SessionIdParams,
  SessionSummary,
  UserSummary,
} from '../src/index.js';
import type * as T from '../src/types.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-22T07:00:00.000Z';
const session = {
  id: id(1),
  current: true,
  createdAt: at,
  lastSeenAt: at,
  expiresAt: at,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
};
const user = { id: id(2), email: 'a@example.com', name: 'Ada' };
const member = {
  id: id(3),
  organizationId: id(4),
  userId: id(2),
  role: 'admin',
  createdAt: at,
  user,
};

describe('SessionSummary', () => {
  it('accepts the API shape, with nullable ip and userAgent', () => {
    expect(Value.Check(SessionSummary, session)).toBe(true);
    expect(
      Value.Check(SessionSummary, { ...session, current: false, ip: null, userAgent: null }),
    ).toBe(true);
    expect(Value.Check(SessionSummary, { ...session, ip: '2001:db8::1' })).toBe(true);
  });
  it('rejects token or secret fields', () => {
    for (const k of [
      'token',
      'tokenHash',
      'sessionToken',
      'csrfToken',
      'refreshToken',
      'accessToken',
      'secret',
    ]) {
      expect(Value.Check(SessionSummary, { ...session, [k]: 'x'.repeat(40) })).toBe(false);
    }
  });
  it('rejects non-UUID id, non-ISO timestamps, missing fields and overlong values', () => {
    expect(Value.Check(SessionSummary, { ...session, id: 'sess-1' })).toBe(false);
    expect(Value.Check(SessionSummary, { ...session, lastSeenAt: 'yesterday' })).toBe(false);
    expect(Value.Check(SessionSummary, { ...session, expiresAt: undefined })).toBe(false);
    expect(Value.Check(SessionSummary, { ...session, userAgent: 'x'.repeat(1025) })).toBe(false);
    expect(Value.Check(SessionSummary, { ...session, ip: 'x'.repeat(46) })).toBe(false);
  });
});

describe('ListSessionsResponse', () => {
  it('is a strict cursor page', () => {
    expect(Value.Check(ListSessionsResponse, { items: [session], nextCursor: null })).toBe(true);
    expect(Value.Check(ListSessionsResponse, { items: [session] })).toBe(false);
    expect(Value.Check(ListSessionsResponse, { items: [], nextCursor: null, total: 0 })).toBe(
      false,
    );
  });
  it('SessionIdParams requires a UUID', () => {
    expect(Value.Check(SessionIdParams, { sessionId: id(1) })).toBe(true);
    expect(Value.Check(SessionIdParams, { sessionId: 'abc' })).toBe(false);
  });
});

describe('OrganizationMember and ListMembersResponse', () => {
  it('accepts membership fields plus a user summary', () => {
    expect(Value.Check(OrganizationMember, member)).toBe(true);
    expect(Value.Check(ListMembersResponse, { items: [member], nextCursor: 'c1' })).toBe(true);
    expect(Value.Check(ListMembersResponse, { items: [], nextCursor: null })).toBe(true);
  });
  it('rejects orgId naming, bad role, a bare Membership and extra user fields', () => {
    expect(
      Value.Check(OrganizationMember, { ...member, organizationId: undefined, orgId: id(4) }),
    ).toBe(false);
    expect(Value.Check(OrganizationMember, { ...member, role: 'root' })).toBe(false);
    const bare = {
      id: member.id,
      organizationId: member.organizationId,
      userId: member.userId,
      role: member.role,
      createdAt: at,
    };
    expect(Value.Check(OrganizationMember, bare)).toBe(false);
    expect(Value.Check(UserSummary, { ...user, passwordHash: 'x' })).toBe(false);
    expect(Value.Check(UserSummary, { ...user, avatarUrl: 'http://x.test/a.png' })).toBe(false);
    expect(Value.Check(ListMembersResponse, { items: [bare], nextCursor: null })).toBe(false);
  });
  it('types are exported from /types', () => {
    expectTypeOf<T.ListMembersResponse>().toEqualTypeOf<{
      items: T.OrganizationMember[];
      nextCursor: string | null;
    }>();
    expectTypeOf<T.ListSessionsResponse>().toEqualTypeOf<{
      items: T.SessionSummary[];
      nextCursor: string | null;
    }>();
    expectTypeOf<T.OrganizationMember['user']>().toEqualTypeOf<T.UserSummary>();
  });
});
