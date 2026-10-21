import { expect, it } from 'vitest';
import { formatElapsed } from '../src/lib/format.js';

it('formats elapsed time', () => {
  expect(formatElapsed(0)).toBe('0:00');
  expect(formatElapsed(65_000)).toBe('1:05');
  expect(formatElapsed(3_725_000)).toBe('1:02:05');
  expect(formatElapsed(-5)).toBe('0:00');
});
