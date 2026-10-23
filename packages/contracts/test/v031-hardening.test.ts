import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CreateOrganizationRequest, CursorPage, ExtensionDeviceLabel, ListMembersResponse, ListOrganizationsResponse,
  MAX_CURSOR_LENGTH, MAX_PAGE_LIMIT, Organization, SAFE_DISPLAY_TEXT_PATTERN, SafeDisplayText, UserSummary,
} from '../src/index.js';
import { Type } from '@sinclair/typebox';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-22T08:00:00.000Z';
const organization = { id: id(1), name: 'Acme', slug: 'acme', createdAt: at, updatedAt: at };
const name = (n: string) => Value.Check(CreateOrganizationRequest, { name: n });

describe('SafeDisplayText', () => {
  it('deviceLabel and org name share the charset', () => {
    expect(ExtensionDeviceLabel.pattern).toBe(SAFE_DISPLAY_TEXT_PATTERN);
    expect(SafeDisplayText({ maxLength: 10 }).maxLength).toBe(10);
  });
});

describe('CreateOrganizationRequest.name', () => {
  it('accepts normal names, inner spaces and accents', () => {
    for (const ok of ['Acme', 'Acme Corp', 'Büro GmbH', 'A', 'x'.repeat(200)]) expect(name(ok)).toBe(true);
  });
  it('rejects HTML, bidi/format and unsafe characters', () => {
    for (const bad of ['<img onerror=x>', 'Acme\u202ECorp', '\u202E', 'Acme & Co', "Akash's org", 'a"b', 'a\u200Bb', 'a\uFEFFb', 'a\nb']) {
      expect(name(bad)).toBe(false);
    }
  });
  it('rejects blank, whitespace-only and leading/trailing whitespace', () => {
    for (const bad of ['', '   ', ' ', '\t', '\u00A0', '\u3000', ' Acme', 'Acme ', ' Acme ', '\u00A0Acme', 'Acme\u2003', 'x'.repeat(201)]) {
      expect(name(bad)).toBe(false);
    }
  });
  it('deviceLabel keeps its previous whitespace behaviour', () => {
    expect(Value.Check(ExtensionDeviceLabel, 'Chrome on MacBook')).toBe(true);
    expect(Value.Check(ExtensionDeviceLabel, '<img onerror=x>')).toBe(false);
    expect(Value.Check(ExtensionDeviceLabel, 'a\u202Eb')).toBe(false);
  });
});

describe('Organization is strict', () => {
  it('accepts exactly the five fields and rejects extras', () => {
    expect(Value.Check(Organization, organization)).toBe(true);
    expect(Value.Check(Organization, { ...organization, ownerId: id(2) })).toBe(false);
    expect(Value.Check(Organization, { ...organization, deletedAt: null })).toBe(false);
    expect(Value.Check(ListOrganizationsResponse, { items: [{ organization: { ...organization, plan: 'pro' }, role: 'owner' }], nextCursor: null })).toBe(false);
  });
});

describe('CursorPage bounds', () => {
  const Page = CursorPage(Type.Integer());
  it(`allows up to ${MAX_PAGE_LIMIT} items and a ${MAX_CURSOR_LENGTH}-char cursor`, () => {
    expect(MAX_PAGE_LIMIT).toBe(100);
    expect(MAX_CURSOR_LENGTH).toBe(512);
    expect(Value.Check(Page, { items: Array.from({ length: 100 }, (_, i) => i), nextCursor: 'c'.repeat(512) })).toBe(true);
    expect(Value.Check(Page, { items: [], nextCursor: null })).toBe(true);
  });
  it('rejects 101 items and a 513-char cursor', () => {
    expect(Value.Check(Page, { items: Array.from({ length: 101 }, (_, i) => i), nextCursor: null })).toBe(false);
    expect(Value.Check(Page, { items: [], nextCursor: 'c'.repeat(513) })).toBe(false);
    expect(Value.Check(ListOrganizationsResponse, { items: [], nextCursor: 'c'.repeat(513) })).toBe(false);
  });
});

describe('UserSummary', () => {
  const user = { id: id(2), email: 'a@example.com' };
  const avatar = (u: string) => Value.Check(UserSummary, { ...user, avatarUrl: u });
  it('accepts plain https avatar URLs', () => {
    for (const ok of ['https://cdn.example/a.png', 'https://cdn.example', 'https://cdn.example:8443/u/1/a.png?s=64', 'https://cdn.example/a@2x.png']) {
      expect(avatar(ok)).toBe(true);
    }
  });
  it('rejects userinfo, backslashes, http, whitespace and overlong URLs', () => {
    for (const bad of ['https://user:pw@evil.example/a', 'https://evil.example\\@good.example', 'https://user@evil.example',
      'https://evil.example\\a', 'https://evil.example/a\\b', 'http://cdn.example/a.png', 'https://cdn.example/a b',
      'javascript:alert(1)', 'https://', `https://cdn.example/${'a'.repeat(2048)}`]) {
      expect(avatar(bad)).toBe(false);
    }
  });
  it('email is optional (omitted for member/viewer viewers)', () => {
    expect(Value.Check(UserSummary, { id: id(2) })).toBe(true);
    expect(Value.Check(UserSummary, user)).toBe(true);
    expect(Value.Check(UserSummary, { ...user, email: 'not-an-email' })).toBe(false);
    const member = { id: id(3), organizationId: id(4), userId: id(2), role: 'member', createdAt: at, user: { id: id(2), name: 'Ada' } };
    expect(Value.Check(ListMembersResponse, { items: [member], nextCursor: null })).toBe(true);
  });
});
