import { describe, it, expect, vi } from 'vitest';
import { canonicalJson, computeWritePayloadHash, guardedWrite, ApprovalRequiredError, ApprovalMismatchError, ApprovalRejectedError } from '../src';
import { governance, approvalFor, ORG, INTEGRATION } from './helpers';

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
    expect(g.events[1]).toMatchObject({ externalId: 'o/r#1', approvalId: 'apr_1', approverUserId: 'usr_1', organizationId: ORG });
  });
  it('audits failures with sanitized errors and rethrows', async () => {
    const g = governance();
    const err = Object.assign(new Error('token ghp_secret leaked in body'), { status: 502 });
    await expect(guardedWrite(g, scope, payload, approvalFor('github', 'createIssue', payload), async () => Promise.reject(err))).rejects.toBe(err);
    expect(g.events.map((e) => e.phase)).toEqual(['attempt', 'failure']);
    expect(g.events[1]?.error).toBe('Error (502)');
    expect(JSON.stringify(g.events)).not.toContain('ghp_secret');
  });
  it('rejects missing, mismatched, cross-org and unverified approvals without writing', async () => {
    const cases: [unknown, unknown, boolean][] = [
      [undefined, ApprovalRequiredError, true],
      [{ approved: true }, ApprovalRequiredError, true],
      [approvalFor('github', 'createIssue', { ...payload, title: 'other' }), ApprovalMismatchError, true],
      [approvalFor('github', 'createIssue', payload, { organizationId: 'org_2' }), ApprovalMismatchError, true],
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
