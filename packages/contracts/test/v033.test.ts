import { describe, it, expect, expectTypeOf } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { API_ERROR_REASONS, ApiErrorEnvelope, ApiErrorReason } from '../src/index.js';
import * as Types from '../src/types.js';

const base = { code: 'CONFLICT', message: 'Conflict', requestId: 'req-1' };

describe('v0.3.3 ApiErrorEnvelope.reason', () => {
  it('accepts every documented reason and stays optional', () => {
    expect(Value.Check(ApiErrorEnvelope, { error: base })).toBe(true);
    for (const reason of API_ERROR_REASONS) expect(Value.Check(ApiErrorEnvelope, { error: { ...base, reason } })).toBe(true);
  });

  it('rejects unknown reasons', () => {
    expect(Value.Check(ApiErrorEnvelope, { error: { ...base, reason: 'NOPE' } })).toBe(false);
  });

  it('constant matches the schema and is on the light types entry', () => {
    expectTypeOf<(typeof API_ERROR_REASONS)[number]>().toEqualTypeOf<ApiErrorReason>();
    expect(Types.API_ERROR_REASONS).toEqual(API_ERROR_REASONS);
    expect(API_ERROR_REASONS).toContain('LAST_OWNER');
  });
});
