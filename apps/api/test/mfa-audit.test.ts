/**
 * ADR-021 Amendment 1 P-5: the MFA audit actions exist in AuditAction, map to the record_global_auth_event allowlist
 * (pre-tenant), and the MFA lockout is its own action (`mfa.lockout` -> `auth.mfa_lockout`). Emitting them is the
 * enrolment / challenge PRs' job; this pins the types and the mapping.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuditAction } from '../src/modules/auth/domain/audit.js';
import { PrismaAuditLog } from '../src/modules/auth/infrastructure/prisma/prisma-audit.log.js';
import type { DatabaseClient } from '../src/shared/prisma/context.js';

const MFA_ACTIONS = {
  'auth.mfa.enroll': 'auth.mfa_enrolled',
  'auth.mfa.confirm': 'auth.mfa_confirmed',
  'auth.mfa.disable': 'auth.mfa_disabled',
  'auth.mfa.challenge.success': 'auth.mfa_challenge_succeeded',
  'auth.mfa.challenge.failure': 'auth.mfa_challenge_failed',
  'auth.mfa.step_up': 'auth.mfa_step_up',
  'auth.mfa.recovery_code.used': 'auth.mfa_recovery_code_used',
  'auth.mfa.recovery_codes.regenerate': 'auth.mfa_recovery_codes_regenerated',
  'mfa.lockout': 'auth.mfa_lockout',
} as const satisfies Partial<Record<AuditAction, string>>;

const here = dirname(fileURLToPath(import.meta.url));
const mfaSql = readFileSync(
  resolve(
    here,
    '../../../packages/database/prisma/migrations/20261111180000_mfa_totp/migration.sql',
  ),
  'utf8',
);

function fakeDb() {
  const calls: unknown[][] = [];
  const db = {
    $executeRaw: (_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve(1);
    },
  } as unknown as DatabaseClient;
  return { db, calls };
}

describe('ADR-021 P-5 MFA audit actions', () => {
  it.each(Object.entries(MFA_ACTIONS))(
    '%s is written pre-tenant as %s on an mfa_factor target',
    async (action, dbAction) => {
      const { db, calls } = fakeDb();
      await new PrismaAuditLog(db).record({
        organizationId: null,
        actorId: '00000000-0000-4000-8000-000000000001',
        action: action as AuditAction,
        targetType: 'mfa_factor',
        targetId: '00000000-0000-4000-8000-000000000002',
        metadata: { purpose: 'login' },
        ip: null,
        userAgent: null,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe(dbAction);
      expect(calls[0]?.[2]).toBe('mfa_factor');
    },
  );

  it('every mapped action is in the record_global_auth_event allowlist of the MFA migration', () => {
    const start = mfaSql.indexOf('p_action NOT IN (');
    expect(start).toBeGreaterThan(-1);
    const body = mfaSql.slice(start, mfaSql.indexOf(') THEN', start));
    for (const dbAction of Object.values(MFA_ACTIONS)) expect(body).toContain(`'${dbAction}'`);
    expect(mfaSql).toContain(`NOT IN ('user', 'session', 'email', 'mfa_factor')`);
  });

  it('the MFA lockout is distinct from a failed challenge (not folded into auth.mfa_challenge_failed)', () => {
    expect(MFA_ACTIONS['mfa.lockout']).not.toBe(MFA_ACTIONS['auth.mfa.challenge.failure']);
  });
});
