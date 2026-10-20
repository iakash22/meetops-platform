import { describe, it, expect } from 'vitest';
import * as db from '../src';

describe('database package', () => {
  it('exports Prisma client types', () => {
    expect(typeof db).toBe('object');
  });
});
