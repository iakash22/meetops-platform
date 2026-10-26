import { describe, expect, it } from 'vitest';
import { hashToken, TOKEN_HASH_PATTERN, TOKEN_HASH_TEST_VECTORS } from '../src/index.js';

describe('hashToken (shared vectors, ADR-011 2.4)', () => {
  it.each(TOKEN_HASH_TEST_VECTORS)('SHA-256 hex of %j', (input, hex) => {
    expect(hashToken(input)).toBe(hex);
    expect(hashToken(input)).toMatch(TOKEN_HASH_PATTERN);
  });
});
