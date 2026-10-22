import { describe, expect, it } from 'vitest';
import { crossOrganizationCases } from './cases.js';

/*
 * Catalogue of XT cases. Implemented cases live elsewhere and are listed here so every ID is
 * accounted for. Every other case is skipped with the reason it can't run yet.
 */
export const implementedXt: Record<string, string> = {
  'XT-01':
    'integration/xt-db.test.ts (withOrgContext) + api/auth/cross-org.test.ts (GET /orgs/{B})',
  'XT-02': 'integration/xt-db.test.ts',
  'XT-03': 'integration/xt-db.test.ts',
  'XT-04': 'integration/xt-db.test.ts + api/auth/cross-org.test.ts (GET /orgs)',
  'XT-10': 'integration/xt-db.test.ts',
  'XT-13': 'integration/xt-db.test.ts',
  'XT-14': 'integration/xt-db.test.ts',
  'XT-21': 'api/auth/cross-org.test.ts (invitations; no GET /members endpoint yet)',
  'XT-26': 'integration/rls.test.ts',
  'XT-27': 'integration/rls.test.ts',
  'XT-28': 'integration/rls.test.ts (DB-BUG-2)',
  'XT-29': 'integration/rls.test.ts',
  'XT-30': 'api/auth/cross-org.test.ts',
};

const NO_ENDPOINT = 'Backend has no such endpoint yet (PR #27 only has auth, orgs and invitations)';
export const pendingXt: Record<string, string> = {
  'XT-05': `${NO_ENDPOINT}: transcripts`,
  'XT-06': `${NO_ENDPOINT}: transcripts`,
  'XT-07': `${NO_ENDPOINT}: summaries`,
  'XT-08': `${NO_ENDPOINT}: tasks`,
  'XT-09': `${NO_ENDPOINT}: tasks`,
  'XT-11': `${NO_ENDPOINT}: tasks`,
  'XT-12': `${NO_ENDPOINT}: task approval`,
  'XT-15': `${NO_ENDPOINT}: files / presign`,
  'XT-16': `${NO_ENDPOINT}: uploads`,
  'XT-17': `${NO_ENDPOINT}: uploads`,
  'XT-18': `${NO_ENDPOINT}: integrations`,
  'XT-19': `${NO_ENDPOINT}: integrations push`,
  'XT-20': `${NO_ENDPOINT}: AI provider config`,
  'XT-22': `${NO_ENDPOINT}: audit log`,
  'XT-23': 'Realtime gateway not wired to auth yet',
  'XT-24': 'Worker job handlers with org checks not implemented yet',
  'XT-25': 'Worker media jobs not implemented yet',
};

for (const c of crossOrganizationCases.filter((x) => !implementedXt[x.id])) {
  describe.skip(`[${c.id}] ${c.title} (pending: ${pendingXt[c.id] ?? 'no reason recorded'})`, () => {
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

  it('every XT case is either implemented or pending with a reason', () => {
    for (const c of crossOrganizationCases)
      expect(Boolean(implementedXt[c.id]) !== Boolean(pendingXt[c.id]), c.id).toBe(true);
  });
});
