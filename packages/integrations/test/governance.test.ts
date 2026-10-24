import { describe, it, expect, vi } from 'vitest';
import { canonicalJson, computeWritePayloadHash, guardedWrite, ApprovalRequiredError, ApprovalMismatchError, ApprovalRejectedError } from '../src';
import { governance, approvalFor, ORG, INTEGRATION, OTHER_ORG, APPROVAL_ID, APPROVER } from './helpers';
import { AuditUnavailableError, AuditRecordError } from '../src';

const scope = { provider: 'github', operation: 'createIssue' as const, organizationId: ORG, integrationId: INTEGRATION };
const payload = { title: 'T', labels: ['a', 'b'] };

describe('canonical payload hash', () => {
  it('is stable across key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    const h1 = computeWritePayloadHash('createIssue', scope, { title: 'T', labels: ['a'] });
    const h2 = computeWritePayloadHash('createIssue', scope, { labels: ['a'], title: 'T' });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeWritePayloadHash('createIssue', { ...scope, organizationId: 'org_2' }, payload)).not.toBe(computeWritePayloadHash('createIssue', scope, payload));
    expect(computeWritePayloadHash('updateStatus', scope, payload)).not.toBe(computeWritePayloadHash('createIssue', scope, payload));
  });
});

describe('guardedWrite', () => {
  it('verifies, audits attempt+success and runs the write', async () => {
    const g = governance();
    const write = vi.fn(async () => ({ key: 'o/r#1' }));
    const approval = approvalFor('github', 'createIssue', payload);
    await guardedWrite(g, scope, payload, approval, write, (r) => r.key);
    expect(g.approvals.verify).toHaveBeenCalledWith(approval, { ...scope, payloadHash: approval.payloadHash });
    expect(g.events.map((e) => e.phase)).toEqual(['attempt', 'success']);
    expect(g.events[1]).toMatchObject({ externalId: 'o/r#1', approvalId: APPROVAL_ID, approverUserId: APPROVER, organizationId: ORG, attemptCount: 1 });
  });
  it('audits failures with sanitized errors and rethrows', async () => {
    const g = governance();
    const err = Object.assign(new Error('token ghp_secret leaked in body'), { status: 502 });
    await expect(guardedWrite(g, scope, payload, approvalFor('github', 'createIssue', payload), async () => Promise.reject(err))).rejects.toBe(err);
    expect(g.events.map((e) => e.phase)).toEqual(['attempt', 'failure']);
    expect(g.events[1]?.error).toBe('Error (502)');
    expect(JSON.stringify(g.events)).not.toContain('ghp_secret');
  });
  it('rejects approvals not matching the contracts WriteApproval schema', async () => {
    for (const bad of [
      approvalFor('github', 'createIssue', payload, { approvalId: 'apr_1' }),
      approvalFor('github', 'createIssue', payload, { payloadHash: 'A'.repeat(64) }),
      approvalFor('github', 'createIssue', payload, { extra: 1 })
    ]) {
      const g = governance();
      const write = vi.fn();
      await expect(guardedWrite(g, scope, payload, bad, write)).rejects.toBeInstanceOf(ApprovalRequiredError);
      expect(write).not.toHaveBeenCalled();
    }
  });
  it('counts underlying write attempts in the after-audit entry', async () => {
    const g = governance();
    await guardedWrite(g, scope, payload, approvalFor('github', 'createIssue', payload), async (t) => {
      t.attempt();
      t.attempt();
      t.attempt();
      return 1;
    });
    expect(g.events[1]).toMatchObject({ phase: 'success', attemptCount: 3 });
    const f = governance();
    await expect(guardedWrite(f, scope, payload, approvalFor('github', 'createIssue', payload), async (t) => {
      t.attempt();
      t.attempt();
      throw Object.assign(new Error('x'), { status: 503 });
    })).rejects.toThrow();
    expect(f.events[1]).toMatchObject({ phase: 'failure', attemptCount: 2, error: 'Error (503)' });
  });
  it('retries audit writes (bounded) and aborts the write if before-audit fails', async () => {
    const sleep = vi.fn(async () => {});
    const flaky = governance();
    flaky.audit.record.mockRejectedValueOnce(new Error('db')).mockRejectedValueOnce(new Error('db'));
    const write = vi.fn(async () => 'ok');
    await guardedWrite({ ...flaky, auditRetry: { sleep } }, scope, payload, approvalFor('github', 'createIssue', payload), write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    const down = governance();
    down.audit.record.mockRejectedValue(new Error('db'));
    const w2 = vi.fn();
    await expect(guardedWrite({ ...down, auditRetry: { sleep, attempts: 3 } }, scope, payload, approvalFor('github', 'createIssue', payload), w2)).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(w2).not.toHaveBeenCalled();
    expect(down.audit.record).toHaveBeenCalledTimes(3);
  });
  it('surfaces AuditRecordError with the result when the after-audit cannot be stored', async () => {
    const g = governance();
    g.audit.record.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('db'));
    const err = await guardedWrite({ ...g, auditRetry: { sleep: async () => {} } }, scope, payload, approvalFor('github', 'createIssue', payload), async () => ({ key: 'o/r#9' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditRecordError);
    expect((err as AuditRecordError<{ key: string }>).result).toEqual({ key: 'o/r#9' });
  });
  it('rejects missing, mismatched, cross-org and unverified approvals without writing', async () => {
    const cases: [unknown, unknown, boolean][] = [
      [undefined, ApprovalRequiredError, true],
      [{ approved: true }, ApprovalRequiredError, true],
      [approvalFor('github', 'createIssue', { ...payload, title: 'other' }), ApprovalMismatchError, true],
      [approvalFor('github', 'createIssue', payload, { organizationId: OTHER_ORG }), ApprovalMismatchError, true],
      [approvalFor('github', 'createIssue', payload), ApprovalRejectedError, false]
    ];
    for (const [approval, Err, verifyOk] of cases) {
      const g = governance(verifyOk);
      const write = vi.fn();
      await expect(guardedWrite(g, scope, payload, approval, write)).rejects.toBeInstanceOf(Err);
      expect(write).not.toHaveBeenCalled();
      expect(g.events.map((e) => e.phase)).toEqual(['rejected']);
    }
  });
});
