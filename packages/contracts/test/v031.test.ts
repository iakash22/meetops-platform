import { describe, it, expect, expectTypeOf } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CreateOrganizationRequest, CreateOrganizationResponse, ListOrganizationsResponse, OrganizationWithRole,
} from '../src/index.js';
import type * as T from '../src/types.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-22T07:00:00.000Z';
const organization = { id: id(1), name: 'Acme', slug: 'acme', createdAt: at, updatedAt: at };

describe('CreateOrganizationRequest', () => {
  it('accepts a name of 1-200 characters', () => {
    expect(Value.Check(CreateOrganizationRequest, { name: 'Acme' })).toBe(true);
    expect(Value.Check(CreateOrganizationRequest, { name: 'x'.repeat(200) })).toBe(true);
  });
  it('rejects empty, overlong, missing name and extra keys', () => {
    expect(Value.Check(CreateOrganizationRequest, { name: '' })).toBe(false);
    expect(Value.Check(CreateOrganizationRequest, { name: 'x'.repeat(201) })).toBe(false);
    expect(Value.Check(CreateOrganizationRequest, {})).toBe(false);
    expect(Value.Check(CreateOrganizationRequest, { name: 'Acme', slug: 'acme' })).toBe(false);
    expect(Value.Check(CreateOrganizationRequest, { name: 'Acme', orgId: id(1) })).toBe(false);
  });
});

describe('CreateOrganizationResponse', () => {
  it('is { organization, role }', () => {
    expect(Value.Check(CreateOrganizationResponse, { organization, role: 'owner' })).toBe(true);
    expect(CreateOrganizationResponse).toBe(OrganizationWithRole);
  });
  it('rejects bad role, non-UUID id, bare Organization and extra keys', () => {
    expect(Value.Check(CreateOrganizationResponse, { organization, role: 'superuser' })).toBe(false);
    expect(Value.Check(CreateOrganizationResponse, { organization: { ...organization, id: 'org-1' }, role: 'owner' })).toBe(false);
    expect(Value.Check(CreateOrganizationResponse, organization)).toBe(false);
    expect(Value.Check(CreateOrganizationResponse, { organization, role: 'owner', organizationId: id(1) })).toBe(false);
  });
});

describe('ListOrganizationsResponse', () => {
  it('accepts a cursor page of { organization, role }', () => {
    expect(Value.Check(ListOrganizationsResponse, { items: [], nextCursor: null })).toBe(true);
    expect(Value.Check(ListOrganizationsResponse, {
      items: [{ organization, role: 'owner' }, { organization: { ...organization, id: id(2), slug: 'beta' }, role: 'viewer' }],
      nextCursor: 'abc',
    })).toBe(true);
  });
  it('rejects a bare Organization[] and missing or extra keys', () => {
    expect(Value.Check(ListOrganizationsResponse, [organization])).toBe(false);
    expect(Value.Check(ListOrganizationsResponse, { items: [organization], nextCursor: null })).toBe(false);
    expect(Value.Check(ListOrganizationsResponse, { items: [] })).toBe(false);
    expect(Value.Check(ListOrganizationsResponse, { items: [], nextCursor: null, total: 0 })).toBe(false);
    expect(Value.Check(ListOrganizationsResponse, { items: [{ organization, role: 'owner', x: 1 }], nextCursor: null })).toBe(false);
  });
  it('types are exported from /types', () => {
    expectTypeOf<T.ListOrganizationsResponse>().toEqualTypeOf<{ items: T.OrganizationWithRole[]; nextCursor: string | null }>();
    expectTypeOf<T.CreateOrganizationRequest>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<T.CreateOrganizationResponse>().toEqualTypeOf<{ organization: T.Organization; role: T.Role }>();
  });
});
