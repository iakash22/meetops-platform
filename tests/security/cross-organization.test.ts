import { describe, expect, it } from 'vitest';
import { crossOrganizationCases } from './cases.js';

// TODO(QA): enable once API auth + organization context exist (see docs/12-security/auth-session-spec.md).
// XT-26..XT-29 (RLS) also need DB's feat/database-tenancy-rls branch; see integration/database.test.ts.
// Each case becomes a real request as an org A user against org B ids from the factories.
for (const c of crossOrganizationCases) {
  describe.skip(`[${c.id}] ${c.title}`, () => {
    it(`${c.steps} -> ${c.expected}`, () => {
      expect.fail(`${c.id} not implemented`);
    });
  });
}

describe('cross-organization case catalogue (XT IDs)', () => {
  it('has XT-01..XT-30', () => {
    expect(crossOrganizationCases.map((c) => c.id)).toEqual(
      Array.from({ length: 30 }, (_, i) => `XT-${String(i + 1).padStart(2, '0')}`),
    );
  });
});
