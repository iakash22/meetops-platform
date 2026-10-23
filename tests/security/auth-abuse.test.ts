import { describe, expect, it } from 'vitest';
import { authAbuseCases } from './cases.js';

/* Catalogue of AU cases: implemented in api/auth/auth-abuse.test.ts (PR #27) or pending with a reason. */
const IMPLEMENTED = [
  1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28,
];
export const implementedAu: Record<string, string> = Object.fromEntries(
  IMPLEMENTED.map((n) => [`AU-${String(n).padStart(2, '0')}`, 'api/auth/auth-abuse.test.ts']),
);

export const pendingAu: Record<string, string> = {
  'AU-06':
    'Timing test needs the real argon2 hasher and many samples; too flaky for CI. Planned as an opt-in perf job',
  'AU-20': 'Browser storage check needs the web app login flow in Playwright (web shell PR)',
  'AU-29': 'No member role-change endpoint (PATCH /members) in PR #27',
  'AU-30': 'No member role-change/remove endpoint in PR #27',
  'AU-31': 'No member role-change endpoint in PR #27',
  'AU-32':
    'Task endpoints do not exist yet (viewer invite refusal is covered as AU-32 (org scope))',
  'AU-33': 'Guest role is not in the contracts Role union yet',
  'AU-34': 'No AI provider config endpoints yet',
  'AU-35': 'No PATCH /me endpoint in PR #27',
};

for (const c of authAbuseCases.filter((x) => !implementedAu[x.id])) {
  describe.skip(`[${c.id}] ${c.title} (pending: ${pendingAu[c.id] ?? 'no reason recorded'})`, () => {
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

  it('every AU case is either implemented or pending with a reason', () => {
    for (const c of authAbuseCases)
      expect(Boolean(implementedAu[c.id]) !== Boolean(pendingAu[c.id]), c.id).toBe(true);
  });
});
