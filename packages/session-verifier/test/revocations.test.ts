import { describe, expect, it } from 'vitest';
import {
  AUTH_REVOCATIONS_CHANNEL,
  buildRevocationMessage,
  createRedisRevocationPublisher,
  parseRevocationMessage,
} from '../src/index.js';

const AT = new Date('2026-10-25T10:00:00.000Z');
const U = '33333333-3333-4333-8333-333333333333';
const O = '11111111-1111-4111-8111-111111111111';
const S = '44444444-4444-4444-8444-444444444444';

describe('revocation messages', () => {
  it('builds ids-only v1 messages per kind', () => {
    expect(
      buildRevocationMessage(
        { kind: 'session', sessionId: S, userId: U, organizationId: O, reason: 'logout' },
        AT,
      ),
    ).toEqual({
      v: 1,
      kind: 'session',
      sessionId: S,
      userId: U,
      organizationId: O,
      reason: 'logout',
      at: AT.toISOString(),
    });
    expect(
      buildRevocationMessage(
        { kind: 'session', sessionId: S, userId: U, organizationId: null, reason: 'logout' },
        AT,
      ),
    ).not.toHaveProperty('organizationId');
    expect(buildRevocationMessage({ kind: 'user', userId: U, reason: 'logout_all' }, AT)).toEqual({
      v: 1,
      kind: 'user',
      userId: U,
      reason: 'logout_all',
      at: AT.toISOString(),
    });
    expect(
      buildRevocationMessage(
        { kind: 'membership', userId: U, organizationId: O, reason: 'role_changed' },
        AT,
      ),
    ).toMatchObject({
      kind: 'membership',
      organizationId: O,
    });
  });

  it('publishes JSON on meetops:auth:revocations', async () => {
    const sent: [string, string][] = [];
    const p = createRedisRevocationPublisher(
      { publish: async (c, m) => void sent.push([c, m]) },
      { now: () => AT },
    );
    await p.publish({ kind: 'user', userId: U, reason: 'password_changed' });
    expect(AUTH_REVOCATIONS_CHANNEL).toBe('meetops:auth:revocations');
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(AUTH_REVOCATIONS_CHANNEL);
    expect(parseRevocationMessage(sent[0]![1])).toEqual({
      v: 1,
      kind: 'user',
      userId: U,
      reason: 'password_changed',
      at: AT.toISOString(),
    });
  });

  it('parse is strict: extra keys (e.g. a token), bad versions, reasons or kinds are dropped', () => {
    const ok = {
      v: 1,
      kind: 'session',
      sessionId: S,
      userId: U,
      reason: 'org_switch',
      at: AT.toISOString(),
    };
    expect(parseRevocationMessage(JSON.stringify(ok))).toEqual(ok);
    expect(parseRevocationMessage(JSON.stringify({ ...ok, tokenHash: 'abc' }))).toBeNull();
    expect(parseRevocationMessage(JSON.stringify({ ...ok, v: 2 }))).toBeNull();
    expect(parseRevocationMessage(JSON.stringify({ ...ok, reason: 'nope' }))).toBeNull();
    expect(parseRevocationMessage(JSON.stringify({ ...ok, kind: 'org' }))).toBeNull();
    expect(
      parseRevocationMessage(
        JSON.stringify({
          v: 1,
          kind: 'membership',
          userId: U,
          reason: 'member_removed',
          at: AT.toISOString(),
        }),
      ),
    ).toBeNull();
    expect(parseRevocationMessage(JSON.stringify({ ...ok, sessionId: 'bad id!' }))).toBeNull();
    expect(parseRevocationMessage('not json')).toBeNull();
    expect(parseRevocationMessage('[]')).toBeNull();
  });
});
