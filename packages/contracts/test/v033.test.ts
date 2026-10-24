import { describe, it, expect, expectTypeOf } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ApiErrorEnvelope, CONFLICT_HTTP_STATUS, CONFLICT_REASONS, ConflictReason, CursorPageQuery, DEFAULT_PAGE_LIMIT,
  ListMembersResponse, ListOrganizationsResponse, MAX_CURSOR_LENGTH, MAX_PAGE_LIMIT,
} from '../src/index.js';
import * as Light from '../src/types.js';
import type * as T from '../src/types.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-22T07:00:00.000Z';
const conflict = (reason?: string) => ({
  error: { code: 'CONFLICT', message: 'This person is already a member of the organization', requestId: 'req-1', ...(reason ? { reason } : {}) },
});

describe('v0.3.3 cursor pagination constants', () => {
  it('are exposed by the light /types entry with the same values as the main entry', () => {
    expect(Light.MAX_PAGE_LIMIT).toBe(MAX_PAGE_LIMIT);
    expect(Light.MAX_CURSOR_LENGTH).toBe(MAX_CURSOR_LENGTH);
    expect(Light.DEFAULT_PAGE_LIMIT).toBe(DEFAULT_PAGE_LIMIT);
    expect([MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, MAX_CURSOR_LENGTH]).toEqual([100, 25, 512]);
  });
  it('CursorPageQuery limit default is DEFAULT_PAGE_LIMIT', () => {
    expect(CursorPageQuery.properties.limit.default).toBe(DEFAULT_PAGE_LIMIT);
  });
  it('matches the page #53 returns for GET /orgs and members (items + opaque base64url nextCursor or null)', () => {
    const organization = { id: id(1), name: 'Acme', slug: 'acme', createdAt: at, updatedAt: at };
    const nextCursor = Buffer.from('o:25').toString('base64url');
    expect(Value.Check(ListOrganizationsResponse, { items: [{ organization, role: 'owner' }], nextCursor })).toBe(true);
    expect(Value.Check(ListOrganizationsResponse, { items: [], nextCursor: null })).toBe(true);
    const member = { id: id(3), organizationId: id(1), userId: id(2), role: 'member', createdAt: at, user: { id: id(2) } };
    expect(Value.Check(ListMembersResponse, { items: [member], nextCursor: null })).toBe(true);
    expect(Value.Check(ListMembersResponse, { items: [member] })).toBe(false);
  });
  it('type: page items and nextCursor', () => {
    expectTypeOf<T.ListOrganizationsResponse['nextCursor']>().toEqualTypeOf<string | null>();
    expectTypeOf<T.CursorPage<number>>().toEqualTypeOf<{ items: number[]; nextCursor: string | null }>();
  });
});

describe('v0.3.3 conflict reasons', () => {
  it('lists exactly the 409 conflicts PR #53 raises', () => {
    expect([...CONFLICT_REASONS]).toEqual([
      'ALREADY_MEMBER', 'INVITATION_EXPIRED', 'INVITATION_REVOKED', 'INVITATION_ALREADY_ACCEPTED', 'LAST_OWNER',
    ]);
    expect(CONFLICT_HTTP_STATUS).toBe(409);
    expect(Light.CONFLICT_REASONS).toBe(CONFLICT_REASONS);
  });
  it('ConflictReason schema accepts every reason and rejects others', () => {
    for (const r of CONFLICT_REASONS) expect(Value.Check(ConflictReason, r)).toBe(true);
    expect(Value.Check(ConflictReason, 'USER_EXISTS')).toBe(false);
  });
  it('ApiErrorEnvelope: reason is optional (older servers stay valid) and validated when present', () => {
    expect(Value.Check(ApiErrorEnvelope, conflict())).toBe(true);
    expect(Value.Check(ApiErrorEnvelope, conflict('ALREADY_MEMBER'))).toBe(true);
    expect(Value.Check(ApiErrorEnvelope, conflict('already_member'))).toBe(false);
  });
  it('type: ConflictErrorEnvelope requires CONFLICT + reason', () => {
    expectTypeOf<T.ConflictReason>().toEqualTypeOf<(typeof CONFLICT_REASONS)[number]>();
    expectTypeOf<T.ConflictErrorEnvelope['error']['code']>().toEqualTypeOf<'CONFLICT'>();
    expectTypeOf<T.ConflictErrorEnvelope['error']['reason']>().toEqualTypeOf<T.ConflictReason>();
  });
});

describe('v0.3.3 package exports', () => {
  it('./types has a "default" condition so require/jest/Metro resolve the light entry', async () => {
    const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
      exports: Record<string, Record<string, string>>;
    };
    expect(pkg.exports['./types']).toMatchObject({ import: './dist/types.js', default: './dist/types.js' });
  });
});
