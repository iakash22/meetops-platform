import { describe, expect, it } from 'vitest';
import { authAbuseCases } from './cases.js';

// TODO(QA): enable once auth/session endpoints exist (AU-*: brute force, enumeration,
// sessions, CSRF, cookies, reset, invites, RBAC). Placeholders keep the IDs visible in reports.
for (const c of authAbuseCases) {
  describe.skip(`[${c.id}] ${c.title}`, () => {
    it(`${c.steps} -> ${c.expected}`, () => {
      expect.fail(`${c.id} not implemented`);
    });
  });
}

describe('auth abuse case catalogue', () => {
  it('has AU-01..AU-35', () => {
    expect(authAbuseCases.map((c) => c.id)).toEqual(
      Array.from({ length: 35 }, (_, i) => `AU-${String(i + 1).padStart(2, '0')}`),
    );
  });
});
