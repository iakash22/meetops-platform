import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ListTasksQuery } from '../src/index.js';

const id = '00000000-0000-4000-8000-000000000001';

/** True when some `default` keyword sits under an anyOf/oneOf branch (Ajv strict mode refuses those). */
function defaultUnderUnion(schema: unknown, inUnion = false): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  if (inUnion && 'default' in s) return true;
  return Object.entries(s).some(([k, v]) => {
    const union = inUnion || k === 'anyOf' || k === 'oneOf';
    return Array.isArray(v)
      ? v.some((x) => defaultUnderUnion(x, union))
      : defaultUnderUnion(v, union);
  });
}

describe('v0.6.1 ListTasksQuery', () => {
  it('has no default inside anyOf/oneOf, so Fastify Ajv strict mode compiles it', () => {
    expect(defaultUnderUnion(ListTasksQuery)).toBe(false);
  });

  it('keeps the same accepted and rejected inputs', () => {
    expect(Value.Check(ListTasksQuery, {})).toBe(true);
    expect(Value.Check(ListTasksQuery, { assigneeId: id })).toBe(true);
    expect(Value.Check(ListTasksQuery, { unassigned: true, limit: 10 })).toBe(true);
    expect(Value.Check(ListTasksQuery, { assigneeId: id, unassigned: true })).toBe(false);
    expect(Value.Check(ListTasksQuery, { unassigned: false })).toBe(false);
    expect(Value.Check(ListTasksQuery, { extra: 1 })).toBe(false);
  });
});
