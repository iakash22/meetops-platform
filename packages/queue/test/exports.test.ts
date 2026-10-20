import { describe, it, expect } from 'vitest';
import { createQueue, createWorker } from '../src';

describe('queue exports', () => {
  it('exposes factory functions', () => {
    expect(typeof createQueue).toBe('function');
    expect(typeof createWorker).toBe('function');
  });
});
