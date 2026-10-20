import { describe, it, expect } from 'vitest';
import { createLogger } from '../src';

describe('logger', () => {
  it('creates a pino logger', () => {
    const logger = createLogger({ name: 'test' });
    expect(typeof logger.info).toBe('function');
  });
});
